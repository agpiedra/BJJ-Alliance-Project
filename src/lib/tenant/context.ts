import { cache } from "react";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { AccessContext, MembershipRole, SystemJobContext, TenantContext, TenantContextResult } from "./types";

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
  const student = await prisma.student.findUnique({
    where: { userId },
    select: { id: true, organizationId: true },
  });
  if (!student || student.organizationId !== organizationId) return null;
  return student.id;
}

async function resolveContext(userId: string, organizationId: string): Promise<TenantContextResult> {
  const [membership, organization] = await Promise.all([
    prisma.organizationMembership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true },
    }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } }),
  ]);

  if (!membership || !organization) {
    return { status: "NO_MEMBERSHIP" };
  }
  if (organization.status !== "ACTIVE") {
    return { status: "ORG_NOT_ACTIVE", organizationStatus: organization.status };
  }

  const [academyIds, selfStudentId] = await Promise.all([
    resolveAcademyIds(userId, organizationId, membership.role),
    resolveSelfStudentId(userId, organizationId, membership.role),
  ]);

  const context: TenantContext = {
    kind: "tenant",
    actorUserId: userId,
    organizationId,
    organizationRole: membership.role,
    academyIds,
    selfStudentId,
  };
  return { status: "OK", context };
}

/**
 * Resolves the current request's tenant context from the session's
 * `activeOrganizationId` selector, re-validated against a real membership
 * row on every call (never trust the selector as authority — Appendix C
 * decision 4 / proposal points 1 and 6).
 *
 * Memoized with React's per-request `cache()` ONLY — this must never become
 * a TTL cache, or a revoked membership / suspended organization would keep
 * granting access until the cache entry expired instead of on the very next
 * request (proposal point 7).
 */
export const getTenantContext = cache(async (): Promise<TenantContextResult> => {
  const session = await auth();
  const userId = session?.user?.id;
  const organizationId = session?.activeOrganizationId;
  if (!userId || !organizationId) {
    return { status: "NO_MEMBERSHIP" };
  }
  return resolveContext(userId, organizationId);
});

export class TenantAccessError extends Error {
  constructor(public readonly result: Extract<TenantContextResult, { status: "NO_MEMBERSHIP" | "ORG_NOT_ACTIVE" }>) {
    super(`Tenant access denied: ${result.status}`);
    this.name = "TenantAccessError";
  }
}

/**
 * For creates and mutations that carry an explicit `organizationId` in their
 * own payload rather than reading the ambient session selector — the two-tab
 * problem (proposal point 2) means a mutation must re-derive authorization
 * from the organization IT names, not from whatever the session's selector
 * happens to be pointed at right now.
 *
 * Never memoized: each call re-validates against the database, and `userId`
 * is always the caller's own, verified `id` (from `auth()`), never trusted
 * from client input.
 */
export async function requireOrganizationAccess(
  userId: string,
  organizationId: string,
  allowedRoles?: MembershipRole[],
): Promise<TenantContext> {
  const result = await resolveContext(userId, organizationId);
  if (result.status !== "OK") {
    throw new TenantAccessError(result);
  }
  if (allowedRoles && !allowedRoles.includes(result.context.organizationRole)) {
    throw new Error("FORBIDDEN");
  }
  return result.context;
}

export type ActionAuthResult = { ok: true; context: TenantContext } | { ok: false };

/**
 * 1f-4: the mutating-action counterpart to `requireTenantContext()` —
 * `organizationId` is the caller's OWN explicit argument (bound from the
 * page's already-resolved `context.organizationId` at render time, the same
 * pattern `login.bind(null, locale, callbackUrl)` already uses for a
 * server-resolved value), never read from the ambient session selector.
 * This is what actually closes the two-tab hole Appendix C proposal point 2
 * names: `requireOrganizationAccess` checks membership against the
 * organization THIS ACTION claims to act on, not whichever org the cookie
 * happens to point at right now — a member with org A active saving an org
 * B row they legitimately belong to still succeeds, because membership is
 * checked against B, not against the cookie's A.
 *
 * Never redirects — an action returns an `ActionState`, not a page. A
 * refusal (no session, no membership, org not active, or role mismatch) is
 * logged and audited server-side, then reported back as a bare `{ ok:
 * false }`. Global rule (revision 17): "disclose to members, never to
 * non-members" — every caller turns this into the SAME generic
 * `{error:"notFound"}` every cross-org row check in this codebase already
 * uses, never a distinct "forbidden" that would let a non-member learn the
 * organization exists at all. Declining to tell the caller is not a reason
 * not to record it: repeated cross-organization attempts are exactly what
 * should be alertable after launch.
 */
export async function resolveActionContext(
  organizationId: string,
  allowedRoles?: MembershipRole[],
): Promise<ActionAuthResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false };
  }

  try {
    const context = await requireOrganizationAccess(userId, organizationId, allowedRoles);
    return { ok: true, context };
  } catch (error) {
    // A role mismatch on a GENUINE member (NOT a TenantAccessError) is an
    // ordinary authorization failure, not the cross-organization disclosure
    // case revision 17 governs — a DIRECTOR/INSTRUCTOR denied an ADMIN-only
    // action is still a real member of the right organization, so there is
    // nothing to hide from them the way there is from a non-member. Preserve
    // every action's existing "let it throw" behavior for this case rather
    // than degrading it to the same generic refusal.
    if (!(error instanceof TenantAccessError)) {
      throw error;
    }
    const reason = error.result.status;
    console.error("[resolveActionContext] cross-organization access refused", {
      actorUserId: userId,
      targetOrganizationId: organizationId,
      reason,
    });
    // Best-effort: an audit row is valuable for post-launch alerting on
    // repeated attempts, but its own failure (e.g. organizationId doesn't
    // even name a real row) must never mask the real refusal above.
    try {
      await prisma.auditLog.create({
        data: {
          actorId: userId,
          organizationId,
          action: "organization.accessRefused",
          entityType: "Organization",
          entityId: organizationId,
          after: { attemptedRoles: allowedRoles ?? null, reason },
        },
      });
    } catch (auditError) {
      console.error("[resolveActionContext] failed to write refusal audit row", { auditError });
    }
    return { ok: false };
  }
}

/**
 * Tenant context for cron/job dispatch (weekly digest, etc.) — a job has no
 * acting user, so it is never represented as a nulled-out `TenantContext`.
 * Callers iterate every organization and skip whichever ones this returns
 * `null` for (spec: "Skip non-active organizations").
 */
export async function resolveSystemJobContext(
  organizationId: string,
  jobName: string,
): Promise<SystemJobContext | null> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;
  return { kind: "system-job", organizationId, jobName };
}


/**
 * 1f-3: the branch-scope HALF of `tenantScopeWhere`, factored out now that
 * `getScopedDb` (scoped-client.ts) covers organization scope unconditionally
 * on its own. Org scope is mandatory and enforced by the wrapper; branch
 * scope is a distinct, OPTIONAL layer callers compose on top of it — never
 * standalone (this carries no `organizationId` of its own).
 *
 * `{}` — no narrowing at all — for ADMIN's "ALL", a `SystemJobContext`, and
 * a `KioskContext`: none of them have a per-user academy LIST to narrow by.
 * This is what makes `locations.ts`'s cross-academy comparison queries
 * (org-scoped, deliberately branch-UNscoped) expressible as "just don't call
 * this," rather than the exception `tenantScopeWhere` forced them into.
 */
export function branchScopeWhere(context: AccessContext): { academyId?: { in: string[] } } {
  if (context.kind !== "tenant" || context.academyIds === "ALL") return {};
  return { academyId: { in: context.academyIds } };
}

/**
 * The 1d replacement for `isAcademyInScope` — deliberately takes a
 * `TenantContext`, not the `AccessContext` union: a `SystemJobContext` has no
 * per-user academy scope to check membership against (its default scope is
 * every academy in its organization), so checking "is this academy in a
 * job's scope" is a category error, not a narrower case of this function.
 *
 * Branch-scope only — this does NOT check organization membership. Every
 * caller that reaches this with an `academyId` sourced from another row
 * (e.g. `student.homeAcademyId`) must independently verify that row's own
 * `organizationId` matches `context.organizationId` first (composite FKs
 * guarantee a real academyId belongs to exactly one organization, but this
 * function has no way to know which one without a DB round trip, so it
 * trusts the caller to have already confirmed same-organization before
 * asking "which academy, within that organization").
 */
export function isAcademyInTenantScope(context: TenantContext, academyId: string): boolean {
  return context.academyIds === "ALL" || context.academyIds.includes(academyId);
}

/**
 * The 1d replacement for `requireStaffSession` — resolves and enforces the
 * current request's tenant context.
 *
 * `NO_MEMBERSHIP` redirects to `/login` (not signed in, or no membership in
 * any organization at all). `ORG_NOT_ACTIVE` redirects to the dedicated
 * `/organization-unavailable` page instead (1e: "suspended-organization
 * behavior") — the user IS authenticated, so dumping them back at the login
 * form with no explanation would fail spec's "a clear localized message, not
 * a generic auth error." Both fail closed (decision 6); only the redirect
 * target differs.
 */
export async function requireTenantContext(allowedRoles?: MembershipRole[]): Promise<TenantContext> {
  const result = await getTenantContext();
  if (result.status === "ORG_NOT_ACTIVE") {
    const locale = await getLocale();
    redirect(`/${locale}/organization-unavailable`);
  }
  if (result.status !== "OK") {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }
  if (allowedRoles && !allowedRoles.includes(result.context.organizationRole)) {
    throw new Error("FORBIDDEN");
  }
  return result.context;
}
