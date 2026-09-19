import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  effectiveGraceDays,
  graceEndsOn,
  flaggedFrom,
  resolveInvoiceState,
  toDateKey,
  isUnreviewed,
} from "../../src/lib/billing/deadline";

const ZONE = "America/Costa_Rica";

function invoice(overrides: Partial<{ dueOn: Date; graceDaysApplied: number; graceExtensionDays: number; paidAt: Date | null; voidedAt: Date | null }> = {}) {
  return {
    dueOn: DateTime.fromISO("2026-01-28", { zone: ZONE }).toJSDate(),
    graceDaysApplied: 5,
    graceExtensionDays: 0,
    paidAt: null,
    voidedAt: null,
    ...overrides,
  };
}

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — deadline.ts", () => {
  it("REQUIRED: an invoice due Jan 28 with 5 grace days is DUE through Feb 2 inclusive and GRACE_EXPIRED from 00:00 org-time on Feb 3", () => {
    const inv = invoice();

    // Feb 2, well within the day — DUE.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-02-02T12:00:00", { zone: ZONE }))).toBe("DUE");
    // Feb 2, the very last millisecond — still DUE.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-02-02T23:59:59.999", { zone: ZONE }))).toBe("DUE");
    // Feb 3, 00:00:00.000 exactly — GRACE_EXPIRED begins here, inclusive.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-02-03T00:00:00.000", { zone: ZONE }))).toBe("GRACE_EXPIRED");
  });

  it("REQUIRED: expiration begins exactly at midnight — both boundary instants asserted directly against graceEndsOn/flaggedFrom themselves, not just resolveInvoiceState", () => {
    const inv = invoice();
    expect(graceEndsOn(inv, ZONE).toISODate()).toBe("2026-02-02");
    expect(flaggedFrom(inv, ZONE).toISO()).toContain("2026-02-03T00:00:00.000");
  });

  it("REQUIRED: graceDays: 0 makes the deadline the due date itself", () => {
    const inv = invoice({ graceDaysApplied: 0 });
    expect(graceEndsOn(inv, ZONE).toISODate()).toBe("2026-01-28");
    // Still CURRENT through the end of the due date itself.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-01-28T23:59:59.999", { zone: ZONE }))).toBe("CURRENT");
    // GRACE_EXPIRED starting the very next day, with no DUE window at all.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-01-29T00:00:00.000", { zone: ZONE }))).toBe("GRACE_EXPIRED");
  });

  it("an organization one day past dueOn (no grace days elapsed) is DUE, not GRACE_EXPIRED, and CURRENT before the due date", () => {
    const inv = invoice();
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-01-27T12:00:00", { zone: ZONE }))).toBe("CURRENT");
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-01-29T12:00:00", { zone: ZONE }))).toBe("DUE");
  });

  it("a paid or voided invoice is always CURRENT, even long past its deadline", () => {
    const paid = invoice({ paidAt: DateTime.fromISO("2026-02-10", { zone: ZONE }).toJSDate() });
    expect(resolveInvoiceState(paid, ZONE, DateTime.fromISO("2026-03-01", { zone: ZONE }))).toBe("CURRENT");

    const voided = invoice({ voidedAt: DateTime.fromISO("2026-02-10", { zone: ZONE }).toJSDate() });
    expect(resolveInvoiceState(voided, ZONE, DateTime.fromISO("2026-03-01", { zone: ZONE }))).toBe("CURRENT");
  });

  it("effectiveGraceDays sums graceDaysApplied and graceExtensionDays — extension pushes the deadline out", () => {
    const inv = invoice({ graceExtensionDays: 10 });
    expect(effectiveGraceDays(inv)).toBe(15);
    expect(graceEndsOn(inv, ZONE).toISODate()).toBe("2026-02-12");

    // Feb 3 (would have been GRACE_EXPIRED with 0 extension) is now DUE.
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-02-03T12:00:00", { zone: ZONE }))).toBe("DUE");
  });

  it("REQUIRED: acknowledgment-key equality is compared by canonical date value — a freshly constructed equivalent date still matches", () => {
    const flagged = DateTime.fromISO("2026-02-03T00:00:00.000", { zone: ZONE });
    const freshEquivalent = DateTime.fromISO("2026-02-03", { zone: ZONE }).toJSDate(); // a brand-new Date object, same calendar day
    expect(toDateKey(freshEquivalent, ZONE)).toBe(toDateKey(flagged, ZONE));
  });

  it("REQUIRED: an unacknowledged GRACE_EXPIRED invoice is unreviewed; acknowledging it (for the current flaggedFrom) removes it from the unreviewed queue", () => {
    const inv = { ...invoice(), reviewAcknowledgedForFlaggedOn: null as Date | null };
    const now = DateTime.fromISO("2026-02-05", { zone: ZONE });
    expect(isUnreviewed(inv, ZONE, now)).toBe(true);

    const currentFlaggedFrom = flaggedFrom(inv, ZONE).toJSDate();
    const acknowledged = { ...inv, reviewAcknowledgedForFlaggedOn: currentFlaggedFrom };
    expect(isUnreviewed(acknowledged, ZONE, now)).toBe(false);
  });

  it("REQUIRED: acknowledge -> extend (returns to DUE) -> let the new deadline pass: the invoice reappears as a fresh unreviewed item", () => {
    const base = invoice();
    const firstFlaggedFrom = flaggedFrom(base, ZONE).toJSDate();
    // Acknowledged for the FIRST expiration episode.
    let inv = { ...base, reviewAcknowledgedForFlaggedOn: firstFlaggedFrom };
    expect(isUnreviewed(inv, ZONE, DateTime.fromISO("2026-02-05", { zone: ZONE }))).toBe(false);

    // Extended: pushes the deadline out, returning the invoice to DUE.
    inv = { ...inv, graceExtensionDays: 20 };
    expect(resolveInvoiceState(inv, ZONE, DateTime.fromISO("2026-02-05", { zone: ZONE }))).toBe("DUE");

    // The new deadline passes — a SECOND, distinct expiration episode.
    const secondFlaggedFrom = flaggedFrom(inv, ZONE);
    expect(secondFlaggedFrom.toISODate()).not.toBe(DateTime.fromJSDate(firstFlaggedFrom, { zone: ZONE }).toISODate());
    expect(isUnreviewed(inv, ZONE, secondFlaggedFrom)).toBe(true); // fresh unreviewed item, the stale ack no longer matches
  });

  it("acknowledgment scoped to a DIFFERENT flaggedFrom than the current one is treated as unreviewed (a stale ack from a prior episode)", () => {
    const inv = { ...invoice(), reviewAcknowledgedForFlaggedOn: DateTime.fromISO("2026-01-01", { zone: ZONE }).toJSDate() };
    expect(isUnreviewed(inv, ZONE, DateTime.fromISO("2026-02-05", { zone: ZONE }))).toBe(true);
  });

  it("DUE and CURRENT invoices are never unreviewed, regardless of acknowledgment state", () => {
    const dueInvoice = { ...invoice(), reviewAcknowledgedForFlaggedOn: null as Date | null };
    expect(isUnreviewed(dueInvoice, ZONE, DateTime.fromISO("2026-02-01", { zone: ZONE }))).toBe(false);

    const currentInvoice = { ...invoice(), reviewAcknowledgedForFlaggedOn: null as Date | null };
    expect(isUnreviewed(currentInvoice, ZONE, DateTime.fromISO("2026-01-20", { zone: ZONE }))).toBe(false);
  });
});
