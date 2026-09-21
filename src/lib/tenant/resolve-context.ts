import { prisma } from "@/lib/prisma";
import type { MembershipRole, TenantContext, TenantContextResult } from "./types";

/**
 * Resolving a (user, organization) pair into a verified `TenantContext`, kept in
 * its own module with NO session, NO next/* and NO `@/auth` imports so that BOTH
 * `context.ts` (per-request checks) and `src/lib/auth/derive-access.ts` (the claim
 * put on the token at sign-in) call the SAME function. `sign-in-jwt-callback.ts`
 * cannot import `context.ts` — that imports `@/auth`, which imports the callback —
 * so without this the claim and the per-request check would be two implementations
 * of the same rule.
 */
async function resolveAcademyIds(
  userId: string,
  organizationId: string,
  role: MembershipRole,
): Promise<string[] | "ALL"> {
  if (role === "ADMIN") return "ALL";
  const assignments = await prisma.staffAssignment.findMany({
    where: { userId, organizationId },
    select: { academyId: true },
  });
  return assignments.map((a) => a.academyId);
}

/**
 * Gated on ROLE, never on "a linked Student record exists" — staff members
 * train too and can have their own Student row, and must still see the full
 * roster rather than being scoped to themselves. See the required regression
 * test in `context.test.ts`: a DIRECTOR with a linked Student record sees the
 * full roster.
 */
async function resolveSelfStudentId(
  userId: string,
  organizationId: string,
  role: MembershipRole,
): Promise<string | null> {
  if (role !== "STUDENT") return null;
  // `userId` alone is the real unique key (Student.userId is a plain
  // `@unique` field, not composite) — `organizationId` is an EXTRA filter
  // alongside it, same pattern `scoped-client.ts`'s `scopeArgs()` already
  // relies on for `findUnique`. A cross-org student row now returns null
  // directly instead of being fetched and discarded in JS.
  const student = await prisma.student.findUnique({
    where: { userId, organizationId },
    select: { id: true },
  });
  return student?.id ?? null;
}

/**
 * The student record linked to this account in this organization, when it is
 * ACTIVE — for ANY membership role (see `TenantContext.linkedStudentId`). A
 * PENDING record has no portal yet and an ARCHIVED one has lost it, exactly as
 * for a pure student: this is the same fact archive and restore already turn on.
 */
async function resolveLinkedStudentId(userId: string, organizationId: string): Promise<string | null> {
  const student = await prisma.student.findUnique({
    where: { userId, organizationId },
    select: { id: true, status: true },
  });
  return student && student.status === "ACTIVE" ? student.id : null;
}

/** `resolveContext` only ever produces these three shapes by construction — narrower than the full `TenantContextResult` union so `TenantAccessError`'s callers don't have to account for statuses this function can never actually return. */
export type ResolveContextResult = Extract<TenantContextResult, { status: "OK" | "NO_MEMBERSHIP" | "ORG_NOT_ACTIVE" }>;

export async function resolveContext(userId: string, organizationId: string): Promise<ResolveContextResult> {
  const [user, membership, organization] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { active: true } }),
    prisma.organizationMembership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true, active: true },
    }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } }),
  ]);

  // A deactivated (or deleted) user is exactly the case `requireTenantContext`'s
  // own doc comment already describes NO_MEMBERSHIP as covering ("a deactivated
  // member") — this check was documented as covered but never actually wired up
  // until now. The JWT is valid for up to 30 days, so this is what makes a
  // deactivation take effect on the very next request rather than at the end of
  // the token's life (the same guarantee the deleted `getStaffSession()` gave
  // the staff surface alone; this closes it for every `TenantContext` caller).
  //
  // Two different switches, deliberately: `user.active` is the ACCOUNT's (it
  // ends access to EVERY organization) and `membership.active` is this ONE
  // organization's. An Owner removing someone from their academy flips only the
  // second — flipping the first locked the person out of every other academy
  // they belong to. Both are read here, on every request, never cached.
  if (!user || !user.active || !membership || !membership.active || !organization) {
    return { status: "NO_MEMBERSHIP" };
  }
  if (organization.status !== "ACTIVE") {
    return { status: "ORG_NOT_ACTIVE", organizationStatus: organization.status };
  }

  const [academyIds, selfStudentId, linkedStudentId] = await Promise.all([
    resolveAcademyIds(userId, organizationId, membership.role),
    resolveSelfStudentId(userId, organizationId, membership.role),
    resolveLinkedStudentId(userId, organizationId),
  ]);

  const context: TenantContext = {
    kind: "tenant",
    actorUserId: userId,
    organizationId,
    organizationRole: membership.role,
    academyIds,
    selfStudentId,
    linkedStudentId,
  };
  return { status: "OK", context };
}
