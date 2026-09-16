"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { reassignAttendance } from "@/lib/kiosk/reassign-attendance";
import { AttendanceMatchSource } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({
  attendanceRecordId: z.string().min(1),
  classSessionId: z.string().min(1),
});

/**
 * The Kiosco page's `Marcajes de hoy` -> `Cambiar` action (REDESIGN_BRIEF.md
 * Phase 9: "an instructor can move an attendance to another class that day").
 *
 * Gated ADMIN/DIRECTOR/INSTRUCTOR per that sentence — deliberately LOOSER than
 * the page it lives on (ADMIN/DIRECTOR), because the brief names the role for
 * this action specifically. No nav path takes an INSTRUCTOR to this page
 * today; that's fine and out of scope to add.
 *
 * Same re-fetch-and-re-check discipline as every other write here: the
 * record's real `academyId` is read from the DB and checked against the
 * caller's scope before anything is written, and `reassignAttendance` itself
 * independently re-validates that the target class belongs to that same
 * academy and that same weekday.
 */
export async function reassignAttendanceRecord(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const record = await getScopedDb(context).attendanceRecord.findUnique({
    where: { id: parsed.data.attendanceRecordId },
    select: { academyId: true, organizationId: true },
  });

  if (!record || !isAcademyInTenantScope(context, record.academyId)) {
    return { error: "notFound" };
  }

  const result = await reassignAttendance(parsed.data.attendanceRecordId, parsed.data.classSessionId, {
    actorUserId: context.actorUserId,
    matchSource: AttendanceMatchSource.STAFF_CORRECTED,
    expectedAcademyId: record.academyId,
    context,
  });

  if (!result.ok) {
    return { error: result.error };
  }

  // Without this the Marcajes table (a plain Server Component read at page
  // load) keeps showing the old class until a manual reload. Best-effort
  // try/catch for the same reason as `payment-actions.ts`: `revalidatePath`
  // needs a real Next.js request-scoped store, which isn't present when an
  // integration test calls this exported function directly. The write already
  // committed; losing the cache signal must not fail the action.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/admin/kiosk-tokens`);
  } catch (error) {
    console.error("[reassign-attendance] failed to revalidate", { error });
  }

  return { ok: true };
}
