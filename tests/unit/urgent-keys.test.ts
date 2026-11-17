import { describe, expect, it } from "vitest";
import type { GenerationAlertReport } from "../../src/lib/dues/monthly-generation-alerts";
import { buildUrgentFindings, unavailableFindings } from "../../src/lib/dues/urgent-findings";
import { keysFromRead, reconcile, validFindings, type FinalizedRun, type KeyRow, type Observation } from "../../src/lib/monitoring/urgent/keys";
import { streakOps } from "../../src/lib/monitoring/urgent/slots";

/**
 * PR-B B-U6–B-U8 and the binding PR-A review decisions, at the level of the pure rule: key age = first sight, bounds only ever
 * move earlier, a missed observation never clears or resets, unavailable or unexpected NULL findings are a monitoring fault.
 */
const t = (iso: string) => new Date(iso);
const WARNING = "2031-11-01T21:00:00.000Z";
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
const NO_ERRORS = { global: 0, organizations: [] };
const findingWithA = (evidenceAt: string) =>
  buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport({ newMonthAtRisk: [A] }), atRisk: { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt } } });
let seq = 0;
const run = (urgentFindings: unknown, startedAt = "2031-11-02T00:00:00Z", finishedAt = "2031-11-02T00:04:00Z"): FinalizedRun => ({
  id: `run-${++seq}`,
  startedAt: t(startedAt),
  finishedAt: t(finishedAt),
  urgentFindings,
});
const obs = (over: Partial<Observation> & { dbNow: Date }): Observation => ({ runs: [], slotOps: [], scheduleFault: null, read: [], ...over });
/** Problem key → its latest occurrence. */
const byKey = (rows: KeyRow[]) => Object.fromEntries([...rows].sort((a, b) => a.occurrence - b.occurrence).map((r) => [r.problemKey, r]));
const ofProblem = (rows: KeyRow[], problemKey: string) => rows.filter((r) => r.problemKey === problemKey).sort((a, b) => a.occurrence - b.occurrence);
const clean = () => buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() });

describe("keysFromRead (B-U6)", () => {
  it("A carries its evidence bounds from the detailed detection; C has no known onset and is proven at the read", () => {
    const readAt = t("2031-11-02T05:07:00Z");
    const keys = keysFromRead(
      okReport({ newMonthAtRisk: [A], conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: ["org-d"] } }),
      { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T03:04:05.000Z" } },
      readAt,
    );
    expect(keys).toEqual([
      { problemKey: "A:org-a:2031-11", category: "A", source: "monitorRead", onsetNotBefore: t(WARNING), evidenceAt: t("2031-11-02T03:04:05.000Z") },
      { problemKey: "C:org-c:noProgress", category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt },
      { problemKey: "C:org-d:noActivation", category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt },
    ]);
  });
});

describe("validFindings: only v1 findings are evidence", () => {
  it("the unavailable marker, NULL and malformed values are not findings", () => {
    expect(validFindings(findingWithA(WARNING))).not.toBeNull();
    for (const bad of [null, undefined, unavailableFindings("x"), { v: 2 }, { v: 1 }, "text", 1]) expect(validFindings(bad)).toBeNull();
  });
});

describe("reconcile: billing findings (B-U7) and clearing rules (B-U8)", () => {
  const now = t("2031-11-02T05:07:00Z");

  it("findings → A/C (source billingRun), RUNDET when detection failed, RUNERR per academy and global", () => {
    const f = buildUrgentFindings({
      runErrors: { global: 2, organizations: ["org-x", "org-y"] },
      alerts: okReport({ newMonthAtRisk: [A], conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] } }),
      atRisk: { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt: WARNING } },
    });
    const failedDetection = buildUrgentFindings({ runErrors: NO_ERRORS, alerts: { ...okReport(), detection: "timeout", conditionC: null, workload: null } });
    const r = byKey(reconcile([], obs({ dbNow: now, runs: [run(f), run(failedDetection, "2031-11-02T03:00:00Z", "2031-11-02T03:02:00Z")], read: [] })).rows);
    expect(Object.keys(r).sort()).toEqual(["A:org-a:2031-11", "C:org-c:noProgress", "RUNDET", "RUNERR:global", "RUNERR:org-x", "RUNERR:org-y"]);
    expect(r["A:org-a:2031-11"]).toMatchObject({ category: "A", source: "billingRun", onsetNotBefore: t(WARNING), evidenceAt: t(WARNING), firstSeenAt: now });
    expect(r["RUNERR:org-x"]).toMatchObject({ category: "RUNERR", onsetNotBefore: t("2031-11-02T00:00:00Z"), evidenceAt: t("2031-11-02T00:04:00Z") });
    // A and C seen only in billing findings are cleared by this run's successful monitor read (it does not show them)...
    expect(r["A:org-a:2031-11"].clearedAt).toEqual(now);
    expect(r["C:org-c:noProgress"].clearedAt).toEqual(now);
    // ...but they stay as pending problems: never accepted, so they are still reported (durable recovery).
    expect(r["A:org-a:2031-11"].firstAcceptedAt).toBeNull();
  });

  it("A and C are cleared ONLY by a successful monitor read; a later billing run never clears them", () => {
    const first = reconcile([], obs({ dbNow: now, runs: [run(findingWithA(WARNING))], read: keysFromRead(okReport({ newMonthAtRisk: [A] }), {}, now) })).rows;
    const later = reconcile(first, obs({ dbNow: t("2031-11-02T05:22:00Z"), runs: [run(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }))], read: keysFromRead(okReport({ newMonthAtRisk: [A] }), {}, now) })).rows;
    expect(byKey(later)["A:org-a:2031-11"].clearedAt).toBeNull();
  });

  it("RUNERR:<org> is cleared by a later valid, non-thrown run without it; a thrown run clears nothing per academy; RUNDET cleared by detection ok", () => {
    const withErr = buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-x"] }, alerts: { ...okReport(), detection: "timeout", conditionC: null, workload: null } });
    let rows = reconcile([], obs({ dbNow: now, runs: [run(withErr)] })).rows;
    const thrown = buildUrgentFindings({ runErrors: { global: 1, organizations: [] }, thrown: true });
    rows = reconcile(rows, obs({ dbNow: now, runs: [run(thrown)] })).rows;
    expect(byKey(rows)["RUNERR:org-x"].clearedAt).toBeNull();
    expect(byKey(rows)["RUNERR:global"].clearedAt).toBeNull();
    rows = reconcile(rows, obs({ dbNow: now, runs: [run(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }))] })).rows;
    expect(byKey(rows)["RUNERR:org-x"].clearedAt).toEqual(now);
    expect(byKey(rows)["RUNERR:global"].clearedAt).toEqual(now);
    expect(byKey(rows)["RUNDET"].clearedAt).toEqual(now);
  });

  it("an occurrence cleared and already repeat-accepted is deleted; a recurrence after that is a NEW occurrence (a new alert)", () => {
    const done: KeyRow = {
      key: "RUNERR:org-x#1", problemKey: "RUNERR:org-x", occurrence: 1, category: "RUNERR", source: "billingRun", onsetNotBefore: null, evidenceAt: null,
      firstSeenAt: t("2031-11-01T00:00:00Z"), lastSeenAt: t("2031-11-01T00:00:00Z"), clearedAt: null,
      firstAcceptedAt: t("2031-11-01T00:10:00Z"), repeatAcceptedAt: t("2031-11-01T00:25:00Z"), lastMissedSlot: null, missedCount: 1, lastAttemptAt: null, lastErrorCode: null,
    };
    const cleared = reconcile([done], obs({ dbNow: now, runs: [run(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }))] }));
    expect(cleared.deletes).toEqual(["RUNERR:org-x#1"]);
    const again = reconcile(cleared.rows, obs({ dbNow: t("2031-11-03T00:00:00Z"), runs: [run(buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-x"] }, alerts: okReport() }))] }));
    expect(byKey(again.rows)["RUNERR:org-x"]).toMatchObject({ firstSeenAt: t("2031-11-03T00:00:00Z"), firstAcceptedAt: null });
  });
});

describe("binding PR-A decisions", () => {
  it("B-I27 (pure): three outage runs with moving evidenceAt → ONE key, earliest bounds, firstSeenAt set once and unchanged later", () => {
    const outage = [findingWithA("2031-11-02T00:05:00.000Z"), findingWithA("2031-11-02T03:05:00.000Z"), findingWithA("2031-11-02T06:05:00.000Z")].map((f) => run(f));
    const recovery = t("2031-11-02T09:07:00Z");
    const stillA = keysFromRead(okReport({ newMonthAtRisk: [A] }), { "org-a:2031-11": { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T06:05:00.000Z" } }, recovery);
    let rows = reconcile([], obs({ dbNow: recovery, runs: outage, read: stillA })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "A:org-a:2031-11#1", problemKey: "A:org-a:2031-11", onsetNotBefore: t(WARNING), evidenceAt: t("2031-11-02T00:05:00.000Z"), firstSeenAt: recovery, clearedAt: null });
    // A later run and a later read with later evidence move nothing later and do not reset the age.
    rows = reconcile(rows, obs({ dbNow: t("2031-11-02T12:07:00Z"), runs: [run(findingWithA("2031-11-02T09:05:00.000Z"))], read: stillA })).rows;
    expect(rows[0]).toMatchObject({ onsetNotBefore: t(WARNING), evidenceAt: t("2031-11-02T00:05:00.000Z"), firstSeenAt: recovery });
  });

  it("B-I25/B-I26 (pure): the unavailable marker and an unexpected NULL raise FAULT:findings; a later valid run clears it", () => {
    for (const missing of [unavailableFindings("unrecognized_error"), null]) {
      const r = byKey(reconcile([], obs({ dbNow: now(), runs: [run(missing)] })).rows);
      expect(r["FAULT:findings"]).toMatchObject({ category: "FAULT", source: "billingRun", clearedAt: null });
      expect(Object.keys(r)).toEqual(["FAULT:findings"]); // never read as "no problems", never as a finding
    }
    const rows = reconcile([], obs({ dbNow: now(), runs: [run(null), run(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okReport() }))] })).rows;
    expect(byKey(rows)["FAULT:findings"].clearedAt).not.toBeNull();
  });

  it("FAULT:schedule raised while the schedule is unsupported (slot ops paused) and cleared when it is supported again", () => {
    let rows = reconcile([], obs({ dbNow: now(), slotOps: null, scheduleFault: "unsupported" })).rows;
    expect(byKey(rows)["FAULT:schedule"].clearedAt).toBeNull();
    rows = reconcile(rows, obs({ dbNow: now(), slotOps: [], scheduleFault: null })).rows;
    expect(byKey(rows)["FAULT:schedule"].clearedAt).not.toBeNull();
  });

  it("slot streaks: insert, extend (count 2, no new key), clear", () => {
    const s0 = t("2031-11-02T00:00:00Z");
    const s1 = t("2031-11-02T03:00:00Z");
    let rows = reconcile([], obs({ dbNow: now(), slotOps: streakOps(null, [{ slot: s0, kept: false }, { slot: s1, kept: false }]) })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "SLOT:2031-11-02T00:00Z#1", missedCount: 2, lastMissedSlot: s1, onsetNotBefore: t("2031-11-02T00:10:00Z") });
    rows = reconcile(rows, obs({ dbNow: now(), slotOps: streakOps("SLOT:2031-11-02T00:00Z", [{ slot: t("2031-11-02T06:00:00Z"), kept: true }]) })).rows;
    expect(rows[0].clearedAt).not.toBeNull();
  });

  function now() {
    return t("2031-11-02T05:07:00Z");
  }
});

describe("review fix B1: separate occurrences of one problem", () => {
  const t0 = t("2031-11-02T05:07:00Z");
  const t1 = t("2031-11-02T05:22:00Z");
  const errX = () => buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-x"] }, alerts: okReport() });

  it("B-U26: recurrence after clearing while the first occurrence's REPEAT is still pending → a NEW occurrence (fresh alert); the old one keeps its pending repeat", () => {
    const first: KeyRow = {
      key: "RUNERR:org-x#1", problemKey: "RUNERR:org-x", occurrence: 1, category: "RUNERR", source: "billingRun", onsetNotBefore: null, evidenceAt: null,
      firstSeenAt: t("2031-11-02T04:52:00Z"), lastSeenAt: t("2031-11-02T04:52:00Z"), clearedAt: null,
      firstAcceptedAt: t("2031-11-02T04:53:00Z"), repeatAcceptedAt: null, lastMissedSlot: null, missedCount: 1, lastAttemptAt: null, lastErrorCode: null,
    };
    let rows = reconcile([first], obs({ dbNow: t0, runs: [run(clean())] })).rows;
    expect(ofProblem(rows, "RUNERR:org-x")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clearedAt: t0, firstAcceptedAt: first.firstAcceptedAt, repeatAcceptedAt: null }); // cleared, repeat pending
    rows = reconcile(rows, obs({ dbNow: t1, runs: [run(errX())] })).rows;
    const [old, fresh] = ofProblem(rows, "RUNERR:org-x");
    expect(old).toMatchObject({ key: "RUNERR:org-x#1", clearedAt: t0, firstAcceptedAt: first.firstAcceptedAt, repeatAcceptedAt: null }); // repeat still owed
    expect(fresh).toMatchObject({ key: "RUNERR:org-x#2", occurrence: 2, clearedAt: null, firstSeenAt: t1, firstAcceptedAt: null }); // fresh alert
  });

  it("B-U27: clear and recurrence inside ONE batch (error, clean, error) → two occurrences, the first cleared, the second open and new", () => {
    const rows = reconcile([], obs({ dbNow: t0, runs: [run(errX()), run(clean()), run(errX())] })).rows;
    const [a, b] = ofProblem(rows, "RUNERR:org-x");
    expect(a).toMatchObject({ occurrence: 1, clearedAt: t0, firstAcceptedAt: null }); // still owed its own alert
    expect(b).toMatchObject({ occurrence: 2, clearedAt: null, firstAcceptedAt: null });
  });

  it("B-U28: the same for unavailable findings: marker, valid, NULL in one batch → two FAULT:findings occurrences", () => {
    const rows = reconcile([], obs({ dbNow: t0, runs: [run(unavailableFindings("x")), run(clean()), run(null)] })).rows;
    expect(ofProblem(rows, "FAULT:findings").map((r) => [r.occurrence, r.clearedAt])).toEqual([[1, t0], [2, null]]);
  });

  it("B-U29: an occurrence is never reopened; at most one is open per problem", () => {
    let rows = reconcile([], obs({ dbNow: t0, runs: [run(errX())] })).rows;
    rows = reconcile(rows, obs({ dbNow: t1, runs: [run(errX()), run(errX())] })).rows;
    expect(ofProblem(rows, "RUNERR:org-x")).toHaveLength(1); // still the same open occurrence
    expect(rows.filter((r) => r.clearedAt === null && r.problemKey === "RUNERR:org-x")).toHaveLength(1);
  });
});

describe("review fix B2: late-committing runs", () => {
  const t0 = t("2031-11-02T05:07:00Z");
  const errX = () => buildUrgentFindings({ runErrors: { global: 0, organizations: ["org-x"] }, alerts: okReport() });
  const late = (r: FinalizedRun): FinalizedRun => ({ ...r, late: true });

  it("B-U30: a late run's findings are reported but never clear what a newer run decided", () => {
    let rows = reconcile([], obs({ dbNow: t0, runs: [run(errX()), run(unavailableFindings("x"))] })).rows;
    rows = reconcile(rows, obs({ dbNow: t0, runs: [late(run(clean()))] })).rows;
    expect(byKey(rows)["RUNERR:org-x"].clearedAt).toBeNull();
    expect(byKey(rows)["FAULT:findings"].clearedAt).toBeNull();
  });

  it("B-U31: a late run with an unavailable marker or errors raises the problem when nothing covers it", () => {
    const rows = reconcile([], obs({ dbNow: t0, runs: [late(run(unavailableFindings("x"))), late(run(errX()))] })).rows;
    expect(byKey(rows)["FAULT:findings"]).toMatchObject({ occurrence: 1, clearedAt: null, firstAcceptedAt: null });
    expect(byKey(rows)["RUNERR:org-x"]).toMatchObject({ occurrence: 1, clearedAt: null });
  });

  it("B-U32: a late run whose problem already cleared moves the cleared occurrence's evidence earlier; no spurious new occurrence", () => {
    let rows = reconcile([], obs({ dbNow: t0, runs: [run(errX(), "2031-11-02T03:00:00Z", "2031-11-02T03:04:00Z"), run(clean())] })).rows;
    rows = reconcile(rows, obs({ dbNow: t0, runs: [late(run(errX(), "2031-11-02T00:00:00Z", "2031-11-02T00:03:00Z"))] })).rows;
    expect(ofProblem(rows, "RUNERR:org-x")).toHaveLength(1);
    expect(byKey(rows)["RUNERR:org-x"]).toMatchObject({ onsetNotBefore: t("2031-11-02T00:00:00Z"), clearedAt: t0 });
  });
});
