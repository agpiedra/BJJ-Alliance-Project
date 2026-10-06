import type { Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import type { YearMonth } from "@/lib/dues/calendar";
import { addMonths, compareYearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inTenantScope, latestEffective } from "@/lib/dues/ledger/common";
import { isValidCoverageMonth } from "@/lib/dues/ledger/create-monthly-obligation";
import { firstUncoveredFrom, SCHEMA_MAX_MONTH } from "@/lib/dues/ledger/prepay-monthly";

/**
 * Monthly-prepayment UI brief §2.2/§2.3: read-only support for the first-available-month advisory (floored at
 * `currentMonth + 1`, unlike the package read's `floor = currentMonth` — this writer never touches the current month
 * or earlier) and each selected month's own effective assignment/terms price. A plain module, mirroring
 * `package-purchase-queries.ts`'s own structure/conventions exactly — never `"use server"`.
 *
 * The real transactional resolution inside `prepayMonthlyObligationsInTx` (`prepay-monthly.ts:230-269`) remains the
 * sole authority at purchase time — this module replicates its per-month `latestEffective` resolution chain
 * (assignment → plan → terms) as a plain read for preview display only; a price that changes between this read and
 * submission is just the ordinary refusal/re-resolution path, never specially handled here.
 */

export type FirstAvailablePrepaymentMonthResult =
  | { ok: true; month: YearMonth | null; horizonEnd: YearMonth | null }
  | { ok: false; error: "notFound" };

/** Advisory-only best-effort guess at the first available prepayment month, PLUS the standing horizon end (for the
 * UI's own non-authoritative "don't let the running list grow past this" bound) — both `null` together whenever no
 * policy with a set `maxPrepaidMonths` is currently effective. NEVER authoritative: the real writer re-validates
 * everything (`prepay-monthly.ts:181-203`) at submit time regardless. */
export async function firstAvailablePrepaymentMonth(context: TenantContext, studentId: string, now: Date = new Date()): Promise<FirstAvailablePrepaymentMonthResult> {
  if (typeof studentId !== "string" || studentId.trim() === "") return { ok: false, error: "notFound" };
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, error: "notFound" };

  const academy = await prisma.academy.findFirst({ where: { id: student.homeAcademyId, organizationId: context.organizationId }, select: { timezone: true } });
  if (!academy) return { ok: false, error: "notFound" };
  const currentMonth = currentMonthIn(academy.timezone, now);

  const policyHistory = await prisma.duesPolicyVersion.findMany({
    where: { organizationId: context.organizationId, academyId: student.homeAcademyId },
    select: { effectiveYear: true, effectiveMonth: true, maxPrepaidMonths: true },
  });
  const effectivePolicy = latestEffective(policyHistory, currentMonth);
  if (!effectivePolicy || effectivePolicy.maxPrepaidMonths === null) return { ok: true, month: null, horizonEnd: null };
  const horizonEndRaw = addMonths(currentMonth, effectivePolicy.maxPrepaidMonths);
  const horizonEnd = compareYearMonth(horizonEndRaw, SCHEMA_MAX_MONTH) < 0 ? horizonEndRaw : SCHEMA_MAX_MONTH;

  const floor = addMonths(currentMonth, 1);
  const month = await firstUncoveredFrom(prisma, context.organizationId, studentId, floor, horizonEnd);
  return { ok: true, month, horizonEnd };
}

export type MonthPrice = { month: YearMonth; priceAmount: string; currency: Currency } | { month: YearMonth; error: "inapplicable" };

export type ListMonthPricesResult = { ok: true; prices: MonthPrice[] } | { ok: false; error: "notFound" | "invalid" };

/** Purely a DoS/resource-exhaustion guard (this function issues one DB query per requested month) — not a business
 * limit. Generously larger than any realistic `maxPrepaidMonths` policy horizon ever configured. */
const MAX_MONTHS_PER_REQUEST = 60;

/**
 * Corrected per the brief: NOT "today's price applied to every month." Each requested month's price is resolved
 * against the `StudentPlanAssignment`/`PaymentPlanTerms` version effective AT THAT SPECIFIC month (one
 * `latestEffective` lookup per month, replicating `prepay-monthly.ts:230-268` exactly) — two months of the same span
 * can genuinely price differently if a scheduled change falls between them. A month with no applicable
 * assignment/plan/terms at all resolves to `{error: "inapplicable"}` for that entry alone (display-only — the real
 * writer's own `inapplicable` refusal is what actually enforces this at submit time).
 *
 * `getMonthPrices` (`prepayment-actions.ts`) is a bare `"use server"` export — `months` is reachable from a crafted
 * request regardless of its TS type, so it is validated here, fully, before any database access: real array shape,
 * every entry a genuine coverage month (the same `isValidCoverageMonth` the engine itself uses), no duplicates, and
 * bounded in size. `listMonthPrices` has exactly one real caller (`getMonthPrices`) — duplicating this check there
 * too would be redundant surface area, not defense-in-depth, so it is not repeated.
 */
export async function listMonthPrices(context: TenantContext, studentId: string, months: YearMonth[]): Promise<ListMonthPricesResult> {
  if (typeof studentId !== "string" || studentId.trim() === "") return { ok: false, error: "notFound" };
  if (!Array.isArray(months)) return { ok: false, error: "invalid" };
  if (months.length > MAX_MONTHS_PER_REQUEST) return { ok: false, error: "invalid" };
  if (!months.every(isValidCoverageMonth)) return { ok: false, error: "invalid" };
  if (new Set(months.map((m) => `${m.year}-${m.month}`)).size !== months.length) return { ok: false, error: "invalid" };

  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, error: "notFound" };
  if (months.length === 0) return { ok: true, prices: [] };

  const assignments = await prisma.studentPlanAssignment.findMany({
    where: { organizationId: context.organizationId, studentId: student.id },
    select: { planId: true, effectiveYear: true, effectiveMonth: true },
  });

  const prices: MonthPrice[] = [];
  for (const month of months) {
    const assignment = latestEffective(assignments, month);
    if (!assignment || assignment.planId === null) {
      prices.push({ month, error: "inapplicable" });
      continue;
    }
    const termsCandidates = await prisma.paymentPlanTerms.findMany({
      where: { organizationId: context.organizationId, planId: assignment.planId },
      select: { id: true, effectiveYear: true, effectiveMonth: true },
    });
    const termsCandidate = latestEffective(termsCandidates, month);
    if (!termsCandidate) {
      prices.push({ month, error: "inapplicable" });
      continue;
    }
    const terms = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { id: termsCandidate.id, organizationId: context.organizationId }, select: { priceAmount: true, currency: true } });
    prices.push({ month, priceAmount: terms.priceAmount.toFixed(2), currency: terms.currency });
  }
  return { ok: true, prices };
}
