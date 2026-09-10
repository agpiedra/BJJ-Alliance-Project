import { describe, expect, it } from "vitest";
import { isOverdue, DEFAULT_OVERDUE_CUTOFF_DAY } from "@/lib/payments/overdue";

describe("isOverdue", () => {
  it("is never overdue on or before the cutoff day, even with no row", () => {
    expect(isOverdue(null, { day: 1 })).toBe(false);
    expect(isOverdue(null, { day: DEFAULT_OVERDUE_CUTOFF_DAY })).toBe(false);
  });

  it("no row + past cutoff = overdue", () => {
    expect(isOverdue(null, { day: DEFAULT_OVERDUE_CUTOFF_DAY + 1 })).toBe(true);
  });

  it("PENDING row + past cutoff = overdue", () => {
    expect(isOverdue({ status: "PENDING" }, { day: 10 })).toBe(true);
  });

  it("PENDING row + on/before cutoff = not yet overdue", () => {
    expect(isOverdue({ status: "PENDING" }, { day: 3 })).toBe(false);
  });

  it("PAID row is never overdue, any day", () => {
    expect(isOverdue({ status: "PAID" }, { day: 28 })).toBe(false);
  });

  it("PROMO row is never overdue", () => {
    expect(isOverdue({ status: "PROMO" }, { day: 28 })).toBe(false);
  });

  it("EXEMPT row is never overdue", () => {
    expect(isOverdue({ status: "EXEMPT" }, { day: 28 })).toBe(false);
  });

  it("respects a custom cutoff day", () => {
    expect(isOverdue(null, { day: 12 }, 15)).toBe(false);
    expect(isOverdue(null, { day: 16 }, 15)).toBe(true);
  });
});
