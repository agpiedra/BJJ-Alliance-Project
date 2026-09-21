"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { PaymentMethod, PaymentStatus, Prisma } from "@/generated/prisma/client";
import { CUSTOM_PROMO_PLAN_NAMES, isCustomPromoPlanName } from "@/lib/payments/custom-promo-plan-name";
import { ALL_DEFAULT_PLAN_NAMES } from "@/lib/payments/default-plan-name";
import { currentCrDateParts } from "@/lib/payments/get-current-period";
import { isPeriodMoreThanOneMonthInFuture } from "@/lib/payments/period-window";
import type { ActionState } from "@/lib/action-state";

const recordPaymentSchema = z.object({
  studentId: z.string().min(1),
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  planId: z.string().min(1),
  status: z.nativeEnum(PaymentStatus),
  amount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  // REDESIGN_BRIEF.md Phase 6 additions. `method` is a genuinely optional
  // enum (not every recorded period has a payment method — a custom
  // promotion may waive the charge entirely). `promoRecurring` is a
  // checkbox: an unchecked box is simply ABSENT from FormData (never
  // `"off"`), so `z.coerce.boolean()` only ever sees `"on"` (-> true) or
  // nothing at all (`.optional()` -> undefined, treated as false below) —
  // same absent-vs-present discipline `amount`/`notes` already established.
  method: z.nativeEnum(PaymentMethod).optional(),
  promoName: z.string().optional(),
  promoReason: z.string().optional(),
  promoRecurring: z.coerce.boolean().optional(),
});

/**
 * ADMIN/DIRECTOR only — narrower than `addAttendanceAdjustment`'s
 * ADMIN/DIRECTOR/INSTRUCTOR, per this task's brief: recording payments is
 * not an INSTRUCTOR-level action. REDESIGN_BRIEF.md Phase 6 keeps this gate
 * exactly as it was (an INSTRUCTOR who now reaches the new `/payments` route
 * for read-only viewing still cannot call this action at all, for a
 * mensualidad OR a custom promotion — there is no separate, looser write
 * path for ordinary payments on that page).
 *
 * Same independent re-fetch-and-check-scope discipline as every other write
 * in this codebase: `studentId` is a client-submitted hidden field, so the
 * student's real `homeAcademyId` is re-read from the DB and re-checked
 * against the session before anything is written — the `PaymentPeriod
 * .academyId` below is that freshly-read value, never a client-submitted
 * one. `planId` is likewise re-fetched and its `academyId` cross-checked
 * against the student's `homeAcademyId` (never trusted as already scoped to
 * the right academy just because the caller is in scope for SOME academy).
 *
 * Recording twice for the same student/year/month (e.g. correcting a
 * mistake, or moving PENDING -> PAID) updates the SAME row via the
 * `@@unique([studentId, year, month])` constraint (Prisma's generated
 * `studentId_year_month` compound-unique input) rather than creating a
 * second one — `upsert` is a natural fit since there is at most one row per
 * student/year/month by construction.
 *
 * The prior row (if any) is read inside the SAME transaction as the
 * `upsert`/`AuditLog` write so the `before` snapshot and the write are
 * atomic — no window for a concurrent recording to land between the read
 * and the write and produce a misleading audit trail.
 */
export async function recordPayment(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = recordPaymentSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  if (isPeriodMoreThanOneMonthInFuture({ year: data.year, month: data.month }, currentCrDateParts())) {
    return { error: "periodTooFarInFuture" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const plan = await prisma.paymentPlan.findUnique({
    where: { id: data.planId, organizationId: student.organizationId },
    select: { id: true, academyId: true, name: true, active: true },
  });

  if (!plan || plan.academyId !== student.homeAcademyId) {
    return { error: "invalidPlan" };
  }

  // Custom-promo validation (§6.3): a promo name is required for this plan.
  // This is a plan-NAME check, not a role check — the role gate above
  // (ADMIN/DIRECTOR only, the whole action) already keeps an INSTRUCTOR from
  // reaching this line at all, promo or not, so no separate role re-check is
  // needed here specifically for the promo path.
  if (isCustomPromoPlanName(plan.name) && !data.promoName?.trim()) {
    return { error: "promoNameRequired", fieldErrors: { promoName: ["promoNameRequired"] } };
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.paymentPeriod.findUnique({
      where: {
        studentId_year_month: { studentId: student.id, year: data.year, month: data.month },
        organizationId: student.organizationId,
      },
      select: {
        status: true,
        planId: true,
        amount: true,
        currency: true,
        method: true,
        promoName: true,
        promoReason: true,
        promoRecurring: true,
      },
    });

    // A DEACTIVATED plan is gone from every picker, so it must not be
    // recordable either — a stale form or a hand-built request could otherwise
    // put a new payment on it. The one exception is a period that ALREADY sits
    // on that plan: correcting its notes/status must keep working (history is
    // never orphaned), which is exactly "the plan isn't changing". Checked
    // here, next to the `existing` read, so it sees the same row the write does.
    if (!plan.active && existing?.planId !== plan.id) {
      return { rejected: "planInactive" as const };
    }

    // Read in the SAME transaction as the write. Only used when this call
    // CREATES the row: the currency is a snapshot taken at the moment of
    // recording, so correcting an existing row (the `update` below) deliberately
    // leaves whatever currency it was recorded in untouched.
    const { currency: organizationCurrency } = await tx.organization.findUniqueOrThrow({
      where: { id: student.organizationId },
      select: { currency: true },
    });

    const period = await tx.paymentPeriod.upsert({
      where: { studentId_year_month: { studentId: student.id, year: data.year, month: data.month } },
      create: {
        studentId: student.id,
        academyId: student.homeAcademyId,
        organizationId: student.organizationId,
        year: data.year,
        month: data.month,
        planId: data.planId,
        status: data.status,
        amount: data.amount,
        currency: organizationCurrency,
        notes: data.notes,
        method: data.method,
        promoName: data.promoName,
        promoReason: data.promoReason,
        promoRecurring: data.promoRecurring ?? false,
        recordedById: context.actorUserId,
      },
      // `data.amount`/`data.notes`/etc. being `undefined` here means the
      // director left the field blank on the form: the form either submits
      // a real value or strips the key entirely, so an absent key is never
      // ambiguous. For `create` above, plain `undefined` is already correct
      // — Prisma writes `null` for a field omitted from a `create` payload.
      // But `update` treats `undefined` as "leave this column at whatever it
      // already holds," NOT "clear it" — so passing these fields straight
      // through here would let a blank field on a CORRECTION silently retain
      // the PREVIOUS payment's stale value instead of clearing it (the same
      // bug this action's `amount`/`notes` fields were already fixed for —
      // see git history). `?? null` makes a blank field on an UPDATE
      // explicitly clear the column, matching what a director leaving it
      // blank actually intends. `promoRecurring` is boolean (not nullable in
      // the schema), so its "cleared" value is `false`, not `null`.
      update: {
        planId: data.planId,
        status: data.status,
        amount: data.amount ?? null,
        notes: data.notes ?? null,
        method: data.method ?? null,
        promoName: data.promoName ?? null,
        promoReason: data.promoReason ?? null,
        promoRecurring: data.promoRecurring ?? false,
        recordedById: context.actorUserId,
        recordedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: student.homeAcademyId,
        action: "payment.record",
        entityType: "PaymentPeriod",
        entityId: period.id,
        // `amount` is a Prisma `Decimal` instance here, not a plain number —
        // converted to a JS number before landing in a `Json` column so it
        // serializes as an ordinary JSON number rather than risking however
        // decimal.js's own `toJSON()` happens to stringify it.
        before: existing
          ? {
              status: existing.status,
              planId: existing.planId,
              amount: existing.amount?.toNumber() ?? null,
              currency: existing.currency,
              method: existing.method,
              promoName: existing.promoName,
              promoReason: existing.promoReason,
              promoRecurring: existing.promoRecurring,
            }
          : Prisma.DbNull,
        after: {
          status: period.status,
          planId: period.planId,
          amount: period.amount?.toNumber() ?? null,
          currency: period.currency,
          method: period.method,
          promoName: period.promoName,
          promoReason: period.promoReason,
          promoRecurring: period.promoRecurring,
        },
      },
    });

    return period;
  });

  // The transaction bailed out before writing anything: the plan is
  // deactivated and this call would have put a new payment on it.
  if ("rejected" in result) {
    return { error: result.rejected };
  }

  // Without this, the payment-history table / Pagos "Estado del mes" table
  // rendered on a SAME-navigation page (both plain Server Components read at
  // page-load time) would keep showing the pre-recording data until a manual
  // reload, even though this form's own success message already says
  // "Payment recorded." Same best-effort try/catch shape as
  // `self-check-in-action.ts`, required for the identical reason:
  // `revalidatePath` needs a real Next.js request-scoped store that isn't
  // present when this action is called directly outside that machinery, as
  // `tests/integration/payment-actions.test.ts` does. The write above
  // already committed; losing the cache-invalidation signal in that one
  // calling context must not fail the whole action.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/students/${data.studentId}`);
    revalidatePath(`/${locale}/payments`);
  } catch (error) {
    console.error("[record-payment] failed to revalidate", { error });
  }

  return { ok: true };
}

/**
 * Pagos "Estado del mes" table's inline `Marcar pagado` action (§6.3) — a
 * thin wrapper around `recordPayment` rather than a second write
 * implementation: it resolves the FormData `recordPayment` needs (reusing
 * the row's own existing plan/amount/notes/method if a `PaymentPeriod`
 * already exists for this student/month, e.g. flipping PENDING -> PAID)
 * and calls the SAME action, so the upsert, audit trail, role gate, and
 * scope check all stay in exactly one place.
 *
 * When there is genuinely no row yet for this student/month (the row was
 * "Atrasado" purely because nothing was ever recorded), there is no prior
 * plan to reuse — this falls back to the academy's plan literally named
 * "Mensualidad" (the overwhelmingly common case in this app's seed data and
 * real usage), then to whatever active plan (excluding the custom-promo
 * bucket) sorts first by name.
 * ponytail: a real "default plan" flag on `PaymentPlan` would replace this
 * heuristic if it ever picks the wrong plan for an academy's makeup —
 * cheap to add later, not worth it for a single quick-mark button today.
 */
export async function markPaymentPaid(
  organizationId: string,
  studentId: string,
  year: number,
  month: number,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const student = await getScopedDb(context).student.findUnique({
    where: { id: studentId },
    select: { id: true, homeAcademyId: true, organizationId: true },
  });
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const existing = await prisma.paymentPeriod.findUnique({
    where: {
      studentId_year_month: { studentId, year, month },
      organizationId: student.organizationId,
    },
    select: {
      planId: true,
      amount: true,
      notes: true,
      method: true,
      promoName: true,
      promoReason: true,
      promoRecurring: true,
    },
  });

  let planId = existing?.planId ?? null;
  if (!planId) {
    const mensualidad = await prisma.paymentPlan.findFirst({
      // The academy's ordinary monthly plan, whichever language it was seeded
      // in ("Mensualidad" / "Monthly" — see default-plan-name.ts).
      where: {
        organizationId: student.organizationId,
        academyId: student.homeAcademyId,
        name: { in: [...ALL_DEFAULT_PLAN_NAMES] },
        active: true,
      },
      select: { id: true },
    });
    planId =
      mensualidad?.id ??
      (
        await prisma.paymentPlan.findFirst({
          where: {
            organizationId: student.organizationId,
            academyId: student.homeAcademyId,
            active: true,
            NOT: { name: { in: [...CUSTOM_PROMO_PLAN_NAMES] } },
          },
          orderBy: { name: "asc" },
          select: { id: true },
        })
      )?.id ??
      null;
  }
  if (!planId) {
    return { error: "invalidPlan" };
  }

  const fd = new FormData();
  fd.set("studentId", studentId);
  fd.set("year", String(year));
  fd.set("month", String(month));
  fd.set("planId", planId);
  fd.set("status", PaymentStatus.PAID);
  if (existing?.amount != null) fd.set("amount", existing.amount.toString());
  if (existing?.notes) fd.set("notes", existing.notes);
  if (existing?.method) fd.set("method", existing.method);
  // A custom-promo row (`isCustomPromoPlanName(plan.name)`) fails
  // `recordPayment`'s own "promo name required" guard unless these three are
  // forwarded too — a PENDING/OVERDUE promo row's ONLY working action in the
  // table is this button (Editar is offered only for the PROMO_OR_EXEMPT
  // bucket), so omitting them made every such row's "Marcar pagado" silently
  // unusable. `promoRecurring` must be forwarded as well, not just the name:
  // leaving it out would submit an implicit "false" and silently cancel the
  // recurrence as a side effect of just marking a month paid.
  if (existing?.promoName) fd.set("promoName", existing.promoName);
  if (existing?.promoReason) fd.set("promoReason", existing.promoReason);
  if (existing?.promoRecurring) fd.set("promoRecurring", "on");

  return recordPayment(organizationId, {}, fd);
}
