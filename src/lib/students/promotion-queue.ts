import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { classifyEligibility, type EligibilityStatus } from "@/lib/students/eligibility";
import type { Belt } from "@/generated/prisma/client";

export interface PromotionCandidate {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  homeAcademyName: string;
  currentBelt: Belt;
  currentStripes: number;
  status: "stripe-eligible" | "exam-eligible" | "approaching";
  atBeltCount: number;
  remainingToNextStripe: number | null;
}

/**
 * Same belt-requirement resolution as `attendance-summary.ts`'s private
 * `resolveBeltRequirement` (per-academy override falls back to the
 * academy-null global default) — exported here (unlike that copy) so Task 3
 * (promotion confirmation) can import this exact logic instead of adding a
 * third duplicate. Not worth consolidating the two existing copies right now
 * (out of scope for this task); just don't add a fourth.
 */
export async function resolveBeltRequirementLike(belt: Belt, homeAcademyId: string) {
  const perAcademy = await prisma.beltRequirement.findUnique({
    where: { academyId_belt: { academyId: homeAcademyId, belt } },
  });
  if (perAcademy) return perAcademy;
  return prisma.beltRequirement.findFirstOrThrow({ where: { academyId: null, belt } });
}

async function classifyActiveStudents(session: StaffSession): Promise<
  Array<{ candidate: PromotionCandidate; status: EligibilityStatus }>
> {
  const scope = academyScopeWhere(session);
  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      // academyScopeWhere returns a fragment keyed `academyId`, but
      // Student's tenancy column is `homeAcademyId` — see academyScopeWhere's
      // own doc comment on why this can't be spread directly, and
      // src/app/[locale]/dashboard/page.tsx for the established translation.
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeAcademyId: true,
      homeAcademy: { select: { name: true } },
      currentBelt: true,
      currentStripes: true,
    },
  });

  const results = await Promise.all(
    students.map(async (student) => {
      const [summary, requirement] = await Promise.all([
        getAtBeltSummary(student.id),
        resolveBeltRequirementLike(student.currentBelt, student.homeAcademyId),
      ]);
      const status = classifyEligibility(
        { nextStripeAt: summary.nextStripeAt, remainingToNextStripe: summary.remainingToNextStripe, examEligible: summary.examEligible },
        student.currentStripes,
        requirement,
      );
      return {
        status,
        candidate: {
          studentId: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          homeAcademyId: student.homeAcademyId,
          homeAcademyName: student.homeAcademy.name,
          currentBelt: student.currentBelt,
          currentStripes: student.currentStripes,
          status: status as "stripe-eligible" | "exam-eligible" | "approaching",
          atBeltCount: summary.atBeltCount,
          remainingToNextStripe: summary.remainingToNextStripe,
        },
      };
    }),
  );

  return results;
}

export async function listPromotionQueue(session: StaffSession): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(session);
  return classified
    .filter((r) => r.status === "stripe-eligible" || r.status === "exam-eligible")
    .map((r) => r.candidate);
}

export async function listApproachingStudents(session: StaffSession): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(session);
  return classified.filter((r) => r.status === "approaching").map((r) => r.candidate);
}
