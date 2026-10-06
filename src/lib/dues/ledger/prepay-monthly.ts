import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { addMonths, compareDates, compareYearMonth, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, parseMoney, policyRevisionOf, versionRevision } from "@/lib/dues/config-input";
import { captureAwaitingRateReceiptInTx } from "@/lib/dues/ledger/awaiting-rate-receipt";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, isRealDate, latestEffective, lockAssignmentShared, lockBranchShared, lockStudent, minusDays, todayIn, type Tx } from "@/lib/dues/ledger/common";
import { resolveCrossCurrency } from "@/lib/dues/ledger/cross-currency-settlement";
import { isValidCoverageMonth, writeMonthlyObligationInTx, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { lockExchangeRateNamespaceShared } from "@/lib/dues/ledger/exchange-rate";
import { decimalToMinor } from "@/lib/dues/ledger/minor-units";
import { classifyRecordPaymentError, resolveMonthlyDebtItemsInTx, settleObligationsInTx, type RecordDuesPaymentError, type SettlementLineItem } from "@/lib/dues/ledger/record-payment";
import { CURRENCIES } from "@/lib/payments/format-money";

/**
 * Monthly-prepayment brief: an owner pays ahead for consecutive future months — each still a `type: "MONTHLY"` obligation,
 * `origin: "PREPAYMENT"` — atomically created and settled in one transaction, together with any named current debt. A plain
 * library function: no server action, route, job or scheduler entry, closed by default (see `activation.ts`).
 *
 * OWNER-ONLY, checked here, not deferred to a caller (D5, who may call `recordDuesPayment` itself, remains explicitly pending
 * and is NOT resolved by this writer — `recordDuesPayment`'s own lack of a role check is untouched).
 *
 * FOUR CONFIRMED POLICIES (MONTHLY-PREPAYMENT-BRIEF.md §1, §8):
 *  1. `DuesPolicyVersion.maxPrepaidMonths` is a STANDING CALENDAR HORIZON from the branch's current month, not a per-purchase
 *     count: September with a limit of 3 permits coverage through December; repeated purchases can never push the horizon
 *     further out than the limit at any one point in time.
 *  2. The limit is read from the policy version effective at RECORDING TIME (`purchaseInstant`, §6 below), in the branch's
 *     timezone — never from an older version a backdated `receivedOn` might otherwise select. Tuition/fee still price each
 *     covered month at THAT month's own effective version, unaffected by this.
 *  3. Reversing a payment that includes ANY `PREPAYMENT`-origin obligation is refused outright, for the WHOLE payment,
 *     PERMANENTLY (see `reverse-payment.ts`'s own doc comment) — a temporary, readiness-review-tracked restriction, not a
 *     cancellation or coverage-release policy.
 *  4. Lowering the limit never touches already-purchased coverage — it only gates new purchase attempts going forward.
 *
 * CURRENT-MONTH GAPS ARE EXPLICITLY OUT OF SCOPE: this writer's notion of "uncovered" is floored at `currentMonth + 1` and
 * never looks earlier. Whatever state the current month or any historical gap is in is ordinary billing's concern (the
 * monthly job, staff entry, or an explicit current-debt obligation id named in `existingObligationIds`) — this writer reads
 * nothing about it and invents no enrollment/resume-charge mechanism to reconcile it.
 *
 * RETRIES ARE BOUND TO EXPLICIT SELECTIONS: `requestedMonths` and `existingObligationIds` are exactly what the caller named,
 * never recomputed as "the next N uncovered months" — a retried identical request hits the existing coverage/duplicate checks
 * and refuses or no-ops cleanly; it can never silently extend into further, not-originally-requested months.
 *
 * ASSIGNMENT RACE (`correctAssignment` locks only the specific `StudentPlanAssignment` row, not the student row, and only for
 * a row whose effective month is still future — precisely the rows this writer relies on): `lockAssignmentShared` closes this
 * by taking the SAME row FOR SHARE before trusting its `planId`, re-read only after the lock succeeds. Whichever side acquires
 * the row lock first fully determines what the other sees.
 *
 * PURCHASE-TIME REFERENCE: captured exactly once, immediately after the branch/student locks succeed (not before — acquiring
 * them can itself take real time), and threaded through every later decision (the gap floor, the limit, per-month pricing via
 * `deps`) — no later step calls the clock again on its own.
 */
export type PrepayMonthlyObligationsError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "prepaymentUnavailable"
  | "prepaymentLimitExceeded"
  | "coverageGap"
  | CreateMonthlyObligationError
  | RecordDuesPaymentError;

export type PrepayMonthlyObligationsResult =
  | { ok: true; obligationIds: string[]; paymentId: string; settlementIds: string[]; totalMinor: number }
  | { ok: false; error: PrepayMonthlyObligationsError; selectableTotals?: string[]; alreadySettledIds?: string[]; receiptId?: string };

const refuse = (
  error: PrepayMonthlyObligationsError,
  extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {},
): Extract<PrepayMonthlyObligationsResult, { ok: false }> => ({ ok: false, error, ...extra });

export const MAX_BACKDATE_DAYS = 3660;
export const MAX_NOTES = 500;

/** The canonical two-decimal tender amount — re-parsed here only because this writer's own top-level validation already
 * proved it parses; narrows the type for the hypothetical-total check and the capture-evidence write. */
function parsedAmount(tender: { amount: string }): string {
  const parsed = parseMoney(tender.amount, { allowZero: false });
  if (!parsed.ok) throw new Error(`parsedAmount called with an amount that failed this writer's own top-level validation: ${tender.amount}`);
  return parsed.value;
}

/** Tags a mid-transaction refusal (an obligation write, or the final settlement) so it can be thrown — forcing Prisma to roll
 * back every provisional obligation/coverage/audit row already written — and converted back to a plain result only after that
 * rollback, never returned directly from inside the transaction callback. Mirrors `correctLateFeeAndSettle`'s own mechanism. */
export class PrepaymentRefusedError extends Error {
  constructor(public readonly result: PrepayMonthlyObligationsResult & { ok: false }) {
    super(`prepayment refused mid-transaction: ${result.error}`);
  }
}

const sameYearMonth = (a: YearMonth, b: YearMonth): boolean => a.year === b.year && a.month === b.month;

/** The last calendar month this schema's dues tables can hold (`isValidCoverageMonth`'s own upper bound) — never invented,
 * reused as the outer ceiling a search must never be asked to exceed regardless of how far out a horizon computes. Exported
 * for reuse by other writers that need the same real ceiling (e.g. `purchase-package.ts`), not a per-writer constant. */
export const SCHEMA_MAX_MONTH: YearMonth = { year: 2100, month: 12 };

/**
 * The smallest `YearMonth` in `[floor, bound]` with no `DuesObligation` row (any type) and no `DuesCoverage` row for this
 * student — reusing the exact two tables `createMonthlyObligationInTx`'s own duplicate check already reads, not a new
 * tracking mechanism. `floor` is `currentMonth + 1` for this writer (§3: never asked about the current month or earlier),
 * but the search itself is floor-agnostic — `purchase-package.ts` reuses it with `floor = currentMonth` (a package may
 * legitimately start immediately). `null` means every month through `bound` is already covered — the caller's horizon is
 * fully consumed, not a corrupt-data condition, so this never throws. Exported for that reuse, not a new mechanism.
 */
export async function firstUncoveredFrom(tx: Tx, organizationId: string, studentId: string, floor: YearMonth, bound: YearMonth): Promise<YearMonth | null> {
  // Enrollment/resume integration plan §7.5: SIGNUP also sets coverageYear/coverageMonth (to the enrollment date)
  // but never claims that month's coverage — it inserts zero DuesCoverage rows and coexists with that same month's
  // own MONTHLY. Excluded here explicitly (an allow-list, not a deny-list, so a FUTURE obligation type defaults to
  // NOT being treated as coverage unless deliberately added) so a SIGNUP-only enrollment month is never wrongly
  // treated as already covered.
  const obligationMonths = await tx.duesObligation.findMany({ where: { organizationId, studentId, type: { in: ["MONTHLY", "PACKAGE"] } }, select: { coverageYear: true, coverageMonth: true } });
  const coverageMonths = await tx.duesCoverage.findMany({ where: { organizationId, studentId }, select: { year: true, month: true } });
  const covered = new Set<string>();
  for (const o of obligationMonths) covered.add(`${o.coverageYear}-${o.coverageMonth}`);
  for (const c of coverageMonths) covered.add(`${c.year}-${c.month}`);
  let cursor = floor;
  while (compareYearMonth(cursor, bound) <= 0) {
    if (!covered.has(`${cursor.year}-${cursor.month}`)) return cursor;
    cursor = addMonths(cursor, 1);
  }
  return null;
}

/**
 * Purchase-submission-identity prerequisite: the narrow transaction-aware extraction of `prepayMonthlyObligations`'s
 * own body, everything from AFTER the shared exchange-rate lock onward — the SAME pattern `purchasePackageInTx`
 * applies to its own sibling writer (see that function's own doc comment for the full precedent list).
 * `prepayMonthlyObligations` itself becomes a thin wrapper below: open the transaction, take the lock, call this,
 * catch `PrepaymentRefusedError` exactly as it always has. `student` arrives PRE-RESOLVED and `requestedMonths`
 * arrives UNSORTED (this function re-sorts and re-checks consecutiveness itself, trusting nothing — the original
 * code's own consecutive-months check ran before the transaction opened; this function restores that check as its
 * own first step so a caller — including the identity wrapper — need not duplicate it).
 */
export async function prepayMonthlyObligationsInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    student: { id: string; homeAcademyId: string };
    requestedMonths: YearMonth[];
    existingObligationIds?: string[];
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<PrepayMonthlyObligationsResult> {
  const { context, student, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const sorted = [...requestedMonths].sort((a, b) => compareYearMonth(a, b));
  for (let i = 1; i < sorted.length; i++) {
    if (!sameYearMonth(addMonths(sorted[i - 1], 1), sorted[i])) return refuse("coverageGap");
  }
  {
      const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
      if (!branch) return refuse("notFound");
      const locked = await lockStudent(tx, organizationId, student.id);
      if (!locked || locked.homeAcademyId !== student.homeAcademyId) return refuse("notFound");

      // §6: captured exactly once, immediately after both locks above — never re-read later in this function.
      const purchaseInstant = (deps.now ?? (() => new Date()))();
      if (deps.afterPrepaymentInstantCapturedForTest) await deps.afterPrepaymentInstantCapturedForTest();
      const currentMonth = currentMonthIn(branch.timezone, purchaseInstant);
      // Every composed call below gets THIS frozen instant, never `deps` unchanged — production's real `deps.now` is a plain
      // `() => new Date()`, which would otherwise return a slightly later wall-clock value on each later call (recordDuesPaymentInTx
      // resolves its own "today" independently). One capture point is what actually guarantees every decision in this purchase
      // agrees, not database snapshot isolation (which has no bearing on repeated application-level clock reads at all).
      const frozenDeps: LedgerDeps = { ...deps, now: () => purchaseInstant };

      // §1: the standing-horizon limit, resolved from the policy effective at recording time (purchaseInstant), never from
      // receivedOn — a backdated receipt cannot select an older, more permissive limit. Resolved BEFORE the gap check below,
      // since the gap search needs the horizon as its own bound.
      const policyHistory = await tx.duesPolicyVersion.findMany({
        where: { organizationId, academyId: student.homeAcademyId },
        select: { id: true, effectiveYear: true, effectiveMonth: true, maxPrepaidMonths: true },
      });
      const effectivePolicy = latestEffective(policyHistory, currentMonth);
      if (!effectivePolicy || effectivePolicy.maxPrepaidMonths === null) return refuse("prepaymentUnavailable");
      const horizonEnd = addMonths(currentMonth, effectivePolicy.maxPrepaidMonths);

      // A direct positional bound: each requested month must be strictly after currentMonth and no later than horizonEnd.
      // NOT equivalent to counting existing coverage — a month already covered from an earlier, since-superseded (higher)
      // limit sits outside today's horizon and must never count against a new, otherwise-in-bounds request; a cumulative
      // count can wrongly refuse a request that is itself entirely within bounds, or wrongly admit one that isn't, depending
      // on unrelated coverage elsewhere. The `<= currentMonth` half is defensive (the floor below should already make it
      // unreachable once the gap check also passes), checked explicitly rather than assumed.
      for (const month of sorted) {
        if (compareYearMonth(month, currentMonth) <= 0 || compareYearMonth(month, horizonEnd) > 0) return refuse("prepaymentLimitExceeded");
      }

      // §3/§4: the gap check, floored at currentMonth + 1 — this writer never looks at the current month or earlier — and
      // bounded by the same horizon (or the schema's own supported range if that is smaller), so the search never looks
      // further than anything could ever be purchasable anyway. `null` means the horizon is already fully consumed by
      // existing coverage — a limit refusal, not a gap (there is no "wrong starting point" to name).
      const floor = addMonths(currentMonth, 1);
      const searchBound = compareYearMonth(horizonEnd, SCHEMA_MAX_MONTH) < 0 ? horizonEnd : SCHEMA_MAX_MONTH;
      const firstUncovered = await firstUncoveredFrom(tx, organizationId, student.id, floor, searchBound);
      if (firstUncovered === null) return refuse("prepaymentLimitExceeded");
      if (!sameYearMonth(sorted[0], firstUncovered)) return refuse("coverageGap");

      // Currency-conversion brief PR 3: checked here — AFTER every horizon/gap check above, exactly where
      // `recordDuesPaymentInTx`'s own `futureDate`/`tooOld` check used to fire relative to them (it ran last, once this
      // writer composed it, well after these refusals already had their chance) — this writer now settles via
      // `settleObligationsInTx`, which has no date check of its own, so it is checked here directly instead. Precedence
      // among refusals is unchanged from before this PR; only which function contains the check moved.
      const today = todayIn(branch.timezone, purchaseInstant);
      if (compareDates(receivedOn, today) > 0) return refuse("futureDate");
      if (compareDates(receivedOn, minusDays(today, maxBackdateDays)) < 0) return refuse("tooOld");

      // Currency-conversion brief PR 3 (plan §3.2): RESOLVE every requested month first — nothing is written yet. Each
      // month's assignment, terms and policy are resolved and locked (FOR SHARE) exactly as before, but `writeMonthlyObligationInTx`
      // is not called until the hypothetical settlement total (existing debt + every resolved month's price) is confirmed
      // payable, including that a rate exists if one is needed. §5: per requested month, oldest first (already sorted above).
      type ResolvedMonth = {
        month: YearMonth;
        planTermsId: string;
        policyVersionId: string;
        policyRevision: string;
        priceAmount: string;
        currency: Currency;
        assignmentId: string;
        assignmentEffectiveYear: number;
        assignmentEffectiveMonth: number;
        assignmentPlanId: string;
      };
      const resolvedMonths: ResolvedMonth[] = [];
      for (const month of sorted) {
        const assignments = await tx.studentPlanAssignment.findMany({
          where: { organizationId, studentId: student.id },
          select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true },
        });
        const candidate = latestEffective(assignments, month);
        if (!candidate) throw new PrepaymentRefusedError(refuse("inapplicable")); // no assignment at all for this month
        if (!(await lockAssignmentShared(tx, organizationId, candidate.id))) throw new PrepaymentRefusedError(refuse("notFound"));
        // Re-read fresh now that the lock is held — the pre-lock candidate above could already be stale (a concurrent
        // correctAssignment may have just committed, or may be about to, depending on which side queued first).
        const assignment = await tx.studentPlanAssignment.findUniqueOrThrow({ where: { id: candidate.id, organizationId } });
        if (assignment.planId === null) throw new PrepaymentRefusedError(refuse("inapplicable")); // explicitly unassigned

        const termsCandidates = await tx.paymentPlanTerms.findMany({
          where: { organizationId, planId: assignment.planId },
          select: { id: true, effectiveYear: true, effectiveMonth: true },
        });
        const termsCandidate = latestEffective(termsCandidates, month);
        const policyCandidate = latestEffective(policyHistory, month);
        if (!termsCandidate || !policyCandidate) throw new PrepaymentRefusedError(refuse("inapplicable"));
        const termsRow = await tx.paymentPlanTerms.findFirstOrThrow({ where: { id: termsCandidate.id, organizationId }, select: { priceAmount: true, currency: true } });
        const policyRow = await tx.duesPolicyVersion.findFirstOrThrow({
          where: { id: policyCandidate.id, organizationId },
          select: { dueDay: true, graceDay: true, lateFeeAmount: true, lateFeeCurrency: true },
        });

        resolvedMonths.push({
          month,
          planTermsId: termsCandidate.id,
          policyVersionId: policyCandidate.id,
          policyRevision: policyRevisionOf({ ...policyRow, lateFeeAmount: policyRow.lateFeeAmount.toFixed(2) }),
          priceAmount: termsRow.priceAmount.toFixed(2),
          currency: termsRow.currency,
          assignmentId: assignment.id,
          assignmentEffectiveYear: assignment.effectiveYear,
          assignmentEffectiveMonth: assignment.effectiveMonth,
          assignmentPlanId: assignment.planId,
        });
      }

      if (frozenDeps.afterPrepaymentObligationsWrittenForTest) await frozenDeps.afterPrepaymentObligationsWrittenForTest();

      // Existing named current debt, resolved read-only (reused, not duplicated) — combined with each resolved month's
      // own price (keyed by a placeholder id, since the obligation it will belong to does not exist yet) to compute the
      // hypothetical full settlement total and discover, BEFORE any write, whether a rate would be needed and available.
      const debtResult = await resolveMonthlyDebtItemsInTx(tx, { organizationId, studentId: student.id, obligationIds: existingObligationIds ?? [], receivedOn });
      if (!debtResult.ok) throw new PrepaymentRefusedError(refuse(debtResult.error, { alreadySettledIds: debtResult.alreadySettledIds }));
      const monthPlaceholderItems: SettlementLineItem[] = resolvedMonths.map((m, i) => ({
        obligationId: `__prepay_month_${i}__`,
        currency: m.currency,
        amountMinor: decimalToMinor(m.priceAmount),
        feeEligible: false,
        expectedOwed: false,
      }));
      const hypotheticalItems = [...debtResult.chosenItems, ...monthPlaceholderItems];
      const hypotheticalCurrencies = new Set(hypotheticalItems.map((i) => i.currency));
      if (hypotheticalCurrencies.size === 1 && !hypotheticalCurrencies.has(tender.currency)) {
        const hypotheticalSettlementItems = hypotheticalItems.map((i) => ({ id: i.obligationId, currency: i.currency, amountMinor: i.amountMinor }));
        const resolved = await resolveCrossCurrency(tx, {
          organizationId, items: hypotheticalSettlementItems, itemCurrency: [...hypotheticalCurrencies][0], receiptCurrency: tender.currency, receivedOn,
        });
        if (!resolved.ok) {
          // Currency-conversion brief PR 3 (plan §2/§3.2): no eligible quote at all — capture instead of refusing. Nothing
          // has been created yet (both loops above are entirely read-only), so capturing here is transaction-safe.
          return captureAwaitingRateReceiptInTx(tx, {
            context,
            student,
            kind: "PREPAYMENT",
            receivedOn,
            tenderCurrency: tender.currency,
            tenderAmount: parsedAmount(tender),
            method,
            notes,
            snapshot: {
              kind: "PREPAYMENT",
              existingObligationIds: existingObligationIds ?? [],
              months: resolvedMonths.map((m) => ({
                coverage: m.month,
                planTermsId: m.planTermsId,
                policyVersionId: m.policyVersionId,
                policyRevision: m.policyRevision,
                priceAmount: m.priceAmount,
                assignmentId: m.assignmentId,
                assignmentRevision: versionRevision({ planId: m.assignmentPlanId }),
              })),
            },
            capturedAt: purchaseInstant,
          });
        }
        // A rate resolves — proceed. settleObligationsInTx (below) re-resolves it again with the REAL obligation ids once
        // they exist; this pre-check only exists to decide whether to capture, never to short-circuit the real settlement.
      }

      // Confirmed payable (or same-currency): now actually create each month's obligation, in order.
      const obligationIds: string[] = [];
      for (const m of resolvedMonths) {
        const written = await writeMonthlyObligationInTx(
          tx,
          { context, student, coverage: m.month, planTermsId: m.planTermsId, policyVersionId: m.policyVersionId, origin: "PREPAYMENT" },
          frozenDeps,
        );
        if (!written.ok) throw new PrepaymentRefusedError(refuse(written.error));
        obligationIds.push(written.obligationId);

        // Complete assignment provenance (brief §5): an id alone points at a mutable row — record the plan actually relied
        // upon and a fingerprint of it, so a later correctAssignment can never erase what this purchase actually used.
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId,
            organizationId,
            academyId: student.homeAcademyId,
            action: "duesObligation.prepaymentAssignment",
            entityType: "DuesObligation",
            entityId: written.obligationId,
            before: Prisma.DbNull,
            after: {
              assignmentId: m.assignmentId,
              effectiveYear: m.assignmentEffectiveYear,
              effectiveMonth: m.assignmentEffectiveMonth,
              planId: m.assignmentPlanId,
              revision: versionRevision({ planId: m.assignmentPlanId }),
            },
          },
        });
      }

      // §9: settle the newly created future months together with any named current debt, in the SAME transaction, reusing
      // the shared settlement core's existing oldest-first/exact-total/currency validation entirely unmodified.
      const parsedTenderAmountValue = parsedAmount(tender);
      const settled = await settleObligationsInTx(
        tx,
        {
          context, student, receivedOn, tenderMinor: decimalToMinor(parsedTenderAmountValue), tender, method,
          obligationIds: [...(existingObligationIds ?? []), ...obligationIds], notes,
        },
        frozenDeps,
      );
      if (!settled.ok) throw new PrepaymentRefusedError(refuse(settled.error, { selectableTotals: settled.selectableTotals, alreadySettledIds: settled.alreadySettledIds }));

      return { ok: true, obligationIds, paymentId: settled.paymentId, settlementIds: settled.settlementIds, totalMinor: settled.totalMinor };
  }
}

/**
 * Monthly-prepayment brief §9: `prepayMonthlyObligations`'s own public entry point — now a thin wrapper around
 * `prepayMonthlyObligationsInTx` (above). Owns the transaction, the shared exchange-rate lock, and the catch for
 * `PrepaymentRefusedError` exactly as this function always has. Every pre-transaction check (activation, input
 * shape, the student lookup/tenant-scope check) is UNCHANGED, byte-for-byte, from before this extraction — this
 * function's own existing test suite (`prepay-monthly.test.ts`) proves zero behavior change.
 */
export async function prepayMonthlyObligations(
  args: {
    context: TenantContext;
    studentId: string;
    /** Explicit, caller-selected future months — never recomputed inside this writer (see the doc comment above). */
    requestedMonths: YearMonth[];
    /** Explicit current-debt obligation ids to combine in the same receipt, if any. */
    existingObligationIds?: string[];
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<PrepayMonthlyObligationsResult> {
  const { context, studentId, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline
  // `correctLateFeeAndSettle`/`reversePayment`/`waiveLateFee` already apply to their own role requirement.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");

  // Verified, not a style nit: an `undefined` studentId reaching the lookup below does not throw — Prisma drops an
  // `undefined` field from `where` entirely, so `findFirst({ where: { id: undefined, organizationId } })` silently matches
  // an ARBITRARY student in the organization instead of refusing. Checked here, before any DB read, the same discipline
  // `correctLateFeeAndSettle`/`reversePayment`/`waiveLateFee` already apply to their own id-shaped argument.
  if (typeof studentId !== "string" || studentId === "") return refuse("invalid");
  if (!Array.isArray(requestedMonths) || requestedMonths.length === 0 || !requestedMonths.every(isValidCoverageMonth)) return refuse("invalid");
  if (
    existingObligationIds !== undefined &&
    (!Array.isArray(existingObligationIds) || existingObligationIds.some((id) => typeof id !== "string" || id === ""))
  ) {
    return refuse("invalid");
  }
  if (!receivedOn || !isRealDate(receivedOn)) return refuse("invalid");
  // Currency-conversion brief PR 3: this writer now settles via `settleObligationsInTx` directly on its success path
  // (never `recordDuesPaymentInTx`, whose own `validatePaymentInput` used to cover these fields) — so it validates its
  // own tender/method/notes/backdating shape here, the same checks `purchasePackage` already runs for the identical
  // reason (it never routed through `recordDuesPaymentInTx` either).
  if (!(CURRENCIES as readonly string[]).includes(tender?.currency)) return refuse("invalid");
  if (!parseMoney(tender?.amount, { allowZero: false }).ok) return refuse("invalid");
  if (!(Object.values(PaymentMethod) as string[]).includes(method)) return refuse("invalid");
  if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTES)) return refuse("invalid");
  if (!Number.isInteger(maxBackdateDays) || maxBackdateDays < 0 || maxBackdateDays > MAX_BACKDATE_DAYS) return refuse("invalid");

  // Re-read the student scoped to the organization; a forged or foreign id is `notFound`, never trusted.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  const sortedCheck = [...requestedMonths].sort((a, b) => compareYearMonth(a, b));
  for (let i = 1; i < sortedCheck.length; i++) {
    if (!sameYearMonth(addMonths(sortedCheck[i - 1], 1), sortedCheck[i])) return refuse("coverageGap");
  }

  try {
    return await prisma.$transaction(async (tx): Promise<PrepayMonthlyObligationsResult> => {
      // The literal first statement, SHARED, before the branch lock. See lockExchangeRateNamespaceShared's own doc
      // comment: every true outermost transaction this ledger opens takes it unconditionally, before any row lock.
      await lockExchangeRateNamespaceShared(tx, organizationId);
      return prepayMonthlyObligationsInTx(tx, { context, student, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays }, deps);
    });
  } catch (error) {
    if (error instanceof PrepaymentRefusedError) return error.result; // AFTER rollback, never before
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as PrepayMonthlyObligationsResult; // RecordDuesPaymentError is a subset of PrepayMonthlyObligationsError
    throw error;
  }
}
