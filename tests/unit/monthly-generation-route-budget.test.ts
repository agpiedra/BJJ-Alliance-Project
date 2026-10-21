import { describe, expect, it, vi } from "vitest";

// The helper is pure, but importing G1's module constructs the Prisma client, which requires DATABASE_URL to exist — it is
// never connected here (same convention as tests/unit/tenant-guard.test.ts).
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { planRouteBudget } = await import("../../src/lib/dues/monthly-generation-route-budget");
const { DEFAULT_GENERATION_LIMITS, admissionBudgetMs } = await import("../../src/lib/dues/monthly-generation-progress");

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

  it("refuses invalid or inconsistent inputs instead of computing with them", () => {
    expect(planRouteBudget({ ...base, functionMaxMs: Number.NaN })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, marginMs: -1 })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, statementTimeoutMs: 3_000 } })).toMatchObject({ ok: false, reason: "invalidInput" });
    expect(planRouteBudget({ ...base, functionMaxMs: 120_000, bookkeeping: { ...bookkeeping, idleInTransactionTimeoutMs: 0 } })).toMatchObject({ ok: false, reason: "invalidInput" });
  });
});
