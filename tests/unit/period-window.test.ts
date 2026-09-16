import { describe, expect, it } from "vitest";
import { isPeriodMoreThanOneMonthInFuture } from "../../src/lib/payments/period-window";

describe("isPeriodMoreThanOneMonthInFuture", () => {
  const today = { year: 2026, month: 9 };

  it("the current month is not too far in the future", () => {
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2026, month: 9 }, today)).toBe(false);
  });

  it("exactly one month ahead is allowed", () => {
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2026, month: 10 }, today)).toBe(false);
  });

  it("two months ahead is rejected", () => {
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2026, month: 11 }, today)).toBe(true);
  });

  it("any month in the past is allowed", () => {
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2026, month: 1 }, today)).toBe(false);
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2020, month: 1 }, today)).toBe(false);
  });

  it("handles a year rollover correctly: December -> next January is exactly one month", () => {
    const december = { year: 2026, month: 12 };
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2027, month: 1 }, december)).toBe(false);
    expect(isPeriodMoreThanOneMonthInFuture({ year: 2027, month: 2 }, december)).toBe(true);
  });
});
