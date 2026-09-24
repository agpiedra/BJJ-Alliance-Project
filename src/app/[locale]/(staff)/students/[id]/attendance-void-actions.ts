"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

const voidSchema = z.object({
  recordId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});

class AlreadyVoidedError extends Error {}

/**
 * Invalidates ONE mistaken attendance entry - a tap for the wrong student, a day recorded by mistake, a
 * class that never happened (docs/PROMOTION_PROGRESS_PROPOSAL.md). "No arbitrary credit" never meant "a
 * mistaken entry cannot be corrected", so this is the correction path, and it is deliberately narrow:
 *
 *  - ADMIN/DIRECTOR only (wider than the instructor-level entry of attendance, because it removes
 *    progress), scoped to the entry's own academy, a reason is required, and it is audited.
 *  - The row is NEVER deleted and never edited beyond the void marker: it stays in the history with who,
 *    when and why. There is no number to type, so it cannot become a progress balance.
 *  - The student's daily contribution is DERIVED from the rows, so voiding recomputes it correctly: if
 *    another valid entry exists that day, that entry becomes the day's contribution; if none, the day
 *    stops counting.
 *  - It never touches a promotion or the student's rank. Voiding an entry that made a student eligible
 *    does not revoke an award already written; a coach explicitly corrects an award if it was wrong.
 */
export async function voidAttendanceEntry(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = voidSchema.safeParse({
    recordId: formData.get("recordId") ?? undefined,
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const record = await getScopedDb(context).attendanceRecord.findUnique({
    where: { id: data.recordId },
    select: { id: true, academyId: true, studentId: true, organizationId: true, type: true, date: true, voidedAt: true },
  });
  if (!record || !isAcademyInTenantScope(context, record.academyId)) {
    return { error: "notFound" };
  }
  if (record.voidedAt) return { error: "alreadyVoided" };

  try {
    await prisma.$transaction(async (tx) => {
      // Guarded by "not yet voided" so two coaches voiding the same entry cannot both write an audit row.
      const result = await tx.attendanceRecord.updateMany({
        where: { id: record.id, organizationId: record.organizationId, voidedAt: null },
        data: { voidedAt: new Date(), voidedById: context.actorUserId, voidReason: data.reason },
      });
      if (result.count !== 1) throw new AlreadyVoidedError();

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: record.academyId,
          action: "attendance.void",
          entityType: "AttendanceRecord",
          entityId: record.id,
          before: { voided: false },
          after: {
            voided: true,
            reason: data.reason,
            studentId: record.studentId,
            entryType: record.type,
            day: record.date.toISOString().slice(0, 10),
          },
        },
      });
    });
  } catch (error) {
    if (error instanceof AlreadyVoidedError) return { error: "alreadyVoided" };
    throw error;
  }

  await refreshPromotionPages(record.studentId);
  return { ok: true };
}
