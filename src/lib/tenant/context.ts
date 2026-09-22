import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveActiveOrganizationForSignIn } from "@/lib/tenant/active-organization";
import type { AccessContext, MembershipRole, SystemJobContext, TenantContext, TenantContextResult } from "./types";

import { resolveContext } from "@/lib/tenant/resolve-context";
import { tenantRedirectPath } from "@/lib/tenant/redirect-path";
import { isStaffRole } from "@/lib/auth/route-access";

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
  if (!userId) {
    return { status: "UNAUTHENTICATED" };
  }

  const organizationId = session?.activeOrganizationId;
  if (!organizationId) {
    // A real, signed-in user with no resolved selector — either a session
    // issued before sign-in resolved one, or (rarer) a request that reached
    // here without going through the picker flow. Re-run the SAME
    // resolution sign-in uses rather than assuming "no membership": this is
    // what makes an already-issued session self-heal on its very next
    // request instead of needing a fresh login.
    const resolution = await resolveActiveOrganizationForSignIn(userId);
    if (resolution.kind === "none") {
      return { status: "NO_MEMBERSHIP" };
    }
    if (resolution.kind === "needsSelection") {
      return { status: "NEEDS_ORGANIZATION_SELECTION" };
    }
    return resolveContext(userId, resolution.organizationId);
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
  allowedRoles: MembershipRole[],
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
 * Four non-OK statuses, four different redirects — this is the fix for the
 * bug where "not authenticated" and "authenticated but no usable
 * organization" were both sent to /login and were therefore
 * indistinguishable from the outside (see KNOWN_LIMITATIONS in
 * scripts/pending-callers.ts for how long that stayed invisible and why):
 *
 * - `UNAUTHENTICATED` -> /login (the only case that actually means that).
 * - `NO_MEMBERSHIP` -> /no-organization-access (signed in, zero active
 *   memberships — a real, expected state: a deactivated member, or an
 *   account mid-onboarding).
 * - `NEEDS_ORGANIZATION_SELECTION` -> /select-organization (signed in, 2+
 *   active memberships, nothing resolved yet — should be rare post-sign-in
 *   now that the jwt callback resolves this, but a request can still reach
 *   here before the picker is completed).
 * - `ORG_NOT_ACTIVE` -> /organization-unavailable (unchanged from before).
 *
 * All four fail closed (decision 6); only the destination differs, and each
 * destination's copy is honest about which of these four it is.
 */
export async function requireTenantContext(allowedRoles: MembershipRole[]): Promise<TenantContext> {
  const result = await getTenantContext();
  if (result.status === "OK") {
    // The role list is REQUIRED — there is no no-argument form, so a permissive gate
    // cannot be had by omission (tests/unit/tenant-gate-has-no-default.test.ts). The
    // Edge middleware can only refuse on a session claim, so a stale one (someone
    // moved to Student only while logged in) or a forged one gets through to here, and
    // this DATABASE check is the only thing that stops it. A student-only member is
    // admitted only by a page that names STUDENT (`requirePortalContext`).
    if (!allowedRoles.includes(result.context.organizationRole)) {
      // A member who is not staff at all was refused a page that excludes students: the
      // stale-claim case. A bare 404 looks like a broken site to someone who was just
      // moved to Student only, so they are TOLD — sent to the refresh route, which
      // corrects the claim from the database and lands on /no-access. (`to` only
      // carries the locale and a staff tree; it is never somewhere they are then sent.)
      if (!isStaffRole(result.context.organizationRole)) {
        redirect(`/api/access/refresh?to=${encodeURIComponent(`/${await getLocale()}/dashboard`)}`);
      }
      // A STAFF member without this page's role knows the app exists; they are refused
      // exactly as a non-member is on /platform (`requireSuperAdmin`): a real `notFound()`,
      // not a thrown Error, which is a raw 500.
      notFound();
    }
    return result.context;
  }

  redirect(tenantRedirectPath(result.status, await getLocale()));
}

/**
 * The PORTAL gate: anyone with a linked, ACTIVE student record in the active
 * organization — whatever their membership role. A coach who also trains holds a
 * staff membership AND a student record, and must reach both the staff app and
 * their own training from one account; gating the portal on the STUDENT role (as
 * this used to) refused them their own training and made a second email address
 * the only workaround. Someone with no such record (an Owner who does not train)
 * gets the same 404 an unauthorized admin route gives.
 *
 * `studentId` comes from the tenant context itself — re-derived from the database
 * on every call — never from a route param, so there is no id to substitute.
 * `tests/unit/portal-gates-on-linked-student.test.ts` fails the build if anything
 * under the portal gates on the STUDENT role again.
 */
export async function requirePortalContext(): Promise<{ context: TenantContext; studentId: string }> {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);
  if (!context.linkedStudentId) notFound();
  return { context, studentId: context.linkedStudentId };
}
