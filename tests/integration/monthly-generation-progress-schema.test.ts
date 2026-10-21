import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";

/**
 * Monthly-generation G1: the hand-written part of migration 20261021120000_dues_generation_progress (Prisma cannot express
 * CHECK constraints). Each constraint is proved by a row that violates it and nothing else, written in SQL so Prisma's own
 * validation cannot be what refuses it. Plus the (organization, year, month) unique key, the foreign key and the discovery index.
 */
const prisma = getTestPrismaClient();
let fx: Awaited<ReturnType<typeof makeAccountingOrg>>;

beforeAll(async () => {
  fx = await makeAccountingOrg("CUMULATIVE", "g1-schema");
  await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
}, 60_000);

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
  await fx?.drop();
});

/** Inserts one row with the given column overrides (SQL literals), or rejects. */
async function insert(overrides: Record<string, string> = {}, month = 1) {
  const columns: Record<string, string> = {
    id: `'g1s-${Date.now()}-${Math.random().toString(36).slice(2)}'`,
    organizationId: `'${fx.org.id}'`,
    year: "2030",
    month: String(month),
    lastVisitedAt: "'1970-01-01'",
    ...overrides,
  };
  const names = Object.keys(columns).map((c) => `"${c}"`).join(", ");
  await prisma.$executeRawUnsafe(`INSERT INTO "DuesGenerationProgress" (${names}) VALUES (${Object.values(columns).join(", ")})`);
}

async function expectViolation(overrides: Record<string, string>, constraint: string) {
  await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
  await expect(insert(overrides)).rejects.toThrow(constraint);
}

describe("DuesGenerationProgress CHECK constraints", () => {
  it("a minimal row (a fresh segment, as stage 9 or rollover inserts it) is valid", async () => {
    await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
    await insert();
    expect(await prisma.duesGenerationProgress.count({ where: { organizationId: fx.org.id } })).toBe(1);
  });

  it("month 1-12 and year 2000-2100", async () => {
    await expectViolation({ month: "13" }, "DuesGenerationProgress_month_valid");
    await expectViolation({ year: "1999" }, "DuesGenerationProgress_year_sane");
  });

  it("pass counts are never negative", async () => {
    await expectViolation({ cursorStudentId: "'s1'", passStartedAt: "now()", passPending: "-1" }, "DuesGenerationProgress_counts_nonnegative");
  });

  it("a pass with no committed student has no start time and no counts; one with a student has a start time", async () => {
    await expectViolation({ passCovered: "1" }, "DuesGenerationProgress_pass_state_complete");
    await expectViolation({ passStartedAt: "now()" }, "DuesGenerationProgress_pass_state_complete");
    await expectViolation({ cursorStudentId: "'s1'" }, "DuesGenerationProgress_pass_state_complete");
    await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
    await insert({ cursorStudentId: "'s1'", passStartedAt: "now()", passCovered: "1" });
  });

  it("a lease is a token and an expiry together", async () => {
    await expectViolation({ leaseToken: "'t'" }, "DuesGenerationProgress_lease_complete");
    await expectViolation({ leaseUntil: "now()" }, "DuesGenerationProgress_lease_complete");
  });

  it("the crash marker names a student with at least one attempt, or is fully clear", async () => {
    await expectViolation({ inFlightStudentId: "'s1'" }, "DuesGenerationProgress_marker_complete"); // attempts default 0
    await expectViolation({ inFlightAttempts: "2" }, "DuesGenerationProgress_marker_complete");
  });

  it("the last finished pass is recorded whole, and 'clean' means exactly zero unpriced and zero pending", async () => {
    const whole = { lastPassCompletedAt: "now()", lastPassIneligible: "0", lastPassCovered: "3", lastPassUnpriced: "0", lastPassPending: "0", lastPassClean: "true" };
    await expectViolation({ lastPassCompletedAt: "now()" }, "DuesGenerationProgress_last_pass_complete");
    await expectViolation({ ...whole, lastPassUnpriced: "1" }, "DuesGenerationProgress_last_pass_complete"); // unpriced cannot be clean
    await expectViolation({ ...whole, lastPassPending: "1" }, "DuesGenerationProgress_last_pass_complete"); // pending cannot be clean
    await expectViolation({ ...whole, lastPassClean: "false" }, "DuesGenerationProgress_last_pass_complete"); // zero work is clean
    await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
    await insert(whole);
    await insert({ ...whole, lastPassUnpriced: "2", lastPassClean: "false" }, 2);
  });
});

describe("DuesGenerationProgress keys and indexes", () => {
  it("one row per (organization, year, month)", async () => {
    await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
    await insert({}, 5);
    await expect(insert({}, 5)).rejects.toThrow("DuesGenerationProgress_organizationId_year_month_key");
  });

  it("the organization must exist (foreign key)", async () => {
    await expect(insert({ organizationId: "'no-such-organization'" }, 6)).rejects.toThrow("DuesGenerationProgress_organizationId_fkey");
  });

  it("the discovery index (lastVisitedAt, id) exists", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE tablename = 'DuesGenerationProgress' AND indexname = 'DuesGenerationProgress_lastVisitedAt_id_idx'`;
    expect(rows[0]?.indexdef).toContain('("lastVisitedAt", id)');
  });
});
