import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { attendanceDateFromZoned, crDayOfWeek, toAttendanceDate } from "@/lib/scheduling/zone";
import { openOccurrence, selectActiveSessionOccurrence } from "@/lib/scheduling/check-in-window";
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
import { isDayContribution } from "@/lib/promotion/progress-days";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { prisma } from "@/lib/prisma";
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

/**
 * What this check-in did for the student's promotion progress - reported
 * truthfully so the screen never presents an extra same-day class as another
 * progress day (docs/PROMOTION_PROGRESS_PROPOSAL.md: at most ONE qualifying
 * attendance per Costa Rica calendar day). The attendance itself is always
 * recorded either way.
 *  - counted: this is the day's one contribution.
 *  - already_counted_today: an earlier qualifying attendance already made the
 *    day's contribution; this one is recorded but adds 0.
 *  - not_promotion_class: this attendance does not qualify (a class that does not
 *    count toward promotion, or a tap not yet matched to a class).
 *  - before_last_promotion: the day's first attendance, but it happened before the
 *    student's last promotion (an offline replay that arrived after the award), so it
 *    belongs to the completed interval and adds nothing toward the next one.
 */
export type ProgressOutcome = "counted" | "already_counted_today" | "not_promotion_class" | "before_last_promotion";

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
      /** This check-in took the student to (or past) the threshold: "eligible for instructor review" - never an automatic award. */
      thresholdReached: boolean;
      progressOutcome: ProgressOutcome;
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
      error: "invalid_code" | "no_active_class" | "already_checked_in" | "invalid_class" | "class_not_open";
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

/**
 * How an EXPLICITLY selected class is validated. Required whenever a class is selected (no default: a channel must
 * say which policy it runs, so a new caller cannot silently inherit the lenient one).
 *  - OPEN_ONLY (the portal): the class must belong to this academy, be active and be OPEN right now (start -30 to
 *    start +30 minutes, inclusive). An unknown / inactive / other-academy / other-organization id is
 *    `invalid_class`; a real class that is not open is `class_not_open`. Nothing is written.
 *  - TODAY_ANY (the attended kiosk): the kiosk's outside-window fallback is kept - any of TODAY's active classes
 *    is accepted whether or not its window is open. An id that is not one of today's classes is treated as if
 *    nothing was selected (the picker / automatic match), exactly as before.
 * Either way the selection is validated server-side against fresh queries, never trusted from the client, and a
 * valid selection is NEVER overridden by a different nearest-time match.
 */
export type PickPolicy = "OPEN_ONLY" | "TODAY_ANY";

type ClassSelection =
  | { pickedClassSessionId?: undefined; pickPolicy?: undefined }
  | { pickedClassSessionId: string; pickPolicy: PickPolicy };

export type PerformCheckInInput =
  | (CommonInput & ClassSelection & { code: string; studentId?: never })
  | (CommonInput & ClassSelection & { studentId: string; code?: never });

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

  // What the row will be attributed to, resolved by the first path that applies: an EXPLICIT selection, then an
  // automatic window match, then the no-match handling (picker / unmatched save).
  type Attribution = { session: (typeof sessions)[number] | null; date: Date; matchSource: AttendanceMatchSource };
  let attribution: Attribution | null = null;

  // 1. An explicit selection is validated FIRST and is never overridden by a different nearest-time match: the
  //    student chose this class, and ranking by closeness to `now` only applies when nothing was chosen (see
  //    PickPolicy). `sessions` is this academy's ACTIVE classes, already scoped to the organization.
  if (input.pickedClassSessionId !== undefined) {
    const picked = sessions.find((session) => session.id === input.pickedClassSessionId);
    if (!picked) {
      if (input.pickPolicy === "OPEN_ONLY") return { ok: false, error: "invalid_class" };
      // TODAY_ANY: a stale or tampered id is treated as if nothing was selected (below), as it always was.
    } else {
      const open = openOccurrence(picked, now);
      if (open) {
        // Stamped from the occurrence's OWN calendar day (a window can straddle CR midnight), exactly like an
        // automatic match; `occurredAt` stays the real wall-clock instant.
        attribution = { session: picked, date: attendanceDateFromZoned(open.anchorDate), matchSource: AttendanceMatchSource.STUDENT_PICKED };
      } else if (input.pickPolicy === "OPEN_ONLY") {
        return { ok: false, error: "class_not_open" };
      } else if (picked.dayOfWeek === crDayOfWeek(now)) {
        // The kiosk's outside-window fallback: one of TODAY's classes, filed under today's date.
        attribution = { session: picked, date: toAttendanceDate(now), matchSource: AttendanceMatchSource.STUDENT_PICKED };
      }
      // else TODAY_ANY and not one of today's classes: falls through, as before.
    }
  }

  if (!attribution) {
    if (occurrence) {
      // Stamped from the matched occurrence's OWN calendar day, never from
      // `now`'s. A window that straddles CR midnight would otherwise give two
      // check-ins to the same class occurrence two different `date` values,
      // slipping past the (studentId, classSessionId, date) unique index and
      // double-crediting one class — and a check-in just before midnight for a
      // just-after-midnight class would be filed under the wrong day entirely.
      // `occurredAt` stays the real wall-clock instant.
      attribution = { session: occurrence.session, date: attendanceDateFromZoned(occurrence.anchorDate), matchSource: AttendanceMatchSource.AUTO };
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

      if (todaysSessions.length > 0 && !input.unattended) {
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

      attribution = { session: null, date: toAttendanceDate(now), matchSource: AttendanceMatchSource.UNMATCHED };
    }
  }

  const { session: attributed, date: attendanceDate, matchSource } = attribution;

  // Two check-ins with no class on the same day are refused by a partial unique index
  // ("AttendanceRecord_unmatched_student_date_key": one class-less CHECKIN per student per day, valid rows only),
  // which is what makes concurrent taps safe. NULLs are distinct to the ordinary
  // (studentId, classSessionId, date) index, so this is the rule for that case. This lookup only gives the common
  // sequential repeat a clean answer without attempting the write; the index (caught below) is the guarantee.
  if (!attributed) {
    const existing = await db.attendanceRecord.findFirst({
      where: {
        studentId: student.id,
        classSessionId: null,
        date: attendanceDate,
        type: AttendanceType.CHECKIN,
        voidedAt: null,
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
  const summaryBefore = await getAtBeltSummary(student.id, input.context.organizationId, configByTrack);

  let created: { id: string };
  try {
    created = await db.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: input.academyId,
        organizationId: input.context.organizationId,
        classSessionId: attributed?.id ?? null,
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
    // Postgres unique violation (Prisma P2002): the per-class-occurrence index or the per-day class-less index.
    // The lookup above is a friendly pre-check; this is the real backstop for a race.
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: "already_checked_in" };
    }
    throw error;
  }

  const summaryAfter = await getAtBeltSummary(student.id, input.context.organizationId, configByTrack);

  // Under PER_INTERVAL accounting only the day's earliest qualifying attendance
  // contributes. Legacy CUMULATIVE tracks count every qualifying class, so there
  // is nothing to explain there.
  let progressOutcome: ProgressOutcome = "counted";
  if (summaryAfter.accounting === "PER_INTERVAL") {
    // Judged on what the attendance was ATTRIBUTED to - an automatic match, a selected class or nothing - so a
    // selected class that does not count toward promotion is reported as such (it used to fall through to
    // "already counted today").
    if (!attributed || !attributed.countsTowardPromotion) {
      progressOutcome = "not_promotion_class";
    } else {
      const contributes = await isDayContribution(prisma, {
        studentId: student.id,
        organizationId: input.context.organizationId,
        recordId: created.id,
      });
      progressOutcome = !contributes
        ? "already_counted_today"
        : now < summaryAfter.progressBaselineAt
          ? "before_last_promotion"
          : "counted";
    }
  }

  if (summaryBefore.remainingAttendance === 1 && summaryAfter.remainingAttendance !== 1) {
    const type = summaryAfter.nextTarget === "BELT" && summaryAfter.isEligible ? "EXAM_THRESHOLD" : "STRIPE_THRESHOLD";
    // See fire-and-forget.ts for why this is wrapped in after() with a
    // fallback rather than left as a bare un-awaited promise.
    fireAndForget("notifyEligibilityReached", () =>
      notifyEligibilityReached(student.id, input.context.organizationId, type),
    );
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
    // for both the stripe case and the belt-exam case, since getAtBeltSummary
    // folds exam-threshold progress into remainingAttendance once a student is
    // at max stripes. It means ELIGIBLE FOR REVIEW: a check-in never awards
    // anything, an instructor does.
    thresholdReached: summaryBefore.remainingAttendance === 1 && summaryAfter.remainingAttendance !== 1,
    progressOutcome,
    isVisitor: student.homeAcademyId !== input.academyId,
    homeAcademyName: student.homeAcademy.name,
    attendanceRecordId: created.id,
    matchedClass: attributed ? toMatchedClass(attributed) : null,
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
