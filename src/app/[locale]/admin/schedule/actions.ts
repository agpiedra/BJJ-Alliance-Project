"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireStaffSession } from "@/lib/auth/session";
import { DayOfWeek, ClassType, Prisma } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

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
 * scoped to one DIRECTOR's own assignment — so there is no `isAcademyInScope`
 * check here, only a fresh `findUniqueOrThrow` re-validating the
 * client-submitted `academyId` names a real row before anything is written.
 *
 * The `@@unique([academyId, dayOfWeek, startTime, name])` constraint
 * (`prisma/schema.prisma`) is enforced at the DB layer; a violation surfaces
 * as Prisma error code P2002, caught below and turned into a friendly
 * `duplicateSlot` error rather than a 500.
 */
export async function createClassSession(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN"]);

  const parsed = createClassSessionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  let academy: { id: string };
  try {
    academy = await prisma.academy.findUniqueOrThrow({
      where: { id: data.academyId },
      select: { id: true },
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
        data: { academyId: academy.id, ...after },
      });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
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
export async function updateClassSession(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN"]);

  const parsed = updateClassSessionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  let existing: {
    id: string;
    academyId: string;
    dayOfWeek: DayOfWeek;
    startTime: string;
    durationMinutes: number;
    name: string;
    type: ClassType;
    countsTowardPromotion: boolean;
  };
  try {
    existing = await prisma.classSession.findUniqueOrThrow({
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
        where: { id: existing.id },
        data: after,
      });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
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
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN"]);

  const parsed = classSessionIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  let existing: { id: string; academyId: string; active: boolean };
  try {
    existing = await prisma.classSession.findUniqueOrThrow({
      where: { id: parsed.data.classSessionId },
      select: { id: true, academyId: true, active: true },
    });
  } catch {
    return { error: "notFound" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.classSession.update({
      where: { id: existing.id },
      data: { active: false },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: existing.academyId,
        action: "classSession.deactivate",
        entityType: "ClassSession",
        entityId: existing.id,
        before: { active: existing.active },
        after: { active: false },
      },
    });
  });

  return { ok: true };
}
