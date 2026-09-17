import { prisma } from "@/lib/prisma";

export type ActiveOrganizationResolution =
  | { kind: "resolved"; organizationId: string }
  | { kind: "needsSelection" }
  | { kind: "none" };

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C decision 4, point 6: "No tenant
 * context must mean deny. Never unscoped, never all organizations, never a
 * silent fallback to the user's first membership." This is the ONE place
 * that resolves what a session's `activeOrganizationId` selector should be
 * — called both at sign-in (src/auth.ts's jwt callback) and, defensively,
 * by `getTenantContext()` for any session whose selector is still null (a
 * session issued before this function existed, or any other path that
 * reaches a protected page without having gone through sign-in first).
 *
 * Zero active memberships and "more than one, none chosen yet" are both
 * real, distinct states — never coerced into each other or into "not
 * authenticated." Only Organizations with status ACTIVE count: a
 * membership in a PENDING/SUSPENDED/CANCELLED org is not a real access
 * grant (`resolveContext` would reject it anyway; filtering it out here
 * means a user whose only membership is suspended gets "no organization
 * access" up front rather than a resolved selector that immediately
 * bounces to /organization-unavailable).
 */
export async function resolveActiveOrganizationForSignIn(userId: string): Promise<ActiveOrganizationResolution> {
  const memberships = await prisma.organizationMembership.findMany({
    where: { userId, organization: { status: "ACTIVE" } },
    select: { organizationId: true },
  });

  if (memberships.length === 0) {
    return { kind: "none" };
  }
  if (memberships.length === 1) {
    return { kind: "resolved", organizationId: memberships[0].organizationId };
  }

  // More than one real option — the persisted "last used" choice is a
  // fast-path candidate, never an unconditional trust: a value that no
  // longer names one of this user's ACTIVE memberships (revoked since, or
  // simply never set) falls through to the explicit picker exactly like a
  // first-ever login would, rather than resolving to something stale.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { lastActiveOrganizationId: true } });
  const lastId = user?.lastActiveOrganizationId;
  if (lastId && memberships.some((membership) => membership.organizationId === lastId)) {
    return { kind: "resolved", organizationId: lastId };
  }

  return { kind: "needsSelection" };
}
