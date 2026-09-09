import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export interface AtBeltSummary {
  currentBelt: string;
  currentStripes: number;
  atBeltCount: number;
  lifetimeCount: number;
  attendancesPerStripe: number;
  maxStripes: number;
  nextStripeAt: number | null;
  remainingToNextStripe: number | null;
  examEligible: boolean;
}

/**
 * Which `AttendanceRecord` rows count toward belt progress.
 *
 * A class can be marked `countsTowardPromotion: false` (the seeded Saturday
 * Striking class is exactly this, and Task 9's schedule editor lets an admin
 * mark any class that way) — the flag had no consumer at all, so a Striking
 * check-in silently advanced a student's belt progress.
 *
 * `classSessionId: null` rows are manual staff adjustments (Task 8). They have
 * no class to inherit a flag from and always count: they carry a
 * human-reviewed `reason` and exist precisely to correct the ledger.
 *
 * This filters the promotion-relevant AGGREGATION only. The ledger itself is
 * untouched — `performCheckIn` still records every physical check-in,
 * including Striking ones, because that is a true attendance fact.
 */
const PROMOTION_RELEVANT: Prisma.AttendanceRecordWhereInput = {
  OR: [{ classSessionId: null }, { classSession: { countsTowardPromotion: true } }],
};

export async function getAtBeltSummary(studentId: string): Promise<AtBeltSummary> {
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { currentBelt: true, currentStripes: true, beltAwardedAt: true, homeAcademyId: true },
  });

  const requirement = await resolveBeltRequirement(student.currentBelt, student.homeAcademyId);

  const [atBeltAgg, lifetimeAgg] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where: { studentId, occurredAt: { gte: student.beltAwardedAt }, ...PROMOTION_RELEVANT },
      _sum: { delta: true },
    }),
    prisma.attendanceRecord.aggregate({
      where: { studentId, ...PROMOTION_RELEVANT },
      _sum: { delta: true },
    }),
  ]);

  const atBeltCount = atBeltAgg._sum.delta ?? 0;
  const lifetimeCount = lifetimeAgg._sum.delta ?? 0;

  const atMaxStripes = student.currentStripes >= requirement.maxStripes;
  const attendancesIntoCurrentStripeSpan = atBeltCount - student.currentStripes * requirement.attendancesPerStripe;

  let nextStripeAt: number | null = null;
  let remainingToNextStripe: number | null = null;
  let examEligible = false;

  if (!atMaxStripes && requirement.attendancesPerStripe > 0) {
    nextStripeAt = (student.currentStripes + 1) * requirement.attendancesPerStripe;
    remainingToNextStripe = Math.max(0, nextStripeAt - atBeltCount);
  } else if (atMaxStripes && requirement.attendancesForExam > 0) {
    // Past the 4th stripe: examEligible once `attendancesForExam` more
    // attendances have accrued since the 4th stripe was earned.
    examEligible = attendancesIntoCurrentStripeSpan >= requirement.attendancesForExam;
    if (!examEligible) {
      remainingToNextStripe = Math.max(0, requirement.attendancesForExam - attendancesIntoCurrentStripeSpan);
    }
  }

  return {
    currentBelt: student.currentBelt,
    currentStripes: student.currentStripes,
    atBeltCount,
    lifetimeCount,
    attendancesPerStripe: requirement.attendancesPerStripe,
    maxStripes: requirement.maxStripes,
    nextStripeAt,
    remainingToNextStripe,
    examEligible,
  };
}

async function resolveBeltRequirement(belt: string, homeAcademyId: string) {
  const perAcademy = await prisma.beltRequirement.findUnique({
    where: { academyId_belt: { academyId: homeAcademyId, belt: belt as never } },
  });
  if (perAcademy) return perAcademy;

  return prisma.beltRequirement.findFirstOrThrow({
    where: { academyId: null, belt: belt as never },
  });
}
