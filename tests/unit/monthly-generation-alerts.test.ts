import { describe, expect, it, vi } from "vitest";

// Pure evaluation; importing the module constructs the Prisma client (never connected here), which requires DATABASE_URL.
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { evaluateGenerationAlerts, detectGenerationAlerts, alertSignalsFor, NEW_MONTH_WARNING_MS, WORKLOAD_THRESHOLDS, DETECTION_CAP } = await import(
  "../../src/lib/dues/monthly-generation-alerts"
);
type State = Parameters<typeof evaluateGenerationAlerts>[0];
type Row = State["progress"][number];

/**
 * MONTHLY-GENERATION-ALERTING-PLAN.md §7.2 (tests 6–10) and the D / signal rules. Fixed clocks; no database.
 * Costa Rica is UTC-6 with no DST: November 2031 opens at 2031-11-01T06:00Z, so T_open + 15 h = 21:00Z.
 */
const CR = "America/Costa_Rica";
const ORG = "org-a";
const done = new Date("2031-11-01T00:00:00Z");
const row = (year: number, month: number, over: Partial<Row> = {}): Row => ({ organizationId: ORG, year, month, lastPassCompletedAt: done, lastPassClean: true, ...over });
const state = (over: Partial<State> = {}): State => ({
  progress: [row(2031, 10), row(2031, 11, { lastPassCompletedAt: null, lastPassClean: null })],
  branches: [{ organizationId: ORG, timezone: CR }],
  students: [{ organizationId: ORG, count: 55 }],
  organizations: [{ organizationId: ORG, status: "ACTIVE" }],
  overflow: false,
  ...over,
});
const at = (iso: string) => new Date(iso);

describe("condition A: the new month at risk at T_open + 15 h", () => {
  it("REQUIRED (test 6): 14 h 59 m 59 s after opening is not A; exactly 15 h is A", () => {
    expect(NEW_MONTH_WARNING_MS).toBe(15 * 3_600_000);
    expect(evaluateGenerationAlerts(state(), at("2031-11-01T20:59:59Z")).newMonthAtRisk).toEqual([]);
    expect(evaluateGenerationAlerts(state(), at("2031-11-01T21:00:00Z")).newMonthAtRisk).toEqual([{ organizationId: ORG, year: 2031, month: 11 }]);
  });

  it("A when the new month has no row yet (rollover has not happened)", () => {
    const s = state({ progress: [row(2031, 10)] });
    expect(evaluateGenerationAlerts(s, at("2031-11-01T21:00:00Z")).newMonthAtRisk).toEqual([{ organizationId: ORG, year: 2031, month: 11 }]);
  });

  it("A when the new month's last finished pass was not clean", () => {
    const s = state({ progress: [row(2031, 10), row(2031, 11, { lastPassClean: false })] });
    expect(evaluateGenerationAlerts(s, at("2031-11-02T00:00:00Z")).newMonthAtRisk).toHaveLength(1);
  });

  it("REQUIRED (test 10): A clears once the new month has a clean finished pass", () => {
    const s = state({ progress: [row(2031, 10), row(2031, 11)] });
    expect(evaluateGenerationAlerts(s, at("2031-11-02T00:00:00Z")).newMonthAtRisk).toEqual([]);
  });

  it("REQUIRED (test 7): T_open is the LATEST branch's local midnight (Costa Rica 06:00Z, Los Angeles 07:00Z)", () => {
    const s = state({ branches: [{ organizationId: ORG, timezone: CR }, { organizationId: ORG, timezone: "America/Los_Angeles" }] });
    expect(evaluateGenerationAlerts(s, at("2031-11-01T21:59:59Z")).newMonthAtRisk).toEqual([]);
    expect(evaluateGenerationAlerts(s, at("2031-11-01T22:00:00Z")).newMonthAtRisk).toHaveLength(1);
  });

  it("a month before the organization's first row (its start month) is never at risk", () => {
    const s = state({ progress: [row(2031, 12, { lastPassCompletedAt: null, lastPassClean: null })] });
    expect(evaluateGenerationAlerts(s, at("2031-11-20T00:00:00Z")).newMonthAtRisk).toEqual([]);
  });
});

describe("condition B: an older month not clean", () => {
  it("REQUIRED (test 10): B persists while an older month's last pass is unclean or never finished, and clears when clean", () => {
    const now = at("2031-11-02T00:00:00Z");
    const unclean = state({ progress: [row(2031, 9, { lastPassClean: false }), row(2031, 10, { lastPassCompletedAt: null, lastPassClean: null }), row(2031, 11)] });
    expect(evaluateGenerationAlerts(unclean, now).olderMonthNotClean).toEqual([
      { organizationId: ORG, year: 2031, month: 9 },
      { organizationId: ORG, year: 2031, month: 10 },
    ]);
    const clean = state({ progress: [row(2031, 9), row(2031, 10), row(2031, 11)] });
    expect(evaluateGenerationAlerts(clean, now).olderMonthNotClean).toEqual([]);
  });

  it("the new month itself is never B (it is A's business)", () => {
    expect(evaluateGenerationAlerts(state(), at("2031-11-01T10:00:00Z")).olderMonthNotClean).toEqual([]);
  });
});

describe("non-ACTIVE organizations owe no billing: no A, B or D for them, but their rows still count as workload", () => {
  const now = at("2031-11-02T00:00:00Z");
  it.each(["SUSPENDED", "CANCELLED", "PENDING"] as const)("REQUIRED: a %s organization cannot hold the urgent or data check down", (s) => {
    const report = evaluateGenerationAlerts(
      state({ progress: [row(2031, 9, { lastPassClean: false }), row(2031, 10)], organizations: [{ organizationId: ORG, status: s }] }),
      now,
    );
    expect(report).toMatchObject({ detection: "ok", newMonthAtRisk: [], olderMonthNotClean: [], notActiveOrganizations: [ORG] });
    expect(report.workload!.counts.progressRows).toBe(2);
    expect(alertSignalsFor(report, 0)).toEqual({ urgent: true, data: true, workload: true });
  });

  it("a non-ACTIVE organization with no branch or an unknown timezone is not a detection failure", () => {
    const suspended = [{ organizationId: ORG, status: "SUSPENDED" as const }];
    expect(evaluateGenerationAlerts(state({ branches: [], organizations: suspended }), now)).toMatchObject({ detection: "ok", notActiveOrganizations: [ORG] });
    expect(evaluateGenerationAlerts(state({ branches: [{ organizationId: ORG, timezone: "Not/AZone" }], organizations: suspended }), now)).toMatchObject({ detection: "ok" });
  });

  it("one suspended organization does not hide an ACTIVE organization's at-risk month", () => {
    const report = evaluateGenerationAlerts(
      state({
        progress: [row(2031, 10), row(2031, 10, { organizationId: "org-b" })],
        branches: [{ organizationId: ORG, timezone: CR }, { organizationId: "org-b", timezone: CR }],
        organizations: [{ organizationId: ORG, status: "SUSPENDED" }, { organizationId: "org-b", status: "ACTIVE" }],
      }),
      now,
    );
    expect(report.newMonthAtRisk).toEqual([{ organizationId: "org-b", year: 2031, month: 11 }]);
    expect(report.notActiveOrganizations).toEqual([ORG]);
  });
});

describe("condition C is not evaluable; D is any detection failure", () => {
  it("REQUIRED: C is reported notEvaluable on every path (ok, overflow, read failure) — never as passed", async () => {
    expect(evaluateGenerationAlerts(state(), at("2031-11-01T10:00:00Z")).conditionC).toBe("notEvaluable");
    expect(evaluateGenerationAlerts(state({ overflow: true }), at("2031-11-01T10:00:00Z")).conditionC).toBe("notEvaluable");
    const failedRead = await detectGenerationAlerts(at("2031-11-01T10:00:00Z"), async () => {
      throw new Error("boom");
    });
    expect(failedRead.conditionC).toBe("notEvaluable");
  });

  it.each([
    ["overflow", state({ overflow: true }), "overflow"],
    ["an organization with no branch", state({ branches: [] }), "noBranches"],
    ["an unknown timezone", state({ branches: [{ organizationId: ORG, timezone: "Not/AZone" }] }), "invalidTimezone"],
  ])("D: %s", (_label, s, code) => {
    const report = evaluateGenerationAlerts(s, at("2031-11-02T00:00:00Z"));
    expect(report).toMatchObject({ detection: code, newMonthAtRisk: [], olderMonthNotClean: [], workload: null });
    expect(alertSignalsFor(report, 0)).toEqual({ urgent: false });
  });

  it("D: a failed or timed-out read never throws and carries a safe code only (never the error's message)", async () => {
    let capSeen = -1;
    const report = await detectGenerationAlerts(at("2031-11-02T00:00:00Z"), async (cap) => {
      capSeen = cap;
      throw new Error("secret detail that must not leak");
    });
    expect(capSeen).toBe(DETECTION_CAP);
    expect(report.detection).not.toBe("ok");
    expect(JSON.stringify(report)).not.toContain("secret detail");
  });

  it("an empty progress table (today's production state) reports nothing and every check succeeds", () => {
    const report = evaluateGenerationAlerts({ progress: [], branches: [], students: [], organizations: [], overflow: false }, at("2031-11-02T00:00:00Z"));
    expect(report).toMatchObject({ detection: "ok", newMonthAtRisk: [], olderMonthNotClean: [], workload: { reasons: [] } });
    expect(alertSignalsFor(report, 0)).toEqual({ urgent: true, data: true, workload: true });
  });
});

describe("workload review thresholds (test 9: limit - 1 / limit / limit + 1)", () => {
  const now = at("2031-11-15T00:00:00Z");
  const reasons = (s: State) => evaluateGenerationAlerts(s, now).workload!.reasons;
  const cleanRows = (n: number, organizationId = ORG): Row[] =>
    Array.from({ length: n }, (_, i) => {
      const total = 2031 * 12 + 10 - i; // November 2031 backwards
      return { organizationId, year: Math.floor(total / 12), month: (total % 12) + 1, lastPassCompletedAt: done, lastPassClean: true };
    });

  it("progress rows: 49 none, 50 reached, 51 reached (>= 50); every row counts, whatever its organization's status", () => {
    expect(WORKLOAD_THRESHOLDS.progressRows).toBe(50);
    expect(reasons(state({ progress: cleanRows(49) }))).toEqual([]);
    expect(reasons(state({ progress: cleanRows(50) }))).toEqual(["progressRows"]);
    expect(reasons(state({ progress: cleanRows(51) }))).toEqual(["progressRows"]);
  });

  it("organizations with progress rows: 4 none, 5 reached", () => {
    const orgs = (n: number): State => {
      const ids = Array.from({ length: n }, (_, i) => `org-${i}`);
      return state({
        progress: ids.flatMap((id) => cleanRows(1, id)),
        branches: ids.map((id) => ({ organizationId: id, timezone: CR })),
        students: ids.map((id) => ({ organizationId: id, count: 1 })),
      });
    };
    expect(reasons(orgs(4))).toEqual([]);
    expect(reasons(orgs(5))).toEqual(["organizations"]);
  });

  it("students in one organization (any status): 100 none, 101 reached; total over all: 280 none, 281 reached", () => {
    expect(reasons(state({ progress: cleanRows(1), students: [{ organizationId: ORG, count: 100 }] }))).toEqual([]);
    expect(reasons(state({ progress: cleanRows(1), students: [{ organizationId: ORG, count: 101 }] }))).toEqual(["studentsPerOrganization"]);
    const three = (counts: number[]): State => {
      const ids = counts.map((_, i) => `org-${i}`);
      return state({ progress: ids.flatMap((id) => cleanRows(1, id)), branches: ids.map((id) => ({ organizationId: id, timezone: CR })), students: ids.map((id, i) => ({ organizationId: id, count: counts[i]! })) });
    };
    expect(reasons(three([100, 90, 90]))).toEqual([]);
    expect(reasons(three([100, 90, 91]))).toEqual(["studentsTotal"]);
  });

  it("branches in one organization: 2 none, 3 reached", () => {
    const branches = (n: number) => Array.from({ length: n }, () => ({ organizationId: ORG, timezone: CR }));
    expect(reasons(state({ progress: cleanRows(1), branches: branches(2) }))).toEqual([]);
    expect(reasons(state({ progress: cleanRows(1), branches: branches(3) }))).toEqual(["branchesPerOrganization"]);
  });

  it("REQUIRED (test 8): Costa Rica is aligned to `0 */3 * * *`; New York (midnight 04:00Z / 05:00Z) is not", () => {
    expect(reasons(state({ progress: cleanRows(1) }))).toEqual([]);
    expect(reasons(state({ progress: cleanRows(1), branches: [{ organizationId: ORG, timezone: "America/New_York" }] }))).toEqual(["unalignedTimezone"]);
  });
});

describe("alertSignalsFor: which check gets what", () => {
  const now = at("2031-11-02T00:00:00Z");
  it("REQUIRED: a reached workload threshold fails ONLY the workload check — never urgent or data", () => {
    const report = evaluateGenerationAlerts(state({ progress: [row(2031, 10), row(2031, 11)], students: [{ organizationId: ORG, count: 101 }] }), now);
    expect(alertSignalsFor(report, 0)).toEqual({ urgent: true, data: true, workload: false });
  });
  it("A fails urgent; B fails data; run-level errors fail urgent", () => {
    expect(alertSignalsFor(evaluateGenerationAlerts(state(), now), 0)).toEqual({ urgent: false, data: true, workload: true });
    const b = evaluateGenerationAlerts(state({ progress: [row(2031, 10, { lastPassClean: false }), row(2031, 11)] }), now);
    expect(alertSignalsFor(b, 0)).toEqual({ urgent: true, data: false, workload: true });
    expect(alertSignalsFor(evaluateGenerationAlerts(state({ progress: [row(2031, 11)] }), now), 1)).toEqual({ urgent: false, data: true, workload: true });
  });
});
