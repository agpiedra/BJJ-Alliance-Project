import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { computeBeltProgress } from "@/lib/students/eligibility";

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
 * This filters `atBeltCount` ONLY — the one number belt math reads
 * (`nextStripeAt` / `remainingToNextStripe` / `examEligible` all derive from
 * it). It deliberately does NOT filter `lifetimeCount`, which no belt math
 * touches: its only consumer renders it as "Lifetime attendances" /
 * "Asistencias totales" on the student detail page, a plain physical-attendance
 * total. The distinction between the two counts is temporal (before vs. after
 * `beltAwardedAt`), not promotion-relevance, so hiding Striking classes from
 * the lifetime total would just make it wrong.
 *
 * The ledger itself is untouched either way — `performCheckIn` still records
 * every physical check-in, including Striking ones, because that is a true
 * attendance fact.
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
    // Unfiltered on purpose: every physical attendance ever, promotion-relevant
    // or not (see PROMOTION_RELEVANT's comment).
    prisma.attendanceRecord.aggregate({
      where: { studentId },
      _sum: { delta: true },
    }),
  ]);

  const atBeltCount = atBeltAgg._sum.delta ?? 0;
  const lifetimeCount = lifetimeAgg._sum.delta ?? 0;

  const progress = computeBeltProgress(atBeltCount, student.currentStripes, requirement);

  return {
    currentBelt: student.currentBelt,
    currentStripes: student.currentStripes,
    atBeltCount,
    lifetimeCount,
    attendancesPerStripe: requirement.attendancesPerStripe,
    maxStripes: requirement.maxStripes,
    ...progress,
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
