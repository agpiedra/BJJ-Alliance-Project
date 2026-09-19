"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { resolveSuperAdminActionContext } from "@/lib/auth/require-super-admin";
import { grantSuperAdminFlag, revokeSuperAdminFlag } from "@/lib/tenant/platform-lookups";
import type { ActionState } from "@/lib/action-state";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — `isSuperAdmin` had exactly one
 * seeded holder and no UI at all before this. Grant/revoke both write
 * `AuditLog` (`organizationId: null` — this action isn't scoped to any
 * organization, the same nullable-for-genuinely-platform-level case the
 * schema's own doc comment on `AuditLog.organizationId` already
 * anticipated).
 */
export async function grantSuperAdmin(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "invalid", fieldErrors: { email: ["required"] } };

  const target = await prisma.user.findUnique({ where: { email }, select: { id: true, isSuperAdmin: true } });
  if (!target) return { error: "userNotFound", fieldErrors: { email: ["userNotFound"] } };
  if (target.isSuperAdmin) return { error: "alreadyGranted" };

  await grantSuperAdminFlag(auth.context.actorUserId, target.id);

  await revalidatePlatformAdmins();
  return { ok: true };
}

/**
 * Two refusals, neither negotiable from the UI:
 * - Self-revocation is disallowed outright. `requireSuperAdmin()` re-reads
 *   fresh every request (by design — see its own doc comment), so a
 *   self-revoke would lock the actor out of the very page they're using to
 *   manage this, mid-session, with no benefit over asking another platform
 *   admin to do it. Recoverable (another admin can re-grant), but a
 *   surprising, pointless failure mode worth simply not offering.
 * - Revoking the LAST remaining platform admin is refused unconditionally —
 *   that's a lockout with no recovery path short of a raw database write,
 *   which is exactly the failure mode this whole page exists to avoid.
 */
export async function revokeSuperAdmin(targetUserId: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  if (targetUserId === auth.context.actorUserId) {
    return { error: "cannotRevokeSelf" };
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { isSuperAdmin: true } });
  if (!target || !target.isSuperAdmin) return { error: "notFound" };

  // Kept as defense-in-depth even though it is currently unreachable through
  // this action alone: `resolveSuperAdminActionContext()` above already
  // requires the ACTOR to be a super admin, so if only one exists total,
  // actor === target, which the self-revoke check above already refuses
  // first. This guard exists for the invariant itself ("never let a revoke
  // bring the count to zero"), not because today's code path can trigger
  // it — a future change to how the actor is authorized (or to how
  // isSuperAdmin gets granted) could make actor !== target reachable at
  // remaining === 1, and this stays correct either way.
  const remaining = await prisma.user.count({ where: { isSuperAdmin: true } });
  if (remaining <= 1) {
    return { error: "cannotRevokeLastAdmin" };
  }

  await revokeSuperAdminFlag(auth.context.actorUserId, targetUserId);

  await revalidatePlatformAdmins();
  return { ok: true };
}

async function revalidatePlatformAdmins(): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/platform/admins`);
  } catch (error) {
    console.error("[platform/admins] failed to revalidate", { error });
  }
}
