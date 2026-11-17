import { describe, expect, it, vi } from "vitest";
import type { GenerationAlertReport } from "../../src/lib/dues/monthly-generation-alerts";
import type { MonthlyGenerationRunReport, SegmentVisitReport } from "../../src/lib/dues/monthly-generation-progress";

// Importing the route module constructs the Prisma client (never connected here), which requires DATABASE_URL.
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { buildUrgentFindings, unavailableFindings, earliestAtRiskEvidence, FINDINGS_LIST_CAP } = await import("../../src/lib/dues/urgent-findings");
const { summarizeMonthlyGenerationRun } = await import("../../src/lib/dues/monthly-generation-route");
const { atRiskKey } = await import("../../src/lib/dues/monthly-generation-alerts");

/**
 * PR-A (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md, tests A-U1–A-U8 and the review fixes): the durable urgent findings a
 * monthly-generation run stores in `JobRun.urgentFindings`. Pure; no database.
 */
const okAlerts = (over: Partial<GenerationAlertReport> = {}): GenerationAlertReport => ({
  detection: "ok",
  newMonthAtRisk: [],
  olderMonthNotClean: [],
  notActiveOrganizations: [],
  conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
  workload: { reasons: [], counts: { progressRows: 0, organizations: 0, maxStudentsPerOrganization: 0, studentsTotal: 0, maxBranchesPerOrganization: 0 } },
  ...over,
});
const failedAlerts = (detection: string): GenerationAlertReport => ({
  detection,
  newMonthAtRisk: [],
  olderMonthNotClean: [],
  notActiveOrganizations: [],
  conditionC: null,
  workload: null,
});
const visit = (organizationId: string, over: Partial<SegmentVisitReport> = {}): SegmentVisitReport => ({
  segmentId: `seg-${organizationId}`,
  organizationId,
  year: 2031,
  month: 11,
  created: 0,
  classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 0, PENDING: 0 },
  reasons: {},
  errorCodes: {},
  ended: "slice",
  ...over,
});
const run = (over: Partial<MonthlyGenerationRunReport> = {}): MonthlyGenerationRunReport => ({ visits: [], claimErrors: 0, stoppedBy: "noClaimableSegment", ...over });
const NO_ERRORS = { global: 0, organizations: [] };
const A = { organizationId: "org-a", year: 2031, month: 11 };
const WARNING = "2031-11-01T21:00:00.000Z"; // Costa Rica: T_open 06:00Z + 15 h

describe("summarizeMonthlyGenerationRun: run errors for the findings come from the same loop as the urgent signal", () => {
  it("A-U2: per academy (visit error, skipped rollover; sorted, unique) and global (claim, discovery); a successful rollover or an unclean pass is not a run error", () => {
    const report = run({
      visits: [
        visit("org-y", { rollover: { skipped: "configurationTooLarge" }, ended: "error" }),
        visit("org-x", { error: { stage: "page", code: "timeout" as never }, ended: "error" }),
        visit("org-x", { error: { stage: "passEnd", code: "timeout" as never }, ended: "error" }),
        visit("org-z", { rollover: { inserted: 1 } }),
        visit("org-w", { passFinished: { ineligible: 0, covered: 0, unpriced: 2, pending: 0, clean: false }, ended: "passEnd" }),
      ],
      claimErrors: 2,
      discoveryError: "timeout" as never,
    });
    expect(summarizeMonthlyGenerationRun(report, okAlerts()).runErrors).toEqual({ global: 3, organizations: ["org-x", "org-y"] });
  });

  it("the split adds up EXACTLY to runLevelErrors (global + one per erroring visit), for every kind of run-level error", () => {
    const cases: [MonthlyGenerationRunReport, number][] = [
      [run(), 0],
      [run({ claimErrors: 3 }), 0],
      [run({ discoveryError: "timeout" as never }), 0],
      [run({ visits: [visit("org-a", { error: { stage: "marker", code: "timeout" as never }, ended: "error" })] }), 1],
      [run({ visits: [visit("org-a", { rollover: { skipped: "error", code: "timeout" as never } })] }), 1],
      [run({ visits: [visit("org-a", { rollover: { skipped: "configurationTooLarge" }, error: { stage: "gate", code: "timeout" as never }, ended: "error" })] }), 2],
    ];
    for (const [report, erroringVisitEvents] of cases) {
      const { runLevelErrors, runErrors } = summarizeMonthlyGenerationRun(report, okAlerts());
      expect(runLevelErrors).toBe(runErrors.global + erroringVisitEvents);
      expect(runErrors.global > 0 || runErrors.organizations.length > 0).toBe(runLevelErrors > 0);
    }
  });
});

describe("buildUrgentFindings", () => {
  it("A-U1: a clean run: detection ok, nothing urgent, zero run errors (an object, never NULL)", () => {
    expect(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts() })).toEqual({
      v: 1,
      detection: "ok",
      newMonthAtRisk: [],
      conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
      runErrors: { global: 0, organizations: [] },
    });
  });

  it("A-U3: detection failed: its safe code is kept, A is empty and C is null (neither passed nor failed)", () => {
    expect(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: failedAlerts("timeout") })).toMatchObject({ detection: "timeout", newMonthAtRisk: [], conditionC: null });
  });

  it("A-U4/A-U5: each A entry carries BOTH evidence bounds, never a single 'onset'", () => {
    const atRisk = { [atRiskKey(A)]: { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T03:04:05.000Z" } };
    expect(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts({ newMonthAtRisk: [A] }), atRisk }).newMonthAtRisk).toEqual([
      { ...A, onsetNotBefore: WARNING, evidenceAt: "2031-11-02T03:04:05.000Z" },
    ]);
    // Without the detail (a test seam), the entry is kept with explicit nulls rather than dropped or guessed.
    expect(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts({ newMonthAtRisk: [A] }) }).newMonthAtRisk).toEqual([{ ...A, onsetNotBefore: null, evidenceAt: null }]);
  });

  it("A-U6: condition C of both kinds is copied", () => {
    const conditionC = { activatedWithoutProgress: ["org-c"], progressWithoutActivation: ["org-d", "org-e"] };
    expect(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts({ conditionC }) }).conditionC).toEqual(conditionC);
  });

  it("A-U7: lists are capped at the detection cap and marked truncated; uncapped findings carry no truncated key", () => {
    const organizations = Array.from({ length: 600 }, (_, i) => `org-${String(i).padStart(4, "0")}`);
    const f = buildUrgentFindings({ runErrors: { global: 0, organizations }, alerts: okAlerts() });
    expect(FINDINGS_LIST_CAP).toBe(500);
    expect(f.runErrors.organizations).toHaveLength(500);
    expect(f.truncated).toBe(true);
    expect("truncated" in buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts() })).toBe(false);
  });

  it("A-U8: only the documented keys; ids, months, counts, ISO times and codes only", () => {
    expect(Object.keys(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts() })).sort()).toEqual(["conditionC", "detection", "newMonthAtRisk", "runErrors", "v"]);
    expect(Object.keys(buildUrgentFindings({ runErrors: { global: 1, organizations: [] }, thrown: true })).sort()).toEqual([
      "conditionC",
      "detection",
      "newMonthAtRisk",
      "runErrors",
      "thrown",
      "v",
    ]);
  });

  it("a thrown job before detection: notEvaluated, the caller's one global run error", () => {
    expect(buildUrgentFindings({ runErrors: { global: 1, organizations: [] }, thrown: true })).toEqual({
      v: 1,
      thrown: true,
      detection: "notEvaluated",
      newMonthAtRisk: [],
      conditionC: null,
      runErrors: { global: 1, organizations: [] },
    });
  });

  it("a thrown job AFTER detection keeps the detection results (A and C survive the failure)", () => {
    const f = buildUrgentFindings({
      runErrors: { global: 1, organizations: [] },
      alerts: okAlerts({ newMonthAtRisk: [A], conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] } }),
      atRisk: { [atRiskKey(A)]: { onsetNotBefore: WARNING, evidenceAt: WARNING } },
      thrown: true,
    });
    expect(f).toMatchObject({ thrown: true, detection: "ok", runErrors: { global: 1, organizations: [] } });
    expect(f.newMonthAtRisk).toEqual([{ ...A, onsetNotBefore: WARNING, evidenceAt: WARNING }]);
    expect(f.conditionC).toEqual({ activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] });
  });

  it("the unavailable marker is an object distinguishable from both a clean result and NULL", () => {
    const marker = unavailableFindings("unrecognized_error");
    expect(marker).toEqual({ v: 1, unavailable: "builderFailed", code: "unrecognized_error" });
    expect(marker).not.toHaveProperty("detection");
    expect(marker).not.toEqual(buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts() }));
  });
});

describe("earliestAtRiskEvidence: repeated unclean passes and recovery after a monitoring outage never make A look younger", () => {
  const finding = (evidenceAt: string, onsetNotBefore = WARNING) =>
    buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts({ newMonthAtRisk: [A] }), atRisk: { [atRiskKey(A)]: { onsetNotBefore, evidenceAt } } });
  // Three billing runs while the monitor was down: each later unclean pass moves the run's own evidenceAt later.
  const runs = [finding("2031-11-02T00:05:00.000Z"), finding("2031-11-02T03:05:00.000Z"), finding("2031-11-02T06:05:00.000Z")];

  it("the earliest bounds win, whatever order the stored findings are read in", () => {
    const expected = { [atRiskKey(A)]: { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T00:05:00.000Z" } };
    expect(earliestAtRiskEvidence(runs)).toEqual(expected);
    expect(earliestAtRiskEvidence([...runs].reverse())).toEqual(expected);
  });

  it("onsetNotBefore never moves (it is the approved 15 h point); evidenceAt only ever moves EARLIER as evidence is added", () => {
    let previous = earliestAtRiskEvidence([runs[2]])[atRiskKey(A)];
    for (const extra of [runs[1], runs[0]]) {
      const merged = earliestAtRiskEvidence([runs[2], extra])[atRiskKey(A)];
      expect(merged.onsetNotBefore).toBe(WARNING);
      expect(Date.parse(merged.evidenceAt)).toBeLessThanOrEqual(Date.parse(previous.evidenceAt));
      previous = merged;
    }
  });

  it("unavailable markers, NULLs and seam entries without bounds contribute nothing (they are faults, not evidence)", () => {
    const noBounds = buildUrgentFindings({ runErrors: NO_ERRORS, alerts: okAlerts({ newMonthAtRisk: [A] }) });
    expect(earliestAtRiskEvidence([null, unavailableFindings("x"), noBounds])).toEqual({});
    expect(earliestAtRiskEvidence([null, runs[1], unavailableFindings("x")])).toEqual({ [atRiskKey(A)]: { onsetNotBefore: WARNING, evidenceAt: "2031-11-02T03:05:00.000Z" } });
  });
});
