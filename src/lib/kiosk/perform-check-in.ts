import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { attendanceDateFromZoned, crDayOfWeek, toAttendanceDate } from "@/lib/scheduling/zone";
import { selectActiveSessionOccurrence } from "@/lib/scheduling/check-in-window";
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { notifyEligibilityReached } from "@/lib/notifications/notify-eligibility";
import { fireAndForget } from "@/lib/notifications/fire-and-forget";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext } from "@/lib/tenant/types";
import {
  AttendanceMatchSource,
  AttendanceType,
  StudentStatus,
  type AttendanceSource,
  type ClassType,
  type DayOfWeek,
} from "@/generated/prisma/client";

/** The class an attendance ended up attributed to, for the confirmation screen. */
export interface MatchedClass {
  id: string;
  name: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
}

/** One of "today's" classes, offered to the student when nothing auto-matched. */
export interface PicklistEntry {
  id: string;
  name: string;
  startTime: string;
  type: ClassType;
}

export type CheckInResult =
  | {
      ok: true;
      student: {
        firstName: string;
        lastName: string;
        currentBelt: string;
        currentBeltLabelEs: string;
        currentBeltLabelEn: string;
        currentBeltVisual: BeltVisualData;
        currentStripes: number;
      };
      summary: AtBeltSummary;
      earnedStripe: boolean;
      isVisitor: boolean;
      /** The checking-in student's home academy name — populated unconditionally
       * (not just for visitors), so the kiosk UI can render a visitor badge
       * ("Visitante de [homeAcademyName]") without a second round-trip. */
      homeAcademyName: string;
      /** The row just written — the kiosk's "¿No es esta clase?" link reassigns
       * exactly this record, so it must come back with the confirmation. */
      attendanceRecordId: string;
      /** null for an UNMATCHED save (no class to name on the confirmation). */
      matchedClass: MatchedClass | null;
    }
  | {
      ok: false;
      error: "invalid_code" | "no_active_class" | "already_checked_in";
      /** Present only on `no_active_class`, and only when that day HAS classes
       * to choose from — the kiosk renders these as buttons. A day with no
       * classes at all never reaches this shape: it auto-saves as UNMATCHED. */
      picklist?: PicklistEntry[];
    };

interface CommonInput {
  academyId: string;
  /**
   * 1f-3: the authority this check-in runs under, for `getScopedDb`'s
   * organization enforcement. The kiosk route constructs a `KioskContext`
   * from its verified device token; the portal's self-check-in action
   * passes its own already-resolved `TenantContext` (a student acting on
   * their own row). Kept separate from `academyId` rather than derived from
   * it — a `TenantContext` has no single concrete academy id of its own
   * (`academyIds` is a list-or-"ALL"), so the two can't collapse into one
   * field. Both real callers construct `academyId` and `context` from the
   * SAME already-verified source (the kiosk's own `academy` row; the
   * portal's own `context.selfStudentId`-verified student row), so they are
   * always consistent by construction.
   */
  context: AccessContext;
  source: AttendanceSource;
  now?: Date;
  /**
   * Set when the student already answered the picklist: which of today's
   * active classes to attribute the tap to. Never trusted — re-validated
   * against this academy's own active sessions for that CR weekday.
   */
  pickedClassSessionId?: string;
  /**
   * "Nobody is standing at the tablet to answer a picker." Set by the API
   * route for an OFFLINE REPLAY (a tap that was queued on the device and is
   * being flushed later — see src/lib/kiosk/offline-queue.ts).
   *
   * Ruling (the brief's prose doesn't cover this case): `flushOfflineQueue`
   * is a fire-and-forget background replay with no UI to render a picker
   * into, and its caller only learns a count of DROPPED entries. Returning a
   * picklist to it would therefore mean the tap is discarded outright —
   * which is exactly the "silently drop a tap" outcome Phase 9 exists to
   * remove. So a replay that matches no window is saved as UNMATCHED
   * instead, whether or not that day had classes, and surfaces on the
   * Kiosco page's "Marcajes de hoy" table where staff can `Cambiar` it to
   * the right class. Attendance preserved, provenance honest.
   */
  unattended?: boolean;
}

export type PerformCheckInInput =
  | (CommonInput & { code: string; studentId?: never })
  | (CommonInput & { studentId: string; code?: never });

export async function performCheckIn(input: PerformCheckInInput): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  // Presence check, not truthiness: a client-submitted `code: ""` is a valid
  // (if useless) member of the `code` variant of the discriminated union —
  // `input.code ? ... : ...` would misroute it into the `studentId` branch,
  // where `input.studentId` is `undefined`, and
  // `findUnique({ where: { id: undefined } })` throws instead of returning
  // the documented `invalid_code`. Checking for `undefined` preserves the
  // original behavior: an empty code hashes to a codeHash that matches no
  // student, so it falls through to the `!student` branch below.
  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1: "Resolve the branch from its
  // verified kiosk token, then derive its organization. Resolve student
  // codes within that organization." `input.academyId` is already the
  // token-verified branch by the time this function is called; organization
  // scope comes from `input.context.organizationId`, resolved by the caller
  // (route.ts's verified kiosk token, or the portal's own TenantContext).
  const db = getScopedDb(input.context);

  const student = input.code !== undefined
    ? await db.student.findUnique({
        where: {
          organizationId_codeHash: {
            organizationId: input.context.organizationId,
            codeHash: digestLookupSecret(input.code, requireEnv("CODE_PEPPER")),
          },
        },
        include: {
          homeAcademy: { select: { name: true } },
          currentRank: {
            select: {
              code: true,
              labelEs: true,
              labelEn: true,
              primaryColor: true,
              centerStripeColor: true,
              barColor: true,
              stripeColors: true,
              maxStripes: true,
              visibleStripeSlots: true,
            },
          },
        },
      })
    : await db.student.findUnique({
        where: { id: input.studentId },
        include: {
          homeAcademy: { select: { name: true } },
          currentRank: {
            select: {
              code: true,
              labelEs: true,
              labelEn: true,
              primaryColor: true,
              centerStripeColor: true,
              barColor: true,
              stripeColors: true,
              maxStripes: true,
              visibleStripeSlots: true,
            },
          },
        },
      });

  // Organization scope is enforced structurally by `getScopedDb` above for
  // BOTH paths — including the studentId path (picker-answer / offline
  // replay), which used to have no organization filter of its own and
  // relied on a manual compare here instead.
  if (!student || student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "invalid_code" };
  }

  const sessions = await db.classSession.findMany({
    where: { academyId: input.academyId, active: true },
  });

  // Deterministic: `findMany` returns rows in no guaranteed order, and
  // overlapping check-in windows are genuinely reachable (adjacent hourly
  // classes touch at their boundary; the admin schedule editor can create
  // real overlaps), so "whichever row came back first" could attribute the
  // same tap to different classes on identical requests.
  const occurrence = selectActiveSessionOccurrence(sessions, now);

  // What the row will be attributed to, resolved by one of three paths below.
  let classSession: MatchedClass | null;
  let attendanceDate: Date;
  let matchSource: AttendanceMatchSource;

  if (occurrence) {
    classSession = toMatchedClass(occurrence.session);
    // Stamped from the matched occurrence's OWN calendar day, never from
    // `now`'s. A window that straddles CR midnight would otherwise give two
    // check-ins to the same class occurrence two different `date` values,
    // slipping past the (studentId, classSessionId, date) unique constraint and
    // double-crediting one class — and a check-in just before midnight for a
    // just-after-midnight class would be filed under the wrong day entirely.
    // `occurredAt` stays the real wall-clock instant.
    attendanceDate = attendanceDateFromZoned(occurrence.anchorDate);
    matchSource = AttendanceMatchSource.AUTO;
  } else {
    // No window contains `now`. Everything from here is Phase 9's no-match
    // path: offer that day's classes, or save the tap unattributed — never
    // reject it outright, which used to lose the attendance entirely.
    //
    // "That day" is `now`'s own CR calendar day. Unlike the AUTO branch there
    // is no occurrence to anchor to, so there is nothing to straddle midnight:
    // a tap at 23:50 CR belongs to that day's schedule, full stop.
    const todaysSessions = await db.classSession.findMany({
      where: { academyId: input.academyId, active: true, dayOfWeek: crDayOfWeek(now) },
      orderBy: { startTime: "asc" },
    });

    // Never blind-trusted: a stale or tampered id that isn't one of THIS
    // academy's active classes for THIS weekday falls through to the picker
    // (or the UNMATCHED save) instead of being written or throwing.
    const picked = input.pickedClassSessionId
      ? todaysSessions.find((session) => session.id === input.pickedClassSessionId)
      : undefined;

    if (!picked && todaysSessions.length > 0 && !input.unattended) {
      return {
        ok: false,
        error: "no_active_class",
        picklist: todaysSessions.map((session) => ({
          id: session.id,
          name: session.name,
          startTime: session.startTime,
          type: session.type,
        })),
      };
    }

    classSession = picked ? toMatchedClass(picked) : null;
    attendanceDate = toAttendanceDate(now);
    matchSource = picked ? AttendanceMatchSource.STUDENT_PICKED : AttendanceMatchSource.UNMATCHED;
  }

  // The `@@unique([studentId, classSessionId, date])` constraint cannot catch a
  // repeat UNMATCHED tap: Postgres treats NULLs as distinct, so a second
  // classSessionId-null row for the same day slips straight past it and
  // double-counts toward belt progress. App-level pre-check, therefore — and
  // only for this case; every attributed path still relies on the constraint.
  // ponytail: a concurrent double-tap can still race this; a partial unique
  // index on (studentId, date) WHERE classSessionId IS NULL would close it, if
  // duplicate UNMATCHED rows ever actually show up in practice.
  if (!classSession) {
    const existing = await db.attendanceRecord.findFirst({
      where: {
        studentId: student.id,
        classSessionId: null,
        date: attendanceDate,
        type: AttendanceType.CHECKIN,
      },
      select: { id: true },
    });
    if (existing) {
      return { ok: false, error: "already_checked_in" };
    }
  }

  // Resolved once and reused for both summaries below (same student, same
  // org) rather than once per call.
  const configByTrack = await resolvePromotionConfigMap(input.context.organizationId);
  const summaryBefore = await getAtBeltSummary(student.id, configByTrack);

  let created: { id: string };
  try {
    created = await db.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: input.academyId,
        organizationId: input.context.organizationId,
        classSessionId: classSession?.id ?? null,
        occurredAt: now,
        date: attendanceDate,
        type: AttendanceType.CHECKIN,
        delta: 1,
        source: input.source,
        matchSource,
      },
      select: { id: true },
    });
  } catch (error) {
    // Postgres unique constraint violation (Prisma P2002) on the
    // (studentId, classSessionId, date) constraint — the app-level check
    // above is a friendly pre-check; this is the real backstop for a race.
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: "already_checked_in" };
    }
    throw error;
  }

  const summaryAfter = await getAtBeltSummary(student.id, configByTrack);

  if (summaryBefore.remainingAttendance === 1 && summaryAfter.remainingAttendance !== 1) {
    const type = summaryAfter.nextTarget === "BELT" && summaryAfter.isEligible ? "EXAM_THRESHOLD" : "STRIPE_THRESHOLD";
    // See fire-and-forget.ts for why this is wrapped in after() with a
    // fallback rather than left as a bare un-awaited promise.
    fireAndForget("notifyEligibilityReached", () => notifyEligibilityReached(student.id, type));
  }

  return {
    ok: true,
    student: {
      firstName: student.firstName,
      lastName: student.lastName,
      currentBelt: student.currentRank.code,
      currentBeltLabelEs: student.currentRank.labelEs,
      currentBeltLabelEn: student.currentRank.labelEn,
      currentBeltVisual: {
        primaryColor: student.currentRank.primaryColor,
        centerStripeColor: student.currentRank.centerStripeColor,
        barColor: student.currentRank.barColor,
        stripeColors: student.currentRank.stripeColors,
        maxStripes: student.currentRank.maxStripes,
        visibleStripeSlots: student.currentRank.visibleStripeSlots,
      },
      currentStripes: student.currentStripes,
    },
    summary: summaryAfter,
    // "This specific check-in was the one that crossed the threshold" — works
    // for both the ordinary stripe-earning case and the exam-eligibility case,
    // since getAtBeltSummary already folds exam-threshold progress into
    // remainingAttendance once a student is at max stripes.
    earnedStripe: summaryBefore.remainingAttendance === 1 && summaryAfter.remainingAttendance !== 1,
    isVisitor: student.homeAcademyId !== input.academyId,
    homeAcademyName: student.homeAcademy.name,
    attendanceRecordId: created.id,
    matchedClass: classSession,
  };
}

function toMatchedClass(session: { id: string; name: string; dayOfWeek: DayOfWeek; startTime: string }): MatchedClass {
  return {
    id: session.id,
    name: session.name,
    dayOfWeek: session.dayOfWeek,
    startTime: session.startTime,
  };
}
