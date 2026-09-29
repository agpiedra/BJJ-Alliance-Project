import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { addMonths, compareDates, compareYearMonth, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, parseMoney } from "@/lib/dues/config-input";
import { settleReceipt, type SettlementItem } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, isRealDate, latestEffective, lockBranchShared, lockStudent, lockTermsShared, minusDays, todayIn } from "@/lib/dues/ledger/common";
import { isValidCoverageMonth } from "@/lib/dues/ledger/create-monthly-obligation";
import { MAX_MINOR_UNITS, columnToMinor, decimalToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";
import { firstUncoveredFrom, SCHEMA_MAX_MONTH } from "@/lib/dues/ledger/prepay-monthly";
import {
  classifyRecordPaymentError,
  resolveMonthlyDebtItemsInTx,
  writeSettlementInTx,
  type RecordDuesPaymentError,
  type SettlementLineItem,
} from "@/lib/dues/ledger/record-payment";
import { CURRENCIES } from "@/lib/payments/format-money";

/**
 * Package-purchase brief: an owner buys one multi-month package for a student — one `type: "PACKAGE"` `DuesObligation`,
 * every one of its `monthsCovered` `DuesCoverage` rows, and its full settlement (optionally combined with the student's
 * existing `MONTHLY` debt in the same receipt) — atomically, in one transaction. A plain library function: no server
 * action, route, job or scheduler entry, closed by default (see `activation.ts`).
 *
 * OWNER-ONLY (`context.organizationRole === "ADMIN"`), checked here — asked and approved on its own terms, never inferred
 * from `prepayMonthlyObligations`'s own approval. D5 (who may call `recordDuesPayment` itself) remains exactly as pending
 * as before; this writer does not touch `recordDuesPayment`'s own lack of a role check.
 *
 * FOUR CONFIRMED POLICIES (PACKAGE-PURCHASE-BRIEF.md §1, §7):
 *  1. `DuesPolicyVersion.maxPrepaidMonths` also bounds a package's FINAL covered month — the same standing calendar horizon
 *     `prepayMonthlyObligations` already enforces for prepaid months, resolved from the policy effective at recording time
 *     (`purchaseInstant`), never from `receivedOn`. Unset means unavailable. Lowering the limit later never touches an
 *     already-purchased package.
 *  2. The package terms must be the version CURRENTLY effective for its plan — a caller-named `planTermsId` that has been
 *     superseded since it was quoted is refused (`staleTerms`), never silently repriced to whatever is effective now.
 *  3. `firstUncovered`'s search floor is the CURRENT branch-local calendar month, not `currentMonth + 1` — unlike
 *     prepayment, a package may legitimately start immediately. This writer never looks at, or reconciles, any month
 *     before that floor: no enrollment/resume-charge mechanism is invented for a historical gap.
 *  4. Existing obligations and coverage (any type, any origin, paid or unpaid) reserve their months regardless — this
 *     writer never replaces one; it only ever creates the ONE package obligation for the span it resolves.
 *
 * EXPLICIT SELECTIONS, NEVER SUBSTITUTED: the caller names the student, the exact `planTermsId` it quoted, the exact
 * `requestedStartMonth`, and any current-debt `existingObligationIds` — nothing here is recomputed as "the next available
 * span". A retried identical request hits the same coverage/duplicate checks and refuses or no-ops cleanly.
 *
 * FULL SETTLEMENT, NOT A BARE `settleReceipt` SUCCESS: `settleReceipt` accepts any valid k-prefix of its item list,
 * including one shorter than the whole list — a receipt matching only the current-debt portion is a LEGITIMATE
 * `settleReceipt` result that excludes the package. This writer explicitly verifies every required item (every named
 * debt id AND the package's own obligation) is actually in `settledIds`; anything short of that refuses the whole
 * transaction and rolls back everything already written (the package obligation and every one of its coverage rows
 * included) — "no unpaid package" is never produced, even transiently.
 *
 * ONE ATOMIC RECEIPT, REUSING `recordDuesPaymentInTx`'s OWN SETTLEMENT CORE: current debt is resolved and validated the
 * identical way `recordDuesPaymentInTx` already does (`resolveMonthlyDebtItemsInTx`, oldest-first among ALL of the
 * student's open `MONTHLY` obligations) — not a second, drifting copy of that logic. The package's own line is appended
 * last, never fee-eligible (a package cannot carry a late fee — `DuesObligation_shape_by_type`), and the combined list is
 * written through the SAME shared write core (`writeSettlementInTx`) `recordDuesPaymentInTx` itself now uses — one
 * `DuesPayment`, never two separate payments for the two portions.
 *
 * ALL OUTSTANDING MONTHLY DEBT MUST BE SETTLED WITH THE PACKAGE, NOT JUST WHATEVER THE CALLER NAMED: unlike an ordinary
 * payment (where settling only some of the oldest debt is legitimate — you can pay this month without paying next month
 * too), committing to FUTURE package coverage while older debt sits untouched is exactly backwards. `resolveMonthlyDebtItemsInTx`
 * only validates that the caller's NAMED ids form a valid oldest-first prefix of whatever count was named — an empty or
 * partial selection trivially passes that check. This writer additionally requires the named ids to be the STUDENT'S
 * ENTIRE open `MONTHLY` set (`debtNotFullySettled` otherwise) — the same length-equality technique already used below to
 * prove the package itself was actually settled, applied here to prove nothing older was left behind.
 *
 * REVERSAL: already refused by `reverse-payment.ts`'s existing `unsupportedObligationType` check (`type !== "MONTHLY"`) —
 * a `PACKAGE` obligation is never `MONTHLY`, so no change to that writer was needed for this phase.
 *
 * PURCHASE-TIME REFERENCE: captured exactly once, immediately after the branch/student locks succeed, and threaded
 * through every later decision via `deps` — no later step calls the clock again on its own.
 */
export type PurchasePackageError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "inapplicable"
  | "staleTerms"
  | "prepaymentUnavailable"
  | "prepaymentLimitExceeded"
  | "coverageGap"
  | "debtNotFullySettled"
  | RecordDuesPaymentError;

export type PurchasePackageResult =
  | { ok: true; obligationId: string; paymentId: string; settlementIds: string[]; totalMinor: number }
  | { ok: false; error: PurchasePackageError; selectableTotals?: string[]; alreadySettledIds?: string[] };

const refuse = (
  error: PurchasePackageError,
  extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {},
): Extract<PurchasePackageResult, { ok: false }> => ({ ok: false, error, ...extra });

// The package itself always occupies one slot in the combined receipt alongside any named debt — capping named debt at
// MAX_SELECTED - 1 (not the full MAX_SELECTED) is what keeps debt-plus-package from ever exceeding the same 60-per-receipt
// ceiling recordDuesPaymentInTx's own MAX_SELECTED already enforces for an ordinary, all-MONTHLY receipt.
const MAX_SELECTED = 60;
const MAX_EXISTING_DEBT = MAX_SELECTED - 1;
const MAX_BACKDATE_DAYS = 3660;
const MAX_NOTES = 500;

/** Tags a mid-transaction refusal so it can be thrown — forcing Prisma to roll back the package obligation, every one of
 * its coverage rows, and anything else already written — and converted back to a plain result only after that rollback.
 * Mirrors `correctLateFeeAndSettle`'s and `prepayMonthlyObligations`'s own mechanism. */
class PackagePurchaseRefusedError extends Error {
  constructor(public readonly result: PurchasePackageResult & { ok: false }) {
    super(`package purchase refused mid-transaction: ${result.error}`);
  }
}

export async function purchasePackage(
  args: {
    context: TenantContext;
    studentId: string;
    /** The exact terms/version id the caller quoted — never re-resolved silently on a stale name (see the doc comment above). */
    planTermsId: string;
    /** Explicit, caller-selected start month — never computed inside this writer. */
    requestedStartMonth: YearMonth;
    /** Explicit current-debt obligation ids to combine in the same receipt, if any. */
    existingObligationIds?: string[];
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<PurchasePackageResult> {
  const { context, studentId, planTermsId, requestedStartMonth, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline
  // correctLateFeeAndSettle/reversePayment/waiveLateFee/prepayMonthlyObligations already apply to their own role requirement.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");

  if (typeof studentId !== "string" || studentId === "") return refuse("invalid");
  if (typeof planTermsId !== "string" || planTermsId === "") return refuse("invalid");
  if (!requestedStartMonth || !isValidCoverageMonth(requestedStartMonth)) return refuse("invalid");
  if (
    existingObligationIds !== undefined &&
    (!Array.isArray(existingObligationIds) ||
      existingObligationIds.length > MAX_EXISTING_DEBT ||
      existingObligationIds.some((id) => typeof id !== "string" || id === "") ||
      new Set(existingObligationIds).size !== existingObligationIds.length)
  ) {
    return refuse("invalid");
  }
  if (!receivedOn || !isRealDate(receivedOn)) return refuse("invalid");
  if (!(CURRENCIES as readonly string[]).includes(tender?.currency)) return refuse("invalid");
  const parsedAmount = parseMoney(tender?.amount, { allowZero: false });
  if (!parsedAmount.ok) return refuse("invalid");
  if (!(Object.values(PaymentMethod) as string[]).includes(method)) return refuse("invalid");
  if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTES)) return refuse("invalid");
  if (!Number.isInteger(maxBackdateDays) || maxBackdateDays < 0 || maxBackdateDays > MAX_BACKDATE_DAYS) return refuse("invalid");

  const tenderMinor = decimalToMinor(parsedAmount.value);

  // Re-read the student scoped to the organization; a forged or foreign id is notFound, never trusted. Checked as a plain
  // string before this read (above) — an undefined/null id would otherwise be silently dropped from Prisma's `where` and
  // match an arbitrary student, the exact gap PR #76's own review found and fixed for prepayMonthlyObligations.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  try {
    return await prisma.$transaction(async (tx): Promise<PurchasePackageResult> => {
      const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
      if (!branch) return refuse("notFound");
      const locked = await lockStudent(tx, organizationId, student.id);
      if (!locked || locked.homeAcademyId !== student.homeAcademyId) return refuse("notFound");

      // Captured exactly once, immediately after both locks above — never re-read later in this function. Threaded through
      // every composed call below via frozenDeps, so no later step calls the clock again on its own.
      const purchaseInstant = (deps.now ?? (() => new Date()))();
      if (deps.afterPackagePurchaseInstantCapturedForTest) await deps.afterPackagePurchaseInstantCapturedForTest();
      const currentMonth = currentMonthIn(branch.timezone, purchaseInstant);
      const frozenDeps: LedgerDeps = { ...deps, now: () => purchaseInstant };

      const today = todayIn(branch.timezone, purchaseInstant);
      if (compareDates(receivedOn, today) > 0) return refuse("futureDate");
      if (compareDates(receivedOn, minusDays(today, maxBackdateDays)) < 0) return refuse("tooOld");

      // Terms: must exist, be locked before its value is trusted, be a genuine package terms row (monthsCovered >= 2),
      // belong to this student's branch, and be the version CURRENTLY effective — a superseded name is refused, never
      // silently repriced (approved policy 2).
      const termsRef = await tx.paymentPlanTerms.findFirst({ where: { id: planTermsId, organizationId }, select: { id: true, planId: true } });
      if (!termsRef) return refuse("notFound");
      if (!(await lockTermsShared(tx, organizationId, termsRef.id))) return refuse("notFound");
      const terms = await tx.paymentPlanTerms.findFirstOrThrow({ where: { id: termsRef.id, organizationId } });
      if (terms.monthsCovered < 2) return refuse("inapplicable");
      const plan = await tx.paymentPlan.findFirst({ where: { id: terms.planId, organizationId }, select: { academyId: true } });
      if (!plan || plan.academyId !== student.homeAcademyId) return refuse("inapplicable");
      const termsHistory = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: terms.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
      if (latestEffective(termsHistory, currentMonth)?.id !== terms.id) return refuse("staleTerms");

      // The prepayment horizon also bounds a package's final covered month (approved policy 1), resolved from the policy
      // effective at recording time — never from receivedOn.
      const policyHistory = await tx.duesPolicyVersion.findMany({
        where: { organizationId, academyId: student.homeAcademyId },
        select: { effectiveYear: true, effectiveMonth: true, maxPrepaidMonths: true },
      });
      const effectivePolicy = latestEffective(policyHistory, currentMonth);
      if (!effectivePolicy || effectivePolicy.maxPrepaidMonths === null) return refuse("prepaymentUnavailable");
      const horizonEnd = addMonths(currentMonth, effectivePolicy.maxPrepaidMonths);
      const finalMonth = addMonths(requestedStartMonth, terms.monthsCovered - 1);
      if (compareYearMonth(finalMonth, currentMonth) <= 0 || compareYearMonth(finalMonth, horizonEnd) > 0) return refuse("prepaymentLimitExceeded");

      // Explicit, never substituted: the requested start must be exactly the first uncovered month, floored at the CURRENT
      // month (approved policy 3 — a package may start immediately, unlike prepayment's currentMonth + 1 floor).
      const searchBound = compareYearMonth(horizonEnd, SCHEMA_MAX_MONTH) < 0 ? horizonEnd : SCHEMA_MAX_MONTH;
      const firstUncovered = await firstUncoveredFrom(tx, organizationId, student.id, currentMonth, searchBound);
      if (firstUncovered === null) return refuse("prepaymentLimitExceeded");
      if (compareYearMonth(requestedStartMonth, firstUncovered) !== 0) return refuse("coverageGap");

      // firstUncovered only guarantees the FIRST month of the span is free — a package longer than one month must have
      // EVERY covered month checked (approved policy 4: existing obligations/coverage reserve their months regardless, and
      // this writer never replaces one). No obligation-level uniqueness protects a PACKAGE row the way it does MONTHLY
      // (DuesObligation_student_month_monthly_key is MONTHLY-scoped); DuesCoverage's own per-month uniqueness is the real
      // backstop, checked here first so a collision refuses cleanly instead of surfacing a raw constraint violation.
      for (let i = 0; i < terms.monthsCovered; i++) {
        const month = addMonths(requestedStartMonth, i);
        const existingObligation = await tx.duesObligation.findFirst({
          where: { organizationId, studentId: student.id, coverageYear: month.year, coverageMonth: month.month },
          select: { id: true },
        });
        const existingCoverage = await tx.duesCoverage.findFirst({
          where: { organizationId, studentId: student.id, year: month.year, month: month.month },
          select: { id: true },
        });
        if (existingObligation || existingCoverage) return refuse("coverageGap");
      }

      // One PACKAGE obligation, DB-enforced shape: dueOn/graceDeadline/lateFeeAmount/policyVersionId all NULL, no
      // reference to any DuesPolicyVersion — origin STAFF (a package purchase is a discrete, owner-recorded sale, not the
      // scheduled job, and NOT the PREPAYMENT origin reverse-payment.ts's own permanent restriction is keyed on: reversal
      // for a package is already blocked by its own type, so origin need not, and must not, carry that separate meaning).
      const amount = terms.priceAmount.toFixed(2);
      const obligation = await tx.duesObligation.create({
        data: {
          organizationId,
          studentId: student.id,
          academyId: student.homeAcademyId,
          type: "PACKAGE",
          origin: "STAFF",
          coverageYear: requestedStartMonth.year,
          coverageMonth: requestedStartMonth.month,
          monthsCovered: terms.monthsCovered,
          amount,
          currency: terms.currency,
          planTermsId: terms.id,
          createdById: context.actorUserId,
        },
      });
      for (let i = 0; i < terms.monthsCovered; i++) {
        const month = addMonths(requestedStartMonth, i);
        await tx.duesCoverage.create({ data: { organizationId, studentId: student.id, obligationId: obligation.id, year: month.year, month: month.month } });
      }
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId,
          academyId: student.homeAcademyId,
          action: "duesObligation.create",
          entityType: "DuesObligation",
          entityId: obligation.id,
          before: Prisma.DbNull,
          after: {
            studentId: student.id,
            type: "PACKAGE",
            origin: "STAFF",
            monthsCovered: terms.monthsCovered,
            startCoverage: `${requestedStartMonth.year}-${String(requestedStartMonth.month).padStart(2, "0")}`,
            amount,
            currency: terms.currency,
            planTermsId: terms.id,
          },
        },
      });

      if (frozenDeps.afterPackageObligationWrittenForTest) await frozenDeps.afterPackageObligationWrittenForTest();

      // Existing outstanding debt, resolved and validated exactly the way recordDuesPaymentInTx already does (oldest-first
      // among ALL of the student's open MONTHLY obligations) — reused, not duplicated.
      const debtResult = await resolveMonthlyDebtItemsInTx(tx, { organizationId, studentId: student.id, obligationIds: existingObligationIds ?? [], receivedOn });
      if (!debtResult.ok) throw new PackagePurchaseRefusedError(refuse(debtResult.error, { alreadySettledIds: debtResult.alreadySettledIds }));

      // ALL outstanding MONTHLY debt must be named and settled together with the package, not just whatever subset the
      // caller chose — committing to future package coverage while older debt sits untouched is exactly what this check
      // exists to prevent. chosenItems is already validated as a prefix of its own count (resolveMonthlyDebtItemsInTx);
      // equal length to the FULL open set is what proves that prefix is everything, not merely a valid partial one.
      if (debtResult.chosenItems.length !== debtResult.allOpenItems.length) {
        throw new PackagePurchaseRefusedError(refuse("debtNotFullySettled"));
      }

      const packageItem: SettlementLineItem = { obligationId: obligation.id, currency: terms.currency, amountMinor: columnToMinor(terms.priceAmount), feeEligible: false, expectedOwed: false };
      const allItems: SettlementLineItem[] = [...debtResult.chosenItems, packageItem];
      const settlementItems: SettlementItem[] = allItems.map((i) => ({ id: i.obligationId, currency: i.currency, amountMinor: i.amountMinor }));
      const fullTotalMinor = settlementItems.reduce((sum, i) => sum + i.amountMinor, 0);

      if (settlementItems.length > 0 && settlementItems[0].amountMinor > MAX_MINOR_UNITS) throw new PackagePurchaseRefusedError(refuse("amountUnsupported"));
      // The oldest item alone can be in range while the FULL required total (debt + package) still is not — checked
      // explicitly, since the column that will hold it (DuesPayment.tenderAmount) is what actually bounds it.
      if (fullTotalMinor > MAX_MINOR_UNITS) throw new PackagePurchaseRefusedError(refuse("amountUnsupported"));

      const settled = settleReceipt(settlementItems, tenderMinor, tender.currency);
      if (!settled.ok) {
        // Never offer a debt-only (or any other short) prefix as a "selectable" total here — every one of those excludes
        // the package and would be refused again by the check below if it were ever submitted. Offer only the ONE total
        // that actually settles everything required (debt + package); currencyMismatch offers nothing, matching
        // settleReceipt's own contract that its totals are always empty for a currency mismatch.
        if (settled.reason === "CURRENCY_MISMATCH") throw new PackagePurchaseRefusedError(refuse("currencyMismatch"));
        throw new PackagePurchaseRefusedError(refuse("notASelectableTotal", { selectableTotals: [minorToDecimal(fullTotalMinor)] }));
      }
      // settleReceipt accepts any valid k-prefix — a receipt matching only the debt portion is a LEGITIMATE success that
      // excludes the package. Bare ok:true is not proof the whole purchase succeeded: require every item, package
      // included, to actually be in settledIds, or refuse the whole thing and roll back everything written so far.
      if (settled.settledIds.length !== allItems.length) {
        throw new PackagePurchaseRefusedError(refuse("totalMismatch", { selectableTotals: [minorToDecimal(fullTotalMinor)] }));
      }

      const written = await writeSettlementInTx(tx, { context, student, receivedOn, tender, method, notes, settledItems: allItems }, frozenDeps);
      return { ok: true, obligationId: obligation.id, paymentId: written.paymentId, settlementIds: written.settlementIds, totalMinor: tenderMinor };
    });
  } catch (error) {
    if (error instanceof PackagePurchaseRefusedError) return error.result; // AFTER rollback, never before
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as PurchasePackageResult;
    throw error;
  }
}
