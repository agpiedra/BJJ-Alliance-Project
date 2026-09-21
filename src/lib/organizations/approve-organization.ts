import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { sendTransactionalEmail } from "@/lib/email/send-transactional-email";
import { Role } from "@/generated/prisma/client";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class OrganizationNotApprovableError extends Error {
  constructor(slug: string, status: string) {
    super(`Cannot approve organization "${slug}" — status is ${status}, not PENDING or already ACTIVE.`);
    this.name = "OrganizationNotApprovableError";
  }
}

export interface ApproveOrganizationResult {
  organizationId: string;
  academySlug: string;
  kioskToken: string | null; // null when the academy already existed (no new token minted)
  invitationLink: string | null; // null when the owner already accepted a prior invitation
  invitationEmailSent: boolean;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5's approval steps, as a plain
 * function — callable from scripts/approve-organization.ts (the CLI
 * stand-in for Phase 6's not-yet-built admin UI) and, later, that UI
 * itself, without duplicating this logic.
 *
 * Idempotent per the doc's own acceptance criterion ("approving twice
 * produces exactly one branch, one membership and one valid invitation"):
 * every step below checks for an existing row before creating one, so a
 * retry (a double-submit, a script re-run) never duplicates the academy,
 * the membership, or issues a stray second invitation once the first has
 * already been accepted.
 */
export async function approveOrganization(orgSlug: string, approvedById: string): Promise<ApproveOrganizationResult> {
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } });

  if (organization.status !== "PENDING" && organization.status !== "ACTIVE") {
    throw new OrganizationNotApprovableError(orgSlug, organization.status);
  }
  if (!organization.contactEmail) {
    throw new Error(`Organization "${orgSlug}" has no contactEmail to invite — cannot approve.`);
  }

  if (organization.status === "PENDING") {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { status: "ACTIVE", approvedAt: new Date(), approvedById },
    });
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — audited here, inside the
    // one shared function, so both scripts/approve-organization.ts and the
    // platform panel's own approve action get this "for free," identically,
    // rather than each caller having to remember to audit its own call.
    await prisma.auditLog.create({
      data: {
        actorId: approvedById,
        organizationId: organization.id,
        action: "organization.approve",
        entityType: "Organization",
        entityId: organization.id,
        before: { status: "PENDING" },
        after: { status: "ACTIVE" },
      },
    });
  }

  // Step 3: default branch, named after the city — Academy.slug is
  // globally unique (not per-organization), so the organization's own
  // already-unique slug doubles as its one default academy's slug,
  // collision-free by construction with no extra derivation needed.
  let academy = await prisma.academy.findFirst({ where: { organizationId: organization.id } });
  let kioskToken: string | null = null;
  if (!academy) {
    kioskToken = generateRandomToken();
    academy = await prisma.academy.create({
      data: {
        organizationId: organization.id,
        name: organization.city || organization.name,
        slug: organization.slug,
        kioskTokenHash: digestLookupSecret(kioskToken, requireEnv("CODE_PEPPER")),
      },
    });
  }

  // Step 2: create or reuse the OWNER identity. "Reuse" (doc): an
  // existing User at this email keeps their password and memberships
  // untouched — only a NEW membership row is added, the Phase 1
  // multi-organization case. A brand-new owner has no password yet (set
  // during acceptance) — User.passwordHash is NOT NULL, so this creates one
  // with a random, unguessable placeholder hash nobody can authenticate
  // with, and `active: false` so no path (including password reset) can
  // reach this account before the real invitation is accepted.
  //
  // The registering owner is an ADMIN, not a DIRECTOR. ADMIN is the
  // organization's owner across every location: its scope is "ALL" academies
  // (tenant/context.ts) and it holds the owner-only gates (schedule, kiosk
  // token, logo). DIRECTOR runs ONE location, and its scope is the academies
  // in its `staffAssignment` rows — of which nothing outside the seed can
  // create any. Granting DIRECTOR here made every customer's owner "the
  // manager of nothing": zero academies in scope and locked out of the
  // owner-only gates. It stayed invisible because Alliance is seeded (see
  // tests/integration/approved-owner-scope.test.ts and revision 33 of
  // docs/MULTI_ACADEMY_AND_KIDS_BELTS.md).
  let owner = await prisma.user.findUnique({ where: { email: organization.contactEmail } });
  if (!owner) {
    owner = await prisma.user.create({
      data: {
        email: organization.contactEmail,
        passwordHash: await hashSecret(generateRandomToken()),
        role: Role.ADMIN,
        active: false,
      },
    });
  }

  const existingMembership = await prisma.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: owner.id, organizationId: organization.id } },
  });
  if (!existingMembership) {
    await prisma.organizationMembership.create({
      data: { userId: owner.id, organizationId: organization.id, role: Role.ADMIN },
    });
  }

  // Step 4: issue the invitation — unless this owner already accepted
  // one for this organization, in which case re-approving must not issue a
  // fresh invite to someone who already has a working account.
  const alreadyAccepted = await prisma.invitation.findFirst({
    where: { organizationId: organization.id, email: organization.contactEmail, usedAt: { not: null } },
  });
  if (alreadyAccepted) {
    return { organizationId: organization.id, academySlug: academy.slug, kioskToken, invitationLink: null, invitationEmailSent: false };
  }

  // "Invalidated appropriately on resend" — same pattern as
  // forgot-password/actions.ts's own prior-token invalidation: mark any
  // still-unused invitation for this org+email spent before issuing a new
  // one, so an old link in an inbox can never be replayed alongside a
  // fresh one.
  await prisma.invitation.updateMany({
    where: { organizationId: organization.id, email: organization.contactEmail, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = generateRandomToken();
  await prisma.invitation.create({
    data: {
      tokenHash: digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")),
      email: organization.contactEmail,
      organizationId: organization.id,
      role: Role.ADMIN,
      invitedById: approvedById,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    },
  });

  const invitationLink = `${requireEnv("APP_URL")}/es/accept-invitation?token=${rawToken}`;

  const emailResult = await sendTransactionalEmail(
    organization.contactEmail,
    `${organization.name} has been approved`,
    [
      `Good news — ${organization.name} has been approved.`,
      "Set your password to finish setting up your academy:",
      invitationLink,
      "This link expires in 7 days.",
    ],
  );
  if (!emailResult.success) {
    console.error("[approve-organization] invitation email failed to send", {
      organizationId: organization.id,
      error: emailResult.error,
    });
  }

  return {
    organizationId: organization.id,
    academySlug: academy.slug,
    kioskToken,
    invitationLink,
    invitationEmailSent: emailResult.success,
  };
}
