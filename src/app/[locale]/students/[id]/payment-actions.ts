"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { PaymentStatus, Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const recordPaymentSchema = z.object({
  studentId: z.string().min(1),
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  planId: z.string().min(1),
  status: z.nativeEnum(PaymentStatus),
  amount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
});

/**
 * ADMIN/DIRECTOR only — narrower than `addAttendanceAdjustment`'s
 * ADMIN/DIRECTOR/INSTRUCTOR, per this task's brief: recording payments is
 * not an INSTRUCTOR-level action.
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
export async function recordPayment(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const parsed = recordPaymentSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const plan = await prisma.paymentPlan.findUnique({
    where: { id: data.planId },
    select: { id: true, academyId: true },
  });

  if (!plan || plan.academyId !== student.homeAcademyId) {
    return { error: "invalidPlan" };
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId: student.id, year: data.year, month: data.month } },
      select: { id: true, status: true, planId: true, amount: true },
    });

    const period = await tx.paymentPeriod.upsert({
      where: { studentId_year_month: { studentId: student.id, year: data.year, month: data.month } },
      create: {
        studentId: student.id,
        academyId: student.homeAcademyId,
        year: data.year,
        month: data.month,
        planId: data.planId,
        status: data.status,
        amount: data.amount,
        notes: data.notes,
        recordedById: session.userId,
      },
      update: {
        planId: data.planId,
        status: data.status,
        amount: data.amount,
        notes: data.notes,
        recordedById: session.userId,
        recordedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: student.homeAcademyId,
        action: "payment.record",
        entityType: "PaymentPeriod",
        entityId: period.id,
        // `amount` is a Prisma `Decimal` instance here, not a plain number —
        // converted to a JS number before landing in a `Json` column so it
        // serializes as an ordinary JSON number rather than risking however
        // decimal.js's own `toJSON()` happens to stringify it.
        before: existing
          ? { status: existing.status, planId: existing.planId, amount: existing.amount?.toNumber() ?? null }
          : Prisma.DbNull,
        after: { status: period.status, planId: period.planId, amount: period.amount?.toNumber() ?? null },
      },
    });

    return period;
  });

  void result;

  return { ok: true };
}
