import { Prisma, type DuesObligationOrigin } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { assertYearMonth, compareYearMonth, dueDateFor, graceDeadlineFor, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, latestEffective, lockBranchShared, lockPolicyShared, lockStudent, lockTermsShared, toDbDate, type Tx } from "@/lib/dues/ledger/common";

export type CreateMonthlyObligationError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "futureMonth"
  | "staleVersion"
  | "inapplicable"
  | "currencyMismatch"
  | "coverageTaken"
  | "conflict";

export type CreateMonthlyObligationResult = { ok: true; created: boolean; obligationId: string } | { ok: false; error: CreateMonthlyObligationError };

const refuse = (error: CreateMonthlyObligationError): CreateMonthlyObligationResult => ({ ok: false, error });

/** A calendar month, and one this schema's dues tables can actually hold (`assertYearMonth`'s range plus the 2000-2100 bound the columns are sized for). Shared so the public wrapper, the transaction-aware core and the monthly-generation runner check coverage the same one way, not three slightly different ones. */
export function isValidCoverageMonth(coverage: YearMonth): boolean {
  try {
    assertYearMonth(coverage);
  } catch {
    return false;
  }
  return coverage.year >= 2000 && coverage.year <= 2100;
}

/**
 * Monthly-prepayment brief §2: the part of `createMonthlyObligationInTx` that has no opinion about whether `coverage` is
 * future, current or past — duplicate detection, terms/policy resolution+locking+staleness, applicability/currency checks,
 * and the write itself. `origin` is an explicit parameter (never hardcoded) so a caller other than `createMonthlyObligationInTx`
 * can originate a row this ledger's ordinary flow would never create on its own (a `PREPAYMENT`).
 *
 * NOT exported for use outside this ledger's own internal composition: no route, server action or scheduler entry ever calls
 * it directly, and nothing about its existence changes how a caller from outside the ledger could reach it (it isn't
 * reachable at all — it takes an already-open `tx` and never opens its own transaction). Every check this function repeats
 * (activation, coverage-month format, tenant scope, the full terms/policy lock-then-read-then-staleness sequence) is
 * unmodified from what `createMonthlyObligationInTx` already ran before this extraction — nothing is skipped, nothing is
 * weakened. Deliberately has NO `futureMonth`-style check of its own: that decision belongs entirely to the caller, which
 * must take its own branch/student locks before calling this (this function takes only the terms/policy locks it needs).
 */
export async function writeMonthlyObligationInTx(
  tx: Tx,
  args: { context: TenantContext; student: { id: string; homeAcademyId: string }; coverage: YearMonth; planTermsId: string; policyVersionId: string; origin: DuesObligationOrigin },
  deps: LedgerDeps = {},
): Promise<CreateMonthlyObligationResult> {
  const { context, student, coverage, planTermsId, policyVersionId, origin } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  if (!isValidCoverageMonth(coverage)) return refuse("invalid");
  if (!inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  // A duplicate returns the existing obligation and changes nothing: no snapshot edit, no coverage row, no audit row.
  const existing = await tx.duesObligation.findFirst({
    where: { organizationId, studentId: student.id, type: "MONTHLY", coverageYear: coverage.year, coverageMonth: coverage.month },
    select: { id: true },
  });
  if (existing) return { ok: true, created: false, obligationId: existing.id };
  const taken = await tx.duesCoverage.findFirst({ where: { organizationId, studentId: student.id, year: coverage.year, month: coverage.month }, select: { id: true } });
  if (taken) return refuse("coverageTaken");

  // The named versions must exist in THIS organization (a foreign or unknown id is notFound), then be locked BEFORE any value is read.
  const termsRef = await tx.paymentPlanTerms.findFirst({ where: { id: planTermsId, organizationId }, select: { id: true, planId: true } });
  const policyRef = await tx.duesPolicyVersion.findFirst({ where: { id: policyVersionId, organizationId }, select: { id: true, academyId: true } });
  if (!termsRef || !policyRef) return refuse("notFound");
  // 3. terms, then policy, FOR SHARE (a fixed order)
  if (!(await lockTermsShared(tx, organizationId, termsRef.id)) || !(await lockPolicyShared(tx, organizationId, policyRef.id))) return refuse("notFound");

  // Values are read only now, from the locked rows.
  const terms = await tx.paymentPlanTerms.findFirstOrThrow({ where: { id: termsRef.id, organizationId } });
  const policy = await tx.duesPolicyVersion.findFirstOrThrow({ where: { id: policyRef.id, organizationId } });

  // The named versions must be the ones EFFECTIVE for the coverage month: a later, superseded or not-yet-effective id is stale.
  const termsHistory = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: terms.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: policy.academyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  if (latestEffective(termsHistory, coverage)?.id !== terms.id || latestEffective(policyHistory, coverage)?.id !== policy.id) return refuse("staleVersion");

  // They must apply to this student: the plan and the policy belong to the student's branch, and the terms cover exactly one month.
  const plan = await tx.paymentPlan.findFirst({ where: { id: terms.planId, organizationId }, select: { academyId: true } });
  if (!plan || plan.academyId !== student.homeAcademyId || policy.academyId !== student.homeAcademyId || terms.monthsCovered !== 1) return refuse("inapplicable");
  if (terms.currency !== policy.lateFeeCurrency) return refuse("currencyMismatch");

  const due = dueDateFor(coverage, policy.dueDay);
  const grace = graceDeadlineFor(coverage, policy.graceDay);
  const amount = terms.priceAmount.toFixed(2);
  const lateFeeAmount = policy.lateFeeAmount.toFixed(2);

  const obligation = await tx.duesObligation.create({
    data: {
      organizationId,
      studentId: student.id,
      academyId: student.homeAcademyId,
      type: "MONTHLY",
      origin,
      coverageYear: coverage.year,
      coverageMonth: coverage.month,
      monthsCovered: 1,
      amount,
      currency: terms.currency,
      lateFeeAmount,
      dueOn: toDbDate(due),
      graceDeadline: toDbDate(grace),
      planTermsId: terms.id,
      policyVersionId: policy.id,
      createdById: context.actorUserId,
    },
  });
  await tx.duesCoverage.create({ data: { organizationId, studentId: student.id, obligationId: obligation.id, year: coverage.year, month: coverage.month } });
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: student.homeAcademyId,
      action: "duesObligation.create",
      entityType: "DuesObligation",
      entityId: obligation.id,
      before: Prisma.DbNull,
      // strings, so the exact amounts survive JSON
      after: {
        studentId: student.id, type: "MONTHLY", origin, coverage: `${coverage.year}-${String(coverage.month).padStart(2, "0")}`, amount, currency: terms.currency,
        lateFeeAmount, dueOn: `${due.year}-${String(due.month).padStart(2, "0")}-${String(due.day).padStart(2, "0")}`,
        graceDeadline: `${grace.year}-${String(grace.month).padStart(2, "0")}-${String(grace.day).padStart(2, "0")}`, planTermsId: terms.id, policyVersionId: policy.id,
      },
    },
  });
  return { ok: true, created: true, obligationId: obligation.id };
}

/**
 * The transaction-aware core of `createMonthlyObligation` (below), extracted (monthly-generation brief §5.2) so the monthly-generation
 * runner — `src/lib/dues/monthly-generation.ts`, the ledger's one other authorized caller — can compose it inside its OWN transaction,
 * which already holds the branch/student locks before this runs, instead of nesting a second transaction inside the first (which would
 * not share a transaction and would reverse the lock order — the exact composition mistake found and reverted in an earlier phase).
 *
 * Every database operation here uses the supplied `tx`; nothing falls back to the global `prisma` client. The activation check,
 * coverage-month validation and tenant/branch-scope check are all repeated here, not only in the public wrapper below, so this
 * function trusts nothing from its caller — a direct caller that skipped any of them gets the same refusal the wrapper would give.
 *
 * Monthly-prepayment brief §2: EXACT signature, behavior and error set unchanged by that phase's extraction below — this function
 * still takes the branch/student locks itself, still refuses `futureMonth` exactly as before, then delegates to
 * `writeMonthlyObligationInTx` with `origin: "STAFF"`. No bypass exists here for a future month: the refusal stays entirely and
 * only in this function, unmodified.
 */
export async function createMonthlyObligationInTx(
  tx: Tx,
  args: { context: TenantContext; student: { id: string; homeAcademyId: string }; coverage: YearMonth; planTermsId: string; policyVersionId: string },
  deps: LedgerDeps = {},
): Promise<CreateMonthlyObligationResult> {
  const { context, student, coverage, planTermsId, policyVersionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  if (!isValidCoverageMonth(coverage)) return refuse("invalid");
  if (!inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  // 1. branch FOR SHARE (waits for an in-flight configuration save), 2. student FOR UPDATE
  const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
  if (!branch) return refuse("notFound");
  const locked = await lockStudent(tx, organizationId, student.id);
  if (!locked || locked.homeAcademyId !== student.homeAcademyId) return refuse("conflict"); // moved branches while we waited: retry

  const now = (deps.now ?? (() => new Date()))();
  if (compareYearMonth(coverage, currentMonthIn(branch.timezone, now)) > 0) return refuse("futureMonth");

  return writeMonthlyObligationInTx(tx, { context, student, coverage, planTermsId, policyVersionId, origin: "STAFF" }, deps);
}

/**
 * Create ONE monthly obligation and its coverage row, atomically (ledger writer 1 of 2, PR 4a).
 *
 * A plain library function: no server action, route, job or caller other than the monthly-generation runner (which calls
 * `createMonthlyObligationInTx` directly, above), and closed by default (see `activation.ts`). It decides nothing about WHO is billed or
 * WHEN: eligibility, status history, assignments and the monthly job are separate work. The caller supplies the student, the month and
 * the two configuration versions; this function proves the versions are the right ones and snapshots them.
 *
 * A thin wrapper: its own pre-transaction checks (activation, format validation, the student lookup) are unchanged from before this
 * function's transaction body was extracted into `createMonthlyObligationInTx`; it then opens one transaction and delegates to that
 * function, which repeats the lock order (branch FOR SHARE, student FOR UPDATE, then terms/policy FOR SHARE) and the activation check.
 *
 * Not in scope, on purpose: packages, signup, opening balances, job origin, status eligibility. Future months (prepayment) are now
 * handled by a separate, dedicated writer (`prepay-monthly.ts`) that composes `writeMonthlyObligationInTx` directly — this function's
 * own `futureMonth` refusal is unchanged and still applies to every caller reaching it, including that writer's sibling calls.
 */
export async function createMonthlyObligation(
  args: { context: TenantContext; studentId: string; coverage: YearMonth; planTermsId: string; policyVersionId: string },
  deps: LedgerDeps = {},
): Promise<CreateMonthlyObligationResult> {
  const { context, studentId, coverage, planTermsId, policyVersionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");

  if (!isValidCoverageMonth(coverage)) return refuse("invalid");
  if (typeof studentId !== "string" || typeof planTermsId !== "string" || typeof policyVersionId !== "string") return refuse("invalid");

  // Re-read the student scoped to the organization; a forged or foreign id is `notFound`, never trusted.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  return prisma.$transaction((tx) => createMonthlyObligationInTx(tx, { context, student, coverage, planTermsId, policyVersionId }, deps));
}
