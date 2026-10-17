import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

/**
 * docs/SUPERADMIN_MONITORING_PLAN.md Increment 0 — /platform/monitoring's data access against a
 * real database: the real `requireSuperAdmin()` (only `auth()` is mocked), real queries, real rows.
 *
 * Every activity fixture is placed around a snapshot instant far from "now" (SNAPSHOT below), so
 * rows other test files write at the real current time can never fall inside the window under test.
 */
let currentSession: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { loadMonitoringSnapshot, RECENT_EVENT_LIMIT } = await import("../../src/lib/monitoring/load-monitoring");
const { STALE_AFTER_HOURS } = await import("../../src/lib/jobs/job-health");

const prisma = getTestPrismaClient();

const SNAPSHOT = new Date("2031-03-10T12:00:00.000Z");
const HOUR = 3_600_000;
const WINDOW_START = new Date(SNAPSHOT.getTime() - 24 * HOUR);
const at = (offsetMs: number, from: Date = SNAPSHOT) => new Date(from.getTime() + offsetMs);

const userIds: string[] = [];
let organizationId: string;
let organizationName: string;
let academyId: string;

async function makeUser(overrides: { isSuperAdmin: boolean; active?: boolean }) {
  const user = await prisma.user.create({
    data: {
      email: `monitoring-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      isSuperAdmin: overrides.isSuperAdmin,
      active: overrides.active ?? true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function expectRefusedWith404() {
  const error = await loadMonitoringSnapshot(SNAPSHOT).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected a refusal").not.toBeNull();
  expect((error as { digest?: string }).digest).toContain("404");
}

async function clearFixtures() {
  await prisma.kioskAttempt.deleteMany({ where: { createdAt: { gte: at(-48 * HOUR), lte: at(48 * HOUR) } } });
  await prisma.auditLog.deleteMany({ where: { createdAt: { gte: at(-48 * HOUR), lte: at(48 * HOUR) } } });
  await prisma.jobRun.deleteMany({ where: { jobName: "weekly-digest" } });
}

beforeAll(async () => {
  const academy = await prisma.academy.findFirstOrThrow({ select: { id: true, organizationId: true, organization: { select: { name: true } } } });
  academyId = academy.id;
  organizationId = academy.organizationId;
  organizationName = academy.organization.name;
});

afterEach(() => {
  currentSession = null;
});

afterAll(async () => {
  await clearFixtures();
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("/platform/monitoring — authorization at the data-access boundary", () => {
  it("REQUIRED: an unauthenticated caller is refused with notFound()", async () => {
    currentSession = null;
    await expectRefusedWith404();
  });

  it("REQUIRED: an organization admin who is not a superadmin is refused with notFound()", async () => {
    const orgAdmin = await makeUser({ isSuperAdmin: false });
    currentSession = { user: { id: orgAdmin.id } };
    await expectRefusedWith404();
  });

  it("REQUIRED: an INACTIVE superadmin is refused with notFound()", async () => {
    const inactive = await makeUser({ isSuperAdmin: true, active: false });
    currentSession = { user: { id: inactive.id } };
    await expectRefusedWith404();
  });

  it("REQUIRED: an active superadmin gets every panel", async () => {
    const superAdmin = await makeUser({ isSuperAdmin: true });
    currentSession = { user: { id: superAdmin.id } };
    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    for (const panel of [snapshot.database, snapshot.jobs, snapshot.kiosk, snapshot.payments, snapshot.accessDenials, snapshot.privilegedChanges]) {
      expect(panel.status).toBe("ok");
    }
    expect(snapshot.database).toMatchObject({ status: "ok", data: { reachable: true } });
  });
});

describe("/platform/monitoring — activity window, limits and selected fields", () => {
  beforeEach(async () => {
    await clearFixtures();
    const superAdmin = await makeUser({ isSuperAdmin: true });
    currentSession = { user: { id: superAdmin.id } };
  });

  it("REQUIRED: zero activity in the window loads as zeros and empty lists", async () => {
    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    expect(snapshot.kiosk).toEqual({ status: "ok", data: { recordedSuccessful: 0, countedTowardPinLimit: 0, other: 0 } });
    expect(snapshot.payments).toEqual({ status: "ok", data: { recordedEvents: 0 } });
    expect(snapshot.accessDenials).toEqual({ status: "ok", data: [] });
    expect(snapshot.privilegedChanges).toEqual({ status: "ok", data: [] });
  });

  it("REQUIRED: kiosk counts include both window edges and exclude one millisecond outside either edge", async () => {
    const attempt = (createdAt: Date, success: boolean, countsAsFailure: boolean) => ({
      academyId,
      organizationId,
      kioskTokenHash: "monitoring-test-token-hash",
      ipAddress: "203.0.113.9",
      success,
      countsAsFailure,
      createdAt,
    });
    await prisma.kioskAttempt.createMany({
      data: [
        attempt(at(-1, WINDOW_START), true, false), // outside
        attempt(WINDOW_START, true, false), // start edge — inside
        attempt(at(-6 * HOUR), true, true), // success wins regardless of countsAsFailure
        attempt(at(-5 * HOUR), false, true),
        attempt(at(-4 * HOUR), false, true),
        attempt(at(-3 * HOUR), false, false),
        attempt(SNAPSHOT, false, false), // end edge — inside
        attempt(at(1), false, true), // outside
      ],
    });

    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    expect(snapshot.kiosk).toEqual({ status: "ok", data: { recordedSuccessful: 2, countedTowardPinLimit: 2, other: 2 } });
  });

  it("REQUIRED: payment events are a count of duesPayment.record rows inside the window only", async () => {
    const event = (createdAt: Date, action = "duesPayment.record") => ({
      organizationId,
      action,
      entityType: "DuesPayment",
      entityId: `payment-${createdAt.getTime()}-${action}`,
      after: { tenderAmount: 45000, studentId: "student-should-never-surface" },
      createdAt,
    });
    await prisma.auditLog.createMany({
      data: [event(at(-1, WINDOW_START)), event(WINDOW_START), event(at(-HOUR)), event(SNAPSHOT), event(at(1)), event(at(-HOUR), "organization.currencyChange")],
    });

    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    expect(snapshot.payments).toEqual({ status: "ok", data: { recordedEvents: 3 } });
    expect(JSON.stringify(snapshot)).not.toContain("45000");
    expect(JSON.stringify(snapshot)).not.toContain("student-should-never-surface");
  });

  it("REQUIRED: access denials are capped at 50, newest first, id breaking ties — the same rows an independent SQL query returns", async () => {
    const actor = await makeUser({ isSuperAdmin: false });
    const tied = at(-2 * HOUR);
    await prisma.auditLog.createMany({
      data: [
        ...Array.from({ length: 55 }, (_, index) => ({
          actorId: actor.id,
          organizationId,
          action: "organization.accessRefused",
          entityType: "Organization",
          entityId: organizationId,
          after: { reason: "not_member", attemptedRoles: ["ADMIN"] },
          // Five rows share one instant so ordering must fall back to id.
          createdAt: index < 5 ? tied : at(-(index + 1) * 60_000),
        })),
        { actorId: actor.id, organizationId, action: "organization.accessRefused", entityType: "Organization", entityId: organizationId, createdAt: at(-1, WINDOW_START) },
      ],
    });

    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    if (snapshot.accessDenials.status !== "ok") throw new Error("accessDenials did not load");
    const events = snapshot.accessDenials.data;

    expect(RECENT_EVENT_LIMIT).toBe(50);
    expect(events).toHaveLength(50);
    const expected = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AuditLog"
      WHERE action = 'organization.accessRefused' AND "createdAt" >= ${WINDOW_START} AND "createdAt" <= ${SNAPSHOT}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 50`;
    expect(events.map((event) => event.id)).toEqual(expected.map((row) => row.id));

    // Selected fields only: no before/after payload, no extra columns.
    expect(Object.keys(events[0]).sort()).toEqual(["action", "actorId", "createdAt", "entityId", "entityType", "id", "organizationName"]);
    expect(events[0]).toMatchObject({ actorId: actor.id, organizationName, entityType: "Organization" });
    expect(JSON.stringify(events)).not.toContain("not_member");
  });

  it("REQUIRED: privileged changes include platform-admin actions (with or without an organization) and nothing else", async () => {
    const actor = await makeUser({ isSuperAdmin: true });
    await prisma.auditLog.createMany({
      data: [
        { actorId: actor.id, organizationId, action: "organization.suspend", entityType: "Organization", entityId: organizationId, createdAt: at(-3 * HOUR) },
        { actorId: actor.id, organizationId: null, action: "user.superAdminGranted", entityType: "User", entityId: actor.id, createdAt: at(-2 * HOUR) },
        { actorId: actor.id, organizationId, action: "organizationBranding.updateTheme", entityType: "Organization", entityId: organizationId, createdAt: at(-HOUR) },
        { actorId: actor.id, organizationId, action: "duesPayment.record", entityType: "DuesPayment", entityId: "p-1", createdAt: at(-HOUR) },
      ],
    });

    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    if (snapshot.privilegedChanges.status !== "ok") throw new Error("privilegedChanges did not load");
    expect(snapshot.privilegedChanges.data.map((event) => [event.action, event.organizationName])).toEqual([
      ["user.superAdminGranted", null],
      ["organization.suspend", organizationName],
    ]);
  });
});

describe("/platform/monitoring — scheduled jobs over all history", () => {
  beforeEach(async () => {
    await clearFixtures();
    const superAdmin = await makeUser({ isSuperAdmin: true });
    currentSession = { user: { id: superAdmin.id } };
  });

  async function weeklyDigest() {
    const snapshot = await loadMonitoringSnapshot(SNAPSHOT);
    if (snapshot.jobs.status !== "ok") throw new Error("jobs did not load");
    const job = snapshot.jobs.data.find((entry) => entry.jobName === "weekly-digest");
    if (!job) throw new Error("weekly-digest missing");
    return job;
  }

  it("REQUIRED: no recorded run is reported as its own state, not as zero activity or a failure", async () => {
    const job = await weeklyDigest();
    expect(job).toMatchObject({ freshness: "no_recorded_run", latestRun: null, latestSuccess: null, stuck: false });
  });

  it("REQUIRED: a run older than the configured threshold is overdue, even though it succeeded", async () => {
    const startedAt = at(-(STALE_AFTER_HOURS["weekly-digest"] + 1) * HOUR);
    await prisma.jobRun.create({ data: { jobName: "weekly-digest", status: "SUCCEEDED", startedAt, finishedAt: at(60_000, startedAt) } });

    const job = await weeklyDigest();
    expect(job.freshness).toBe("overdue");
    expect(job.latestRun?.status).toBe("SUCCEEDED");
    expect(job.latestSuccess?.startedAt).toEqual(startedAt);
  });

  it("REQUIRED: a recent FAILED run is FAILED while on schedule and not stuck; the last success is a separate, older row", async () => {
    const successAt = at(-9 * 24 * HOUR);
    const partialAt = at(-5 * 24 * HOUR);
    const failedAt = at(-2 * 24 * HOUR);
    await prisma.jobRun.createMany({
      data: [
        { jobName: "weekly-digest", status: "SUCCEEDED", startedAt: successAt, finishedAt: at(60_000, successAt) },
        { jobName: "weekly-digest", status: "PARTIAL", startedAt: partialAt, finishedAt: at(60_000, partialAt), failed: 1 },
        { jobName: "weekly-digest", status: "FAILED", startedAt: failedAt, finishedAt: at(60_000, failedAt), failed: 3, heartbeatStatus: "failed" },
      ],
    });

    const job = await weeklyDigest();
    expect(job).toMatchObject({ freshness: "on_schedule", stuck: false });
    expect(job.latestRun).toEqual({ status: "FAILED", startedAt: failedAt, finishedAt: at(60_000, failedAt), failed: 3, heartbeatStatus: "failed" });
    expect(job.latestSuccess).toEqual({ startedAt: successAt, finishedAt: at(60_000, successAt) });
  });

  it("job rows outside the 24-hour activity window still count — jobs are not windowed", async () => {
    const startedAt = at(-6 * 24 * HOUR);
    await prisma.jobRun.create({ data: { jobName: "weekly-digest", status: "SUCCEEDED", startedAt, finishedAt: at(60_000, startedAt) } });
    const job = await weeklyDigest();
    expect(job).toMatchObject({ freshness: "on_schedule", latestRun: { status: "SUCCEEDED", startedAt } });
  });
});
