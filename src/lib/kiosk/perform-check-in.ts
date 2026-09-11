import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { selectActiveSessionOccurrence } from "@/lib/scheduling/check-in-window";
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { notifyEligibilityReached } from "@/lib/notifications/notify-eligibility";
import { fireAndForget } from "@/lib/notifications/fire-and-forget";
import { AttendanceType, StudentStatus, type AttendanceSource } from "@/generated/prisma/client";

export type CheckInResult =
  | {
      ok: true;
      student: { firstName: string; lastName: string; currentBelt: string; currentStripes: number };
      summary: AtBeltSummary;
      earnedStripe: boolean;
      isVisitor: boolean;
      /** The checking-in student's home academy name — populated unconditionally
       * (not just for visitors), so the kiosk UI can render a visitor badge
       * ("Visitante de [homeAcademyName]") without a second round-trip. */
      homeAcademyName: string;
    }
  | { ok: false; error: "invalid_code" | "no_active_class" | "already_checked_in" };

export type PerformCheckInInput =
  | { academyId: string; code: string; studentId?: never; source: AttendanceSource; now?: Date }
  | { academyId: string; studentId: string; code?: never; source: AttendanceSource; now?: Date };

export async function performCheckIn(input: PerformCheckInInput): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  // Presence check, not truthiness: a client-submitted `code: ""` is a valid
  // (if useless) member of the `code` variant of the discriminated union —
  // `input.code ? ... : ...` would misroute it into the `studentId` branch,
  // where `input.studentId` is `undefined`, and
  // `prisma.student.findUnique({ where: { id: undefined } })` throws instead
  // of returning the documented `invalid_code`. Checking for `undefined`
  // preserves the original behavior: an empty code hashes to a codeHash that
  // matches no student, so it falls through to the `!student` branch below.
  const student = input.code !== undefined
    ? await prisma.student.findUnique({
        where: { codeHash: digestLookupSecret(input.code, requireEnv("CODE_PEPPER")) },
        include: { homeAcademy: { select: { name: true } } },
      })
    : await prisma.student.findUnique({
        where: { id: input.studentId },
        include: { homeAcademy: { select: { name: true } } },
      });

  if (!student || student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "invalid_code" };
  }

  const sessions = await prisma.classSession.findMany({
    where: { academyId: input.academyId, active: true },
  });

  // Deterministic: `findMany` returns rows in no guaranteed order, and
  // overlapping check-in windows are genuinely reachable (adjacent hourly
  // classes touch at their boundary; the admin schedule editor can create
  // real overlaps), so "whichever row came back first" could attribute the
  // same tap to different classes on identical requests.
  const occurrence = selectActiveSessionOccurrence(sessions, now);

  if (!occurrence) {
    return { ok: false, error: "no_active_class" };
  }

  const activeSession = occurrence.session;
  // Stamped from the matched occurrence's OWN calendar day, never from
  // `now`'s. A window that straddles CR midnight would otherwise give two
  // check-ins to the same class occurrence two different `date` values,
  // slipping past the (studentId, classSessionId, date) unique constraint and
  // double-crediting one class — and a check-in just before midnight for a
  // just-after-midnight class would be filed under the wrong day entirely.
  // `occurredAt` stays the real wall-clock instant.
  const attendanceDate = attendanceDateFromZoned(occurrence.anchorDate);
  const summaryBefore = await getAtBeltSummary(student.id);

  try {
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: input.academyId,
        classSessionId: activeSession.id,
        occurredAt: now,
        date: attendanceDate,
        type: AttendanceType.CHECKIN,
        delta: 1,
        source: input.source,
      },
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

  const summaryAfter = await getAtBeltSummary(student.id);

  if (summaryBefore.remainingToNextStripe === 1 && summaryAfter.remainingToNextStripe !== 1) {
    const type = summaryAfter.examEligible ? "EXAM_THRESHOLD" : "STRIPE_THRESHOLD";
    // See fire-and-forget.ts for why this is wrapped in after() with a
    // fallback rather than left as a bare un-awaited promise.
    fireAndForget("notifyEligibilityReached", () => notifyEligibilityReached(student.id, type));
  }

  return {
    ok: true,
    student: {
      firstName: student.firstName,
      lastName: student.lastName,
      currentBelt: student.currentBelt,
      currentStripes: student.currentStripes,
    },
    summary: summaryAfter,
    // "This specific check-in was the one that crossed the threshold" — works
    // for both the ordinary stripe-earning case and the exam-eligibility case,
    // since getAtBeltSummary already folds exam-threshold progress into
    // remainingToNextStripe once a student is at max stripes.
    earnedStripe: summaryBefore.remainingToNextStripe === 1 && summaryAfter.remainingToNextStripe !== 1,
    isVisitor: student.homeAcademyId !== input.academyId,
    homeAcademyName: student.homeAcademy.name,
  };
}
