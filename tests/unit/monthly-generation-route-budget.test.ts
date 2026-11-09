import { describe, expect, it, vi } from "vitest";

// The helper is pure, but importing G1's module constructs the Prisma client, which requires DATABASE_URL to exist — it is
// never connected here (same convention as tests/unit/tenant-guard.test.ts).
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { planRouteBudget } = await import("../../src/lib/dues/monthly-generation-route-budget");
const { DEFAULT_GENERATION_LIMITS, admissionBudgetMs, generationLimitsProblem, runMonthlyGeneration } = await import("../../src/lib/dues/monthly-generation-progress");
const { HEARTBEAT_TIMEOUT_MS } = await import("../../src/lib/jobs/heartbeat");
const { runScheduledJob } = await import("../../src/lib/jobs/run-scheduled-job");
const { listClaimableGenerationSegments } = await import("../../src/lib/tenant/platform-lookups");
const { generateMonthlyObligationForStudent } = await import("../../src/lib/dues/monthly-generation");

/**
 * G2a: the whole-route budget (docs/dues/G2-ROUTE-BUDGET-PLAN.md revision 2, §2). Pure arithmetic: F, C and M are parameters
 * because the host's real limits are unknown (D5). "Feasible" means the runner can admit one visit under worst-case bounds,
 * never a throughput figure.
 */
const bookkeeping = { maxWaitMs: 1_000, timeoutMs: 2_000, statementTimeoutMs: 1_000, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 1_000 };
const base = { coldStartReserveMs: 1_000, marginMs: 1_000, bookkeeping, generation: DEFAULT_GENERATION_LIMITS };

describe("planRouteBudget", () => {
  it("counts each sequential cost once: post = finalize + heartbeat + heartbeat-status; admission = create + the runner's own 40 s", () => {
    expect(admissionBudgetMs(DEFAULT_GENERATION_LIMITS)).toBe(40_000); // discovery 4 s + one visit's entry 36 s
    const plan = planRouteBudget({ ...base, functionMaxMs: 60_000 });
    expect(plan).toMatchObject({
      ok: true,
      admissionMs: 4_000 + 40_000,
      generationDeadlineMs: 60_000 - 1_000 - 1_000 - 13_000,
      reserves: { bookkeepingTransactionMs: 4_000, postMs: 4_000 + 5_000 + 4_000 },
    });
  });

  it("the default limits need F > 57 s + C + M just to admit one visit (strict, like the runner's own admission check)", () => {
    const edge = 57_000 + 1_000 + 1_000;
    expect(planRouteBudget({ ...base, functionMaxMs: edge })).toMatchObject({ ok: false, reason: "budgetInfeasible", failurePathFits: true });
    expect(planRouteBudget({ ...base, functionMaxMs: edge + 1 })).toMatchObject({ ok: true });
  });

  it("every early exit's own reserve fits inside post + M, so reserving post covers all exits", () => {
    const plan = planRouteBudget({ ...base, functionMaxMs: 120_000 });
    if (!plan.ok) throw new Error("expected feasible");
    const { postMs, createFailedMs, budgetInfeasibleMs, finalizeUnconfirmedMs } = plan.reserves;
    for (const reserve of [createFailedMs, budgetInfeasibleMs, finalizeUnconfirmedMs]) expect(reserve).toBeLessThanOrEqual(postMs + base.marginMs);
    expect(createFailedMs).toBe(5_000 + 1_000); // one /fail ping + margin; no finalize, no heartbeat-status write
    expect(finalizeUnconfirmedMs).toBe(5_000 + 1_000); // one /fail ping + margin; heartbeat-status not attempted
  });

  it("reports when even the refusal cannot be recorded inside F", () => {
    expect(planRouteBudget({ ...base, functionMaxMs: 10_000 })).toMatchObject({ ok: false, reason: "budgetInfeasible", failurePathFits: false });
  });

  it("refuses a lease that does not outlive F", () => {
    expect(planRouteBudget({ ...base, functionMaxMs: 600_000 })).toEqual({ ok: false, reason: "leaseTooShort", leaseMs: 600_000, functionMaxMs: 600_000 });
  });

  describe("timeouts are validated as executed: no zero, truncated, non-finite or out-of-order value is certified", () => {
    const G = DEFAULT_GENERATION_LIMITS;
    const cases: Array<[string, Parameters<typeof planRouteBudget>[0]]> = [
      ["a zero bookkeeping statement timeout (PostgreSQL 0 disables it)", { ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, statementTimeoutMs: 0, lockTimeoutMs: 0 } }],
      ["a sub-millisecond bookkeeping timeout that Math.trunc would turn into 0", { ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, statementTimeoutMs: 0.5, lockTimeoutMs: 0.5 } }],
      ["a fractional idle timeout", { ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, idleInTransactionTimeoutMs: 0.9 } }],
      ["a zero generation statement timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, statementTimeoutMs: 0, lockTimeoutMs: 0 } }],
      ["a sub-millisecond generation idle timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, idleInTransactionTimeoutMs: 0.4 } }],
      ["a non-finite generation student timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, studentTimeoutMs: Number.POSITIVE_INFINITY } }],
      ["a NaN generation short timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, shortTimeoutMs: Number.NaN } }],
      ["generation statement timeout above the short transaction timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, statementTimeoutMs: 3_000 } }],
      ["generation lock timeout above the statement timeout", { ...base, functionMaxMs: 120_000, generation: { ...G, lockTimeoutMs: 2_000 } }],
      ["a fractional lease", { ...base, functionMaxMs: 120_000, generation: { ...G, leaseSeconds: 600.5 } }],
      ["a non-finite generation deadline", { ...base, functionMaxMs: 120_000, generation: { ...G, deadlineMs: Number.NaN } }],
    ];
    for (const [name, input] of cases) {
      it(`refuses ${name}`, () => {
        expect(planRouteBudget(input)).toMatchObject({ ok: false, reason: "invalidInput" });
      });
    }

    it("the valid defaults are unchanged and still certified", () => {
      expect(generationLimitsProblem(DEFAULT_GENERATION_LIMITS)).toBeNull();
      expect(DEFAULT_GENERATION_LIMITS).toMatchObject({ statementTimeoutMs: 1_000, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 1_000, shortMaxWaitMs: 1_000, shortTimeoutMs: 2_000, studentMaxWaitMs: 2_000, studentTimeoutMs: 5_000, deadlineMs: 45_000, leaseSeconds: 600 });
      expect(planRouteBudget({ ...base, functionMaxMs: 60_000 })).toMatchObject({ ok: true, admissionMs: 44_000, generationDeadlineMs: 45_000 });
    });

    it("every bounded execution entry point refuses the same invalid values before any I/O", async () => {
      const zero = { maxWaitMs: 1_000, timeoutMs: 2_000, statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 1_000 };
      const truncating = { ...zero, statementTimeoutMs: 0.5, lockTimeoutMs: 0.5 };
      for (const bounds of [zero, truncating]) {
        await expect(runScheduledJob("weekly-digest", new Request("http://localhost/x"), async () => ({ outcome: { sent: 0, failed: 0, skipped: 0, organizationsProcessed: 0 }, body: {} }), { bookkeeping: bounds })).rejects.toThrow(RangeError);
        await expect(listClaimableGenerationSegments(1, bounds)).rejects.toThrow(RangeError);
        await expect(
          generateMonthlyObligationForStudent({ kind: "system-job", organizationId: "o", jobName: "monthly-generation" }, "s", { year: 2030, month: 9 }, {}, { bounds }),
        ).rejects.toThrow(RangeError);
        await expect(runMonthlyGeneration({ closurePolicy: "reopen", limits: { statementTimeoutMs: bounds.statementTimeoutMs, lockTimeoutMs: bounds.lockTimeoutMs } })).rejects.toThrow(RangeError);
      }
    });
  });

  it("the heartbeat reserve is exactly the abort the heartbeat client uses; there is no override that could reserve less", () => {
    const plan = planRouteBudget({ ...base, functionMaxMs: 120_000 });
    if (!plan.ok) throw new Error("expected feasible");
    expect(plan.reserves.postMs - 2 * plan.reserves.bookkeepingTransactionMs).toBe(HEARTBEAT_TIMEOUT_MS);
    expect(plan.reserves.createFailedMs - base.marginMs).toBe(HEARTBEAT_TIMEOUT_MS);
    expect(plan.reserves.finalizeUnconfirmedMs - base.marginMs).toBe(HEARTBEAT_TIMEOUT_MS);
    // An attempted override is not part of the input type, and has no effect at runtime either.
    // @ts-expect-error heartbeatTimeoutMs is deliberately not an input
    const overridden = planRouteBudget({ ...base, functionMaxMs: 120_000, heartbeatTimeoutMs: 1 });
    expect(overridden).toEqual(plan);
  });

  describe("four-check alerting (MONTHLY-GENERATION-ALERTING-PLAN.md §5): sequential pings and the pre-runner detection read", () => {
    const route = { functionMaxMs: 300_000, coldStartReserveMs: 30_000, marginMs: 30_000, bookkeeping, generation: DEFAULT_GENERATION_LIMITS };

    it("REQUIRED: 4 pings and a 4 s read give a 212 s deadline and 48 s admission; 1 ping and no read stay at 227 s / 44 s", () => {
      expect(planRouteBudget({ ...route, heartbeatPings: 4, preRunnerReadMs: 4_000 })).toMatchObject({
        ok: true,
        generationDeadlineMs: 212_000,
        admissionMs: 48_000,
        reserves: { postMs: 2 * 4_000 + 4 * HEARTBEAT_TIMEOUT_MS },
      });
      expect(planRouteBudget(route)).toMatchObject({ ok: true, generationDeadlineMs: 227_000, admissionMs: 44_000 });
      expect(planRouteBudget({ ...route, heartbeatPings: 1, preRunnerReadMs: 0 })).toEqual(planRouteBudget(route));
    });

    it("each extra ping costs exactly one HEARTBEAT_TIMEOUT_MS of deadline; the read costs admission only, never the deadline", () => {
      const at = (heartbeatPings: number, preRunnerReadMs = 0) => planRouteBudget({ ...route, heartbeatPings, preRunnerReadMs });
      const [one, two] = [at(1), at(2)];
      if (!one.ok || !two.ok) throw new Error("expected feasible");
      expect(one.generationDeadlineMs - two.generationDeadlineMs).toBe(HEARTBEAT_TIMEOUT_MS);
      const withRead = at(1, 4_000);
      if (!withRead.ok) throw new Error("expected feasible");
      expect(withRead.generationDeadlineMs).toBe(one.generationDeadlineMs);
      expect(withRead.admissionMs - one.admissionMs).toBe(4_000);
    });

    it("the refusal path reserves every ping too, and still fits inside post + M", () => {
      const plan = planRouteBudget({ ...route, heartbeatPings: 4, preRunnerReadMs: 4_000 });
      if (!plan.ok) throw new Error("expected feasible");
      expect(plan.reserves.budgetInfeasibleMs).toBe(plan.reserves.postMs + route.marginMs);
    });

    it("infeasible exactly where admission (48 s) stops fitting under the shrunken deadline (strict)", () => {
      // deadline = F - 60 s - 28 s must exceed 48 s: F > 136 s.
      expect(planRouteBudget({ ...route, functionMaxMs: 136_000, heartbeatPings: 4, preRunnerReadMs: 4_000 })).toMatchObject({ ok: false, reason: "budgetInfeasible" });
      expect(planRouteBudget({ ...route, functionMaxMs: 136_001, heartbeatPings: 4, preRunnerReadMs: 4_000 })).toMatchObject({ ok: true });
    });

    it.each([
      ["zero pings", { heartbeatPings: 0 }],
      ["a fractional ping count", { heartbeatPings: 1.5 }],
      ["a negative read", { preRunnerReadMs: -1 }],
      ["a non-finite read", { preRunnerReadMs: Number.POSITIVE_INFINITY }],
    ])("refuses %s", (_label, extra) => {
      expect(planRouteBudget({ ...route, ...extra })).toMatchObject({ ok: false, reason: "invalidInput" });
    });

    it("the lease must still outlive F", () => {
      expect(planRouteBudget({ ...route, functionMaxMs: 600_000, heartbeatPings: 4 })).toMatchObject({ ok: false, reason: "leaseTooShort" });
    });
  });

  it("refuses invalid or inconsistent inputs instead of computing with them", () => {
    expect(planRouteBudget({ ...base, functionMaxMs: Number.NaN })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, marginMs: -1 })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, statementTimeoutMs: 3_000 } })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, idleInTransactionTimeoutMs: 0 } })).toMatchObject({ ok: false, reason: "invalidInput" });
  });
});
