import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationAlertReport, GenerationAlertDetail } from "../../src/lib/dues/monthly-generation-alerts";

/**
 * Urgent monitor PR-B, integration tests B-I1–B-I27 (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md) against the real local
 * (disposable) test database. Healthchecks is a fake transport injected into the monitor: nothing leaves the machine.
 * Detection is injected unless a test needs the real read (B-I22). Every test resets the monitor's own three tables and the
 * monthly-generation JobRun rows.
 */
const { runUrgentMonitor, handleUrgentMonitorRequest } = await import("../../src/lib/monitoring/urgent/run");
const store = await import("../../src/lib/monitoring/urgent/store");
const { prisma: appPrisma } = await import("../../src/lib/prisma");
const { buildUrgentFindings, unavailableFindings } = await import("../../src/lib/dues/urgent-findings");
const { detectGenerationAlertsDetailed } = await import("../../src/lib/dues/monthly-generation-alerts");
type Deps = Parameters<typeof runUrgentMonitor>[0];

const prisma = getTestPrismaClient();
const M1 = "https://hc.example/monitor-check";
const M2 = "https://hc.example/new-check";
const H3 = 3 * 60 * 60 * 1000;
const MIN = 60_000;
const SUPPORTED = "0 */3 * * *";
const NO_ERRORS = { global: 0, organizations: [] };
const A = { organizationId: "org-a", year: 2031, month: 11 };

const okReport = (over: Partial<GenerationAlertReport> = {}): GenerationAlertReport => ({
  detection: "ok",
  newMonthAtRisk: [],
  olderMonthNotClean: [],
  notActiveOrganizations: [],
  conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
  workload: { reasons: [], counts: { progressRows: 0, organizations: 0, maxStudentsPerOrganization: 0, studentsTotal: 0, maxBranchesPerOrganization: 0 } },
  ...over,
});
const detectWith = (report: GenerationAlertReport, atRisk: GenerationAlertDetail["atRisk"] = {}) => async () => ({ report, atRisk });

type Call = { check: "M1" | "M2"; kind: "success" | "fail"; body?: string };
function fakeHc(answer: (call: Call) => number | null | Promise<number | null> = () => 200) {
  const calls: Call[] = [];
  const request: Deps["request"] = async (url, init) => {
    const call: Call = { check: url.startsWith(M1) ? "M1" : "M2", kind: url.endsWith("/fail") ? "fail" : "success", body: init.body };
    calls.push(call);
    return answer(call);
  };
  return { calls, request, m2: () => calls.filter((c) => c.check === "M2").map((c) => c.kind), m1: () => calls.filter((c) => c.check === "M1") };
}

function deps(over: Partial<Deps> = {}, hc = fakeHc()) {
  return {
    hc,
    deps: {
      db: appPrisma,
      detect: detectWith(okReport()),
      scheduleExpr: () => SUPPORTED,
      urls: { m1: M1, m2: M2 },
      request: hc.request,
      sleep: async () => undefined,
      elapsedMs: () => 0,
      newLeaseId: () => randomUUID(),
      ...over,
    } satisfies Deps,
  };
}
/** One monitor run, with the 75 s spacing reset first (tests run several monitor runs within seconds). */
async function monitor(d: Deps) {
  await prisma.$executeRaw`UPDATE "MonitorState" SET "lastRunEndedAt" = NULL WHERE id = 1`;
  return runUrgentMonitor(d);
}
async function dbNow() {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return new Date(now);
}
const lastDueSlot = (now: Date) => new Date(Math.floor((now.getTime() - 10 * MIN) / H3) * H3);
const slotKeyOf = (d: Date) => `SLOT:${d.toISOString().slice(0, 16)}Z`;
const state = () => prisma.monitorState.findUniqueOrThrow({ where: { id: 1 } });
/** Problem key → its LATEST occurrence (most tests have one occurrence per problem). */
const keys = async () => Object.fromEntries((await prisma.urgentAlertKey.findMany({ orderBy: { occurrence: "asc" } })).map((k) => [k.problemKey, k]));
const occurrences = (problemKey: string) => prisma.urgentAlertKey.findMany({ where: { problemKey }, orderBy: { occurrence: "asc" } });
const processed = () => prisma.monitorProcessedRun.count();
/** A row as an earlier monitor run would have written it (occurrence 1). */
const keyRow = (problemKey: string, category: string, at: Date, over: object = {}) => ({
  key: `${problemKey}#1`, problemKey, occurrence: 1, category, source: "billingRun", firstSeenAt: at, lastSeenAt: at, ...over,
});
const setState = (data: Parameters<typeof prisma.monitorState.update>[0]["data"]) => prisma.monitorState.update({ where: { id: 1 }, data });
async function billingRun(startedAt: Date, finishedAt: Date | null, urgentFindings?: object | null) {
  return prisma.jobRun.create({
    data: { jobName: "monthly-generation", status: finishedAt ? "SUCCEEDED" : "RUNNING", startedAt, finishedAt, ...(urgentFindings ? { urgentFindings: urgentFindings as never } : {}) },
  });
}

async function reset() {
  await prisma.urgentAlertKey.deleteMany();
  await prisma.monitorProcessedRun.deleteMany();
  await prisma.$executeRaw`UPDATE "MonitorState" SET "leaseId" = NULL, "leaseUntil" = NULL, "lastRunEndedAt" = NULL, "watchingSince" = NULL,
    "slotCheckedThrough" = NULL, "findingsHighWater" = NULL, "m2LastSignal" = 'unknown', "lastReminderAt" = NULL WHERE id = 1`;
  await prisma.jobRun.deleteMany({ where: { jobName: "monthly-generation" } });
}
beforeEach(reset);
afterAll(reset);

describe("schema and lease (B-I1–B-I5)", () => {
  it("B-I1: one singleton row; constraints reject a second row and invalid values", async () => {
    expect(await prisma.monitorState.count()).toBe(1);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "MonitorState" (id) VALUES (2)`)).rejects.toThrow(/MonitorState_singleton/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "MonitorState" SET "m2LastSignal" = 'maybe' WHERE id = 1`)).rejects.toThrow(/MonitorState_m2LastSignal/);
    const base = `"key", "problemKey", "occurrence", "source", "firstSeenAt", "lastSeenAt"`;
    const v = `'x#1', 'x', 1, 'monitor', now(), now()`;
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "UrgentAlertKey" (${base}, "category") VALUES (${v}, 'Z')`)).rejects.toThrow(/UrgentAlertKey_category/);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "UrgentAlertKey" (${base}, "category", "missedCount") VALUES (${v}, 'A', 0)`)).rejects.toThrow(/UrgentAlertKey_missedCount/);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "UrgentAlertKey" (${base}, "category", "repeatAcceptedAt") VALUES (${v}, 'A', now())`)).rejects.toThrow(/UrgentAlertKey_repeat_after_first/);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "UrgentAlertKey" (${base}, "category") VALUES ('x#2', 'x', 1, 'monitor', now(), now(), 'A')`)).rejects.toThrow(/UrgentAlertKey_key_shape/);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "UrgentAlertKey" (${base}, "category") VALUES ('x#0', 'x', 0, 'monitor', now(), now(), 'A')`)).rejects.toThrow(/UrgentAlertKey_occurrence/);
  });

  it("B-I2: five concurrent runs: exactly one runs; the others are skipped and send nothing", async () => {
    const runs = Array.from({ length: 5 }, () => deps());
    const results = await Promise.all(runs.map((r) => runUrgentMonitor(r.deps)));
    expect(results.filter((r) => r.outcome === "ran")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(4);
    expect(runs.filter((r) => r.hc.calls.length > 0)).toHaveLength(1);
  });

  it("B-I3: spacing: a run 74 s after the previous one ended is skipped; 76 s after, it runs", async () => {
    await prisma.$executeRaw`UPDATE "MonitorState" SET "lastRunEndedAt" = (now() AT TIME ZONE 'UTC') - interval '74 seconds' WHERE id = 1`;
    expect((await runUrgentMonitor(deps().deps)).outcome).toBe("skipped");
    await prisma.$executeRaw`UPDATE "MonitorState" SET "lastRunEndedAt" = (now() AT TIME ZONE 'UTC') - interval '76 seconds' WHERE id = 1`;
    expect((await runUrgentMonitor(deps().deps)).outcome).toBe("ran");
  });

  it("B-I4: an expired lease is reclaimed; the dead run's fenced writes affect nothing and abort", async () => {
    await prisma.$executeRaw`UPDATE "MonitorState" SET "leaseId" = 'dead-run', "leaseUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = 1`;
    expect((await runUrgentMonitor(deps().deps)).outcome).toBe("ran");
    await expect(store.persist(appPrisma, "dead-run", { reconcile: () => ({ upserts: [], deletes: [], rows: [] }) })).rejects.toBeInstanceOf(store.LeaseLostError);
    await expect(store.recordOutcome(appPrisma, "dead-run", { newKeys: [], repeatKeys: [], failAccepted: true, due: true, signal: "fail", errorCode: null })).rejects.toBeInstanceOf(store.LeaseLostError);
    expect((await state()).m2LastSignal).not.toBe("fail");
  });

  it("B-I5: the first run sets watchingSince once; no slot before it is judged", async () => {
    const r = await monitor(deps().deps);
    const s = await state();
    expect(r.outcome).toBe("ran");
    expect(s.watchingSince).not.toBeNull();
    expect(s.slotCheckedThrough).toBeNull();
    expect(await prisma.urgentAlertKey.count()).toBe(0);
    await monitor(deps().deps);
    expect((await state()).watchingSince).toEqual(s.watchingSince);
  });
});

describe("missed slots (B-I6–B-I9)", () => {
  it("B-I6: a missed slot is persisted BEFORE any request; HTTP 200 on its /fail marks it accepted", async () => {
    const slot = lastDueSlot(await dbNow());
    await setState({ watchingSince: new Date(slot.getTime() - 2 * H3), slotCheckedThrough: new Date(slot.getTime() - H3) });
    let existedAtFirstRequest: boolean | null = null;
    const hc = fakeHc(async () => {
      existedAtFirstRequest ??= (await prisma.urgentAlertKey.count({ where: { category: "SLOT" } })) === 1;
      return 200;
    });
    const r = await monitor(deps({}, hc).deps);
    expect(existedAtFirstRequest).toBe(true);
    expect(r).toMatchObject({ outcome: "ran", sequence: "rearmFail", m2: "accepted" });
    expect((await keys())[slotKeyOf(slot)]).toMatchObject({ category: "SLOT", missedCount: 1, firstAcceptedAt: expect.any(Date) });
    expect((await state()).slotCheckedThrough).toEqual(slot);
  });

  it("B-I7: consecutive misses are ONE key (count 2 in the summary); a later miss extends it, no new key", async () => {
    const slot = lastDueSlot(await dbNow());
    await setState({ watchingSince: new Date(slot.getTime() - 3 * H3), slotCheckedThrough: new Date(slot.getTime() - 2 * H3) });
    const first = deps();
    await monitor(first.deps);
    expect(Object.keys(await keys())).toHaveLength(1);
    expect(Object.values(await keys())[0].missedCount).toBe(2);
    expect(first.hc.calls.find((c) => c.kind === "fail" && c.check === "M2")?.body).toContain("SLOT=1(x2)");
    await setState({ slotCheckedThrough: new Date(slot.getTime() - H3) }); // re-judge the last slot once more (still missed)
    await monitor(deps().deps);
    const all = Object.values(await keys());
    expect(all).toHaveLength(1);
    expect(all[0].missedCount).toBe(3);
  });

  it("B-I8: missed, kept, missed in one batch: the first streak is cleared and a new key opens for the new miss", async () => {
    const slot = lastDueSlot(await dbNow());
    const s = (k: number) => new Date(slot.getTime() - k * H3);
    await setState({ watchingSince: s(3), slotCheckedThrough: s(3) });
    await billingRun(new Date(s(1).getTime() + MIN), new Date(s(1).getTime() + 4 * MIN), buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }));
    await monitor(deps().deps);
    const k = await keys();
    expect(Object.keys(k).filter((x) => x.startsWith("SLOT:")).sort()).toEqual([slotKeyOf(s(2)), slotKeyOf(s(0))].sort());
    expect(k[slotKeyOf(s(2))].clearedAt).not.toBeNull();
    expect(k[slotKeyOf(s(0))].clearedAt).toBeNull();
  });

  it("B-I9: monitor out for 10 slots: all judged in one run, one streak per contiguous miss, checkpoint at the last slot", async () => {
    const slot = lastDueSlot(await dbNow());
    const s = (k: number) => new Date(slot.getTime() - k * H3);
    await setState({ watchingSince: s(10), slotCheckedThrough: s(10) });
    for (const k of [9, 8, 4, 3, 2, 1]) await billingRun(new Date(s(k).getTime() + MIN), new Date(s(k).getTime() + 3 * MIN), buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }));
    await monitor(deps().deps); // missed: s7, s6, s5 (one streak, cleared by s4), s0 (new streak)
    const k = await keys();
    expect(k[slotKeyOf(s(7))]).toMatchObject({ missedCount: 3 });
    expect(k[slotKeyOf(s(7))].clearedAt).not.toBeNull();
    expect(k[slotKeyOf(s(0))]).toMatchObject({ missedCount: 1, clearedAt: null });
    expect(Object.keys(k).filter((x) => x.startsWith("SLOT:"))).toHaveLength(2);
    expect((await state()).slotCheckedThrough).toEqual(slot);
  });
});

describe("crashes, retries and acceptance (B-I10–B-I16)", () => {
  const withA = detectWith(okReport({ newMonthAtRisk: [A] }), { "org-a:2031-11": { onsetNotBefore: "2031-11-01T21:00:00.000Z", evidenceAt: "2031-11-01T21:00:00.000Z" } });

  it("B-I10: crash after persist, before any request: the problem stays pending and the next run sends it", async () => {
    await setState({ watchingSince: await dbNow() });
    const crash = deps({ detect: withA, afterPersist: () => Promise.reject(new Error("crash")) });
    await expect(monitor(crash.deps)).rejects.toThrow("crash");
    expect(crash.hc.m2()).toEqual([]); // no M2 request at all
    expect((await keys())["A:org-a:2031-11"].firstAcceptedAt).toBeNull();
    const next = deps({ detect: withA });
    await monitor(next.deps);
    expect(next.hc.m2()).toEqual(["success", "fail"]);
    expect((await keys())["A:org-a:2031-11"].firstAcceptedAt).not.toBeNull();
  });

  it("B-I11: /fail times out twice: not accepted, signal unknown; the next run re-arms and sends again (a duplicate is possible by design)", async () => {
    await setState({ watchingSince: await dbNow(), m2LastSignal: "success" });
    const timeouts = deps({ detect: withA }, fakeHc((c) => (c.kind === "fail" && c.check === "M2" ? null : 200)));
    const r = await monitor(timeouts.deps);
    expect(r).toMatchObject({ sequence: "fail", m2: "notAccepted" });
    expect(timeouts.hc.m2()).toEqual(["fail", "fail"]);
    expect((await keys())["A:org-a:2031-11"]).toMatchObject({ firstAcceptedAt: null, lastErrorCode: "notAccepted" });
    expect((await state()).m2LastSignal).toBe("unknown");
    expect((await monitor(deps({ detect: withA }).deps)).sequence).toBe("rearmFail");
  });

  it("B-I12: HTTP 200, then the acceptance write fails: NOT marked accepted; resent next run", async () => {
    await setState({ watchingSince: await dbNow() });
    const failing = deps({ detect: withA, store: { recordOutcome: () => Promise.reject(new Error("db down")) } });
    const r = await monitor(failing.deps);
    expect(r).toMatchObject({ m2: "accepted", acceptanceRecorded: false });
    expect((await keys())["A:org-a:2031-11"].firstAcceptedAt).toBeNull();
    await monitor(deps({ detect: withA }).deps);
    expect((await keys())["A:org-a:2031-11"].firstAcceptedAt).not.toBeNull();
  });

  it("B-I13: acceptance marks exactly the counted keys; a key added while the /fail was in flight is not marked", async () => {
    await setState({ watchingSince: await dbNow() });
    const hc = fakeHc(async (c) => {
      if (c.kind === "fail" && c.check === "M2") {
        const now = await dbNow();
        await prisma.urgentAlertKey.create({ data: keyRow("RUNERR:late", "RUNERR", now) });
      }
      return 200;
    });
    await monitor(deps({ detect: withA }, hc).deps);
    const k = await keys();
    expect(k["A:org-a:2031-11"].firstAcceptedAt).not.toBeNull();
    expect(k["RUNERR:late"].firstAcceptedAt).toBeNull();
  });

  it("B-I14: accepted at run k, repeat-accepted at k+1 (exactly once), deleted once cleared", async () => {
    await setState({ watchingSince: await dbNow() });
    await monitor(deps({ detect: withA }).deps);
    expect((await monitor(deps({ detect: withA }).deps)).counts).toMatchObject({ new: 0, repeat: 1 });
    expect((await keys())["A:org-a:2031-11"].repeatAcceptedAt).not.toBeNull();
    expect((await monitor(deps({ detect: withA }).deps)).sequence).toBe("failRefresh"); // no further repeat; M2 stays Down
    await monitor(deps().deps); // A no longer read: cleared, and already repeat-accepted → deleted
    expect(await keys()).toEqual({});
  });

  it("B-I15: a reminder 60 min after the last accepted /fail re-arms with all unresolved problems counted", async () => {
    await setState({ watchingSince: await dbNow() });
    await monitor(deps({ detect: withA }).deps);
    await monitor(deps({ detect: withA }).deps);
    await prisma.$executeRaw`UPDATE "MonitorState" SET "lastReminderAt" = "lastReminderAt" - interval '61 minutes' WHERE id = 1`;
    const before = (await state()).lastReminderAt!;
    const reminder = deps({ detect: withA });
    const r = await monitor(reminder.deps);
    expect(r).toMatchObject({ sequence: "rearmFail", counts: { new: 0, repeat: 0, reminder: 1 } });
    expect(reminder.hc.calls.find((c) => c.check === "M2" && c.kind === "fail")?.body).toContain("rem=1");
    expect((await state()).lastReminderAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("B-I16: processed-run ledger: three finalized runs processed once; a crash before commit reprocesses them idempotently", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 4 * H3) });
    for (let i = 3; i >= 1; i--) {
      const start = new Date(now.getTime() - i * H3);
      await billingRun(start, new Date(start.getTime() + 3 * MIN), buildUrgentFindings({ runErrors: { global: 0, organizations: [`org-${i}`] }, alerts: okReport() }));
    }
    await expect(monitor(deps({ scheduleExpr: () => null, store: { persist: () => Promise.reject(new Error("crash before commit")) } }).deps)).rejects.toThrow();
    expect(await prisma.urgentAlertKey.count()).toBe(0);
    expect(await processed()).toBe(0);
    expect((await state()).findingsHighWater).toBeNull();
    await monitor(deps({ scheduleExpr: () => null }).deps);
    const k = await keys();
    expect(Object.keys(k).filter((x) => x.startsWith("RUNERR:")).sort()).toEqual(["RUNERR:org-1", "RUNERR:org-2", "RUNERR:org-3"]);
    expect(k["RUNERR:org-3"].clearedAt).not.toBeNull(); // cleared by the later runs without it, still a reported problem
    expect(k["RUNERR:org-3"].firstAcceptedAt).not.toBeNull();
    expect(await processed()).toBe(3);
    const highWater = (await state()).findingsHighWater;
    expect(highWater).not.toBeNull();
    // Second run: org-2 and org-3 get their one repeat and, being cleared, are deleted. If the ledger let the three runs be
    // processed again they would come back as NEW occurrences; they do not.
    await monitor(deps({ scheduleExpr: () => null }).deps);
    const after = await keys();
    expect(Object.keys(after).filter((x) => x.startsWith("RUNERR:"))).toEqual(["RUNERR:org-1"]);
    expect(after["RUNERR:org-1"].firstSeenAt).toEqual(k["RUNERR:org-1"].firstSeenAt);
    expect(await processed()).toBe(3);
    expect((await state()).findingsHighWater).toEqual(highWater);
  });
});

describe("faults, recovery, limitations (B-I17–B-I27)", () => {
  it("B-I17: schedule fault: FAULT:schedule + M1 /fail; checkpoint, watchingSince and pending problems preserved; findings still processed", async () => {
    const now = await dbNow();
    const slot = lastDueSlot(now);
    await setState({ watchingSince: new Date(slot.getTime() - 3 * H3), slotCheckedThrough: new Date(slot.getTime() - 2 * H3) });
    const pendingAt = await dbNow();
    await prisma.urgentAlertKey.create({ data: keyRow("RUNERR:org-p", "RUNERR", pendingAt) });
    await billingRun(new Date(now.getTime() - 20 * MIN), new Date(now.getTime() - 17 * MIN), buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-f"] }, alerts: okReport() }));
    const before = await state();
    const fault = deps({ scheduleExpr: () => "0 */2 * * *" });
    const r = await monitor(fault.deps);
    const after = await state();
    const k = await keys();
    expect(r.faults).toEqual(["schedule=unsupported"]);
    expect(fault.hc.m1()).toEqual([{ check: "M1", kind: "fail", body: expect.stringContaining("schedule=unsupported") }]);
    expect(k["FAULT:schedule"].clearedAt).toBeNull();
    expect(after.slotCheckedThrough).toEqual(before.slotCheckedThrough); // checkpoint preserved
    expect(after.watchingSince).toEqual(before.watchingSince);
    expect(Object.keys(k).filter((x) => x.startsWith("SLOT:"))).toEqual([]); // judging paused
    expect(k["RUNERR:org-f"]).toBeDefined(); // durable findings still processed...
    expect(await processed()).toBe(1); // ...and recorded as processed
    expect(k["RUNERR:org-p"].firstAcceptedAt).not.toBeNull(); // pending work still sent
  });

  it("B-I18: schedule restored: judging resumes from the preserved checkpoint; gap slots judged; FAULT:schedule cleared", async () => {
    const slot = lastDueSlot(await dbNow());
    await setState({ watchingSince: new Date(slot.getTime() - 3 * H3), slotCheckedThrough: new Date(slot.getTime() - 2 * H3) });
    await monitor(deps({ scheduleExpr: () => null }).deps);
    const restored = deps();
    const r = await monitor(restored.deps);
    const k = await keys();
    // Cleared now; and since its first alert was accepted in the fault run, this run's repeat completes it, so it is deleted.
    expect(k["FAULT:schedule"] === undefined || k["FAULT:schedule"].clearedAt !== null).toBe(true);
    expect(Object.values(k).find((x) => x.category === "SLOT")).toMatchObject({ missedCount: 2 });
    expect((await state()).slotCheckedThrough).toEqual(slot);
    expect(r.faults).toEqual([]);
    expect(restored.hc.m1()).toEqual([{ check: "M1", kind: "success", body: undefined }]);
  });

  it("B-I19: detection read fails (D): M1 /fail only; M2 not contacted; no key and no checkpoint changes", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - H3), slotCheckedThrough: new Date(now.getTime() - 2 * H3) });
    const before = await state();
    const d = deps({ detect: detectWith({ ...okReport(), detection: "timeout", conditionC: null, workload: null }) });
    const r = await monitor(d.deps);
    expect(r).toMatchObject({ outcome: "detectionFailed", m1: "accepted" });
    expect(d.hc.calls).toEqual([{ check: "M1", kind: "fail", body: expect.stringContaining("D=timeout") }]);
    expect(await prisma.urgentAlertKey.count()).toBe(0);
    const after = await state();
    expect(after.slotCheckedThrough).toEqual(before.slotCheckedThrough);
    expect(after.findingsHighWater).toEqual(before.findingsHighWater);
    expect(await processed()).toBe(0);
  });

  it("B-I20: durable recovery: a billing run during an outage recorded A and RUNERR; A cleared since; both still reported", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    const f = buildUrgentFindings({
      runErrors: { global: 0, organizations: ["org-x"] },
      alerts: okReport({ newMonthAtRisk: [A] }),
      atRisk: { "org-a:2031-11": { onsetNotBefore: "2031-11-01T21:00:00.000Z", evidenceAt: "2031-11-01T21:00:00.000Z" } },
    });
    await billingRun(new Date(now.getTime() - H3), new Date(now.getTime() - H3 + 3 * MIN), f);
    const r = await monitor(deps({ scheduleExpr: () => null }).deps); // A no longer seen by the monitor's read
    const k = await keys();
    expect(k["A:org-a:2031-11"]).toMatchObject({ source: "billingRun", firstAcceptedAt: expect.any(Date) });
    expect(k["A:org-a:2031-11"].clearedAt).not.toBeNull();
    expect(k["RUNERR:org-x"].firstAcceptedAt).not.toBeNull();
    expect(r.counts!.new).toBeGreaterThanOrEqual(2);
  });

  it("B-I21 (owner-accepted limitation, locked in): A true and cleared between two monitor reads with no billing run in between is NOT reported", async () => {
    await setState({ watchingSince: await dbNow() });
    await monitor(deps().deps); // read 1: no A
    await monitor(deps().deps); // read 2: no A (it was true only in between; nothing durable recorded it)
    expect(await prisma.urgentAlertKey.count()).toBe(0);
  });

  it("B-I22: read-only: a full run with the REAL detection changes no billing table and writes no JobRun row", async () => {
    const snapshot = async () => {
      const [row] = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
        SELECT (SELECT count(*) FROM "Organization") AS orgs, (SELECT count(*) FROM "Academy") AS academies, (SELECT count(*) FROM "Student") AS students,
               (SELECT count(*) FROM "DuesGenerationProgress") AS progress, (SELECT count(*) FROM "DuesActivation") AS activations,
               (SELECT count(*) FROM "DuesObligation") AS obligations, (SELECT count(*) FROM "JobRun") AS jobruns,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM "DuesGenerationProgress" t) AS progress_hash,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM "Organization" t) AS org_hash`);
      return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    };
    const before = await snapshot();
    const r = await monitor(deps({ detect: (now) => detectGenerationAlertsDetailed(now) }).deps);
    expect(r.outcome).toBe("ran");
    expect(await snapshot()).toBe(before);
  });

  it("B-I23: M1/M2 not configured: nothing is sent or accepted; problems stay pending", async () => {
    await setState({ watchingSince: await dbNow() });
    const d = deps({ urls: {}, detect: detectWith(okReport({ newMonthAtRisk: [A] })) });
    const r = await monitor(d.deps);
    expect(r).toMatchObject({ m2: "notConfigured", m1: "notConfigured" });
    expect(d.hc.calls).toEqual([]);
    expect((await keys())["A:org-a:2031-11"].firstAcceptedAt).toBeNull();
  });

  it("B-I24: route: a wrong bearer gets 401 and takes no lease; the response body holds no URL, academy id or key", async () => {
    vi.stubEnv("CRON_SECRET", "monitor-test-secret");
    try {
      const bad = await handleUrgentMonitorRequest(new Request("http://localhost/x", { headers: { authorization: "Bearer wrong" } }), deps().deps);
      expect(bad.status).toBe(401);
      expect((await state()).lastRunEndedAt).toBeNull();
      await setState({ watchingSince: await dbNow() });
      const good = await handleUrgentMonitorRequest(
        new Request("http://localhost/x", { headers: { authorization: "Bearer monitor-test-secret" } }),
        deps({ detect: detectWith(okReport({ newMonthAtRisk: [A] })) }).deps,
      );
      const text = await good.text();
      expect(good.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ ok: true, outcome: "ran" });
      expect(text).not.toMatch(/org-a|hc\.example|A:|RUNERR|SLOT:/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("B-I25: the unavailable marker raises FAULT:findings: M1 /fail and a new problem in the M2 summary", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - H3) });
    await billingRun(new Date(now.getTime() - 30 * MIN), new Date(now.getTime() - 27 * MIN), unavailableFindings("unrecognized_error"));
    const d = deps({ scheduleExpr: () => null });
    const r = await monitor(d.deps);
    expect((await keys())["FAULT:findings"]).toMatchObject({ category: "FAULT", clearedAt: null, firstAcceptedAt: expect.any(Date) });
    expect(r.faults).toContain("findings=unavailable");
    expect(d.hc.calls.find((c) => c.check === "M2" && c.kind === "fail")?.body).toMatch(/F=2/); // FAULT:findings + FAULT:schedule
  });

  it("B-I26: an unexpected NULL after watchingSince is a fault; a NULL before watchingSince (historical) is ignored", async () => {
    const now = await dbNow();
    await billingRun(new Date(now.getTime() - 5 * H3), new Date(now.getTime() - 5 * H3 + 3 * MIN), null); // historical
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    await monitor(deps().deps);
    expect((await keys())["FAULT:findings"]).toBeUndefined();
    await billingRun(new Date(now.getTime() - 30 * MIN), new Date(now.getTime() - 27 * MIN), null); // after watchingSince
    await monitor(deps().deps);
    expect((await keys())["FAULT:findings"]).toMatchObject({ clearedAt: null });
  });

  it("B-I27: three outage runs with moving evidenceAt → one key, earliest bounds, firstSeenAt unchanged by later runs", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 4 * H3) });
    const WARNING = "2031-11-01T21:00:00.000Z";
    const withEvidence = (evidenceAt: string) =>
      buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport({ newMonthAtRisk: [A] }), atRisk: { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt } } });
    for (const [i, ev] of [[3, "2031-11-02T00:05:00.000Z"], [2, "2031-11-02T03:05:00.000Z"], [1, "2031-11-02T06:05:00.000Z"]] as const) {
      const start = new Date(now.getTime() - i * H3);
      await billingRun(start, new Date(start.getTime() + 3 * MIN), withEvidence(ev));
    }
    const read = detectWith(okReport({ newMonthAtRisk: [A] }), { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T06:05:00.000Z" } });
    await monitor(deps({ detect: read, scheduleExpr: () => null }).deps);
    const first = (await keys())["A:org-a:2031-11"];
    expect(await prisma.urgentAlertKey.count({ where: { category: "A" } })).toBe(1);
    expect(first).toMatchObject({ onsetNotBefore: new Date(WARNING), evidenceAt: new Date("2031-11-02T00:05:00.000Z") });
    await billingRun(new Date(now.getTime() - 10 * MIN), new Date(now.getTime() - 7 * MIN), withEvidence("2031-11-02T09:05:00.000Z"));
    await monitor(deps({ detect: read, scheduleExpr: () => null }).deps);
    const later = (await keys())["A:org-a:2031-11"];
    expect(later.firstSeenAt).toEqual(first.firstSeenAt);
    expect(later.evidenceAt).toEqual(new Date("2031-11-02T00:05:00.000Z"));
  });
});

describe("PR-B review fixes (B-I28–B-I32)", () => {
  const errX = () => buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-x"] }, alerts: okReport() });
  const clean = () => buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() });
  const noSchedule = (hc = fakeHc()) => deps({ scheduleExpr: () => null }, hc);

  it("B-I28 (B1): recurrence while the cleared occurrence's REPEAT is pending → a fresh alert for occurrence 2; occurrence 1 still gets its repeat", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    await billingRun(new Date(now.getTime() - 60 * MIN), new Date(now.getTime() - 57 * MIN), errX());
    await monitor(noSchedule().deps); // occurrence 1 alerted (accepted)
    expect((await occurrences("RUNERR:org-x"))[0].firstAcceptedAt).not.toBeNull();
    await billingRun(new Date(now.getTime() - 40 * MIN), new Date(now.getTime() - 37 * MIN), clean());
    // The run that clears it fails to deliver its /fail: the repeat stays pending.
    await monitor(noSchedule(fakeHc((c) => (c.check === "M2" && c.kind === "fail" ? 500 : 200))).deps);
    expect((await occurrences("RUNERR:org-x"))[0]).toMatchObject({ clearedAt: expect.any(Date), repeatAcceptedAt: null });
    await billingRun(new Date(now.getTime() - 20 * MIN), new Date(now.getTime() - 17 * MIN), errX()); // it comes back
    const recur = noSchedule();
    const r = await monitor(recur.deps);
    expect(r.counts).toMatchObject({ new: 1 }); // occurrence 2: a FRESH alert
    expect(r.counts!.repeat).toBeGreaterThanOrEqual(1); // occurrence 1's pending repeat, in the same /fail
    expect(recur.hc.calls.find((c) => c.check === "M2" && c.kind === "fail")?.body).toMatch(/new=1 rep=[1-9]/);
    // Occurrence 1 is complete (cleared + repeat-accepted) and deleted at acceptance; occurrence 2 is open and alerted.
    const left = await occurrences("RUNERR:org-x");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ key: "RUNERR:org-x#2", clearedAt: null, firstAcceptedAt: expect.any(Date), repeatAcceptedAt: null });
  });

  it("B-I29 (B1): clear and recurrence inside one batch (error, clean, error) → two occurrences, both alerted", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    for (const [m, f] of [[60, errX()], [40, clean()], [20, errX()]] as const) await billingRun(new Date(now.getTime() - m * MIN), new Date(now.getTime() - (m - 3) * MIN), f);
    const r = await monitor(noSchedule().deps);
    const [o1, o2] = await occurrences("RUNERR:org-x");
    expect(o1).toMatchObject({ occurrence: 1, clearedAt: expect.any(Date), firstAcceptedAt: expect.any(Date) });
    expect(o2).toMatchObject({ occurrence: 2, clearedAt: null, firstAcceptedAt: expect.any(Date) });
    expect(r.counts!.new).toBeGreaterThanOrEqual(2);
  });

  it("B-I30 (B2): out-of-order commit: a run that FINISHED earlier but committed after a newer run was processed is still processed, including unavailable findings", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    await billingRun(new Date(now.getTime() - 12 * MIN), new Date(now.getTime() - 10 * MIN), clean()); // B: commits first
    await monitor(noSchedule().deps);
    const highWater = (await state()).findingsHighWater!;
    expect(highWater).toEqual(new Date(now.getTime() - 10 * MIN));
    // A and A': finished BEFORE B's finish, committed only now (the old time cursor skipped these forever).
    await billingRun(new Date(now.getTime() - 25 * MIN), new Date(now.getTime() - 20 * MIN), unavailableFindings("unrecognized_error"));
    await billingRun(new Date(now.getTime() - 24 * MIN), new Date(now.getTime() - 19 * MIN), errX());
    const r = await monitor(noSchedule().deps);
    const k = await keys();
    expect(k["FAULT:findings"]).toMatchObject({ clearedAt: null, firstAcceptedAt: expect.any(Date) });
    expect(k["RUNERR:org-x"]).toMatchObject({ clearedAt: null, firstAcceptedAt: expect.any(Date) });
    expect(r.faults).toContain("findings=unavailable");
    expect(await processed()).toBe(3);
    expect((await state()).findingsHighWater).toEqual(highWater); // late runs never move the high-water mark back
    // Processed exactly once: nothing new on the next run.
    const again = await monitor(noSchedule().deps);
    expect(again.counts!.new).toBe(0);
    expect(await processed()).toBe(3);
    expect((await occurrences("FAULT:findings"))).toHaveLength(1);
  });

  it("B-I31 (B2): a run committing DURING a monitor run (after its read) is picked up by the next run, not skipped", async () => {
    const now = await dbNow();
    await setState({ watchingSince: new Date(now.getTime() - 2 * H3) });
    await billingRun(new Date(now.getTime() - 12 * MIN), new Date(now.getTime() - 10 * MIN), clean());
    // Commits after this monitor run's read, with an EARLIER finish than the run it just processed.
    await monitor(deps({ scheduleExpr: () => null, afterPersist: async () => void (await billingRun(new Date(now.getTime() - 30 * MIN), new Date(now.getTime() - 15 * MIN), null)) }).deps);
    expect(await processed()).toBe(1);
    await monitor(noSchedule().deps);
    expect(await processed()).toBe(2);
    expect((await keys())["FAULT:findings"]).toMatchObject({ clearedAt: null }); // the NULL is a fault, not "no problems"
  });

  it("B-I32 (R4): unresolved problems with nothing due and M2 not known Down → no M2 request; the next due /fail still counts them", async () => {
    await setState({ watchingSince: await dbNow() });
    const withA = detectWith(okReport({ newMonthAtRisk: [A] }));
    await monitor(deps({ detect: withA }).deps); // first alert
    await monitor(deps({ detect: withA }).deps); // repeat
    await setState({ m2LastSignal: "unknown" }); // e.g. the last refresh timed out
    const quiet = deps({ detect: withA });
    expect(await monitor(quiet.deps)).toMatchObject({ sequence: "none", m2: "notSent", counts: { unresolved: 1 } });
    expect(quiet.hc.m2()).toEqual([]); // no request, so no empty alert email
    expect((await state()).m2LastSignal).toBe("unknown");
    await prisma.$executeRaw`UPDATE "MonitorState" SET "lastReminderAt" = "lastReminderAt" - interval '61 minutes' WHERE id = 1`;
    const reminder = deps({ detect: withA });
    expect(await monitor(reminder.deps)).toMatchObject({ sequence: "rearmFail", counts: { reminder: 1 } });
  });
});
