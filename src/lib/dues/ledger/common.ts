import { DateTime } from "luxon";
import type { TenantContext } from "@/lib/tenant/types";
import type { CalendarDate } from "@/lib/dues/calendar";
import { lockStudent, type Tx } from "@/lib/students/lock";

export { lockStudent };
export type { Tx };

/**
 * Shared by the two ledger writers. GLOBAL LOCK ORDER for every ledger writer (deadlock-free because each waits only on locks that come
 * later in the order, and PR 3's configuration writers take the branch row first as well):
 *
 *   1. the branch (`Academy`) row, FOR SHARE (PR 3's configuration saves hold it FOR UPDATE, so a save and a ledger write for one branch
 *      never interleave),
 *   2. the student row, FOR UPDATE (serializes everything about one student's ledger),
 *   3. configuration version rows (terms, then policy), FOR SHARE, and only THEN their values are read.
 *
 * Every raw statement filters by `organizationId` as well as by id.
 */

/** The same scope rule as `isAcademyInTenantScope` (an owner's "ALL", or a listed branch), without importing the request-facing module. */
export function inTenantScope(context: TenantContext, academyId: string): boolean {
  return context.academyIds === "ALL" || context.academyIds.includes(academyId);
}

/** The branch row, `FOR SHARE`. Returns its timezone, or null when it is not in the organization. */
export async function lockBranchShared(tx: Tx, organizationId: string, academyId: string): Promise<{ timezone: string } | null> {
  const rows = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT "timezone" FROM "Academy" WHERE "id" = ${academyId} AND "organizationId" = ${organizationId} FOR SHARE`;
  return rows[0] ?? null;
}

/** A terms version row, `FOR SHARE` (its values are read only after this returns). False when it is not in the organization. */
export async function lockTermsShared(tx: Tx, organizationId: string, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PaymentPlanTerms" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR SHARE`;
  return rows.length === 1;
}

/** A policy version row, `FOR SHARE` (its values are read only after this returns). False when it is not in the organization. */
export async function lockPolicyShared(tx: Tx, organizationId: string, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "DuesPolicyVersion" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR SHARE`;
  return rows.length === 1;
}

/**
 * A `StudentPlanAssignment` row, `FOR SHARE` (its `planId` is trusted only after this returns). Mirrors `lockTermsShared`/
 * `lockPolicyShared` exactly. `correctAssignment` (assignment-actions.ts) locks the same row `FOR UPDATE` and only for a row
 * whose effective month is still future — precisely the rows a prepayment purchase resolves and relies on. Without this lock,
 * the student lock alone does not serialize a purchase against a concurrent correction of the specific assignment it read,
 * since the two never contend for the same row. False when the row is not in the organization.
 */
export async function lockAssignmentShared(tx: Tx, organizationId: string, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "StudentPlanAssignment" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR SHARE`;
  return rows.length === 1;
}

/** Whether year, month and day name a real calendar date in the years the schema supports (2000 to 2100). */
export function isRealDate(date: CalendarDate): boolean {
  if (![date.year, date.month, date.day].every(Number.isInteger) || date.year < 2000 || date.year > 2100) return false;
  const d = DateTime.utc(date.year, date.month, date.day);
  return d.isValid && d.year === date.year && d.month === date.month && d.day === date.day;
}

/** The calendar date it is in `zone` at instant `now` (the branch's own date, never the server's or UTC's). */
export function todayIn(zone: string, now: Date): CalendarDate {
  const local = DateTime.fromJSDate(now, { zone });
  if (!local.isValid) throw new RangeError(`Unknown timezone: ${zone}`);
  return { year: local.year, month: local.month, day: local.day };
}

/** `days` calendar days before `date` (pure calendar arithmetic, no timezone). */
export function minusDays(date: CalendarDate, days: number): CalendarDate {
  const d = DateTime.utc(date.year, date.month, date.day).minus({ days });
  return { year: d.year, month: d.month, day: d.day };
}

/** A calendar date as the UTC midnight the `@db.Date` columns store. */
export const toDbDate = (date: CalendarDate): Date => new Date(Date.UTC(date.year, date.month - 1, date.day));

/** The calendar date a `@db.Date` value holds. */
export const fromDbDate = (value: Date): CalendarDate => ({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() });

/** The latest version whose effective month is on or before `month`, or null. Versions are unique per month, so there is no tie. */
export function latestEffective<T extends { effectiveYear: number; effectiveMonth: number }>(versions: readonly T[], month: { year: number; month: number }): T | null {
  const index = (y: number, m: number) => y * 12 + (m - 1);
  let best: T | null = null;
  for (const v of versions) {
    if (index(v.effectiveYear, v.effectiveMonth) > index(month.year, month.month)) continue;
    if (best === null || index(v.effectiveYear, v.effectiveMonth) > index(best.effectiveYear, best.effectiveMonth)) best = v;
  }
  return best;
}
