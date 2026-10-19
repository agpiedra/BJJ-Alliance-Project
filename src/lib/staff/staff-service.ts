import { prisma } from "@/lib/prisma";
import { generateRandomToken, digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { sendTransactionalEmail, type EmailSendOutcome } from "@/lib/email/send-transactional-email";
import type { TenantContext } from "@/lib/tenant/types";
import { isStaffRole, type StaffMembershipRole } from "@/lib/staff/staff-role";

/**
 * Staff management, as plain functions over a resolved `TenantContext` — the
 * server actions in `staff-actions.ts` do the authentication and the form
 * parsing and call these; keeping the rules here means they can be driven
 * directly (including concurrently) by tests, and can never be reached
 * without a context.
 *
 * Owner-only, and enforced here too (not just in the action): every function
 * below refuses a context that is not the organization's Owner (ADMIN).
 *
 * The rules, each with its test in tests/integration/staff-management.test.ts:
 * - nobody deactivates or demotes themselves (`selfChange`);
 * - the organization is never left without an active Owner (`lastOwner`) —
 *   serialized per organization by a transaction-level advisory lock, because
 *   with self-changes refused the only way to break it is two Owners removing
 *   each other at the same moment, which a plain count-then-write cannot stop;
 * - a director or instructor always has at least one academy, and only
 *   academies of THIS organization (`academyRequired`, `invalidAcademy`);
 * - a `StaffAssignment`'s role always equals its membership's role, and an
 *   Owner has none (their scope is every academy);
 * - every mutation writes its `AuditLog` row in the same transaction.
 */

// Re-exported for the callers that already import them from here; the definitions
// live in a zero-import module so Client Components can use them (see staff-role.ts).
export { STAFF_ROLES, type StaffMembershipRole } from "@/lib/staff/staff-role";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, same as the owner's

export type StaffError =
  | "notFound"
  | "invalid"
  | "academyRequired"
  | "invalidAcademy"
  | "alreadyMember"
  | "alreadyMemberInactive"
  | "alreadyInvited"
  | "noStudentRecord"
  | "selfChange"
  | "lastOwner"
  | "notPending";

export type StaffResult<T extends object = object> = ({ ok: true } & T) | { error: StaffError };

/**
 * docs/STAFF_INVITATION_RESEND_PLAN.md §2.2 — what settlement found when it checked the new invitation under the lock:
 * - "settled": it was usable at that moment (and, for a provider-accepted resend, the links it replaced were retired);
 * - "acceptedMeanwhile": it had been accepted (its own `acceptedAt` — the only acceptance evidence used);
 * - "unavailable": it was no longer usable (revoked or expired). No cause is claimed;
 * - "failed": settlement itself failed — nothing was invalidated, and whether the link works is UNKNOWN.
 */
export type StaffInvitationSettlement = "settled" | "acceptedMeanwhile" | "unavailable" | "failed";

/** What the Owner is handed after issuing or resending an invitation. The link is returned so it can be copied when the
 * email never arrives — but only while it may work: settled (usable when checked) or failed (unknown, shown with a
 * warning). Never for an invitation settlement found accepted or unusable. */
export interface InvitationDelivery {
  invitationId: string;
  invitationLink?: string;
  expiresAt: Date;
  emailOutcome: EmailSendOutcome;
  settlement: StaffInvitationSettlement;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function assertOwner(context: TenantContext): void {
  if (context.organizationRole !== "ADMIN") throw new Error("FORBIDDEN");
}

/** One staff mutation at a time per organization. `pg_advisory_xact_lock` is
 * released with the transaction, so it is safe behind a transaction pooler
 * (unlike a session-level lock). Also taken by every invitation lifecycle
 * write — the platform issue and settle steps (approve-organization.ts) and
 * acceptance — so they all serialize on ONE key per organization. Always the
 * first lock a transaction takes. */
export async function lockOrganizationStaff(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))::text AS locked`;
}

/** An Owner has no academies; anyone else needs at least one, all of this organization's. */
async function resolveAcademyIds(
  tx: Tx,
  organizationId: string,
  role: StaffMembershipRole,
  requested: string[],
): Promise<{ academyIds: string[] } | { error: "academyRequired" | "invalidAcademy" }> {
  if (role === "ADMIN") return { academyIds: [] };
  const academyIds = [...new Set(requested)].sort();
  if (academyIds.length === 0) return { error: "academyRequired" };
  const found = await tx.academy.count({ where: { organizationId, id: { in: academyIds } } });
  if (found !== academyIds.length) return { error: "invalidAcademy" };
  return { academyIds };
}

async function assignedAcademyIds(tx: Tx, userId: string, organizationId: string): Promise<string[]> {
  const rows = await tx.staffAssignment.findMany({ where: { userId, organizationId }, select: { academyId: true } });
  return rows.map((row) => row.academyId).sort();
}

/** Brings a member's assignments in line with `role` + `academyIds`: exactly those academies, each carrying exactly the membership's role. */
export async function syncStaffAssignments(
  tx: Tx,
  userId: string,
  organizationId: string,
  role: StaffMembershipRole | "STUDENT",
  academyIds: string[],
): Promise<void> {
  // An Owner has every academy; a student-only member has none — neither keeps assignments.
  if (role === "ADMIN" || role === "STUDENT") {
    await tx.staffAssignment.deleteMany({ where: { userId, organizationId } });
    return;
  }
  await tx.staffAssignment.deleteMany({ where: { userId, organizationId, academyId: { notIn: academyIds } } });
  for (const academyId of academyIds) {
    await tx.staffAssignment.upsert({
      where: { userId_academyId: { userId, academyId } },
      update: { role },
      create: { userId, academyId, organizationId, role },
    });
  }
}

/** Active Owners other than `excludeMembershipId`. An Owner whose ACCOUNT cannot sign in does not count. */
async function otherActiveOwners(tx: Tx, organizationId: string, excludeMembershipId: string): Promise<number> {
  return tx.organizationMembership.count({
    where: { organizationId, role: "ADMIN", active: true, id: { not: excludeMembershipId }, user: { active: true } },
  });
}

async function findStaffMembership(tx: Tx, organizationId: string, membershipId: string) {
  const membership = await tx.organizationMembership.findUnique({
    where: { id: membershipId, organizationId },
    select: { id: true, userId: true, role: true, active: true, user: { select: { email: true } } },
  });
  // Students have memberships too; they are not staff and are not managed here.
  if (!membership || !isStaffRole(membership.role)) return null;
  return { ...membership, role: membership.role as StaffMembershipRole };
}

/** Same academies, ignoring order and duplicates. Only for FINDING matching invitations — stored values are never rewritten. */
function sameAcademySet(a: string[], b: string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The live invitations carrying the same OFFER as `invitation` (docs/STAFF_INVITATION_RESEND_PLAN.md §2.1): same
 * organization, EXACT stored address (the identity acceptance and its sibling revocation use — never case-folded), same
 * role, same academy set. Includes `invitation` itself while it is live. Call under the organization lock.
 */
async function liveSameOffer(
  tx: Tx,
  organizationId: string,
  invitation: { email: string; role: string; academyIds: string[] },
): Promise<string[]> {
  const candidates = await tx.invitation.findMany({
    where: { organizationId, email: invitation.email, role: invitation.role as StaffMembershipRole, usedAt: null, revokedAt: null },
    select: { id: true, academyIds: true },
  });
  return candidates.filter((candidate) => sameAcademySet(candidate.academyIds, invitation.academyIds)).map((candidate) => candidate.id);
}

/**
 * Settles one issued invitation once its email outcome is known (§2.2 step 3), under the organization lock with fresh
 * time. Only the new invitation's own `acceptedAt` counts as acceptance; any other reason it is no longer usable is
 * "unavailable", cause unclaimed. Only a provider-accepted send retires anything, and only the still-live ids captured
 * at issue — never an invitation issued later. Rejected, unconfigured and unknown sends change nothing.
 */
async function settleStaffInvitation(
  actorUserId: string,
  organizationId: string,
  invitationId: string,
  previousIds: string[],
  outcome: EmailSendOutcome,
): Promise<Exclude<StaffInvitationSettlement, "failed">> {
  return prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organizationId);
    const now = new Date();
    const own = await tx.invitation.findFirstOrThrow({
      where: { id: invitationId, organizationId },
      select: { acceptedAt: true, usedAt: true, revokedAt: true, expiresAt: true },
    });
    if (own.acceptedAt) return "acceptedMeanwhile";
    if (own.usedAt || own.revokedAt || own.expiresAt <= now) return "unavailable";

    if (outcome === "accepted" && previousIds.length > 0) {
      const stillLive = await tx.invitation.findMany({
        where: { organizationId, id: { in: previousIds }, usedAt: null, revokedAt: null },
        select: { id: true },
      });
      if (stillLive.length > 0) {
        const ids = stillLive.map((invitation) => invitation.id);
        await tx.invitation.updateMany({ where: { organizationId, id: { in: ids }, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        await tx.auditLog.create({
          data: {
            actorId: actorUserId,
            organizationId,
            action: "staff.invitationSuperseded",
            entityType: "Invitation",
            entityId: invitationId,
            before: { invitationIds: ids },
          },
        });
      }
    }
    return "settled";
  });
}

interface IssuedInvitation {
  invitationId: string;
  rawToken: string;
  email: string;
  role: StaffMembershipRole;
  expiresAt: Date;
  /** Replacement candidates captured at issue (empty for a first invite). */
  previousIds: string[];
}

/** The email, in the organization's own language (the link opens in it too) — sent with no transaction open — then settled. */
async function deliverInvitation(actorUserId: string, organizationId: string, issued: IssuedInvitation): Promise<InvitationDelivery> {
  const { email, rawToken, role } = issued;
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true, defaultLocale: true },
  });
  const locale = organization.defaultLocale === "en" ? "en" : "es";
  const invitationLink = `${requireEnv("APP_URL")}/${locale}/accept-invitation?token=${rawToken}`;
  const roleLabel = {
    en: { ADMIN: "Owner", DIRECTOR: "Location director", INSTRUCTOR: "Instructor" },
    es: { ADMIN: "Dueño", DIRECTOR: "Director de sede", INSTRUCTOR: "Instructor" },
  }[locale][role];
  const message =
    locale === "en"
      ? {
          subject: `You've been invited to ${organization.name}`,
          lines: [`You've been invited to join ${organization.name} as ${roleLabel}.`, "Open this link to continue:", invitationLink, "This link expires in 7 days."],
        }
      : {
          subject: `Te invitaron a ${organization.name}`,
          lines: [`Te invitaron a unirte a ${organization.name} como ${roleLabel}.`, "Abre este enlace para continuar:", invitationLink, "Este enlace vence en 7 días."],
        };
  const result = await sendTransactionalEmail(email, message.subject, message.lines, { suppressProviderErrorLogging: true });
  if (!result.success) {
    // Outcome and fixed provider code only — the provider's free-text message can carry the recipient or the link.
    console.error("[staff] invitation email outcome", { organizationId, outcome: result.outcome, providerCode: result.providerCode });
  }

  let settlement: StaffInvitationSettlement;
  try {
    settlement = await settleStaffInvitation(actorUserId, organizationId, issued.invitationId, issued.previousIds, result.outcome);
  } catch {
    // The transaction rolled back: nothing was invalidated. No error text — it can carry query parameters.
    console.error("[staff] invitation settle failed", { organizationId, outcome: result.outcome });
    settlement = "failed";
  }
  const mayWork = settlement === "settled" || settlement === "failed";
  return {
    invitationId: issued.invitationId,
    expiresAt: issued.expiresAt,
    emailOutcome: result.outcome,
    settlement,
    ...(mayWork ? { invitationLink } : {}),
  };
}

export interface InviteStaffInput {
  /** Already trimmed and lower-cased by the caller. */
  email: string;
  role: string;
  academyIds: string[];
}

export async function inviteStaffMember(context: TenantContext, input: InviteStaffInput): Promise<StaffResult<InvitationDelivery>> {
  assertOwner(context);
  const { organizationId } = context;
  if (!isStaffRole(input.role)) return { error: "invalid" };
  const role = input.role;

  const issued = await prisma.$transaction(async (tx): Promise<{ error: StaffError } | IssuedInvitation> => {
    await lockOrganizationStaff(tx, organizationId);

    const academies = await resolveAcademyIds(tx, organizationId, role, input.academyIds);
    if ("error" in academies) return academies;

    // The address may already be an account (its exact casing is the one on
    // the User row — the invitation must carry THAT, or acceptance would not
    // find the account and would create a second identity).
    const existingUser = await tx.user.findFirst({
      where: { email: { equals: input.email, mode: "insensitive" } },
      select: { id: true, email: true },
    });

    const email = existingUser?.email ?? input.email;
    if (existingUser) {
      const membership = await tx.organizationMembership.findUnique({
        where: { userId_organizationId: { userId: existingUser.id, organizationId } },
        select: { active: true, role: true },
      });
      // An ACTIVE student membership is not a refusal — in a jiu-jitsu academy
      // every instructor is a student, and access is membership, so inviting a
      // student account PROMOTES that membership in place when they accept (see
      // `acceptInvitation`). Anyone already staff here, or deactivated, is refused.
      const promotable = membership?.active === true && membership.role === "STUDENT";
      if (membership && !promotable) return { error: membership.active ? ("alreadyMember" as const) : ("alreadyMemberInactive" as const) };
    }

    const pending = await tx.invitation.findFirst({
      where: { organizationId, email: { equals: email, mode: "insensitive" }, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (pending) return { error: "alreadyInvited" as const };

    const rawToken = generateRandomToken();
    const invitation = await tx.invitation.create({
      data: {
        tokenHash: digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")),
        email,
        organizationId,
        role,
        invitedById: context.actorUserId,
        academyIds: academies.academyIds,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "staff.invite",
        entityType: "Invitation",
        entityId: invitation.id,
        after: { email, role, academyIds: academies.academyIds },
      },
    });
    return { invitationId: invitation.id, rawToken, email, role, expiresAt: invitation.expiresAt, previousIds: [] };
  });

  if ("error" in issued) return { error: issued.error };
  return { ok: true, ...(await deliverInvitation(context.actorUserId, organizationId, issued)) };
}

/**
 * A new link for the same invitation (docs/STAFF_INVITATION_RESEND_PLAN.md §2.2). Nothing is invalidated here: the
 * earlier links are only captured, and settlement retires them once the provider has accepted the new email. Role and
 * academies are copied exactly as stored. An expired invitation may be resent; a used or revoked one may not.
 */
export async function resendStaffInvitation(context: TenantContext, invitationId: string): Promise<StaffResult<InvitationDelivery>> {
  assertOwner(context);
  const { organizationId } = context;

  const reissued = await prisma.$transaction(async (tx): Promise<{ error: StaffError } | IssuedInvitation> => {
    await lockOrganizationStaff(tx, organizationId);
    const previous = await tx.invitation.findFirst({ where: { id: invitationId, organizationId } });
    if (!previous) return { error: "notFound" as const };
    if (previous.usedAt || previous.revokedAt || !isStaffRole(previous.role)) return { error: "notPending" as const };

    // Replacement candidates, captured NOW: the resent invitation and every other live link of the same offer. A later
    // settlement may retire only these — never an invitation issued after this point.
    const previousIds = await liveSameOffer(tx, organizationId, previous);
    const rawToken = generateRandomToken();
    const replacement = await tx.invitation.create({
      data: {
        tokenHash: digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")),
        email: previous.email,
        organizationId,
        role: previous.role,
        invitedById: context.actorUserId,
        academyIds: previous.academyIds,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "staff.invitationResend",
        entityType: "Invitation",
        entityId: replacement.id,
        before: { invitationId: previous.id, previousIds },
        after: { email: previous.email, role: previous.role, academyIds: previous.academyIds },
      },
    });
    return {
      invitationId: replacement.id,
      rawToken,
      email: previous.email,
      role: previous.role as StaffMembershipRole,
      expiresAt: replacement.expiresAt,
      previousIds,
    };
  });

  if ("error" in reissued) return { error: reissued.error };
  return { ok: true, ...(await deliverInvitation(context.actorUserId, organizationId, reissued)) };
}

/**
 * Withdraws the OFFER, not just one link (docs/STAFF_INVITATION_RESEND_PLAN.md §2.4, D2): every live invitation with
 * the same exact address, role and academy set — including a resend's replacement whose email is still in flight, so
 * that settlement then finds it unusable and changes nothing. A different-scope offer to the same address is untouched.
 */
export async function revokeStaffInvitation(context: TenantContext, invitationId: string): Promise<StaffResult> {
  assertOwner(context);
  const { organizationId } = context;

  return prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organizationId);
    const invitation = await tx.invitation.findFirst({ where: { id: invitationId, organizationId } });
    if (!invitation) return { error: "notFound" as const };
    if (invitation.usedAt || invitation.revokedAt) return { error: "notPending" as const };

    const invitationIds = await liveSameOffer(tx, organizationId, invitation);
    await tx.invitation.updateMany({ where: { organizationId, id: { in: invitationIds }, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "staff.invitationRevoke",
        entityType: "Invitation",
        entityId: invitation.id,
        before: { email: invitation.email, role: invitation.role, academyIds: invitation.academyIds, invitationIds },
      },
    });
    return { ok: true as const };
  });
}

export async function updateStaffMembership(
  context: TenantContext,
  membershipId: string,
  input: { role: string; academyIds: string[] },
): Promise<StaffResult> {
  assertOwner(context);
  const { organizationId } = context;
  // "Student only" is the one non-staff role this accepts: it takes staff access away
  // and leaves the person's own training (their student record) exactly as it is.
  const studentOnly = input.role === "STUDENT";
  if (!studentOnly && !isStaffRole(input.role)) return { error: "invalid" };
  const role: StaffMembershipRole | "STUDENT" = studentOnly ? "STUDENT" : (input.role as StaffMembershipRole);

  return prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organizationId);
    const target = await findStaffMembership(tx, organizationId, membershipId);
    if (!target) return { error: "notFound" as const };
    if (target.userId === context.actorUserId) return { error: "selfChange" as const };

    // Student only needs no locations. It DOES need an active student record to keep:
    // without one the membership would be left with nothing to reach (no staff app, no
    // portal) — removing someone is what deactivating is for, and it should say so.
    if (studentOnly) {
      const training = await tx.student.findUnique({
        where: { userId: target.userId, organizationId },
        select: { status: true },
      });
      if (!training || training.status !== "ACTIVE") return { error: "noStudentRecord" as const };
    }
    const academies = studentOnly ? { academyIds: [] as string[] } : await resolveAcademyIds(tx, organizationId, role as StaffMembershipRole, input.academyIds);
    if ("error" in academies) return academies;

    // Demoting the last active Owner would leave the organization with nobody who can manage it.
    if (target.role === "ADMIN" && target.active && role !== "ADMIN" && (await otherActiveOwners(tx, organizationId, target.id)) === 0) {
      return { error: "lastOwner" as const };
    }

    const beforeAcademyIds = await assignedAcademyIds(tx, target.userId, organizationId);
    if (target.role === role && JSON.stringify(beforeAcademyIds) === JSON.stringify(academies.academyIds)) return { ok: true as const };

    await tx.organizationMembership.update({ where: { id: target.id, organizationId }, data: { role } });
    await syncStaffAssignments(tx, target.userId, organizationId, role, academies.academyIds);
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "staff.update",
        entityType: "OrganizationMembership",
        entityId: target.id,
        before: { email: target.user.email, role: target.role, academyIds: beforeAcademyIds },
        after: { email: target.user.email, role, academyIds: academies.academyIds },
      },
    });
    return { ok: true as const };
  });
}

/** Deactivate or reactivate ONE membership. The account (`User.active`) is never touched, and the assignments are kept so a reactivation restores the same scope. */
export async function setMembershipActive(context: TenantContext, membershipId: string, active: boolean): Promise<StaffResult> {
  assertOwner(context);
  const { organizationId } = context;

  return prisma.$transaction(async (tx) => {
    await lockOrganizationStaff(tx, organizationId);
    const target = await findStaffMembership(tx, organizationId, membershipId);
    if (!target) return { error: "notFound" as const };
    if (target.active === active) return { ok: true as const };

    if (!active) {
      if (target.userId === context.actorUserId) return { error: "selfChange" as const };
      if (target.role === "ADMIN" && (await otherActiveOwners(tx, organizationId, target.id)) === 0) {
        return { error: "lastOwner" as const };
      }
    }

    await tx.organizationMembership.update({ where: { id: target.id, organizationId }, data: { active } });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: active ? "staff.reactivate" : "staff.deactivate",
        entityType: "OrganizationMembership",
        entityId: target.id,
        before: { email: target.user.email, role: target.role, active: target.active },
        after: { email: target.user.email, role: target.role, active },
      },
    });
    return { ok: true as const };
  });
}
