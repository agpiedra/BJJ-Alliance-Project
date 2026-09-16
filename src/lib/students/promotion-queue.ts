import { branchScopeWhere } from "@/lib/tenant/context";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { MissingTimeAnchorError } from "@/lib/promotion/engine";
import { isNotFoundError } from "@/lib/prisma-errors";

export interface PromotionCandidate {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  homeAcademyName: string;
  currentBelt: string;
  currentBeltLabelEs: string;
  currentBeltLabelEn: string;
  currentBeltVisual: BeltVisualData;
  currentStripes: number;
  status: "stripe-eligible" | "exam-eligible" | "approaching";
  atBeltCount: number;
  remainingAttendance: number | null;
}

type QueueStatus = "stripe-eligible" | "exam-eligible" | "approaching" | "none";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: preserved exactly as the old
 * eligibility.ts's `classifyEligibility` default — a behavior-preserving
 * migration, not a redesign. Known limitation (doesn't generalize per belt
 * or per academy): see scripts/pending-callers.ts's KNOWN_LIMITATIONS,
 * tracked as a Phase 4 settings candidate.
 */
const APPROACHING_THRESHOLD = 5;

async function classifyActiveStudents(context: TenantContext): Promise<
  Array<{ candidate: PromotionCandidate; status: QueueStatus }>
> {
  const branchScope = branchScopeWhere(context);
  const students = await getScopedDb(context).student.findMany({
    where: {
      status: "ACTIVE",
      // branchScopeWhere returns a fragment keyed `academyId`, but Student's
      // tenancy column is `homeAcademyId` — see its own doc comment on why
      // this can't be spread directly, and
      // src/app/[locale]/(staff)/dashboard/page.tsx for the established
      // translation. Organization scope itself comes from `getScopedDb`,
      // unconditionally.
      ...(branchScope.academyId ? { homeAcademyId: branchScope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeAcademyId: true,
      homeAcademy: { select: { name: true } },
    },
  });

  // Resolved ONCE for this whole batch, not once per student — a lookup
  // inside getAtBeltSummary would be an N+1 (see resolvePromotionConfigMap's
  // own doc comment).
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);

  let skippedForMissingTimeAnchor = 0;

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
      // `getAtBeltSummary` resolves `currentRank` in the same query as the
      // student row (a required FK since Phase 2's schema), so the only
      // P2025 it can raise is from its own `findUniqueOrThrow(student)` —
      // i.e. the student vanished.
      try {
        const summary = await getAtBeltSummary(student.id, configByTrack);
        let status: QueueStatus;
        if (summary.nextTarget === "STRIPE" && summary.isEligible) {
          status = "stripe-eligible";
        } else if (summary.nextTarget === "BELT" && summary.isEligible) {
          status = "exam-eligible";
        } else if (
          summary.remainingAttendance !== null &&
          summary.remainingAttendance > 0 &&
          summary.remainingAttendance <= APPROACHING_THRESHOLD
        ) {
          status = "approaching";
        } else {
          status = "none";
        }
        return {
          status,
          candidate: {
            studentId: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            homeAcademyId: student.homeAcademyId,
            homeAcademyName: student.homeAcademy.name,
            currentBelt: summary.currentBelt,
            currentBeltLabelEs: summary.currentBeltLabelEs,
            currentBeltLabelEn: summary.currentBeltLabelEn,
            currentBeltVisual: summary.currentBeltVisual,
            currentStripes: summary.currentStripes,
            status: status as "stripe-eligible" | "exam-eligible" | "approaching",
            atBeltCount: summary.atBeltCount,
            remainingAttendance: summary.remainingAttendance,
          },
        };
      } catch (error) {
        // A TIME/HYBRID student with no timeAnchorAt is a per-student data
        // gap (e.g. a mode switch that missed backfilling an anchor), not an
        // org config bug — excluding just this row is right (2b's own
        // design: "strict engine, caller decides handling"), but excluding
        // it SILENTLY would let the director see a shorter list with no
        // reason why — the exact failure shape this project keeps finding.
        // Logged loudly instead, with the student id, so "the queue looks
        // short" is traceable to a cause.
        if (error instanceof MissingTimeAnchorError) {
          skippedForMissingTimeAnchor++;
          console.warn(
            `listPromotionQueue: skipped student ${student.id} (org ${context.organizationId}, homeAcademyId ${student.homeAcademyId}) — ${error.message}`,
          );
          return null;
        }
        // Any other P2025 here can only mean the student itself vanished
        // (getAtBeltSummary's internal findUniqueOrThrow) — benign, exclude
        // it from the batch. Anything else (including
        // InvalidPromotionConfigError — a real org-level config bug) is
        // unexpected and must fail the whole batch loudly, not be swallowed
        // per-row.
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );

  if (skippedForMissingTimeAnchor > 0) {
    console.warn(
      `listPromotionQueue: ${skippedForMissingTimeAnchor} student(s) skipped for org ${context.organizationId} — missing time anchor.`,
    );
  }

  return results.filter((r): r is { candidate: PromotionCandidate; status: QueueStatus } => r !== null);
}

export async function listPromotionQueue(context: TenantContext): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(context);
  return classified
    .filter((r) => r.status === "stripe-eligible" || r.status === "exam-eligible")
    .map((r) => r.candidate);
}

export async function listApproachingStudents(context: TenantContext): Promise<PromotionCandidate[]> {
  const classified = await classifyActiveStudents(context);
  return classified.filter((r) => r.status === "approaching").map((r) => r.candidate);
}
