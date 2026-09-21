"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { Prisma } from "@/generated/prisma/client";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { ActionState } from "@/lib/action-state";

/**
 * Plan management — list, create, edit, DEACTIVATE. Never delete.
 *
 * A plan is deactivated, not deleted, because every payment ever recorded on it
 * references it: deleting one would orphan the record of money that actually
 * changed hands. There is deliberately NO delete action anywhere in this
 * codebase, and a test fails if one appears. A deactivated plan disappears from
 * every picker (`listSelectablePlans`) and from `recordPayment` for NEW
 * payments, and stays fully readable on every past record.
 *
 * Gate: ADMIN (the owner, every academy) or DIRECTOR (their own location's
 * academies — `isAcademyInTenantScope`, so a location director manages exactly
 * the plans of the academies they run). Every write re-reads the plan from the
 * database and re-checks its academy against the session: a client-submitted
 * `planId` or `academyId` is never trusted as already in scope.
 */

const STAFF = ["ADMIN", "DIRECTOR"] as const;

/** `decimal(10,2)` holds up to 99,999,999.99. */
const MAX_AMOUNT = 99_999_999.99;

const planFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).optional(),
  defaultAmount: z.string().trim().optional(),
});

/** Blank = "no standard price"; anything else must be a non-negative amount. */
function parseDefaultAmount(raw: string | undefined): number | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) return "invalid";
  return Math.round(amount * 100) / 100;
}

function planSnapshot(plan: { name: string; description: string | null; defaultAmount: Prisma.Decimal | null; active: boolean }) {
  return {
    name: plan.name,
    description: plan.description,
    // A Prisma Decimal, converted so it serializes as an ordinary JSON number.
    defaultAmount: plan.defaultAmount?.toNumber() ?? null,
    active: plan.active,
  };
}

async function refreshPlanPages(): Promise<void> {
  // Best-effort, same shape as recordPayment: revalidatePath needs a real
  // request-scoped store that a direct test call doesn't have, and the write
  // has already committed.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments`);
    revalidatePath(`/${locale}/payments/plans`);
  } catch (error) {
    console.error("[plan-actions] failed to revalidate", { error });
  }
}

export async function createPlan(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, [...STAFF]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const academyId = formData.get("academyId");
  if (typeof academyId !== "string" || !isAcademyInTenantScope(context, academyId)) {
    return { error: "notFound" };
  }

  const parsed = planFieldsSchema.safeParse({
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? undefined,
    defaultAmount: formData.get("defaultAmount") ?? undefined,
  });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  const defaultAmount = parseDefaultAmount(parsed.data.defaultAmount);
  if (defaultAmount === "invalid") return { error: "invalid", fieldErrors: { defaultAmount: ["invalid"] } };

  // The academy must belong to THIS organization — scope alone says the session
  // may act on it, this says the row is real and in the right tenant.
  const academy = await prisma.academy.findUnique({ where: { id: academyId, organizationId: context.organizationId }, select: { id: true } });
  if (!academy) return { error: "notFound" };

  if (parsed.data.name === CUSTOM_PROMO_PLAN_NAME) return { error: "systemPlan" };

  // A name is unique per academy, INCLUDING deactivated plans. Say so — and if
  // it is a deactivated one, point at reactivating it instead of a bare error.
  const clash = await prisma.paymentPlan.findUnique({
    where: { academyId_name: { academyId, name: parsed.data.name }, organizationId: context.organizationId },
    select: { active: true },
  });
  if (clash) return { error: clash.active ? "nameTaken" : "nameTakenInactive" };

  try {
    await prisma.$transaction(async (tx) => {
      const plan = await tx.paymentPlan.create({
        data: {
          academyId,
          organizationId: context.organizationId,
          name: parsed.data.name,
          description: parsed.data.description || null,
          defaultAmount,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId,
          action: "paymentPlan.create",
          entityType: "PaymentPlan",
          entityId: plan.id,
          before: Prisma.DbNull,
          after: planSnapshot(plan),
        },
      });
    });
  } catch (error) {
    // A concurrent create with the same name lost the race to the unique constraint.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { error: "nameTaken" };
    throw error;
  }

  await refreshPlanPages();
  return { ok: true };
}

export async function updatePlan(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, [...STAFF]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const planId = formData.get("planId");
  if (typeof planId !== "string") return { error: "notFound" };

  const existing = await prisma.paymentPlan.findUnique({ where: { id: planId, organizationId: context.organizationId } });
  if (!existing || !isAcademyInTenantScope(context, existing.academyId)) return { error: "notFound" };
  // The promo plan is system-managed: every Pagos render upserts it by name, so
  // renaming or hiding it would break the custom-promotion flow.
  if (existing.name === CUSTOM_PROMO_PLAN_NAME) return { error: "systemPlan" };

  const parsed = planFieldsSchema.safeParse({
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? undefined,
    defaultAmount: formData.get("defaultAmount") ?? undefined,
  });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  const defaultAmount = parseDefaultAmount(parsed.data.defaultAmount);
  if (defaultAmount === "invalid") return { error: "invalid", fieldErrors: { defaultAmount: ["invalid"] } };

  if (parsed.data.name === CUSTOM_PROMO_PLAN_NAME) return { error: "systemPlan" };
  if (parsed.data.name !== existing.name) {
    const clash = await prisma.paymentPlan.findUnique({
      where: { academyId_name: { academyId: existing.academyId, name: parsed.data.name }, organizationId: context.organizationId },
      select: { active: true },
    });
    if (clash) return { error: clash.active ? "nameTaken" : "nameTakenInactive" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const plan = await tx.paymentPlan.update({
        where: { id: existing.id, organizationId: context.organizationId },
        data: { name: parsed.data.name, description: parsed.data.description || null, defaultAmount },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: existing.academyId,
          action: "paymentPlan.update",
          entityType: "PaymentPlan",
          entityId: plan.id,
          before: planSnapshot(existing),
          after: planSnapshot(plan),
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { error: "nameTaken" };
    throw error;
  }

  await refreshPlanPages();
  return { ok: true };
}

/**
 * Deactivate or reactivate — the ONLY way a plan leaves circulation. Neither
 * touches a single payment already recorded on the plan.
 */
async function setPlanActive(organizationId: string, planId: string, active: boolean): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, [...STAFF]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const existing = await prisma.paymentPlan.findUnique({ where: { id: planId, organizationId: context.organizationId } });
  if (!existing || !isAcademyInTenantScope(context, existing.academyId)) return { error: "notFound" };
  if (existing.name === CUSTOM_PROMO_PLAN_NAME) return { error: "systemPlan" };
  if (existing.active === active) return { ok: true };

  if (!active) {
    // An academy with no active plan can't record a single payment. Count the
    // OTHER active plans — the system promo plan doesn't count, it can't
    // stand in for an ordinary monthly plan.
    const otherActive = await prisma.paymentPlan.count({
      where: {
        organizationId: context.organizationId,
        academyId: existing.academyId,
        active: true,
        id: { not: existing.id },
        NOT: { name: CUSTOM_PROMO_PLAN_NAME },
      },
    });
    if (otherActive === 0) return { error: "lastActivePlan" };
  }

  await prisma.$transaction(async (tx) => {
    const plan = await tx.paymentPlan.update({ where: { id: existing.id, organizationId: context.organizationId }, data: { active } });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: existing.academyId,
        action: active ? "paymentPlan.reactivate" : "paymentPlan.deactivate",
        entityType: "PaymentPlan",
        entityId: plan.id,
        before: planSnapshot(existing),
        after: planSnapshot(plan),
      },
    });
  });

  await refreshPlanPages();
  return { ok: true };
}

export async function deactivatePlan(organizationId: string, planId: string): Promise<ActionState> {
  return setPlanActive(organizationId, planId, false);
}

export async function reactivatePlan(organizationId: string, planId: string): Promise<ActionState> {
  return setPlanActive(organizationId, planId, true);
}

const currencySchema = z.object({ currency: z.enum(CURRENCIES) });

/**
 * The organization's currency — OWNER only (ADMIN). One per organization, like
 * timezone. Changing it NEVER rewrites history: every recorded payment carries
 * its own `PaymentPeriod.currency` snapshot, so past amounts keep the currency
 * they were recorded in. Plan default amounts are bare numbers and are NOT
 * converted — the form says so, and a plan's default is just a suggestion the
 * director edits per payment anyway.
 */
export async function changeOrganizationCurrency(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = currencySchema.safeParse({ currency: formData.get("currency") });
  if (!parsed.success) return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };

  const before = await prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { currency: true } });
  if (before.currency === parsed.data.currency) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: context.organizationId }, data: { currency: parsed.data.currency } });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        action: "organization.currencyChange",
        entityType: "Organization",
        entityId: context.organizationId,
        before: { currency: before.currency },
        after: { currency: parsed.data.currency },
      },
    });
  });

  await refreshPlanPages();
  return { ok: true };
}
