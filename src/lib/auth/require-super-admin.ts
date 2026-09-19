import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export interface SuperAdminContext {
  actorUserId: string;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — `isSuperAdmin` is deliberately
 * NOT a `Role`/`MembershipRole` value (Appendix C decision 5: "never
 * representable as 'member of org X with role SUPER_ADMIN'"), so it can't be
 * checked by `requireTenantContext`, which is inherently organization-
 * scoped. This is the parallel guard for the one privilege that crosses
 * tenant boundaries by design.
 *
 * Re-reads `isSuperAdmin`/`active` fresh from the database on EVERY call,
 * never from the session/JWT — the same principle `resolveContext`'s own
 * `Organization.status` re-check already established: revoking someone's
 * platform-admin flag (`/platform/admins`) must lock them out of
 * `/platform/**` on their very next request, not whenever their session
 * happens to refresh.
 *
 * `notFound()`, never a distinct "forbidden" page or a thrown `Error`, per
 * the doc's own "disclose to members, never to non-members" rule, read
 * literally: an org ADMIN (or anyone else) is a non-member of the platform
 * surface, and a 403 would itself disclose that the route exists. This is
 * the page-facing half; `resolveSuperAdminActionContext` below is the
 * server-action counterpart, mirroring `requireTenantContext`/
 * `resolveActionContext`'s existing split.
 */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    notFound();
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, active: true } });
  if (!user || !user.active || !user.isSuperAdmin) {
    notFound();
  }

  return { actorUserId: userId };
}

export type SuperAdminActionResult = { ok: true; context: SuperAdminContext } | { ok: false };

/**
 * The mutating-action counterpart to `requireSuperAdmin()` — never calls
 * `notFound()` (that's a page-navigation primitive; an action returns an
 * `ActionState`). A refusal is logged server-side and reported back as a
 * bare `{ ok: false }`, the same generic shape `resolveActionContext` uses
 * for a cross-organization refusal — never a distinct status that would let
 * a non-super-admin learn anything about what this action would have done.
 */
export async function resolveSuperAdminActionContext(): Promise<SuperAdminActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false };
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, active: true } });
  if (!user || !user.active || !user.isSuperAdmin) {
    console.error("[requireSuperAdmin] platform-admin action refused", { actorUserId: userId });
    return { ok: false };
  }

  return { ok: true, context: { actorUserId: userId } };
}
