"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { CREDIT_DELTA_LIMIT } from "@/lib/promotion/credit";
import { Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const creditAdjustmentSchema = z.object({
  studentId: z.string().min(1),
  delta: z.coerce
    .number()
    .int()
    .min(-CREDIT_DELTA_LIMIT)
    .max(CREDIT_DELTA_LIMIT)
    .refine((n) => n !== 0),
  reason: z.string().min(1),
});

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d point 4: "Correctable through the
 * existing correction path, not a bespoke one." This IS that reuse — same
 * shape as adjustment-actions.ts's `addAttendanceAdjustment` (signed delta,
 * required reason, ADMIN/DIRECTOR/INSTRUCTOR gate, one interactive
 * transaction with an AuditLog row) — deliberately NOT a mutation of a prior
 * PromotionCredit row: a correction is a NEW row with a signed delta, same
 * append-only philosophy as AttendanceRecord's own ADJUSTMENT ledger, so the
 * original estimate and every fix to it both stay permanently visible.
 *
 * Always anchors the new row to the student's CURRENT `beltAwardedAt`, read
 * fresh here — never trusted from a client payload, and never the anchor of
 * an old, already-superseded belt period: that history is immutable, only
 * the active period's credit is ever correctable.
 */
export async function adjustPromotionCredit(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = creditAdjustmentSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const student = await getScopedDb(context).student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, beltAwardedAt: true },
  });
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }
  if (student.status === StudentStatus.ARCHIVED) {
    return { error: "archived" };
  }

  await prisma.$transaction(async (tx) => {
    const record = await tx.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: student.homeAcademyId,
        organizationId: student.organizationId,
        beltAwardedAtAnchor: student.beltAwardedAt,
        classesGranted: data.delta,
        reason: data.reason,
        grantedById: context.actorUserId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        academyId: student.homeAcademyId,
        action: "promotionCredit.correct",
        entityType: "PromotionCredit",
        entityId: record.id,
        before: Prisma.DbNull,
        after: { delta: data.delta, reason: data.reason },
      },
    });
  });

  return { ok: true };
}
