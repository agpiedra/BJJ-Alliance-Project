import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import {
  classifyEligibility,
  MissingBeltRequirementError,
  type BeltRequirementLike,
  type EligibilityStatus,
} from "@/lib/students/eligibility";
import { isNotFoundError } from "@/lib/prisma-errors";
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
      // This admin-wide scan and this per-student work are not atomic: a
      // student present in the `findMany` above can vanish at ANY point
      // before or during the per-student work below (e.g. another test
      // file's fixture teardown hard-deleting its own rows mid-scan —
      // confirmed reproducible, see
      // tests/integration/promotion-queue.test.ts's vanished-student case).
      //
      // A prior version of this fix (round 2) split "check the student still
      // exists" from "do the per-student work" into two separate calls. That
      // closed the window the check covered but opened a NEW one: the
      // student could still vanish between the check and the use, producing
      // an uncaught crash that sank the whole batch — a narrower instance of
      // the exact bug being fixed. Round 3 (this version) restores a single
      // atomic try/catch around the whole per-student unit of work instead,
      // so there is no window at all in which the two calls can observe
      // different states of the world.
      //
      // The remaining problem a plain broad catch would reintroduce:
      // `getAtBeltSummary` itself internally resolves BOTH the student row
      // AND the belt requirement, and can raise Prisma's generic P2025
      // "not found" for either — but only one of those is benign. A missing
      // global `BeltRequirement` row is a seed-data/config bug that must
      // propagate loudly, not be silently treated like a vanished student.
      // That's solved by TYPE rather than by call site: `getAtBeltSummary`'s
      // internal belt-requirement resolution throws a distinctly-typed
      // `MissingBeltRequirementError` for ITS P2025, instead of leaving it as
      // a generic P2025 — so any plain P2025 that reaches this catch can only
      // have come from `getAtBeltSummary`'s internal
      // `findUniqueOrThrow(student)`, i.e. the student vanished.
      //
      // There is now only ONE call (`getAtBeltSummary`) needed per student,
      // not two — it already carries `attendancesPerStripe`/`maxStripes`/
      // `attendancesForExam` from its own belt-requirement resolution, so the
      // `BeltRequirementLike` object `classifyEligibility` needs is built
      // directly from its return value rather than from a second, separate
      // lookup. This also structurally removes the `Promise.all`
      // first-rejection-ordering non-determinism the two-call version had,
      // and the snapshot/fresh-belt mismatch risk of resolving the belt
      // requirement against a value that could differ from what
      // `getAtBeltSummary` itself read.
      try {
        const summary = await getAtBeltSummary(student.id);
        const requirement: BeltRequirementLike = {
          attendancesPerStripe: summary.attendancesPerStripe,
          maxStripes: summary.maxStripes,
          attendancesForExam: summary.attendancesForExam,
        };
        // Read from `summary` (the same call that produced the progress
        // numbers below), not the outer `findMany`'s `student.currentBelt`/
        // `currentStripes` — same root cause as Phase 4 Task 3 fix round 1's
        // finding I-1 (promotion-actions.ts), though here it's read-only
        // display data (this list view writes nothing), so a stale pairing
        // is cosmetic rather than a false permanent record.
        const status = classifyEligibility(
          { nextStripeAt: summary.nextStripeAt, remainingToNextStripe: summary.remainingToNextStripe, examEligible: summary.examEligible },
          summary.currentStripes,
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
            currentBelt: summary.currentBelt,
            currentStripes: summary.currentStripes,
            status: status as "stripe-eligible" | "exam-eligible" | "approaching",
            atBeltCount: summary.atBeltCount,
            remainingToNextStripe: summary.remainingToNextStripe,
          },
        };
      } catch (error) {
        // Real configuration bug — must fail the whole batch loudly, not be
        // swallowed as if this were a lone vanished student.
        if (error instanceof MissingBeltRequirementError) {
          throw error;
        }
        // Any other Prisma "not found" here can now only mean the student
        // itself vanished (getAtBeltSummary's internal findUniqueOrThrow) —
        // benign, exclude it from the batch.
        if (isNotFoundError(error)) {
          return null;
        }
        // Anything else is unexpected — don't broaden the catch beyond the
        // two distinguishable cases above.
        throw error;
      }
    }),
  );

  return results.filter((r): r is { candidate: PromotionCandidate; status: EligibilityStatus } => r !== null);
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
