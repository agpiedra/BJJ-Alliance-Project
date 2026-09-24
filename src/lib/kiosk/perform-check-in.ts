import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { attendanceDateFromZoned, toAttendanceDate } from "@/lib/scheduling/zone";
import { openOccurrences, type SessionOccurrence } from "@/lib/scheduling/check-in-window";
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

/**
 * One class that is OPEN right now, as offered to a student who must say which class they attended: name, the
 * scheduled time range (`HH:mm`, Costa Rica wall clock; `endTime` may be past midnight) and the real class type.
 */
export interface OpenClassEntry {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  type: ClassType;
}

/** The picker entry for one open occurrence (its own scheduled range, from its own configured duration). */
export function toOpenClassEntry(
  occurrence: SessionOccurrence<{ id: string; name: string; startTime: string; durationMinutes: number; type: ClassType; dayOfWeek: DayOfWeek }>,
): OpenClassEntry {
  return {
    id: occurrence.session.id,
    name: occurrence.session.name,
    startTime: occurrence.session.startTime,
    endTime: occurrence.startsAt.plus({ minutes: occurrence.session.durationMinutes }).toFormat("HH:mm"),
    type: occurrence.session.type,
  };
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
      /** Another class was open at the same instant, so "this is not my class" has something to offer. */
      canCorrect: boolean;
    }
  | {
      ok: false;
      /**
       *  - invalid_code / already_checked_in: as ever.
       *  - invalid_class: the selected id is not an active class of this academy. Nothing written.
       *  - class_not_open: the selected class is not open at this instant (it closed while the picker was up, or it
       *    never opened). Nothing written; `openClasses` carries the FRESH choices (possibly none).
       *  - no_open_class: no class is open. A live attempt never creates an attendance from this: check-in is
       *    unavailable and a coach can record the attendance.
       *  - class_selection_required: SEVERAL classes are open and none was selected. Nothing written; `openClasses`
       *    is the picker's list. Only a student's explicit choice records the attendance.
       * A queued replay (`replay`) never returns the last four: it is retained for staff review instead.
       */
      error: "invalid_code" | "already_checked_in" | "invalid_class" | "class_not_open" | "no_open_class" | "class_selection_required";
      openClasses?: OpenClassEntry[];
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
   * Set ONLY for a queued offline replay (the kiosk route derives it from a `queuedAt` in the body). Nobody is
   * standing at the tablet to answer a picker, and a queued attendance must NEVER be silently discarded, so a replay is
   * evaluated at its own ORIGINAL instant (`now`, the validated `queuedAt`) and:
   *  - a valid recorded selection (open at that instant) is honored (STUDENT_PICKED);
   *  - exactly ONE eligible class and no selection -> that class (AUTO);
   *  - zero eligible classes, SEVERAL eligible classes without a recorded selection, an invalid recorded selection, or
   *    an instant that could not be verified (`timestampVerified: false`: malformed, in the future or older than the
   *    bound) -> saved UNMATCHED for staff review (never counted toward promotion, one per student per day).
   * This is recovery for attendance that already happened; a NEW online attempt never takes this path.
   */
  replay?: { timestampVerified: boolean };
}

/**
 * An explicit selection. It is validated server-side against fresh queries - never trusted from the client - and the
 * class must belong to this academy, be active and be OPEN at the instant of the check-in (start -30 minutes to the
 * class's scheduled end +30 minutes, inclusive, using that class's own duration): the SAME rule for the portal and the
 * kiosk. A valid selection is never replaced by a different match.
 */
type ClassSelection = { pickedClassSessionId?: string };

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

  // The classes open at the instant this attendance belongs to, in a stable order. A replay whose instant could not be
  // verified is evaluated against NO class (an untrusted timestamp must not attribute anything to whatever happens to
  // be open at replay time): it is retained for staff review below.
  const replay = input.replay;
  const open = !replay || replay.timestampVerified ? openOccurrences(sessions, now) : [];

  // What the row will be attributed to. `sessions` is this academy's ACTIVE classes, already scoped to the organization.
  type Attribution = { session: (typeof sessions)[number] | null; date: Date; matchSource: AttendanceMatchSource };
  let attribution: Attribution | null = null;
  const picked = input.pickedClassSessionId !== undefined ? sessions.find((session) => session.id === input.pickedClassSessionId) : undefined;
  const choices = () => open.map(toOpenClassEntry);

  // 1. An explicit selection is validated FIRST and always wins when valid. It is filed under the occurrence's OWN
  //    Costa Rica day (a window can straddle midnight) and `occurredAt` stays the real instant.
  if (input.pickedClassSessionId !== undefined) {
    const chosen = picked ? open.find((occurrence) => occurrence.session.id === picked.id) : undefined;
    if (picked && chosen) {
      attribution = { session: picked, date: attendanceDateFromZoned(chosen.anchorDate), matchSource: AttendanceMatchSource.STUDENT_PICKED };
    } else if (!replay) {
      // A live attempt is refused and NOTHING is written: an unknown / inactive / other-academy / other-organization id
      // is `invalid_class`; a real class that is not open (it may have closed while the picker was up) is
      // `class_not_open`, with the fresh choices so the student can pick again.
      return picked ? { ok: false, error: "class_not_open", openClasses: choices() } : { ok: false, error: "invalid_class" };
    }
    // A replay with an unusable selection is not discarded: it falls through to the staff-review save below.
  }

  if (!attribution) {
    if (!replay) {
      // A NEW attempt with no selection. Zero open classes: check-in is unavailable and a coach records it - never an
      // unmatched attendance from an online attempt. Several: the student must say which class; nothing is written
      // until they do. Exactly one: it is unambiguous, so it is selected automatically.
      if (open.length === 0) return { ok: false, error: "no_open_class" };
      if (open.length > 1) return { ok: false, error: "class_selection_required", openClasses: choices() };
      attribution = { session: open[0].session, date: attendanceDateFromZoned(open[0].anchorDate), matchSource: AttendanceMatchSource.AUTO };
    } else if (input.pickedClassSessionId === undefined && open.length === 1) {
      attribution = { session: open[0].session, date: attendanceDateFromZoned(open[0].anchorDate), matchSource: AttendanceMatchSource.AUTO };
    } else {
      // Replay: nothing to attribute unambiguously. Kept, class-less, for staff to resolve on the Kiosco page; it never
      // contributes to promotion (only a class-attributed attendance can).
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
    canCorrect: !replay && attributed !== null && open.some((occurrence) => occurrence.session.id !== attributed.id),
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
