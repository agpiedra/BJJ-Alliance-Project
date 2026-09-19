import { DateTime } from "luxon";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — every derived billing
 * value, computed at read time, never stored. All dates are CALENDAR dates
 * resolved in the organization's own timezone (`Organization.timezone`),
 * never UTC and never the server's local zone — every function here takes
 * `timezone` explicitly rather than defaulting to anything, so a caller
 * cannot accidentally reach for the wrong one.
 */

export type InvoiceState = "CURRENT" | "DUE" | "GRACE_EXPIRED";

export interface InvoiceLike {
  dueOn: Date;
  graceDaysApplied: number;
  graceExtensionDays: number;
  paidAt: Date | null;
  voidedAt: Date | null;
}

/** `graceDaysApplied + graceExtensionDays` — the only two grace inputs that ever exist for one invoice. */
export function effectiveGraceDays(invoice: Pick<InvoiceLike, "graceDaysApplied" | "graceExtensionDays">): number {
  return invoice.graceDaysApplied + invoice.graceExtensionDays;
}

/**
 * The last day the invoice is still within grace, inclusive. Luxon calendar-
 * day addition — never `n * 86400000` milliseconds, which silently breaks
 * across a DST transition (Costa Rica has none today, but this must stay
 * correct regardless of which organization's timezone is passed in).
 */
export function graceEndsOn(invoice: Pick<InvoiceLike, "dueOn" | "graceDaysApplied" | "graceExtensionDays">, timezone: string): DateTime {
  const due = DateTime.fromJSDate(invoice.dueOn, { zone: timezone }).startOf("day");
  return due.plus({ days: effectiveGraceDays(invoice) });
}

/** The exact instant (00:00:00.000 org-time) expiration begins — inclusive, see `resolveInvoiceState`'s own comment on why `>=`, not `>`. */
export function flaggedFrom(invoice: Pick<InvoiceLike, "dueOn" | "graceDaysApplied" | "graceExtensionDays">, timezone: string): DateTime {
  return graceEndsOn(invoice, timezone).plus({ days: 1 }).startOf("day");
}

/**
 * `CURRENT` (no open invoice, or paid/voided) / `DUE` (past due, still
 * inside grace) / `GRACE_EXPIRED` (grace has run out, unpaid, flagged for
 * review — still ACTIVE, never suspended by this state; see
 * `platform/organizations/actions.ts`'s own comment on why billing never
 * touches `Organization.status`).
 *
 * `now >= flaggedFrom`, deliberately not "`flaggedFrom` is in the past" —
 * `flaggedFrom` is already `startOf('day')`, so `>=` makes expiration begin
 * exactly at `00:00:00.000` org-time. A strict `>` would leave the first
 * millisecond of the day unexpired, which is the wrong side of the doc's
 * own boundary ("DUE through Feb 2 inclusive, GRACE_EXPIRED from 00:00 on
 * Feb 3").
 */
export function resolveInvoiceState(invoice: InvoiceLike, timezone: string, now: DateTime = DateTime.now()): InvoiceState {
  if (invoice.paidAt || invoice.voidedAt) return "CURRENT";

  const nowInOrgZone = now.setZone(timezone);
  const dueEndOfDay = DateTime.fromJSDate(invoice.dueOn, { zone: timezone }).endOf("day");
  if (nowInOrgZone <= dueEndOfDay) return "CURRENT";

  const flagged = flaggedFrom(invoice, timezone);
  if (nowInOrgZone >= flagged) return "GRACE_EXPIRED";
  return "DUE";
}

/**
 * Canonical date-value comparison — NEVER compare two `Date`/`DateTime`
 * values for equality by object identity (`dateA !== dateB` on two JS
 * `Date` objects is always true even for the same instant). Every
 * date-equality comparison in billing code goes through this.
 */
export function toDateKey(date: Date | DateTime, timezone: string): string {
  const dt = date instanceof DateTime ? date : DateTime.fromJSDate(date, { zone: timezone });
  return dt.setZone(timezone).toISODate()!;
}

export interface AcknowledgeableInvoice extends InvoiceLike {
  reviewAcknowledgedForFlaggedOn: Date | null;
}

/**
 * An invoice is UNREVIEWED (appears in the admin's unreviewed queue)
 * whenever it's expired AND its stored acknowledgment (if any) doesn't
 * match the CURRENT `flaggedFrom` — scoped to one expiration episode. If an
 * extension later pushes the deadline out and the invoice expires again,
 * `flaggedFrom` is a new date, the stale acknowledgment no longer matches,
 * and a fresh review item reappears automatically; an old acknowledgment
 * can never suppress it indefinitely.
 */
export function isUnreviewed(invoice: AcknowledgeableInvoice, timezone: string, now: DateTime = DateTime.now()): boolean {
  const state = resolveInvoiceState(invoice, timezone, now);
  if (state !== "GRACE_EXPIRED") return false;
  if (!invoice.reviewAcknowledgedForFlaggedOn) return true;

  const currentFlaggedFrom = flaggedFrom(invoice, timezone);
  return toDateKey(invoice.reviewAcknowledgedForFlaggedOn, timezone) !== toDateKey(currentFlaggedFrom, timezone);
}
