import type { Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import type { YearMonth } from "@/lib/dues/calendar";
import { addMonths, compareYearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inTenantScope, latestEffective } from "@/lib/dues/ledger/common";
import { firstUncoveredFrom, SCHEMA_MAX_MONTH } from "@/lib/dues/ledger/prepay-monthly";

/**
 * Package-purchase UI brief §2 deliverable 1/2: read-only support for the package-plan/terms picker and the
 * first-available-month advisory. Neither existing reader (`package-plans.ts`'s `isPackagePlan`/`NOT_PACKAGE_PLAN`,
 * `list-plans.ts`'s `listSelectablePlans`/`listPlansForManagement`) lists ACTIVE package plans together with their
 * CURRENTLY effective terms row for purchase-time selection — confirmed directly by reading both files in full; this
 * module adds exactly that, nothing else. A plain module, like `payment-entry-queries.ts` — never `"use server"`.
 *
 * DEVIATION (flagged): the dispatch brief claimed `purchasePackage.ts`'s own `resolvePackageTermsInTx` is "NOT
 * exported for reuse." Reading `purchase-package.ts` directly shows it IS exported (line 128). This does not change
 * what needs to be built here: `resolvePackageTermsInTx` resolves ONE already-named `planTermsId`'s current terms
 * (and whether it's stale) — useful at submit time, not for listing every active package plan's own current price
 * for a picker. The read below necessarily replicates `resolvePackageTermsInTx`'s own `latestEffective`-against-
 * `currentMonth` resolution logic (as the original brief text intended), not its signature.
 *
 * The real transactional resolution inside `purchasePackageInTx` (via `resolvePackageTermsInTx`, taking the
 * `FOR SHARE` lock first) remains the sole authority at purchase time — a plan's terms changing between this read and
 * submission is just the ordinary `staleTerms` refusal, handled like any other refusal, never specially.
 */

export type PackagePlanOption = {
  planId: string;
  planTermsId: string;
  planName: string;
  monthsCovered: number;
  /** Two-decimal string, matching every other money value this codebase already hands to the client (never a float). */
  priceAmount: string;
  currency: Currency;
};

export type ListPackagePlanOptionsResult = { ok: true; plans: PackagePlanOption[] } | { ok: false; error: "notFound" };

/** Every ACTIVE package plan (multi-month terms) on `studentId`'s own branch, each with its CURRENTLY effective
 * terms row — a plan with no terms effective yet (every version dated after `currentMonth`) is simply omitted, not
 * an error. `now` is injectable for tests, exactly like `getStudentBranchLocalToday`. */
export async function listActivePackagePlanOptions(context: TenantContext, studentId: string, now: Date = new Date()): Promise<ListPackagePlanOptionsResult> {
  if (typeof studentId !== "string" || studentId.trim() === "") return { ok: false, error: "notFound" };
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId: context.organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, error: "notFound" };

  const academy = await prisma.academy.findFirst({ where: { id: student.homeAcademyId, organizationId: context.organizationId }, select: { timezone: true } });
  if (!academy) return { ok: false, error: "notFound" };
  const currentMonth = currentMonthIn(academy.timezone, now);

  const plans = await prisma.paymentPlan.findMany({
    where: { organizationId: context.organizationId, academyId: student.homeAcademyId, active: true, terms: { some: { monthsCovered: { gt: 1 } } } },
    select: {
      id: true,
      name: true,
      terms: { select: { id: true, effectiveYear: true, effectiveMonth: true, monthsCovered: true, priceAmount: true, currency: true } },
    },
    orderBy: { name: "asc" },
  });

  const options: PackagePlanOption[] = [];
  for (const plan of plans) {
    const current = latestEffective(plan.terms, currentMonth);
    if (!current) continue; // no version effective yet — nothing to offer, not an error
    options.push({ planId: plan.id, planTermsId: current.id, planName: plan.name, monthsCovered: current.monthsCovered, priceAmount: current.priceAmount.toFixed(2), currency: current.currency });
  }
  return { ok: true, plans: options };
}

export type FirstAvailablePackageMonthResult = { ok: true; month: YearMonth | null } | { ok: false; error: "notFound" };

/**
 * Advisory-only best-effort guess at a package's first available start month (brief §2.2/§2.6 point 6): reuses
 * `firstUncoveredFrom` (already exported, read-only) with `floor = currentMonth` — a package may start immediately,
 * unlike prepayment's `currentMonth + 1` floor (approved policy 3) — bounded by the SAME standing-horizon
 * computation `validatePackageSpanInTx` performs (replicated here as a plain read for the identical reason
 * `resolvePackageTermsInTx` above is replicated, not reused: that function validates one already-chosen candidate
 * span, it does not search for one). `month: null` means either the horizon is fully consumed by existing coverage,
 * or no policy with a set `maxPrepaidMonths` is currently effective — in both cases there is nothing useful to
 * suggest; the UI must treat this as "no suggestion," never as an error. NEVER authoritative: the real writer
 * re-validates everything at submit time regardless.
 */
export async function firstAvailablePackageMonth(context: TenantContext, studentId: string, now: Date = new Date()): Promise<FirstAvailablePackageMonthResult> {
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
  if (!effectivePolicy || effectivePolicy.maxPrepaidMonths === null) return { ok: true, month: null };
  const horizonEnd = addMonths(currentMonth, effectivePolicy.maxPrepaidMonths);
  const bound = compareYearMonth(horizonEnd, SCHEMA_MAX_MONTH) < 0 ? horizonEnd : SCHEMA_MAX_MONTH;

  const month = await firstUncoveredFrom(prisma, context.organizationId, studentId, currentMonth, bound);
  return { ok: true, month };
}
