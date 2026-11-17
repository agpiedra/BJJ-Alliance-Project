import { describe, expect, it, vi } from "vitest";
import type { GenerationAlertReport } from "../../src/lib/dues/monthly-generation-alerts";
import type { MonthlyGenerationRunReport, SegmentVisitReport } from "../../src/lib/dues/monthly-generation-progress";

// Importing the route module constructs the Prisma client (never connected here), which requires DATABASE_URL.
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { buildUrgentFindings, FINDINGS_LIST_CAP } = await import("../../src/lib/dues/urgent-findings");
const { summarizeMonthlyGenerationRun } = await import("../../src/lib/dues/monthly-generation-route");
const { atRiskKey } = await import("../../src/lib/dues/monthly-generation-alerts");

/**
 * PR-A (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md, tests A-U1–A-U8): the durable urgent findings a monthly-generation
 * run stores in `JobRun.urgentFindings`. Pure; no database.
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

describe("buildUrgentFindings", () => {
  it("A-U1: a clean run: detection ok, nothing urgent, zero run errors", () => {
    expect(buildUrgentFindings({ report: run(), alerts: okAlerts() })).toEqual({
      v: 1,
      detection: "ok",
      newMonthAtRisk: [],
      conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
      runErrors: { global: 0, organizations: [] },
    });
  });

  it("A-U2: per-academy run errors (visit error, skipped rollover) are listed sorted and unique; claim and discovery errors are global", () => {
    const report = run({
      visits: [
        visit("org-y", { rollover: { skipped: "configurationTooLarge" }, ended: "error" }),
        visit("org-x", { error: { stage: "page", code: "timeout" as never }, ended: "error" }),
        visit("org-x", { error: { stage: "passEnd", code: "timeout" as never }, ended: "error" }),
        visit("org-z", { rollover: { inserted: 1 } }), // a successful rollover is not an error
      ],
      claimErrors: 2,
      discoveryError: "timeout" as never,
    });
    expect(buildUrgentFindings({ report, alerts: okAlerts() }).runErrors).toEqual({ global: 3, organizations: ["org-x", "org-y"] });
  });

  it("A-U3: detection failed: its safe code is kept, A is empty and C is null (neither passed nor failed)", () => {
    const f = buildUrgentFindings({ report: run(), alerts: failedAlerts("timeout") });
    expect(f).toMatchObject({ detection: "timeout", newMonthAtRisk: [], conditionC: null });
  });

  it("A-U4/A-U5: each A entry carries its atRiskSince from the detailed detection, keyed by organization and month", () => {
    const a = [
      { organizationId: "org-a", year: 2031, month: 11 },
      { organizationId: "org-b", year: 2031, month: 11 },
    ];
    const since = { [atRiskKey(a[0])]: "2031-11-01T21:00:00.000Z", [atRiskKey(a[1])]: "2031-11-02T03:04:05.000Z" };
    expect(buildUrgentFindings({ report: run(), alerts: okAlerts({ newMonthAtRisk: a }), atRiskSince: since }).newMonthAtRisk).toEqual([
      { organizationId: "org-a", year: 2031, month: 11, atRiskSince: "2031-11-01T21:00:00.000Z" },
      { organizationId: "org-b", year: 2031, month: 11, atRiskSince: "2031-11-02T03:04:05.000Z" },
    ]);
    // Without the detail (a test seam), the entry is kept with an explicit null rather than dropped or guessed.
    expect(buildUrgentFindings({ report: run(), alerts: okAlerts({ newMonthAtRisk: [a[0]] }) }).newMonthAtRisk).toEqual([{ ...a[0], atRiskSince: null }]);
  });

  it("A-U6: condition C of both kinds is copied", () => {
    const conditionC = { activatedWithoutProgress: ["org-c"], progressWithoutActivation: ["org-d", "org-e"] };
    expect(buildUrgentFindings({ report: run(), alerts: okAlerts({ conditionC }) }).conditionC).toEqual(conditionC);
  });

  it("A-U7: lists are capped at the detection cap and marked truncated; uncapped findings carry no truncated key", () => {
    const visits = Array.from({ length: 600 }, (_, i) => visit(`org-${String(i).padStart(4, "0")}`, { error: { stage: "gate", code: "timeout" as never }, ended: "error" }));
    const f = buildUrgentFindings({ report: run({ visits }), alerts: okAlerts() });
    expect(FINDINGS_LIST_CAP).toBe(500);
    expect(f.runErrors.organizations).toHaveLength(500);
    expect(f.truncated).toBe(true);
    expect("truncated" in buildUrgentFindings({ report: run(), alerts: okAlerts() })).toBe(false);
  });

  it("A-U8: only the documented keys; ids, months, counts and codes only (no names, messages or URLs)", () => {
    const f = buildUrgentFindings({ report: run(), alerts: okAlerts() });
    expect(Object.keys(f).sort()).toEqual(["conditionC", "detection", "newMonthAtRisk", "runErrors", "v"]);
    expect(Object.keys(buildUrgentFindings({ thrown: true })).sort()).toEqual(["conditionC", "detection", "newMonthAtRisk", "runErrors", "thrown", "v"]);
  });

  it("a thrown job before detection: notEvaluated, one global run error", () => {
    expect(buildUrgentFindings({ thrown: true })).toEqual({
      v: 1,
      thrown: true,
      detection: "notEvaluated",
      newMonthAtRisk: [],
      conditionC: null,
      runErrors: { global: 1, organizations: [] },
    });
  });

  it("a thrown job AFTER detection keeps the detection results (A and C survive the failure)", () => {
    const a = { organizationId: "org-a", year: 2031, month: 11 };
    const f = buildUrgentFindings({
      alerts: okAlerts({ newMonthAtRisk: [a], conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] } }),
      atRiskSince: { [atRiskKey(a)]: "2031-11-01T21:00:00.000Z" },
      thrown: true,
    });
    expect(f).toMatchObject({ thrown: true, detection: "ok", runErrors: { global: 1, organizations: [] } });
    expect(f.newMonthAtRisk).toEqual([{ ...a, atRiskSince: "2031-11-01T21:00:00.000Z" }]);
    expect(f.conditionC).toEqual({ activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] });
  });
});

describe("findings agree with the urgent signal the billing run already sends", () => {
  it("run errors are present in the findings exactly when summarizeMonthlyGenerationRun counts run-level errors", () => {
    const cases: MonthlyGenerationRunReport[] = [
      run(),
      run({ claimErrors: 1 }),
      run({ discoveryError: "timeout" as never }),
      run({ visits: [visit("org-a", { error: { stage: "marker", code: "timeout" as never }, ended: "error" })] }),
      run({ visits: [visit("org-a", { rollover: { skipped: "error", code: "timeout" as never } })] }),
      run({ visits: [visit("org-a", { passFinished: { ineligible: 0, covered: 0, unpriced: 2, pending: 0, clean: false }, ended: "passEnd" })] }), // B, not run-level
    ];
    for (const report of cases) {
      const { runLevelErrors } = summarizeMonthlyGenerationRun(report, okAlerts());
      const { runErrors } = buildUrgentFindings({ report, alerts: okAlerts() });
      expect(runErrors.global > 0 || runErrors.organizations.length > 0).toBe(runLevelErrors > 0);
    }
  });
});
