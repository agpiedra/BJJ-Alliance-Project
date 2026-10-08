// `portal-ledger-queries.ts` imports `@/lib/prisma` at module scope (unconditionally, for its other exports) — a
// plain unit-test run never loads `.env`, so DATABASE_URL must be loaded explicitly here before that import
// executes, even though this file's own tests never touch a database (same discipline
// `roster-ledger-filter-match.test.ts` already established for the identical reason).
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { resolveEligibilityNoticeKey } from "../../src/lib/dues/portal-ledger-queries";
import type { DuesFactsForStudent } from "../../src/lib/dues/portal-ledger-queries";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §5.2: pure, DB-free tests for the structural suppression predicate
 * and the outcome-by-outcome notice mapping — constructed fixtures, no database. The real-engine-backed versions
 * of these same three scenarios (mid-month resume, package-covered month, bare-SIGNUP counterexample) live in
 * `tests/integration/portal-ledger-queries.test.ts`, proving the ACTUAL resolver output flows into this function
 * correctly; this file proves the function's own logic in isolation.
 */
const CURRENT_PERIOD = { year: 2030, month: 6 };

function facts(overrides: Partial<DuesFactsForStudent>): DuesFactsForStudent {
  return {
    studentId: "s1",
    eligibility: { outcome: "RESOLVED", planId: "p1" },
    outstanding: [],
    coverage: [],
    pendingReceipts: [],
    ...overrides,
  };
}

describe("resolveEligibilityNoticeKey: suppression predicate (revision 5/6 — exact two facts, never 'any obligation')", () => {
  it("suppresses (returns null) when a current-period MONTHLY obligation exists, even if SETTLED", () => {
    const f = facts({
      eligibility: { outcome: "NOT_ELIGIBLE" },
      outstanding: [{ obligationId: "o1", type: "MONTHLY", currency: "USD", coverageYear: 2030, coverageMonth: 6, settled: true, outstandingAmountMinor: 0, outstandingFeeMinor: 0, dueOn: "2030-06-01", pastGrace: null }],
    });
    expect(resolveEligibilityNoticeKey(f, CURRENT_PERIOD)).toBeNull();
  });

  it("suppresses when a current-period MONTHLY obligation exists and is UNSETTLED — existence is what matters, never outstandingAmountMinor > 0", () => {
    const f = facts({
      eligibility: { outcome: "NOT_ELIGIBLE" },
      outstanding: [{ obligationId: "o1", type: "MONTHLY", currency: "USD", coverageYear: 2030, coverageMonth: 6, settled: false, outstandingAmountMinor: 10000, outstandingFeeMinor: 0, dueOn: "2030-06-01", pastGrace: false }],
    });
    expect(resolveEligibilityNoticeKey(f, CURRENT_PERIOD)).toBeNull();
  });

  it("suppresses when a current-period coverage row exists (e.g. from an active PACKAGE), even with zero outstanding obligations", () => {
    const f = facts({
      eligibility: { outcome: "MISSING_CONFIGURATION" },
      coverage: [{ year: 2030, month: 6, obligationId: "pkg-1" }],
    });
    expect(resolveEligibilityNoticeKey(f, CURRENT_PERIOD)).toBeNull();
  });

  it("does NOT suppress for a DIFFERENT month's MONTHLY/coverage — only the current period counts", () => {
    const f = facts({
      eligibility: { outcome: "NOT_ELIGIBLE" },
      outstanding: [{ obligationId: "o1", type: "MONTHLY", currency: "USD", coverageYear: 2030, coverageMonth: 5, settled: false, outstandingAmountMinor: 10000, outstandingFeeMinor: 0, dueOn: "2030-05-01", pastGrace: true }],
      coverage: [{ year: 2030, month: 5, obligationId: "o1" }],
    });
    expect(resolveEligibilityNoticeKey(f, CURRENT_PERIOD)).toBe("notRecorded");
  });

  it("a bare current-period SIGNUP alone does NOT suppress — SIGNUP is excluded by the MONTHLY-type filter, exactly as the brief requires", () => {
    const f = facts({
      eligibility: { outcome: "MISSING_CONFIGURATION" },
      outstanding: [{ obligationId: "signup-1", type: "SIGNUP", currency: "USD", coverageYear: 2030, coverageMonth: 6, settled: false, outstandingAmountMinor: 10000, outstandingFeeMinor: null, dueOn: "2030-06-15", pastGrace: null }],
    });
    expect(resolveEligibilityNoticeKey(f, CURRENT_PERIOD)).toBe("unconfirmed");
  });
});

describe("resolveEligibilityNoticeKey: outcome-by-outcome mapping, when suppression finds nothing", () => {
  it("RESOLVED -> null (no notice)", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "RESOLVED", planId: "p1" } }), CURRENT_PERIOD)).toBeNull();
  });
  it("NOT_ELIGIBLE -> notRecorded", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "NOT_ELIGIBLE" } }), CURRENT_PERIOD)).toBe("notRecorded");
  });
  it("NO_ASSIGNMENT -> noAssignment", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "NO_ASSIGNMENT" } }), CURRENT_PERIOD)).toBe("noAssignment");
  });
  it("UNDECIDABLE -> unconfirmed", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "UNDECIDABLE" } }), CURRENT_PERIOD)).toBe("unconfirmed");
  });
  it("MISSING_CONFIGURATION -> unconfirmed", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "MISSING_CONFIGURATION" } }), CURRENT_PERIOD)).toBe("unconfirmed");
  });
  it("OBSERVED_DISCREPANCY -> unconfirmed", () => {
    expect(resolveEligibilityNoticeKey(facts({ eligibility: { outcome: "OBSERVED_DISCREPANCY" } }), CURRENT_PERIOD)).toBe("unconfirmed");
  });
});
