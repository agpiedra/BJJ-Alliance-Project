import { Belt } from "@/generated/prisma/client";

export interface BeltRequirementLike {
  attendancesPerStripe: number;
  maxStripes: number;
  attendancesForExam: number;
}

export interface BeltProgress {
  nextStripeAt: number | null;
  remainingToNextStripe: number | null;
  examEligible: boolean;
}

/**
 * Byte-for-byte extraction of `getAtBeltSummary`'s inline stripe/exam math
 * (originally `src/lib/students/attendance-summary.ts:69-86`). Do not "clean
 * this up" independently of that call site — Phase 3's already-reviewed
 * integration test (`tests/integration/attendance-summary.test.ts`) depends
 * on these exact semantics.
 */
export function computeBeltProgress(
  atBeltCount: number,
  currentStripes: number,
  requirement: BeltRequirementLike,
): BeltProgress {
  const atMaxStripes = currentStripes >= requirement.maxStripes;
  const attendancesIntoCurrentStripeSpan = atBeltCount - currentStripes * requirement.attendancesPerStripe;

  let nextStripeAt: number | null = null;
  let remainingToNextStripe: number | null = null;
  let examEligible = false;

  if (!atMaxStripes && requirement.attendancesPerStripe > 0) {
    nextStripeAt = (currentStripes + 1) * requirement.attendancesPerStripe;
    remainingToNextStripe = Math.max(0, nextStripeAt - atBeltCount);
  } else if (atMaxStripes && requirement.attendancesForExam > 0) {
    // Past the 4th stripe: examEligible once `attendancesForExam` more
    // attendances have accrued since the 4th stripe was earned.
    examEligible = attendancesIntoCurrentStripeSpan >= requirement.attendancesForExam;
    if (!examEligible) {
      remainingToNextStripe = Math.max(0, requirement.attendancesForExam - attendancesIntoCurrentStripeSpan);
    }
  }

  return { nextStripeAt, remainingToNextStripe, examEligible };
}

export type EligibilityStatus = "stripe-eligible" | "exam-eligible" | "approaching" | "none";

export function classifyEligibility(
  progress: BeltProgress,
  currentStripes: number,
  requirement: BeltRequirementLike,
  approachingThreshold = 5,
): EligibilityStatus {
  const atMaxStripes = currentStripes >= requirement.maxStripes;

  if (!atMaxStripes && progress.remainingToNextStripe === 0) {
    return "stripe-eligible";
  }
  if (progress.examEligible) {
    return "exam-eligible";
  }
  if (
    progress.remainingToNextStripe !== null &&
    progress.remainingToNextStripe > 0 &&
    progress.remainingToNextStripe <= approachingThreshold
  ) {
    return "approaching";
  }
  return "none";
}

export const BELT_ORDER: readonly Belt[] = [Belt.WHITE, Belt.BLUE, Belt.PURPLE, Belt.BROWN, Belt.BLACK];

export function nextBelt(belt: Belt): Belt | null {
  const index = BELT_ORDER.indexOf(belt);
  if (index === -1 || index === BELT_ORDER.length - 1) {
    return null;
  }
  return BELT_ORDER[index + 1];
}

export interface PromotionTarget {
  fromBelt: Belt;
  fromStripes: number;
  toBelt: Belt;
  toStripes: number;
  kind: "stripe" | "belt";
}

export function resolvePromotionTarget(
  status: EligibilityStatus,
  currentBelt: Belt,
  currentStripes: number,
): PromotionTarget | null {
  if (status === "approaching" || status === "none") {
    return null;
  }

  if (status === "stripe-eligible") {
    return {
      fromBelt: currentBelt,
      fromStripes: currentStripes,
      toBelt: currentBelt,
      toStripes: currentStripes + 1,
      kind: "stripe",
    };
  }

  // status === "exam-eligible"
  const target = nextBelt(currentBelt);
  if (!target) {
    // Genuine invariant violation: classifyEligibility should never return
    // "exam-eligible" for BLACK (BLACK's seeded requirement is 0/0/0, which
    // computeBeltProgress never marks examEligible for).
    throw new Error(`resolvePromotionTarget: no next belt after ${currentBelt}, but status was exam-eligible`);
  }

  return {
    fromBelt: currentBelt,
    fromStripes: currentStripes,
    toBelt: target,
    toStripes: 0,
    kind: "belt",
  };
}
