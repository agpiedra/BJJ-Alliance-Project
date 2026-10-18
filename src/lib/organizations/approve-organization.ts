import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { sendTransactionalEmail, type EmailSendOutcome } from "@/lib/email/send-transactional-email";
import { ensureDefaultPlan } from "@/lib/payments/ensure-default-plan";
import { lockOrganizationStaff } from "@/lib/staff/staff-service";
import { Role } from "@/generated/prisma/client";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class OrganizationNotApprovableError extends Error {
  constructor(slug: string, status: string) {
    super(`Cannot approve organization "${slug}" — status is ${status}, not PENDING or already ACTIVE.`);
    this.name = "OrganizationNotApprovableError";
  }
}

/**
 * One invitation recipient = one organization + one EXACT stored address — the same identity acceptInvitation resolves
 * (`User.email` is unique case-sensitively, and acceptance looks the account up exactly), so two addresses that differ
 * only by case may be two distinct accounts and must never block, settle or revoke each other's invitations. Issue,
 * settlement, the legacy diagnostic and acceptance's sibling revocation all match recipients this way.
 */
export function sameRecipient(organizationId: string, email: string) {
  return { organizationId, email };
}

/** Genuinely accepted. */
export const ACCEPTED = { acceptedAt: { not: null } };

/** Consumed under the old rules (before `acceptedAt` existed): accepted OR superseded — unknowable, never reinterpreted. */
export const LEGACY_USED = { usedAt: { not: null }, acceptedAt: null, revokedAt: null };

/** Whether a new invitation was issued: not when one was genuinely accepted, nor while a legacy-used row is unresolved. */
export type InvitationIssue = "issued" | "alreadyAccepted" | "legacyUnresolved";

/**
 * What settlement found, under the lock, after the send:
 * - "settled": the new invitation was still live and was settled by the email outcome;
 * - "acceptedMeanwhile": an invitation to this address was accepted while this one was sent — nothing further changed;
 * - "unavailable": the new invitation was no longer usable (cause not recorded) — nothing further changed;
 * - "failed": the settlement transaction failed — the records are as issue left them, or as a concurrent change made them.
 */
export type InvitationSettlement = "settled" | "acceptedMeanwhile" | "unavailable" | "failed";

export interface ApproveOrganizationOptions {
  /**
   * The CLI's manual-link fallback: on a rejected or unconfigured send, keep the new link live so an operator can
   * share it by hand. Panel callers never show the link, so for them it is withdrawn.
   */
  keepLinkOnFailedSend?: boolean;
}

export interface ApproveOrganizationResult {
  organizationId: string;
  academySlug: string;
  kioskToken: string | null; // null when the academy already existed (no new token minted)
  invitationIssue: InvitationIssue;
  invitationLink: string | null; // null unless a new invitation was issued
  invitationEmailSent: boolean;
  /** What is known about the invitation email (send-transactional-email.ts); null when no invitation was issued. */
  invitationEmailOutcome: EmailSendOutcome | null;
  /** null when no invitation was issued. */
  invitationSettlement: InvitationSettlement | null;
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
export async function approveOrganization(
  orgSlug: string,
  approvedById: string,
  options: ApproveOrganizationOptions = {},
): Promise<ApproveOrganizationResult> {
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
    // Only when the academy is CREATED, never on a re-approval: an organization
    // that can't record a single payment on day one is the owner lockout's
    // cousin, but a re-approval (resend) must not resurrect a plan the
    // director deliberately deactivated or grow a duplicate of one they renamed.
    // Named from the language the registrant chose (`defaultLocale`).
    await ensureDefaultPlan(organization.id, academy.id, organization.defaultLocale);
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

  // Step 4: the invitation, in three steps (docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md): ISSUE a new one in a short
  // transaction, SEND the email with no transaction open, then SETTLE by the send's outcome in a second short
  // transaction. Issue, settle, acceptance and every staff invitation mutation take the same per-organization lock.
  const contactEmail = organization.contactEmail;
  const sameAddress = sameRecipient(organization.id, contactEmail);
  const issued = await prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organization.id);
    // Genuine acceptance only — `acceptedAt`. `usedAt` also marked supersession before that column existed.
    if (await tx.invitation.findFirst({ where: { ...sameAddress, ...ACCEPTED }, select: { id: true } })) {
      return { issue: "alreadyAccepted" as const };
    }
    // Consumed under the old rules: accepted OR superseded, and nothing on the row says which. Never reinterpreted —
    // it blocks a resend until an operator resolves it (scripts/report-legacy-invitations.ts).
    if (await tx.invitation.findFirst({ where: { ...sameAddress, ...LEGACY_USED }, select: { id: true } })) {
      return { issue: "legacyUnresolved" as const };
    }
    // The links live right now. Only THESE are retired at settlement, and only if the new email is accepted — never
    // an invitation issued later by a concurrent resend.
    const previous = await tx.invitation.findMany({ where: { ...sameAddress, usedAt: null, revokedAt: null }, select: { id: true } });
    const rawToken = generateRandomToken();
    const created = await tx.invitation.create({
      data: {
        tokenHash: digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")),
        email: contactEmail,
        organizationId: organization.id,
        role: Role.ADMIN,
        invitedById: approvedById,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: { id: true },
    });
    return { issue: "issued" as const, invitationId: created.id, previousIds: previous.map((row) => row.id), rawToken };
  });
  if (issued.issue !== "issued") {
    return {
      organizationId: organization.id,
      academySlug: academy.slug,
      kioskToken,
      invitationIssue: issued.issue,
      invitationLink: null,
      invitationEmailSent: false,
      invitationEmailOutcome: null,
      invitationSettlement: null,
    };
  }

  const invitationLink = `${requireEnv("APP_URL")}/es/accept-invitation?token=${issued.rawToken}`;

  const emailResult = await sendTransactionalEmail(
    contactEmail,
    `${organization.name} has been approved`,
    [
      `Good news — ${organization.name} has been approved.`,
      "Set your password to finish setting up your academy:",
      invitationLink,
      "This link expires in 7 days.",
    ],
    { suppressProviderErrorLogging: true },
  );
  if (!emailResult.success) {
    // Outcome and fixed provider code only — the provider's free-text message can carry the recipient. The message is
    // neutral: for "unknown" the provider may well have accepted the request.
    console.error("[approve-organization] invitation email outcome", {
      organizationId: organization.id,
      outcome: emailResult.outcome,
      providerCode: emailResult.providerCode,
    });
  }

  let invitationSettlement: InvitationSettlement;
  try {
    invitationSettlement = await settleInvitation(organization.id, contactEmail, issued.invitationId, issued.previousIds, emailResult.outcome, options);
  } catch {
    // The email outcome is already known and is still reported. No error text: it can carry query parameters.
    console.error("[approve-organization] invitation settle failed", { organizationId: organization.id, outcome: emailResult.outcome });
    invitationSettlement = "failed";
  }

  return {
    organizationId: organization.id,
    academySlug: academy.slug,
    kioskToken,
    invitationIssue: "issued",
    invitationLink,
    invitationEmailSent: emailResult.success,
    invitationEmailOutcome: emailResult.outcome,
    invitationSettlement,
  };
}

/**
 * Settles a sent invitation under the organization's lock. Every write is id-scoped and only ever sets `revokedAt`
 * on a row that is still unused and unrevoked, so it can neither revive a link nor touch one issued after this one.
 */
async function settleInvitation(
  organizationId: string,
  contactEmail: string,
  invitationId: string,
  previousIds: string[],
  outcome: EmailSendOutcome,
  options: ApproveOrganizationOptions,
): Promise<InvitationSettlement> {
  return prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organizationId);
    // Evidence-backed: issue found no accepted invitation, so any `acceptedAt` now was recorded while this one was sent.
    const accepted = await tx.invitation.findFirst({ where: { ...sameRecipient(organizationId, contactEmail), ...ACCEPTED }, select: { id: true } });
    if (accepted) return "acceptedMeanwhile";
    // No longer usable — withdrawn by an Owner, replaced by a newer resend, or otherwise retired. The row records no
    // cause, so none is claimed. Earlier links stay as they are: retiring them for a dead link would leave none.
    const own = await tx.invitation.findFirstOrThrow({ where: { id: invitationId, organizationId }, select: { usedAt: true, revokedAt: true } });
    if (own.usedAt || own.revokedAt) return "unavailable";

    const now = new Date();
    if (outcome === "accepted") {
      await tx.invitation.updateMany({
        where: { organizationId, id: { in: previousIds }, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
    } else if ((outcome === "rejected" || outcome === "not_configured") && !options.keepLinkOnFailedSend) {
      // Provably not delivered by email; nobody holds it. Earlier links are left usable.
      await tx.invitation.updateMany({ where: { organizationId, id: invitationId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    }
    // "unknown": the new email may or may not have arrived — every link stays; the first accepted retires the rest.
    return "settled";
  });
}
