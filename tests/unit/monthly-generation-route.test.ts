import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";
import type { MonthlyGenerationRunReport } from "../../src/lib/dues/monthly-generation-progress";

/**
 * G2b unit checks: the shared constant-time secret check, the route's constants and budget, the §8 outcome mapping, and the
 * "registered but not scheduled" job-health invariants. The route's HTTP behavior is in
 * tests/integration/monthly-generation-route.test.ts.
 */
const { secretsMatch, bearerMatches } = await import("../../src/lib/auth/secrets-match");
const {
  MONTHLY_GENERATION_FUNCTION_MAX_SECONDS,
  COLD_START_RESERVE_MS,
  MARGIN_MS,
  MONTHLY_GENERATION_BOOKKEEPING,
  monthlyGenerationRouteBudget,
  summarizeMonthlyGenerationRun,
} = await import("../../src/lib/dues/monthly-generation-route");
const { planRouteBudget } = await import("../../src/lib/dues/monthly-generation-route-budget");
const { DEFAULT_GENERATION_LIMITS, GENERATION_JOB_NAME } = await import("../../src/lib/dues/monthly-generation-progress");
const { JOB_NAMES } = await import("../../src/lib/jobs/job-names");
const { STALE_AFTER_HOURS, isJobStale, resolveJobSchedule } = await import("../../src/lib/jobs/job-health");

describe("secretsMatch / bearerMatches (constant time, same accept set as the former !==)", () => {
  it("accepts only the exact value", () => {
    expect(secretsMatch("s3cret", "s3cret")).toBe(true);
    for (const other of ["", "s3cre", "s3crett", "S3cret", " s3cret", "s3cret ", "s3crex"]) expect(secretsMatch("s3cret", other)).toBe(false);
  });

  it("Unicode: an exact multi-byte secret matches; a canonically equivalent but differently encoded one does not (as with !==)", () => {
    const secret = "sécret-ñ-✓-🥋";
    expect(secretsMatch(secret, secret)).toBe(true);
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
    const nfd = secret.normalize("NFD"); // "é" and "ñ" decomposed: equal to a reader, different strings and bytes
    expect(nfd).not.toBe(secret);
    expect(secretsMatch(secret, nfd)).toBe(false);
    expect(secret !== nfd).toBe(true); // the former check rejected it too
  });

  it("different byte lengths never throw (timingSafeEqual would) and never match, including same-length-in-characters values", () => {
    expect(() => secretsMatch("abc", "abcd")).not.toThrow();
    expect(secretsMatch("abc", "abcd")).toBe(false);
    expect(secretsMatch("é", "e")).toBe(false); // 1 character each, 2 bytes vs 1
    expect(secretsMatch("ab", "é")).toBe(false); // 2 bytes each, different content
  });

  it("empty values: equal empties match exactly as `\"\" === \"\"`; route callers never get here with an empty secret (requireEnv throws first)", () => {
    expect(secretsMatch("", "")).toBe(true);
    expect(secretsMatch("", "x")).toBe(false);
    expect(bearerMatches(null, "x")).toBe(false);
    expect(bearerMatches("", "x")).toBe(false);
  });

  it("bearerMatches compares the whole header, untrimmed and case-sensitive", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    for (const header of [null, "", "s3cret", "bearer s3cret", "Bearer  s3cret", "Bearer s3cret ", "Bearer s3cre", "Bearer s3crett", "Basic s3cret"]) {
      expect(bearerMatches(header, "s3cret")).toBe(false);
    }
  });

  it("no production file compares the Authorization header or CRON_SECRET with === / !== any more", () => {
    const offenders = productionSourceFiles()
      .filter((f) => /[!=]==\s*`Bearer \$\{|`Bearer \$\{[^`]*\}`\s*[!=]==/.test(stripComments(f.text)))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
    for (const file of ["src/lib/jobs/run-scheduled-job.ts", "src/app/api/health/jobs/route.ts"]) {
      expect(stripComments(readFileSync(file, "utf8"))).toContain("bearerMatches(");
    }
    expect(stripComments(readFileSync("src/app/api/e2e-auth-bypass/route.ts", "utf8"))).toMatch(/import \{ secretsMatch \} from "@\/lib\/auth\/secrets-match"/);
  });
});

describe("the route's constants and budget", () => {
  it("maxDuration in the route file is the literal F the module uses (Next reads it statically)", () => {
    const route = stripComments(readFileSync("src/app/api/cron/monthly-generation/route.ts", "utf8"));
    const literal = /export const maxDuration = (\d+);/.exec(route);
    expect(literal).not.toBeNull();
    expect(Number(literal![1])).toBe(MONTHLY_GENERATION_FUNCTION_MAX_SECONDS);
    expect(MONTHLY_GENERATION_FUNCTION_MAX_SECONDS).toBe(300);
  });

  it("C and M are the approved reserves (30 s each) and the bookkeeping bounds are G2a's 4 s per write", () => {
    expect(COLD_START_RESERVE_MS).toBe(30_000);
    expect(MARGIN_MS).toBe(30_000);
    expect(MONTHLY_GENERATION_BOOKKEEPING).toEqual({ maxWaitMs: 1_000, timeoutMs: 2_000, statementTimeoutMs: 1_000, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 1_000 });
  });

  it("the deadline is whatever planRouteBudget computes from F, C, M, 4 sequential pings and the 4 s detection read (212 s, admission 48 s) — never a literal in the route", () => {
    const plan = monthlyGenerationRouteBudget();
    const direct = planRouteBudget({
      functionMaxMs: 300_000,
      coldStartReserveMs: 30_000,
      marginMs: 30_000,
      bookkeeping: MONTHLY_GENERATION_BOOKKEEPING,
      generation: DEFAULT_GENERATION_LIMITS,
      heartbeatPings: 4,
      preRunnerReadMs: 4_000,
    });
    expect(plan).toEqual(direct);
    // post = 2 x 4 s writes + 4 x 5 s pings = 28 s; 300 - 30 - 30 - 28 = 212 s. Admission = 4 s create + 4 s read + 40 s.
    expect(plan).toMatchObject({ ok: true, generationDeadlineMs: 212_000, admissionMs: 48_000, reserves: { postMs: 28_000 } });
    if (!plan.ok) throw new Error("expected a feasible plan");
    // The whole function, end to end: cold start C | create + detection read + generation (all inside the 212 s, measured
    // from the handler's first line) | finalize + 4 ping timeouts + heartbeat/alert write (post) | margin M = F exactly.
    expect(COLD_START_RESERVE_MS + plan.generationDeadlineMs + plan.reserves.postMs + MARGIN_MS).toBe(300_000);
    expect(plan.reserves.postMs).toBe(2 * 4_000 + 4 * 5_000);
    const source = stripComments(readFileSync("src/lib/dues/monthly-generation-route.ts", "utf8"));
    expect(source).not.toMatch(/2(12|27)[_]?000|\b2(12|27)\b/);
    expect(source).toContain("deadlineMs: budget.generationDeadlineMs");
  });

  it("a too-small F is reported infeasible, not run", () => {
    expect(monthlyGenerationRouteBudget(60_000)).toMatchObject({ ok: false });
  });
});

const visit = (o: Partial<MonthlyGenerationRunReport["visits"][number]> = {}): MonthlyGenerationRunReport["visits"][number] => ({
  segmentId: "seg",
  organizationId: "org-a",
  year: 2031,
  month: 3,
  created: 0,
  classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 0, PENDING: 0 },
  reasons: {},
  errorCodes: {},
  ended: "deadline",
  ...o,
});
const report = (o: Partial<MonthlyGenerationRunReport> = {}): MonthlyGenerationRunReport => ({ visits: [], claimErrors: 0, stoppedBy: "deadline", ...o });

describe("summarizeMonthlyGenerationRun: MONTHLY-GENERATION-TRIGGER-PLAN.md §8 mapping", () => {
  it("sent = created, skipped = INELIGIBLE + COVERED; a deadline stop with work left is not a failure; never certifies billing", () => {
    const { outcome, body } = summarizeMonthlyGenerationRun(report({ visits: [visit({ created: 4, classes: { INELIGIBLE: 2, COVERED: 3, UNPRICED: 0, PENDING: 0 } })] }));
    expect(outcome).toMatchObject({ sent: 4, skipped: 5, failed: 0, organizationsProcessed: 1, errors: [] });
    expect(body).toMatchObject({ ok: true, billingCompletenessCertified: false, stoppedBy: "deadline" });
  });

  it.each([
    ["a pass that ended with UNPRICED students", visit({ ended: "passEnd", passFinished: { ineligible: 0, covered: 1, unpriced: 2, pending: 0, clean: false } }), "passEnded unpriced=2 pending=0"],
    ["a pass that ended with PENDING students", visit({ ended: "passEnd", passFinished: { ineligible: 0, covered: 1, unpriced: 0, pending: 1, clean: false } }), "passEnded unpriced=0 pending=1"],
    ["a rollover skipped as too large", visit({ rollover: { skipped: "configurationTooLarge" } }), "rolloverSkipped=configurationTooLarge"],
    ["a rollover skipped on an error", visit({ rollover: { skipped: "error", code: "P2024" } }), "rolloverSkipped=error:P2024"],
    ["a visit ended by a stage error", visit({ ended: "error", error: { stage: "page", code: "P2028" } }), "stage=page code=P2028"],
  ])("%s counts as one failure, reported by ids and codes only", (_label, v, expected) => {
    const { outcome, body } = summarizeMonthlyGenerationRun(report({ visits: [v] }));
    expect(outcome.failed).toBe(1);
    expect(outcome.errors).toEqual([expect.stringContaining(expected)]);
    expect(body.ok).toBe(false);
  });

  it("a clean finished pass and a refused (inactive) visit are not failures", () => {
    const { outcome } = summarizeMonthlyGenerationRun(
      report({ visits: [visit({ ended: "passEnd", passFinished: { ineligible: 1, covered: 2, unpriced: 0, pending: 0, clean: true } }), visit({ segmentId: "s2", ended: "refused", refused: "ledgerNotActive" })] }),
    );
    expect(outcome.failed).toBe(0);
  });

  it("a student transaction that failed mid-pass is not yet a run failure, but its safe code and reason counts are in the body", () => {
    const { outcome, body } = summarizeMonthlyGenerationRun(
      report({ visits: [visit({ classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 1, PENDING: 2 }, reasons: { noEffectiveVersion: 1, unexpected: 2 }, errorCodes: { P2028: 2 } })] }),
    );
    expect(outcome.failed).toBe(0);
    expect((body.visits as Array<Record<string, unknown>>)[0]).toMatchObject({ reasons: { noEffectiveVersion: 1, unexpected: 2 }, errorCodes: { P2028: 2 } });
    expect((body.visits as Array<Record<string, unknown>>)[0]).not.toHaveProperty("studentId");
  });

  it("a visit with no codes carries no empty reasons/errorCodes objects", () => {
    const { body } = summarizeMonthlyGenerationRun(report({ visits: [visit()] }));
    expect((body.visits as Array<Record<string, unknown>>)[0]).not.toHaveProperty("reasons");
    expect((body.visits as Array<Record<string, unknown>>)[0]).not.toHaveProperty("errorCodes");
  });

  it("claim errors and a discovery error are failures", () => {
    const { outcome } = summarizeMonthlyGenerationRun(report({ claimErrors: 2, discoveryError: "P1001", stoppedBy: "discoveryFailed" }));
    expect(outcome.failed).toBe(3);
    expect(outcome.errors).toEqual(["claimErrors=2", "discovery code=P1001"]);
  });

  it("groups the breakdown per organization", () => {
    const { outcome } = summarizeMonthlyGenerationRun(report({ visits: [visit({ created: 1 }), visit({ segmentId: "s2", created: 2 }), visit({ segmentId: "s3", organizationId: "org-b", created: 5 })] }));
    expect(outcome.organizationsProcessed).toBe(2);
    expect(outcome.organizationBreakdown).toEqual([
      { organizationId: "org-a", sent: 3, failed: 0, skipped: 0 },
      { organizationId: "org-b", sent: 5, failed: 0, skipped: 0 },
    ]);
  });
});

describe("scheduled (D5: `0 */3 * * *` UTC, stale after 4 h)", () => {
  it("the registry name is the runner's own job name", () => {
    expect(JOB_NAMES).toContain(GENERATION_JOB_NAME);
  });

  it("every job with a vercel.json schedule has a stale threshold, and every unscheduled job has none", () => {
    for (const job of JOB_NAMES) {
      expect(STALE_AFTER_HOURS[job] === null, `${job}: threshold and schedule must be added together`).toBe(resolveJobSchedule(job) === null);
    }
  });

  it("monthly generation is stale with no run, fresh up to 4 h after its last start, stale after: a single missed 3-hour slot is reported (about an hour after it was due)", () => {
    const now = Date.parse("2031-11-01T12:00:00Z");
    expect(isJobStale("monthly-generation", null, now)).toBe(true);
    expect(isJobStale("monthly-generation", new Date(now - 3 * 3_600_000), now)).toBe(false); // the previous slot
    expect(isJobStale("monthly-generation", new Date(now - 4 * 3_600_000), now)).toBe(false); // exactly the threshold
    expect(isJobStale("monthly-generation", new Date(now - 4 * 3_600_000 - 1), now)).toBe(true);
    expect(isJobStale("monthly-generation", new Date(now - 6 * 3_600_000), now)).toBe(true); // a missed slot plus
  });
});
