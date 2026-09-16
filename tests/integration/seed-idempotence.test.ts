import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";
import { reseed } from "../helpers/reseed";

const prisma = getTestPrismaClient();

// prisma/seed.ts has no exports (it runs main() as a module side effect), so
// its fixed ids are duplicated here rather than imported — the same
// "duplicated literals" call scripts/alliance-baseline.ts's own header makes
// for the same reason. This test only needs the id *scheme*, not the seed's
// implementation.
const ALLIANCE_ORG_ID = "seed-org-alliance";
const SEED_USER_IDS = [
  "seed-user-admin",
  "seed-user-director",
  "seed-user-instructor",
  "seed-user-student",
  "seed-user-qa-director",
];

function omit<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  const clone = { ...row };
  for (const key of keys) delete clone[key];
  return clone;
}

/**
 * Snapshots every row the deterministic seed owns, across every model it
 * writes. Scoped by the seed's own "seed-"-prefixed ids (or, for
 * OrganizationMembership, which has no deterministic id of its own, by the
 * fixed userId it belongs to) so a concurrently running test's scratch
 * fixtures — which this repo's convention always gives their own
 * non-"seed-" id — can never leak into the comparison.
 *
 * `passwordHash` (a fresh bcrypt salt every run, by design — see this
 * file's own header) and `updatedAt` (bumped by Prisma on every `update()`
 * regardless of whether any value actually changed) are the only fields
 * excluded: this checks real re-seed idempotence, not literal byte-for-byte
 * row identity including fields that are supposed to change.
 */
async function snapshotSeedRows() {
  const [
    organizations,
    academies,
    beltRanks,
    promotionConfigs,
    classSessions,
    paymentPlans,
    users,
    memberships,
    staffAssignments,
    students,
    attendanceRecords,
    promotions,
    paymentPeriods,
  ] = await Promise.all([
    prisma.organization.findMany({ where: { id: ALLIANCE_ORG_ID } }),
    prisma.academy.findMany({ where: { id: { startsWith: "seed-academy-" } }, orderBy: { id: "asc" } }),
    prisma.beltRank.findMany({ where: { id: { startsWith: "seed-belt-rank-" } }, orderBy: { id: "asc" } }),
    prisma.promotionConfig.findMany({ where: { id: { startsWith: "seed-promotion-config-" } }, orderBy: { id: "asc" } }),
    prisma.classSession.findMany({ where: { id: { startsWith: "seed-class-" } }, orderBy: { id: "asc" } }),
    prisma.paymentPlan.findMany({ where: { id: { startsWith: "seed-payment-plan-" } }, orderBy: { id: "asc" } }),
    prisma.user.findMany({ where: { id: { in: SEED_USER_IDS } }, orderBy: { id: "asc" } }),
    prisma.organizationMembership.findMany({ where: { userId: { in: SEED_USER_IDS } }, orderBy: { userId: "asc" } }),
    prisma.staffAssignment.findMany({ where: { id: { startsWith: "seed-staff-" } }, orderBy: { id: "asc" } }),
    prisma.student.findMany({ where: { id: { startsWith: "seed-" } }, orderBy: { id: "asc" } }),
    prisma.attendanceRecord.findMany({ where: { id: { startsWith: "seed-attendance-" } }, orderBy: { id: "asc" } }),
    prisma.promotion.findMany({ where: { id: { startsWith: "seed-promotion-" } }, orderBy: { id: "asc" } }),
    prisma.paymentPeriod.findMany({ where: { id: { startsWith: "seed-payment-" } }, orderBy: { id: "asc" } }),
  ]);

  return {
    Organization: organizations.map((r) => omit(r, ["updatedAt"])),
    Academy: academies.map((r) => omit(r, ["updatedAt"])),
    BeltRank: beltRanks.map((r) => omit(r, ["updatedAt"])),
    PromotionConfig: promotionConfigs.map((r) => omit(r, ["updatedAt"])),
    ClassSession: classSessions.map((r) => omit(r, ["updatedAt"])),
    PaymentPlan: paymentPlans.map((r) => omit(r, ["updatedAt"])),
    User: users.map((r) => omit(r, ["updatedAt", "passwordHash"])),
    OrganizationMembership: memberships.map((r) => omit(r, ["updatedAt"])),
    StaffAssignment: staffAssignments,
    Student: students.map((r) => omit(r, ["updatedAt"])),
    AttendanceRecord: attendanceRecords,
    Promotion: promotions,
    PaymentPeriod: paymentPeriods,
  };
}

/**
 * SCOPE: value MISMATCHES and second-run crashes, not omissions.
 *
 * This test seeds an already-seeded database a second time and asserts
 * every seed-owned row is byte-identical before and after. That catches an
 * `update` branch that writes a genuinely DIFFERENT value than `create` did
 * (a typo, a stale literal, divergent derivation logic) and it catches the
 * second run throwing at all (a unique-constraint violation, a crash on an
 * upsert given a row that already exists).
 *
 * It does NOT catch a field that's simply missing from `update` entirely —
 * that was the actual historical bug (stripeColors/visibleStripeSlots on
 * BeltRank). Proven, not assumed: reintroducing that exact bug and rerunning
 * this test still passed, because an omitted field can't produce a diff
 * between two runs of the SAME seed source — there's nothing to move it.
 * seed-repairs-drift.test.ts is the test that catches an omission, by
 * mutating a row to a WRONG value first and asserting reseed corrects it
 * back — see that file for why the two tests are not redundant.
 */
describe("Deterministic seed — reseeding an already-seeded database changes nothing (value-mismatch guard)", () => {
  it(
    "every seed-owned row is identical before and after a second seed run",
    async () => {
      const before = await snapshotSeedRows();
      reseed();
      const after = await snapshotSeedRows();
      expect(after).toEqual(before);
    },
    30_000,
  );
});
