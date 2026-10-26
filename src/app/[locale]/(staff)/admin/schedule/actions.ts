"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { DayOfWeek, ClassType, Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import { isNotFoundError, isUniqueConstraintError } from "@/lib/prisma-errors";

// "HH:mm", 24h — the exact wall-clock shape `getCheckInWindow`
// (src/lib/scheduling/check-in-window.ts) already parses via
// `startTime.split(":").map(Number)`. A browser <input type="time"> submits
// exactly this shape with no seconds component.
const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

const baseFields = {
  dayOfWeek: z.nativeEnum(DayOfWeek),
  startTime: z.string().regex(TIME_FORMAT),
  durationMinutes: z.coerce.number().int().min(1).max(600),
  name: z.string().min(1),
  type: z.nativeEnum(ClassType),
  // A native checkbox's FormData entry is absent entirely when unchecked, so
  // this is deliberately a required <select> of "true"/"false" strings
  // (never a checkbox) — an absent field would otherwise be indistinguishable
  // from "not submitted at all" and fail `required`-less validation silently.
  countsTowardPromotion: z.enum(["true", "false"]).transform((v) => v === "true"),
};

const createClassSessionSchema = z.object({
  academyId: z.string().min(1),
  ...baseFields,
});

const updateClassSessionSchema = z.object({
  classSessionId: z.string().min(1),
  ...baseFields,
});

const classSessionIdSchema = z.object({ classSessionId: z.string().min(1) });

/**
 * ADMIN-only (spec §5: class-schedule structure is academy policy, not a
 * DIRECTOR power — DIRECTOR's grants per spec §3's role table cover
 * payments/promotions, not the schedule itself). Same global-academy-resource
 * shape as `admin/kiosk-tokens/actions.ts`'s `regenerateKioskToken`: this
 * manages a shared resource ADMIN can reach for either academy, not something
 * scoped to one DIRECTOR's own assignment — so there is no `isAcademyInTenantScope`
 * check here, only a fresh `findUniqueOrThrow` re-validating the
 * client-submitted `academyId` names a real row before anything is written.
 *
 * The `@@unique([academyId, dayOfWeek, startTime, name])` constraint
 * (`prisma/schema.prisma`) is enforced at the DB layer; a violation surfaces
 * as Prisma error code P2002, caught below and turned into a friendly
 * `duplicateSlot` error rather than a 500.
 */
export async function createClassSession(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = createClassSessionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  // Never trust a client-submitted academy id, even from ADMIN — this
  // manages a shared resource ADMIN can reach for any academy IN THEIR OWN
  // ORGANIZATION, never another tenant's, just by knowing/guessing its id.
  // `getScopedDb` enforces that structurally: a cross-organization id throws
  // (caught below), never resolves.
  let academy: { id: string; organizationId: string };
  try {
    academy = await getScopedDb(context).academy.findUniqueOrThrow({
      where: { id: data.academyId },
      select: { id: true, organizationId: true },
    });
  } catch {
    return { error: "notFound" };
  }

  const after = {
    dayOfWeek: data.dayOfWeek,
    startTime: data.startTime,
    durationMinutes: data.durationMinutes,
    name: data.name,
    type: data.type,
    countsTowardPromotion: data.countsTowardPromotion,
  };

  try {
    // The row and its audit entry are written in the SAME interactive
    // transaction, matching every other write in this codebase, so an audit
    // row can never exist without the session it describes.
    await prisma.$transaction(async (tx) => {
      const created = await tx.classSession.create({
        data: { academyId: academy.id, organizationId: academy.organizationId, ...after },
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: academy.id,
          action: "classSession.create",
          entityType: "ClassSession",
          entityId: created.id,
          before: Prisma.DbNull,
          after,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { error: "duplicateSlot" };
    }
    throw error;
  }

  return { ok: true };
}

/**
 * ADMIN-only, same reasoning as `createClassSession`. `academyId` is
 * deliberately NOT part of the editable payload — moving a session to a
 * different academy isn't a feature this task builds, so the row's real,
 * freshly-read `academyId` (never a client-submitted one) is what both the
 * `AuditLog` row and the unique-constraint check below actually use.
 */
export async function updateClassSession(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = updateClassSessionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  // Never trust a client-submitted classSessionId, even from ADMIN — an
  // ADMIN of one organization must not be able to edit another tenant's
  // schedule just by knowing/guessing an id. `getScopedDb` enforces that
  // structurally: a cross-organization id throws (caught below).
  let existing: {
    id: string;
    academyId: string;
    organizationId: string;
    dayOfWeek: DayOfWeek;
    startTime: string;
    durationMinutes: number;
    name: string;
    type: ClassType;
    countsTowardPromotion: boolean;
  };
  try {
    existing = await getScopedDb(context).classSession.findUniqueOrThrow({
      where: { id: data.classSessionId },
    });
  } catch {
    return { error: "notFound" };
  }

  const after = {
    dayOfWeek: data.dayOfWeek,
    startTime: data.startTime,
    durationMinutes: data.durationMinutes,
    name: data.name,
    type: data.type,
    countsTowardPromotion: data.countsTowardPromotion,
  };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.classSession.update({
        where: { id: existing.id, organizationId: existing.organizationId },
        data: after,
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: existing.academyId,
          action: "classSession.update",
          entityType: "ClassSession",
          entityId: existing.id,
          before: {
            dayOfWeek: existing.dayOfWeek,
            startTime: existing.startTime,
            durationMinutes: existing.durationMinutes,
            name: existing.name,
            type: existing.type,
            countsTowardPromotion: existing.countsTowardPromotion,
          },
          after,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { error: "duplicateSlot" };
    }
    // Deleted (`deleteClassSession`) between the read above and this write: nothing was changed.
    if (isNotFoundError(error)) {
      return { error: "notFound" };
    }
    throw error;
  }

  return { ok: true };
}

/**
 * ADMIN-only. Flips `active` to false — never a `delete()` call, matching
 * every other "remove" action in this codebase (`archiveStudent`, etc.).
 * Existing `AttendanceRecord` rows keep their `classSessionId` foreign key
 * untouched, so a deactivated session's attendance history is unaffected.
 */
export async function deactivateClassSession(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = classSessionIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  // Never trust a client-submitted classSessionId, even from ADMIN — an
  // ADMIN of one organization must not be able to deactivate another
  // tenant's schedule just by knowing/guessing an id. `getScopedDb` enforces
  // that structurally: a cross-organization id throws (caught below).
  let existing: { id: string; academyId: string; organizationId: string; active: boolean };
  try {
    existing = await getScopedDb(context).classSession.findUniqueOrThrow({
      where: { id: parsed.data.classSessionId },
      select: { id: true, academyId: true, organizationId: true, active: true },
    });
  } catch {
    return { error: "notFound" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.classSession.update({
        where: { id: existing.id, organizationId: existing.organizationId },
        data: { active: false },
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: existing.academyId,
          action: "classSession.deactivate",
          entityType: "ClassSession",
          entityId: existing.id,
          before: { active: existing.active },
          after: { active: false },
        },
      });
    });
  } catch (error) {
    // Deleted (`deleteClassSession`) between the read above and this write: nothing was changed.
    if (isNotFoundError(error)) return { error: "notFound" };
    throw error;
  }

  return { ok: true };
}

/**
 * ADMIN-only. The ONE permanent removal of a class, and only of a class nothing refers to: it must already be inactive
 * (so no new check-in can pick it), have NO `AttendanceRecord` - voided rows included, they are still history - and no
 * PENDING `QueuedCheckIn` claiming it. Anything else keeps its row, so attendance history, promotion counts (which read
 * the class's `countsTowardPromotion` through a live join) and the audit trail are never touched.
 *
 * Race-safety: the class row is locked `FOR UPDATE` FIRST, and only then are the references counted.
 *  - An attendance insert holds a key-share lock on this row through its foreign key, so one in flight finishes before the
 *    lock is granted and is then counted; one that starts later waits and fails its foreign key once the row is gone.
 *  - A queued claim has no foreign key, so `performCheckIn` takes the same row `FOR SHARE` in the transaction that writes
 *    the claim: one in flight is counted here; one that starts after the delete finds no row and is kept verbatim as a
 *    claim of an unknown class - the same as any replay that arrives after its class was removed.
 */
export async function deleteClassSession(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = classSessionIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  // Same tenant re-validation as `deactivateClassSession`: a cross-organization id throws, never resolves.
  let existing: { id: string; organizationId: string };
  try {
    existing = await getScopedDb(context).classSession.findUniqueOrThrow({
      where: { id: parsed.data.classSessionId },
      select: { id: true, organizationId: true },
    });
  } catch {
    return { error: "notFound" };
  }

  const error = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ active: boolean }[]>`
      SELECT "active" FROM "ClassSession"
      WHERE "id" = ${existing.id} AND "organizationId" = ${existing.organizationId}
      FOR UPDATE`;
    if (!locked) return "notFound";
    if (locked.active) return "mustDeactivateFirst";

    const attendance = await tx.attendanceRecord.count({
      where: { organizationId: existing.organizationId, classSessionId: existing.id },
    });
    const pendingQueued = await tx.queuedCheckIn.count({
      where: { organizationId: existing.organizationId, claimedClassSessionId: existing.id, status: "PENDING" },
    });
    if (attendance > 0 || pendingQueued > 0) return "inUse";

    const deleted = await tx.classSession.delete({
      where: { id: existing.id, organizationId: existing.organizationId },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: deleted.academyId,
        action: "classSession.delete",
        entityType: "ClassSession",
        entityId: deleted.id,
        before: {
          dayOfWeek: deleted.dayOfWeek,
          startTime: deleted.startTime,
          durationMinutes: deleted.durationMinutes,
          name: deleted.name,
          type: deleted.type,
          countsTowardPromotion: deleted.countsTowardPromotion,
          active: deleted.active,
          createdAt: deleted.createdAt.toISOString(),
        },
        after: Prisma.DbNull,
      },
    });
    return null;
  });
  if (error) return { error };

  // Best-effort: `revalidatePath` needs a real Next.js request scope, absent when a test calls the action directly. The
  // delete has already committed.
  try {
    revalidatePath(`/${await getLocale()}/admin/schedule`);
  } catch {
    console.error("[schedule] failed to revalidate after delete");
  }
  return { ok: true };
}
