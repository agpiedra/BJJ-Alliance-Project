import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { forceDeleteForTest } from "../helpers/force-delete";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { makeClassStudent, cleanupClassFixtures } from "../helpers/class-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * MONTHLY-GENERATION-ALERTING-PLAN.md §7.1 (tests 1–5): the bounded detection read against the real database.
 * - it reads EVERY progress row (a suspended organization's too) and counts students of ANY status;
 * - over its cap it reports overflow (condition D) instead of evaluating a partial list;
 * - a lock past its timeouts makes it fail (condition D) within its bounds and release its connection;
 * - it runs in a READ ONLY transaction;
 * - on today's production state (an empty progress table) it reports nothing.
 */
const { readGenerationAlertState } = await import("../../src/lib/tenant/platform-lookups");
const { detectGenerationAlerts, evaluateGenerationAlerts, DETECTION_BOUNDS } = await import("../../src/lib/dues/monthly-generation-alerts");
const { unscopedPrisma } = await import("../../src/lib/prisma/unscoped");

const prisma = getTestPrismaClient();
let fixture: Awaited<ReturnType<typeof makeAccountingOrg>> | undefined;

async function holdTableLock() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const held = new Promise<void>((r) => (locked = r));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "DuesGenerationProgress" IN ACCESS EXCLUSIVE MODE`);
      locked();
      await gate;
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
  await held;
  return async () => {
    release();
    await done;
  };
}

beforeAll(async () => {
  expect(await prisma.duesGenerationProgress.count(), "precondition: no progress rows").toBe(0);
});

afterAll(async () => {
  if (fixture) await forceDeleteForTest(prisma, { sql: `DELETE FROM "DuesGenerationProgress" WHERE "organizationId" = $1`, params: [fixture.org.id] });
  await cleanupClassFixtures();
  await fixture?.drop();
});

describe("the alert detection read (bounded, read-only)", () => {
  it("REQUIRED (test 5): today's production state — an empty progress table — reports nothing, and every check would succeed", async () => {
    const state = await readGenerationAlertState(500, DETECTION_BOUNDS);
    expect(state).toEqual({ progress: [], branches: [], students: [], organizations: [], activatedOrganizations: [], overflow: false });
    const report = await detectGenerationAlerts(new Date());
    expect(report).toMatchObject({ detection: "ok", newMonthAtRisk: [], olderMonthNotClean: [], conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] }, workload: { reasons: [] } });
  });

  it("REQUIRED (test 1): every progress row is read — a SUSPENDED organization's too — and students of ANY status are counted", async () => {
    fixture = await makeAccountingOrg("CUMULATIVE", "alerts-read");
    await prisma.organization.update({ where: { id: fixture.org.id }, data: { status: "SUSPENDED" } });
    const white = await fixture.rankId("WHITE");
    const active = await makeClassStudent(fixture.academy.id, fixture.org.id, { rankId: white });
    const archived = await makeClassStudent(fixture.academy.id, fixture.org.id, { rankId: white });
    await prisma.student.update({ where: { id: archived.student.id }, data: { status: "ARCHIVED" } });
    expect(active.student.status).toBe("ACTIVE");
    await prisma.duesGenerationProgress.createMany({
      data: [
        // A finished pass is recorded whole (DuesGenerationProgress_last_pass_complete): unclean = 1 unpriced student.
        {
          organizationId: fixture.org.id, year: 2031, month: 9, lastVisitedAt: new Date(), lastPassCompletedAt: new Date(),
          lastPassIneligible: 0, lastPassCovered: 0, lastPassUnpriced: 1, lastPassPending: 0, lastPassClean: false,
        },
        { organizationId: fixture.org.id, year: 2031, month: 10, lastVisitedAt: new Date() },
      ],
    });

    const state = await readGenerationAlertState(500, DETECTION_BOUNDS);
    expect(state.overflow).toBe(false);
    expect(state.progress).toHaveLength(2);
    expect(state.branches).toEqual([{ organizationId: fixture.org.id, timezone: fixture.academy.timezone }]);
    expect(state.students).toEqual([{ organizationId: fixture.org.id, count: 2 }]);
    expect(state.organizations).toEqual([{ organizationId: fixture.org.id, status: "SUSPENDED" }]);

    // SUSPENDED: refused at the visit gate, so it owes no billing — no A or B — but its rows count as workload.
    const when = new Date("2031-11-02T00:00:00Z");
    const suspended = evaluateGenerationAlerts(state, when);
    expect(suspended).toMatchObject({ newMonthAtRisk: [], olderMonthNotClean: [], notActiveOrganizations: [fixture.org.id] });
    expect(suspended.workload!.counts).toMatchObject({ progressRows: 2, studentsTotal: 2 });

    // The same rows for an ACTIVE organization: B for both older months, A for the missing November row.
    await prisma.organization.update({ where: { id: fixture.org.id }, data: { status: "ACTIVE" } });
    const report = evaluateGenerationAlerts(await readGenerationAlertState(500, DETECTION_BOUNDS), when);
    expect(report.olderMonthNotClean).toEqual([
      { organizationId: fixture.org.id, year: 2031, month: 9 },
      { organizationId: fixture.org.id, year: 2031, month: 10 },
    ]);
    expect(report.newMonthAtRisk).toEqual([{ organizationId: fixture.org.id, year: 2031, month: 11 }]); // no November row
  });

  it("REQUIRED (test 2): more rows than the cap is overflow (condition D) — never a partial evaluation", async () => {
    const state = await readGenerationAlertState(1, DETECTION_BOUNDS);
    expect(state).toEqual({ progress: [], branches: [], students: [], organizations: [], activatedOrganizations: [], overflow: true });
    expect(evaluateGenerationAlerts(state, new Date()).detection).toBe("overflow");
  });

  it("REQUIRED (test 3): a lock held past the read's timeouts fails it (condition D) within its bounds, and its connection is released", async () => {
    const release = await holdTableLock();
    const tiny = { maxWaitMs: 500, timeoutMs: 1_000, statementTimeoutMs: 300, lockTimeoutMs: 200, idleInTransactionTimeoutMs: 300 };
    const t0 = Date.now();
    let report: Awaited<ReturnType<typeof detectGenerationAlerts>>;
    try {
      report = await detectGenerationAlerts(new Date(), (cap) => readGenerationAlertState(cap, tiny));
    } finally {
      await release();
    }
    const waited = Date.now() - t0;
    expect(report.detection).not.toBe("ok");
    expect(report.detection).toMatch(/^(P\d{4}|PrismaClient\w+Error|unrecognized_error)$/); // a safe code only
    expect(report.workload).toBeNull();
    expect(waited).toBeLessThan(tiny.maxWaitMs + tiny.timeoutMs + tiny.statementTimeoutMs + 1_500);
    // The connection came back: the next read works normally.
    expect((await readGenerationAlertState(500, DETECTION_BOUNDS)).overflow).toBe(false);
  }, 30_000);

  it("REQUIRED (test 4): the read is READ ONLY — the database itself refuses a write inside such a transaction, and the read uses one", async () => {
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe(`UPDATE "DuesGenerationProgress" SET "inFlightAttempts" = "inFlightAttempts" WHERE false`);
      }),
    ).rejects.toThrow(/read-only transaction/);
    const source = readFileSync("src/lib/tenant/platform-lookups.ts", "utf8");
    const body = source.slice(source.indexOf("export async function readGenerationAlertState"));
    expect(body.indexOf('"SET TRANSACTION READ ONLY"')).toBeGreaterThan(-1);
    expect(body.indexOf('"SET TRANSACTION READ ONLY"')).toBeLessThan(body.indexOf("findMany")); // first, before any read
    const fn = body.slice(0, body.search(/\r?\n\}\r?\n/)); // this function only, whatever the file's line endings
    expect(fn).toContain("groupBy");
    expect(fn).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(|\$executeRaw`/);
  });
});
