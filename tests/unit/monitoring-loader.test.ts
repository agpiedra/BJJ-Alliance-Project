import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * docs/SUPERADMIN_MONITORING_PLAN.md Increment 0 — the /platform/monitoring data-access boundary.
 * The guard and every query are mocked here so ORDER and ISOLATION can be asserted directly; the
 * real guard and real queries are exercised against the test database in
 * tests/integration/platform-monitoring.test.ts.
 */
const requireSuperAdmin = vi.fn();
vi.mock("@/lib/auth/require-super-admin", () => ({ requireSuperAdmin: () => requireSuperAdmin() }));

const getDatabaseHealth = vi.fn();
vi.mock("@/lib/health/database-check", () => ({ getDatabaseHealth: () => getDatabaseHealth() }));

const lookups = {
  countKioskAttemptsByOutcome: vi.fn(),
  countDuesPaymentRecordEvents: vi.fn(),
  listRecentAuditEvents: vi.fn(),
  getJobRunSummary: vi.fn(),
};
vi.mock("@/lib/tenant/platform-lookups", () => ({
  countKioskAttemptsByOutcome: (...args: unknown[]) => lookups.countKioskAttemptsByOutcome(...args),
  countDuesPaymentRecordEvents: (...args: unknown[]) => lookups.countDuesPaymentRecordEvents(...args),
  listRecentAuditEvents: (...args: unknown[]) => lookups.listRecentAuditEvents(...args),
  getJobRunSummary: (...args: unknown[]) => lookups.getJobRunSummary(...args),
}));

const { loadMonitoringSnapshot, classifyJob, ACCESS_DENIAL_ACTIONS, PRIVILEGED_CHANGE_ACTIONS, MONITORING_WINDOW_MS, RECENT_EVENT_LIMIT } = await import(
  "../../src/lib/monitoring/load-monitoring"
);
const { resolveJobSchedule, STALE_AFTER_HOURS, STUCK_AFTER_MINUTES } = await import("../../src/lib/jobs/job-health");

const NOW = new Date("2031-03-10T12:00:00.000Z");
const HOUR = 3_600_000;

function allQueryMocks() {
  return [getDatabaseHealth, ...Object.values(lookups)];
}

beforeEach(() => {
  requireSuperAdmin.mockReset().mockResolvedValue({ actorUserId: "super-1" });
  getDatabaseHealth.mockReset().mockResolvedValue({ ok: true, checkedAt: new Date(NOW.getTime() - 2_000) });
  lookups.countKioskAttemptsByOutcome.mockReset().mockResolvedValue({ recordedSuccessful: 0, countedTowardPinLimit: 0, other: 0 });
  lookups.countDuesPaymentRecordEvents.mockReset().mockResolvedValue(0);
  lookups.listRecentAuditEvents.mockReset().mockResolvedValue([]);
  lookups.getJobRunSummary.mockReset().mockResolvedValue({ latestRun: null, latestSuccess: null });
});

describe("loadMonitoringSnapshot — authorization", () => {
  it("REQUIRED: a refusal propagates unchanged (never becomes 'panel unavailable') and no monitoring query starts", async () => {
    const refusal = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    requireSuperAdmin.mockRejectedValue(refusal);

    await expect(loadMonitoringSnapshot(NOW)).rejects.toBe(refusal);
    for (const mock of allQueryMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("REQUIRED: no query is launched until authorization has resolved", async () => {
    let authorize!: () => void;
    requireSuperAdmin.mockReturnValue(new Promise<void>((resolve) => (authorize = resolve)));

    const pending = loadMonitoringSnapshot(NOW);
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const mock of allQueryMocks()) expect(mock).not.toHaveBeenCalled();

    authorize();
    await pending;
    expect(lookups.countKioskAttemptsByOutcome).toHaveBeenCalledTimes(1);
  });
});

describe("loadMonitoringSnapshot — panels", () => {
  it("REQUIRED: one failed panel query renders only that panel unavailable; every other panel still loads", async () => {
    lookups.countKioskAttemptsByOutcome.mockRejectedValue(new Error("relation does not exist"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const snapshot = await loadMonitoringSnapshot(NOW);

    expect(snapshot.kiosk).toEqual({ status: "unavailable" });
    expect(snapshot.database.status).toBe("ok");
    expect(snapshot.jobs.status).toBe("ok");
    expect(snapshot.payments).toEqual({ status: "ok", data: { recordedEvents: 0 } });
    expect(snapshot.accessDenials).toEqual({ status: "ok", data: [] });
    expect(snapshot.privilegedChanges).toEqual({ status: "ok", data: [] });
  });

  it("REQUIRED: zero activity is data (ok with zeros / empty lists), not unavailable", async () => {
    const snapshot = await loadMonitoringSnapshot(NOW);
    expect(snapshot.kiosk).toEqual({ status: "ok", data: { recordedSuccessful: 0, countedTowardPinLimit: 0, other: 0 } });
    expect(snapshot.payments).toEqual({ status: "ok", data: { recordedEvents: 0 } });
    expect(snapshot.accessDenials).toEqual({ status: "ok", data: [] });
  });

  it("REQUIRED: every activity panel reads the same window ending at one snapshot instant, lists capped at 50", async () => {
    const snapshot = await loadMonitoringSnapshot(NOW);
    const window = { start: new Date(NOW.getTime() - MONITORING_WINDOW_MS), end: NOW };

    expect(MONITORING_WINDOW_MS).toBe(24 * HOUR);
    expect(RECENT_EVENT_LIMIT).toBe(50);
    expect(snapshot.snapshotAt).toBe(NOW);
    expect(snapshot.window).toEqual(window);
    expect(lookups.countKioskAttemptsByOutcome).toHaveBeenCalledWith(window);
    expect(lookups.countDuesPaymentRecordEvents).toHaveBeenCalledWith(window);
    expect(lookups.listRecentAuditEvents).toHaveBeenCalledWith(ACCESS_DENIAL_ACTIONS, window, 50);
    expect(lookups.listRecentAuditEvents).toHaveBeenCalledWith(PRIVILEGED_CHANGE_ACTIONS, window, 50);
  });

  it("the database panel reports reachability and the cached check's own time — no duration field", async () => {
    const snapshot = await loadMonitoringSnapshot(NOW);
    expect(snapshot.database).toEqual({ status: "ok", data: { reachable: true, checkedAt: new Date(NOW.getTime() - 2_000) } });
  });
});

describe("classifyJob", () => {
  const now = NOW.getTime();
  const run = (status: string, hoursAgo: number, failed = 0) => ({
    status,
    startedAt: new Date(now - hoursAgo * HOUR),
    finishedAt: null,
    failed,
    heartbeatStatus: "ok",
  });

  it("REQUIRED: no recorded run is its own state — never on schedule, never 'overdue'", () => {
    const job = classifyJob("weekly-digest", { latestRun: null, latestSuccess: null }, now);
    expect(job).toMatchObject({ freshness: "no_recorded_run", latestRun: null, latestSuccess: null, freshUntil: null, stuck: false });
  });

  it("REQUIRED: a run older than the configured threshold is overdue", () => {
    const latest = run("SUCCEEDED", STALE_AFTER_HOURS["weekly-digest"] + 1);
    const job = classifyJob("weekly-digest", { latestRun: latest, latestSuccess: latest }, now);
    expect(job.freshness).toBe("overdue");
    expect(job.freshUntil).toEqual(new Date(latest.startedAt.getTime() + STALE_AFTER_HOURS["weekly-digest"] * HOUR));
  });

  it("exactly at the threshold is still fresh (same `>` rule as /api/health/jobs)", () => {
    const latest = run("SUCCEEDED", STALE_AFTER_HOURS["weekly-digest"]);
    expect(classifyJob("weekly-digest", { latestRun: latest, latestSuccess: latest }, now).freshness).toBe("on_schedule");
  });

  it("REQUIRED: a recent FAILED run stays FAILED while on schedule and not stuck; last success is kept separate", () => {
    const success = { startedAt: new Date(now - 200 * HOUR), finishedAt: null };
    const job = classifyJob("weekly-digest", { latestRun: run("FAILED", 48, 3), latestSuccess: success }, now);
    expect(job).toMatchObject({ freshness: "on_schedule", stuck: false });
    expect(job.latestRun).toMatchObject({ status: "FAILED", failed: 3 });
    expect(job.latestSuccess).toBe(success);
  });

  it("a RUNNING row past the stuck window is stuck", () => {
    const job = classifyJob("weekly-digest", { latestRun: run("RUNNING", (STUCK_AFTER_MINUTES + 1) / 60), latestSuccess: null }, now);
    expect(job.stuck).toBe(true);
  });
});

describe("resolveJobSchedule", () => {
  it("REQUIRED: reads the schedule from vercel.json itself, not a copied value", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    const declared = config.crons.find((cron) => cron.path === "/api/cron/weekly-digest");
    expect(resolveJobSchedule("weekly-digest")?.cron).toBe(declared?.schedule);
  });

  it("describes only the weekly shape; anything else is returned raw, a missing entry as null", () => {
    expect(resolveJobSchedule("weekly-digest", [{ path: "/api/cron/weekly-digest", schedule: "5 4 * * 3" }])).toEqual({
      cron: "5 4 * * 3",
      weekly: { weekday: 3, hourUtc: 4, minuteUtc: 5 },
    });
    expect(resolveJobSchedule("weekly-digest", [{ path: "/api/cron/weekly-digest", schedule: "*/15 * * * *" }])).toEqual({ cron: "*/15 * * * *", weekly: null });
    expect(resolveJobSchedule("weekly-digest", [])).toBeNull();
  });
});

describe("monitored audit actions", () => {
  it("REQUIRED: every action the page filters on is one some production writer actually records", () => {
    const writers = productionSourceFiles(["src"])
      .filter(({ file }) => !file.includes("monitoring"))
      .map(({ text }) => stripComments(text))
      .join("\n");
    for (const action of [...ACCESS_DENIAL_ACTIONS, ...PRIVILEGED_CHANGE_ACTIONS, "duesPayment.record"]) {
      expect(writers, action).toContain(`action: "${action}"`);
    }
  });
});
