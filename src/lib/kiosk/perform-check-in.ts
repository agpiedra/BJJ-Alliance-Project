import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import { isWithinCheckInWindow } from "@/lib/scheduling/check-in-window";
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
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

export async function performCheckIn(input: {
  academyId: string;
  code: string;
  source: AttendanceSource;
  now?: Date;
}): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  const codeHash = digestLookupSecret(input.code, requireEnv("CODE_PEPPER"));
  const student = await prisma.student.findUnique({
    where: { codeHash },
    include: { homeAcademy: { select: { name: true } } },
  });

  if (!student || student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "invalid_code" };
  }

  const sessions = await prisma.classSession.findMany({
    where: { academyId: input.academyId, active: true },
  });

  const activeSession = sessions.find((s) => isWithinCheckInWindow(s, now));

  if (!activeSession) {
    return { ok: false, error: "no_active_class" };
  }

  const attendanceDate = toAttendanceDate(now);
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

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
