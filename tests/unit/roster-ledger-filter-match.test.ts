// `roster-payment-facts-queries.ts` imports `@/lib/prisma` at module scope (unconditionally, for its other
// exports) — a plain unit-test run never loads `.env`, so DATABASE_URL must be loaded explicitly here before that
// import executes, even though this file's own tests never touch a database.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { matchesActiveLedgerFilters, type RosterLedgerFlags, type RosterLedgerEntry } from "../../src/lib/dues/roster-payment-facts-queries";

/**
 * Review-fix: the roster's own `filteredStudents` OR-matching logic (brief §3 decision 5), extracted into a plain,
 * DB-free, directly-testable function. Closes the agreed verification gap — until this fix round, signupPastDue/
 * pendingConversion/configIssue were only proven at the flag-COMPUTATION level (`toRosterLedgerDisplay`), never at
 * the CONSUMER (filter-matching) level; the roster page's real import of `matchesActiveLedgerFilters` (not a
 * reimplementation) means this test is proof about the actual production filtering code, not a parallel copy.
 */
const NO_FLAGS: RosterLedgerFlags = { debt: false, noDebt: true, monthlyPastGrace: false, signupPastDue: false, pendingConversion: false, configIssue: false };

function ledgerEntry(flags: Partial<RosterLedgerFlags>): RosterLedgerEntry {
  return { kind: "ledger", display: { totals: [], flags: { ...NO_FLAGS, ...flags } } };
}

describe("matchesActiveLedgerFilters", () => {
  it("an unavailable entry always matches, regardless of which filters are active or how many", () => {
    const entry: RosterLedgerEntry = { kind: "unavailable" };
    expect(matchesActiveLedgerFilters(entry, new Set())).toBe(true);
    expect(matchesActiveLedgerFilters(entry, new Set(["debt"]))).toBe(true);
    expect(matchesActiveLedgerFilters(entry, new Set(["signupPastDue", "configIssue"]))).toBe(true);
  });

  it("no filters active matches every ledger entry, regardless of its flags", () => {
    expect(matchesActiveLedgerFilters(ledgerEntry({ debt: true }), new Set())).toBe(true);
    expect(matchesActiveLedgerFilters(ledgerEntry({}), new Set())).toBe(true);
  });

  it("signupPastDue: matches only when that flag is true", () => {
    expect(matchesActiveLedgerFilters(ledgerEntry({ signupPastDue: true }), new Set(["signupPastDue"]))).toBe(true);
    expect(matchesActiveLedgerFilters(ledgerEntry({ signupPastDue: false }), new Set(["signupPastDue"]))).toBe(false);
  });

  it("pendingConversion: matches only when that flag is true", () => {
    expect(matchesActiveLedgerFilters(ledgerEntry({ pendingConversion: true }), new Set(["pendingConversion"]))).toBe(true);
    expect(matchesActiveLedgerFilters(ledgerEntry({ pendingConversion: false }), new Set(["pendingConversion"]))).toBe(false);
  });

  it("configIssue: matches only when that flag is true", () => {
    expect(matchesActiveLedgerFilters(ledgerEntry({ configIssue: true }), new Set(["configIssue"]))).toBe(true);
    expect(matchesActiveLedgerFilters(ledgerEntry({ configIssue: false }), new Set(["configIssue"]))).toBe(false);
  });

  it("OR semantics across all three: a student with ONLY configIssue true still matches when signupPastDue/pendingConversion/configIssue are all checked together", () => {
    const entry = ledgerEntry({ configIssue: true });
    expect(matchesActiveLedgerFilters(entry, new Set(["signupPastDue", "pendingConversion", "configIssue"]))).toBe(true);
  });

  it("a student matching NONE of the checked flags is excluded, never matched by coincidence", () => {
    const entry = ledgerEntry({ debt: true }); // true for a DIFFERENT flag than what's checked below
    expect(matchesActiveLedgerFilters(entry, new Set(["signupPastDue", "pendingConversion", "configIssue"]))).toBe(false);
  });
});
