"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { resolveSuperAdminActionContext } from "@/lib/auth/require-super-admin";
import { approveOrganization, OrganizationNotApprovableError } from "@/lib/organizations/approve-organization";
import type { ActionState } from "@/lib/action-state";

async function revalidatePlatformPaths(organizationId?: string): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/platform/organizations`);
    revalidatePath(`/${locale}/platform/organizations/pending`);
    revalidatePath(`/${locale}/platform`);
    if (organizationId) revalidatePath(`/${locale}/platform/organizations/${organizationId}`);
  } catch (error) {
    console.error("[platform/organizations] failed to revalidate", { error });
  }
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — the panel's own "Approve" row
 * action. Calls the exact same `approveOrganization()` every caller shares
 * (`scripts/approve-organization.ts`, this action, and nothing else) —
 * never a second implementation. `orgSlug` is looked up from `organizationId`
 * first since `approveOrganization` is keyed by slug (the CLI's own natural
 * key); the panel works from ids everywhere else.
 */
export async function approveOrganizationAction(organizationId: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { slug: true } });
  if (!organization) return { error: "notFound" };

  try {
    await approveOrganization(organization.slug, auth.context.actorUserId);
  } catch (error) {
    if (error instanceof OrganizationNotApprovableError) {
      return { error: "notApprovable" };
    }
    throw error;
  }

  await revalidatePlatformPaths(organizationId);
  return { ok: true };
}

/**
 * On reject: `status -> CANCELLED` with an internal reason note (doc's own
 * Phase 5 decision, reused here rather than inventing a second field —
 * `Organization.internalNotes` already exists for exactly this). Never
 * hard-delete.
 */
export async function rejectOrganizationAction(organizationId: string, note: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };
  if (!note.trim()) return { error: "noteRequired", fieldErrors: { note: ["noteRequired"] } };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!organization) return { error: "notFound" };
  if (organization.status !== "PENDING") return { error: "notPending" };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: organizationId },
      data: { status: "CANCELLED", internalNotes: note },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organization.reject",
        entityType: "Organization",
        entityId: organizationId,
        before: { status: "PENDING" },
        after: { status: "CANCELLED", note },
      },
    });
  });

  await revalidatePlatformPaths(organizationId);
  return { ok: true };
}

/**
 * Suspending needs no new enforcement mechanism — `resolveContext()`
 * (tenant/context.ts) already re-reads `Organization.status` from the
 * database on every tenant-context resolution, never from the session,
 * and `ORG_NOT_ACTIVE` already redirects every request to
 * `/organization-unavailable`. This action's entire job is to flip the
 * status and audit it; the existing, already-tested guard does the rest —
 * see `tests/integration/organization-suspend-revalidation.test.ts` for the
 * test that closes the loop between "the guard works" and "this action
 * actually triggers it."
 */
export async function suspendOrganizationAction(organizationId: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!organization) return { error: "notFound" };
  if (organization.status !== "ACTIVE") return { error: "notActive" };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: organizationId }, data: { status: "SUSPENDED" } });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organization.suspend",
        entityType: "Organization",
        entityId: organizationId,
        before: { status: "ACTIVE" },
        after: { status: "SUSPENDED" },
      },
    });
  });

  await revalidatePlatformPaths(organizationId);
  return { ok: true };
}

/**
 * Danger-zone "Cancel" (doc: "danger zone (suspend, cancel — never
 * hard-delete)") — a permanent shutdown, distinct from `reject` (which only
 * ever applies to a still-PENDING application). Allowed from ACTIVE or
 * SUSPENDED; never reversible through this UI (there is no "reactivate a
 * cancelled organization" action, deliberately — that would need its own
 * decision, not a side effect of this one).
 */
export async function cancelOrganizationAction(organizationId: string, note: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };
  if (!note.trim()) return { error: "noteRequired", fieldErrors: { note: ["noteRequired"] } };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!organization) return { error: "notFound" };
  if (organization.status !== "ACTIVE" && organization.status !== "SUSPENDED") return { error: "notCancellable" };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: organizationId },
      data: { status: "CANCELLED", internalNotes: note },
    });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organization.cancel",
        entityType: "Organization",
        entityId: organizationId,
        before: { status: organization.status },
        after: { status: "CANCELLED", note },
      },
    });
  });

  await revalidatePlatformPaths(organizationId);
  return { ok: true };
}

/** The reverse of suspend — only ever SUSPENDED -> ACTIVE. Reversing a
 * CANCELLED (rejected) organization is a different, more deliberate
 * decision than "undo a suspension" and isn't offered here. */
export async function reactivateOrganizationAction(organizationId: string): Promise<ActionState> {
  const auth = await resolveSuperAdminActionContext();
  if (!auth.ok) return { error: "notFound" };

  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!organization) return { error: "notFound" };
  if (organization.status !== "SUSPENDED") return { error: "notSuspended" };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: organizationId }, data: { status: "ACTIVE" } });
    await tx.auditLog.create({
      data: {
        actorId: auth.context.actorUserId,
        organizationId,
        action: "organization.reactivate",
        entityType: "Organization",
        entityId: organizationId,
        before: { status: "SUSPENDED" },
        after: { status: "ACTIVE" },
      },
    });
  });

  await revalidatePlatformPaths(organizationId);
  return { ok: true };
}
