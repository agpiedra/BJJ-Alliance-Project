import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyReversedObligation,
  isReversalReasonCategory,
  sameIdSet,
  storedReversalReason,
} from "../../src/lib/dues/reversal-classification";

/**
 * O4 (owner decisions B1–B10, 2026-11-09): the pure rule (T1) and two static guards — T10 (every direct obligation/coverage
 * query in src filters cancelled/released rows) and the I1 creator guard (only the two prepayment paths create PREPAYMENT
 * obligations). The database enforces the same rules independently (tests/integration/o4-prepayment-reversal.test.ts).
 */

const P = "pay-P";
const prepaid = (year: number, month: number, settlementPaymentIds: string[]) => ({ origin: "PREPAYMENT", coverageYear: year, coverageMonth: month, settlementPaymentIds });

describe("classifyReversedObligation (R1/R2/R3)", () => {
  const current = { year: 2031, month: 1 };

  it("R1 cancel: prepaid, only ever settled by P, month after the current month", () => {
    expect(classifyReversedObligation(prepaid(2031, 2, [P]), P, current)).toBe("cancel");
    expect(classifyReversedObligation(prepaid(2032, 1, [P]), P, current)).toBe("cancel"); // across a year boundary
  });

  it("R2 owedStarted: the current month and earlier are never cancelled", () => {
    expect(classifyReversedObligation(prepaid(2031, 1, [P]), P, current)).toBe("owedStarted");
    expect(classifyReversedObligation(prepaid(2030, 12, [P]), P, current)).toBe("owedStarted");
  });

  it("R3 owedIndependent: any other origin, however it was paid", () => {
    for (const origin of ["SCHEDULED_JOB", "STAFF"]) {
      expect(classifyReversedObligation({ origin, coverageYear: 2031, coverageMonth: 6, settlementPaymentIds: [P] }, P, current)).toBe("owedIndependent");
    }
  });

  it("R3 owedIndependent: a prepaid obligation with more than one settlement ever, or whose only settlement is another payment's", () => {
    expect(classifyReversedObligation(prepaid(2031, 6, ["pay-C", P]), P, current)).toBe("owedIndependent");
    expect(classifyReversedObligation(prepaid(2031, 6, [P, P]), P, current)).toBe("owedIndependent");
    expect(classifyReversedObligation(prepaid(2031, 6, ["pay-C"]), P, current)).toBe("owedIndependent");
    expect(classifyReversedObligation(prepaid(2031, 6, []), P, current)).toBe("owedIndependent");
  });
});

describe("reason category (B7) and the confirmed-set comparison", () => {
  it("accepts exactly the two categories and stores them as a prefix", () => {
    expect(isReversalReasonCategory("NOT_RECEIVED")).toBe(true);
    expect(isReversalReasonCategory("RECORDED_IN_ERROR")).toBe(true);
    for (const bad of ["REFUND", "", null, undefined, 1, "not_received"]) expect(isReversalReasonCategory(bad)).toBe(false);
    expect(storedReversalReason("NOT_RECEIVED", "  transfer bounced  ")).toBe("[NOT_RECEIVED] transfer bounced");
  });

  it("sameIdSet is order-insensitive and rejects duplicates, extras and omissions", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet([], [])).toBe(true);
    expect(sameIdSet(["a"], [])).toBe(false);
    expect(sameIdSet([], ["a"])).toBe(false);
    expect(sameIdSet(["a", "a"], ["a", "b"])).toBe(false);
    expect(sameIdSet(["a", "b"], ["a", "c"])).toBe(false);
  });
});

const SRC = path.resolve(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "generated") out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** The text of the call starting at `start` (an index just after its opening parenthesis), up to its balanced close. */
function callText(source: string, start: number): string {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

describe("T10 guard: every direct obligation/coverage READ in src excludes cancelled/released rows", () => {
  it("each duesObligation/duesCoverage find/count call carries cancelledAt / releasedAt", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      const re = /\.(duesObligation|duesCoverage)\.(findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\(/g;
      for (const m of source.matchAll(re)) {
        const body = callText(source, m.index! + m[0].length);
        const required = m[1] === "duesObligation" ? "cancelledAt" : "releasedAt";
        if (!body.includes(required)) offenders.push(`${path.relative(SRC, file)}:${source.slice(0, m.index).split("\n").length} (${m[1]}.${m[2]} without ${required})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the raw-SQL readiness read filters both", () => {
    const source = readFileSync(path.join(SRC, "lib/dues/readiness/opening-core.ts"), "utf8");
    expect(source).toContain(`o."cancelledAt" IS NULL`);
    expect(source).toContain(`c."releasedAt" IS NULL`);
  });

  it("no other raw SQL in src reads DuesObligation or DuesCoverage", () => {
    const readers = sourceFiles(SRC).filter((f) => /(FROM|JOIN) "Dues(Obligation|Coverage)"/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => path.relative(SRC, f).replace(/\\/g, "/"))).toEqual(["lib/dues/readiness/opening-core.ts"]);
  });
});

describe("I1 creator guard: only the two prepayment paths create PREPAYMENT obligations", () => {
  it("origin: \"PREPAYMENT\" is written only by prepay-monthly.ts and awaiting-rate-receipt.ts", () => {
    const writers = sourceFiles(SRC)
      .filter((f) => /origin:\s*"PREPAYMENT"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
      .sort();
    expect(writers).toEqual(["lib/dues/ledger/awaiting-rate-receipt.ts", "lib/dues/ledger/prepay-monthly.ts"]);
  });
});
