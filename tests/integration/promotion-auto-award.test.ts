import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { TenantContext } from "../../src/lib/tenant/types";

// C1: lets exactly one test (below) direct one real organization id to throw from
// runAutomaticStripeAwardsForOrganization, without touching production code — every other
// organization id (including every test in this file that calls it directly) still runs
// the REAL implementation, forwarded to `actual`. Same shape as
// tests/integration/weekly-digest.test.ts's own `digestFailureState`.
const autoAwardFailureState = vi.hoisted(() => ({ failOrganizationId: null as string | null }));

vi.mock("../../src/lib/promotion/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/promotion/automation")>();
  return {
    ...actual,
    runAutomaticStripeAwardsForOrganization: vi.fn(async (organizationId: string, batchSize?: number) => {
      if (organizationId === autoAwardFailureState.failOrganizationId) {
        throw new Error("SIMULATED_AUTO_AWARD_FAILURE_FOR_TEST");
      }
      return actual.runAutomaticStripeAwardsForOrganization(organizationId, batchSize);
    }),
  };
});

const { GET } = await import("../../src/app/api/cron/promotion-auto-award/route");
const { runAutomaticStripeAwardsForOrganization } = await import("../../src/lib/promotion/automation");
const { listPromotionQueue } = await import("../../src/lib/students/promotion-queue");
const attendanceSummaryModule = await import("../../src/lib/students/attendance-summary");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");
const DAY_MS = 24 * 60 * 60 * 1000;

function ctx(organizationId: string): TenantContext {
  return {
    kind: "tenant",
    actorUserId: "x",
    organizationId,
    organizationRole: "ADMIN",
    academyIds: "ALL",
    selfStudentId: null, linkedStudentId: null,
  };
}

function request(secret: string | null): Request {
  return new Request("http://localhost/api/cron/promotion-auto-award", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

/**
 * A scratch org with approval OFF for ADULT — the only way to exercise this
 * job at all: Alliance's own seed has `requiresCoachApproval: true`, so it
 * is a structural no-op against the only real academy in the seed. WHITE
 * (non-terminal) -> BLUE (terminal) is a real, valid 2-rank catalog, not a
 * gap — this file isn't testing the InvalidPromotionConfigError path
 * (structurally unreachable from automation anyway, since it never selects
 * a BELT target).
 */
async function makeApprovalOffOrg(suffix: string) {
  const orgId = `auto-award-org-${suffix}`;
  const academyId = `auto-award-academy-${suffix}`;
  const whiteId = `auto-award-white-${suffix}`;
  const blueId = `auto-award-blue-${suffix}`;

  await prisma.organization.create({
    data: { id: orgId, slug: orgId, name: "Auto Award Test Org", status: "ACTIVE", timezone: "America/Costa_Rica" },
  });
  await prisma.academy.create({
    data: { id: academyId, organizationId: orgId, name: "Auto Award Test Academy", slug: academyId, kioskTokenHash: `${academyId}-hash` },
  });
  await prisma.beltRank.createMany({
    data: [
      { id: whiteId, organizationId: orgId, track: "ADULT", code: "WHITE", labelEs: "Blanco", labelEn: "White", primaryColor: "#F0EBE0", barColor: "#111116", order: 1, maxStripes: 4, isTerminal: false, attendancesPerStripe: 30, attendancesForExam: 30, stripeColors: ["a", "b", "c", "d"] },
      { id: blueId, organizationId: orgId, track: "ADULT", code: "BLUE", labelEs: "Azul", labelEn: "Blue", primaryColor: "#215DA5", barColor: "#111116", order: 2, maxStripes: 4, isTerminal: true, attendancesPerStripe: 65, attendancesForExam: 65, stripeColors: ["a", "b", "c", "d"] },
    ],
  });
  await prisma.promotionConfig.create({
    data: { organizationId: orgId, track: "ADULT", mode: "ATTENDANCE", requiresCoachApproval: false },
  });
  return { orgId, academyId, whiteId, blueId };
}

async function cleanupOrg(orgId: string, academyId: string) {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotion.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendanceRecord.deleteMany({ where: { organizationId: orgId } });
  await prisma.student.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: orgId } });
  await prisma.beltRank.deleteMany({ where: { organizationId: orgId } });
  await prisma.academy.deleteMany({ where: { id: academyId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

async function makeStudent(academyId: string, organizationId: string, rankId: string, currentStripes: number, beltAwardedAt: Date) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "AutoAwardTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `auto-award-${suffix}@example.com`,
      currentRankId: rankId,
      currentStripes,
      beltAwardedAt,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`auto-award-${suffix}`, pepper),
    },
  });
}

async function addAttendances(studentId: string, academyId: string, organizationId: string, count: number, startAt: Date) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

describe("GET /api/cron/promotion-auto-award", () => {
  // These tests call the REAL route, which (C1) writes a real JobRun row on every call —
  // cleaned up here so a leftover row doesn't outrank a deliberately old fixture row in
  // tests/integration/health-jobs-endpoint.test.ts's own "most recent run" query. Cleanup
  // is by ID SET (snapshot before, delete whatever's new after), not by `startedAt` — a
  // wall-clock comparison between this process and the database server is vulnerable to
  // clock skew between the two.
  let jobRunIdsBeforeSuite: Set<string>;
  beforeAll(async () => {
    jobRunIdsBeforeSuite = new Set(
      (await prisma.jobRun.findMany({ where: { jobName: "promotion-auto-award" }, select: { id: true } })).map((r) => r.id),
    );
  });
  afterAll(async () => {
    await prisma.jobRun.deleteMany({ where: { jobName: "promotion-auto-award", id: { notIn: [...jobRunIdsBeforeSuite] } } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await GET(request(null));
    expect(response.status).toBe(401);
  });

  it("returns 401 when the Authorization header doesn't match CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await GET(request("wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("awards a genuinely stripe-eligible student end to end, with source AUTO and no invented human awardedById", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { orgId, academyId, whiteId } = await makeApprovalOffOrg("happy");
    try {
      const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
      const student = await makeStudent(academyId, orgId, whiteId, 0, beltAwardedAt);
      await addAttendances(student.id, academyId, orgId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

      const response = await GET(request("test-cron-secret"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      // C1: the route surfaces real counts, not just an opaque `results` array.
      expect(body.sent).toBeGreaterThanOrEqual(1);
      expect(body.failed).toBe(0);

      const promotions = await prisma.promotion.findMany({ where: { studentId: student.id } });
      expect(promotions).toHaveLength(1);
      expect(promotions[0]).toMatchObject({ source: "AUTO", awardedById: null, fromStripes: 0, toStripes: 1 });

      const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(after.currentStripes).toBe(1);
      // Stripe award — the anchor is untouched (the 47 -> 17 rule).
      expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

      // C1: the run is recorded on JobRun, SUCCEEDED, with the same sent count the response
      // reported — this is the row the health endpoint and Healthchecks.io heartbeat rely on.
      const run = await prisma.jobRun.findFirst({ where: { jobName: "promotion-auto-award" }, orderBy: { startedAt: "desc" } });
      expect(run).toMatchObject({ status: "SUCCEEDED", sent: body.sent, failed: 0 });
      expect(run!.finishedAt).not.toBeNull();
    } finally {
      await cleanupOrg(orgId, academyId);
    }
  });

  it("REQUIRED (C1): one organization throwing doesn't block the others, and is recorded — PARTIAL, not SUCCEEDED", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const good = await makeApprovalOffOrg("c1-good");
    const bad = await makeApprovalOffOrg("c1-bad");
    autoAwardFailureState.failOrganizationId = bad.orgId;
    try {
      const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
      const student = await makeStudent(good.academyId, good.orgId, good.whiteId, 0, beltAwardedAt);
      await addAttendances(student.id, good.academyId, good.orgId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

      const response = await GET(request("test-cron-secret"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.sent).toBeGreaterThanOrEqual(1);
      expect(body.failed).toBeGreaterThanOrEqual(1);
      const failedEntry = body.errors.find((e: { organizationId: string }) => e.organizationId === bad.orgId);
      expect(failedEntry?.error).toContain("SIMULATED_AUTO_AWARD_FAILURE_FOR_TEST");

      // The good organization still got its award — one organization's failure never blocks another.
      expect(await prisma.promotion.count({ where: { studentId: student.id, source: "AUTO" } })).toBe(1);

      // C1: PARTIAL because something both succeeded (the good org) and failed (the bad
      // org) in the same run — never silently reported as SUCCEEDED.
      const run = await prisma.jobRun.findFirst({ where: { jobName: "promotion-auto-award" }, orderBy: { startedAt: "desc" } });
      expect(run!.status).toBe("PARTIAL");
      expect(run!.failed).toBeGreaterThanOrEqual(1);
    } finally {
      autoAwardFailureState.failOrganizationId = null;
      await cleanupOrg(good.orgId, good.academyId);
      await cleanupOrg(bad.orgId, bad.academyId);
    }
  });

  it("amendment 1: a BELT-eligible student is never auto-awarded, but still appears in the promotion queue regardless of requiresCoachApproval", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { orgId, academyId, whiteId } = await makeApprovalOffOrg("belt-surfaces");
    try {
      const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
      const student = await makeStudent(academyId, orgId, whiteId, 4, beltAwardedAt);
      // 4 * 30 + 30 (attendancesForExam) = 150, exactly at the exam threshold.
      await addAttendances(student.id, academyId, orgId, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

      const response = await GET(request("test-cron-secret"));
      expect(response.status).toBe(200);

      expect(await prisma.promotion.findMany({ where: { studentId: student.id } })).toHaveLength(0);
      const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(after.currentStripes).toBe(4);

      // The director turned approval off expecting the app to still handle
      // promotions — a belt-ready student must not become invisible.
      const queue = await listPromotionQueue(ctx(orgId));
      const candidate = queue.find((c) => c.studentId === student.id);
      expect(candidate).toBeDefined();
      expect(candidate?.status).toBe("exam-eligible");
    } finally {
      await cleanupOrg(orgId, academyId);
    }
  });

  it("amendment 2 (idempotency): running the job twice in a row awards nothing further the second time", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { orgId, academyId, whiteId } = await makeApprovalOffOrg("idempotent");
    try {
      const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
      const student = await makeStudent(academyId, orgId, whiteId, 0, beltAwardedAt);
      await addAttendances(student.id, academyId, orgId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

      const first = await GET(request("test-cron-secret"));
      expect(first.status).toBe(200);
      expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(1);

      const second = await GET(request("test-cron-secret"));
      expect(second.status).toBe(200);
      expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(1);
      const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(after.currentStripes).toBe(1);
    } finally {
      await cleanupOrg(orgId, academyId);
    }
  });

  it("amendment 3 (starvation): more eligible students than the batch size are awarded oldest-beltAwardedAt-first, draining fully across repeated runs", async () => {
    const { orgId, academyId, whiteId } = await makeApprovalOffOrg("starvation");
    try {
      const students = [];
      for (let i = 0; i < 7; i++) {
        // Distinct, strictly increasing anchors — proves the ORDER, not just eventual completion.
        const beltAwardedAt = new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0));
        const student = await makeStudent(academyId, orgId, whiteId, 0, beltAwardedAt);
        await addAttendances(student.id, academyId, orgId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
        students.push(student);
      }

      const result1 = await runAutomaticStripeAwardsForOrganization(orgId, 3);
      expect(result1.awardedStudentIds).toEqual([students[0].id, students[1].id, students[2].id]);

      const result2 = await runAutomaticStripeAwardsForOrganization(orgId, 3);
      expect(result2.awardedStudentIds).toEqual([students[3].id, students[4].id, students[5].id]);

      const result3 = await runAutomaticStripeAwardsForOrganization(orgId, 3);
      expect(result3.awardedStudentIds).toEqual([students[6].id]);

      for (const student of students) {
        expect(await prisma.promotion.count({ where: { studentId: student.id, source: "AUTO" } })).toBe(1);
      }
    } finally {
      await cleanupOrg(orgId, academyId);
    }
  });

  it("the from-state guard: a student's state moving between candidate selection and the write is skipped as a conflict, and the rest of the batch still completes", async () => {
    const { orgId, academyId, whiteId } = await makeApprovalOffOrg("conflict");
    try {
      const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
      const contested = await makeStudent(academyId, orgId, whiteId, 0, beltAwardedAt);
      const unaffected = await makeStudent(academyId, orgId, whiteId, 0, new Date(beltAwardedAt.getTime() + DAY_MS));
      await addAttendances(contested.id, academyId, orgId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
      await addAttendances(unaffected.id, academyId, orgId, 30, new Date(beltAwardedAt.getTime() + 2 * DAY_MS));

      const original = attendanceSummaryModule.getAtBeltSummary;
      const spy = vi.spyOn(attendanceSummaryModule, "getAtBeltSummary").mockImplementation(async (studentId, organizationId, configByTrack) => {
        const result = await original(studentId, organizationId, configByTrack);
        if (studentId === contested.id) {
          // Simulate a concurrent manual confirm landing strictly between
          // this read (which established fromStripes) and writeAward's own
          // from-state-guarded write below.
          await prisma.student.update({ where: { id: contested.id }, data: { currentStripes: { increment: 1 } } });
        }
        return result;
      });

      let result;
      try {
        result = await runAutomaticStripeAwardsForOrganization(orgId, 10);
      } finally {
        spy.mockRestore();
      }

      expect(result.awardedStudentIds).not.toContain(contested.id);
      expect(result.awardedStudentIds).toContain(unaffected.id);
      expect(result.skippedConflict).toBe(1);
      expect(result.errors).toHaveLength(0);

      // No AUTO promotion for the contested student — only the simulated
      // competing write changed their state.
      expect(await prisma.promotion.count({ where: { studentId: contested.id, source: "AUTO" } })).toBe(0);
      const contestedAfter = await prisma.student.findUniqueOrThrow({ where: { id: contested.id } });
      expect(contestedAfter.currentStripes).toBe(1);

      expect(await prisma.promotion.count({ where: { studentId: unaffected.id, source: "AUTO" } })).toBe(1);
    } finally {
      await cleanupOrg(orgId, academyId);
    }
  });
});
