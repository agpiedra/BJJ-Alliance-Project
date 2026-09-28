import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { compareDates, type CalendarDate } from "@/lib/dues/calendar";
import { parseMoney } from "@/lib/dues/config-input";
import { feeAssessableFrom, lateFeeApplies, lateFeeToAssessMinor, orderOldestFirst, outstandingItems, settleReceipt, type ObligationTerms } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { fromDbDate, inTenantScope, isRealDate, lockStudent, minusDays, todayIn, toDbDate, type Tx } from "@/lib/dues/ledger/common";
import { MAX_MINOR_UNITS, columnToMinor, decimalToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";
import { isUniqueViolationOn } from "@/lib/dues/ledger/unique-violation";
import { CURRENCIES } from "@/lib/payments/format-money";

/**
 * Record ONE payment that settles WHOLE outstanding monthly obligations, oldest first, in the obligations' own currency (ledger writer 2
 * of 2, PR 4a). A plain library function: no server action, route, job or caller, and closed by default (see `activation.ts`).
 *
 * VALIDATE FIRST, THEN WRITE. Under the transaction's locks the function loads the student's obligations and their fee state, then
 * checks the explicitly selected obligation ids, the oldest-first order, the currency, the received date and the exact total. Only when
 * every check has passed does it insert any required late-fee rows, the payment, the settlements and the audit rows, in one transaction.
 * A refused submission therefore leaves every ledger table and the audit log exactly as it was.
 *
 * THE SELECTION IS EXPLICIT AND BOUND TO THE ORIGINAL OBLIGATIONS. The caller names the obligation ids; nothing is ever recomputed from
 * "the next unpaid months". A replay of a request whose obligations are already settled is refused (`alreadySettled`) and is never
 * applied to later obligations that happen to cost the same amount. A payment always settles at least one whole obligation and an
 * obligation has at most one active settlement, so a duplicate can never double-record.
 *
 * Fee rules preserved: a late fee row exists at most once per obligation; a waived or voided (removed) fee is not owed and is never
 * touched; an already-assessed active fee is reused. This function has NO fee-removal behaviour: an earlier received date that would
 * have avoided an already-assessed fee is refused (`feeAlreadyAssessed`), because removing it is undecided policy.
 *
 * Not in scope, on purpose: CRC-for-USD conversion (D1), prepaid or future months (D24), packages, signup, opening balances, reversals,
 * refunds, who may call it (D5), and a default backdating limit (D4: `maxBackdateDays` is a required parameter).
 *
 * A COLUMN-CAPACITY BOUNDARY THAT IS NOT A BUSINESS RULE: each obligation's amount and fee are individually bounded by their own
 * `Decimal(10,2)` columns, but a SUM of several is not, and neither is one obligation's tuition plus its own applicable late fee — both
 * can exceed what `DuesPayment.tenderAmount` (also `Decimal(10,2)`) can ever hold. When the OLDEST outstanding obligation's own amount
 * due already exceeds that, no payment can ever settle it (oldest-first admits no way past it), so this is refused explicitly
 * (`amountUnsupported`) before anything else is checked. No obligation is split, no fee is waived, no amount is clamped, and no schema
 * changes: an amount this large is a genuine gap, reported honestly. For a LATER total that would exceed it, the totals this writer
 * offers in a refusal (`selectableTotals`) simply stop before the first one that would not fit — an earlier, smaller, still-payable
 * prefix is never withheld because of what comes after it.
 */
export type AssessLateFeeError = "notActive" | "notFound" | "invalid";
/**
 * `feeId` and `owed` answer two different questions, deliberately kept separate: `feeId` is the fee ROW that exists for this
 * obligation, if any (created now, reused, or a waived/voided one found as-is) — the runner's own "was there already a fee
 * record here" question. `owed` is whether that fee is CURRENTLY active and chargeable — false for a waived or voided row
 * regardless of whether it would otherwise apply, and the one `recordDuesPayment` must use to decide `DuesSettlement.lateFeeId`
 * (which must reference an active fee or nothing, never a waived one).
 */
export type AssessLateFeeResult = { ok: true; feeId: string | null; owed: boolean; created: boolean } | { ok: false; error: AssessLateFeeError };

/**
 * Late-fee-assessment brief §6: the transaction-aware core `recordDuesPayment`'s own inline fee logic used to duplicate, extracted so
 * the (not-yet-built-here) proactive runner can share it. Trusts NOTHING from its caller except `obligationId`, `asOf` and `actorId` —
 * obligation, active-settlement and fee state are all re-read here, fresh, under the caller's already-held student lock, never accepted
 * as a snapshot. Repeats the activation check itself (the same lesson the monthly-generation PR's own review already applied to
 * `createMonthlyObligationInTx`): a caller that skips it gets refused here too.
 *
 * `asOf` is the date lateness is judged against — the caller's to supply, not a business fact to re-derive: the proactive runner passes
 * today (in the branch's timezone); `recordDuesPayment` passes the payment's own `receivedOn`, since a fee's lateness is judged by the
 * RECEIVED date of the settlement (`settlement.ts:37,56-58`), not by when this transaction happens to run.
 *
 * `settledOn` (fed into `lateFeeToAssessMinor`) comes from the obligation's active, UNREVERSED settlement's PAYMENT's `receivedOn` —
 * never `DuesSettlement.createdAt` or `DuesPayment.recordedAt` (both are row-creation instants, not the received date), and a reversed
 * settlement is excluded entirely (not an active payment for this purpose).
 */
export async function assessLateFeeInTx(
  tx: Tx,
  args: { context: TenantContext; obligationId: string; asOf: CalendarDate; actorId: string | null },
  deps: LedgerDeps = {},
): Promise<AssessLateFeeResult> {
  const { context, obligationId, asOf, actorId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };
  if (!isRealDate(asOf)) return { ok: false, error: "invalid" };

  const obligation = await tx.duesObligation.findFirst({
    where: { id: obligationId, organizationId, type: "MONTHLY" },
    select: { id: true, academyId: true, amount: true, currency: true, lateFeeAmount: true, graceDeadline: true, coverageYear: true, coverageMonth: true },
  });
  if (!obligation || !inTenantScope(context, obligation.academyId) || obligation.graceDeadline === null) return { ok: false, error: "notFound" };

  const activeSettlement = await tx.duesSettlement.findFirst({
    where: { organizationId, obligationId: obligation.id, reversedAt: null },
    select: { payment: { select: { receivedOn: true } } },
  });
  const settledOn = activeSettlement ? fromDbDate(activeSettlement.payment.receivedOn) : null;

  const existingFee = await tx.duesLateFee.findFirst({ where: { organizationId, obligationId: obligation.id }, select: { id: true, removedAt: true } });
  if (existingFee) return { ok: true, feeId: existingFee.id, owed: existingFee.removedAt === null, created: false };

  const graceDeadline = fromDbDate(obligation.graceDeadline);
  const owedMinor = lateFeeToAssessMinor(
    {
      id: obligation.id,
      coverage: { year: obligation.coverageYear, month: obligation.coverageMonth },
      currency: obligation.currency,
      tuitionMinor: columnToMinor(obligation.amount),
      lateFeeMinor: obligation.lateFeeAmount === null ? 0 : columnToMinor(obligation.lateFeeAmount),
      graceDeadline,
      settledOn,
    },
    asOf,
  );
  if (owedMinor === 0) return { ok: true, feeId: null, owed: false, created: false };

  const assessable = feeAssessableFrom(graceDeadline);
  try {
    const fee = await tx.duesLateFee.create({ data: { organizationId, obligationId: obligation.id, assessableFrom: toDbDate(assessable) } });
    await tx.auditLog.create({
      data: {
        actorId, organizationId, academyId: obligation.academyId, action: "duesLateFee.assess", entityType: "DuesLateFee", entityId: fee.id,
        before: Prisma.DbNull, after: { obligationId: obligation.id, assessableFrom: ymd(assessable), amount: minorToDecimal(owedMinor), currency: obligation.currency },
      },
    });
    return { ok: true, feeId: fee.id, owed: true, created: true };
  } catch (error) {
    // Under the caller's held student lock this create-if-not-exists window shouldn't lose a race — DuesLateFee_obligationId_key is a
    // backstop for "somehow it still did." Identify it specifically (never assume every P2002 here means this): re-read the row a
    // concurrent call just won the race to create, and return it exactly as if this call had found it existing in the first place.
    // Any other error — including a P2002 on a different constraint — is genuinely unexpected and must not be absorbed here.
    if (isUniqueViolationOn(error, "DuesLateFee")) {
      const wonByOther = await tx.duesLateFee.findFirst({ where: { organizationId, obligationId: obligation.id }, select: { id: true, removedAt: true } });
      if (wonByOther) return { ok: true, feeId: wonByOther.id, owed: wonByOther.removedAt === null, created: false };
    }
    throw error;
  }
}

export type RecordDuesPaymentError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "futureDate"
  | "tooOld"
  | "alreadySettled"
  | "notOldestFirst"
  | "currencyMismatch"
  | "notASelectableTotal"
  | "totalMismatch"
  | "feeAlreadyAssessed"
  | "amountUnsupported"
  | "conflict";

export type RecordDuesPaymentResult =
  | { ok: true; paymentId: string; settlementIds: string[]; feeIds: string[]; totalMinor: number }
  | { ok: false; error: RecordDuesPaymentError; selectableTotals?: string[]; alreadySettledIds?: string[] };

const MAX_SELECTED = 60;
const MAX_BACKDATE_DAYS = 3660;
const MAX_NOTES = 500;

const refuse = (error: RecordDuesPaymentError, extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {}): RecordDuesPaymentResult => ({ ok: false, error, ...extra });
const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/**
 * The running totals, oldest first, this writer could actually offer for a refusal message: at most `MAX_SELECTED` obligations, and only
 * while the cumulative amount still fits `Decimal(10,2)` (`MAX_MINOR_UNITS`). Stops at the first count or amount it cannot represent — a
 * later, larger total is simply never offered; it never withholds an earlier, still-payable prefix.
 */
function selectablePrefixTotals(items: readonly { amountMinor: number }[]): string[] {
  const totals: string[] = [];
  let running = 0;
  for (let i = 0; i < items.length && i < MAX_SELECTED; i++) {
    running += items[i].amountMinor;
    if (running > MAX_MINOR_UNITS) break;
    totals.push(minorToDecimal(running));
  }
  return totals;
}

export async function recordDuesPayment(
  args: {
    context: TenantContext;
    studentId: string;
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    /** The obligations this payment settles, chosen explicitly. Never recomputed. */
    obligationIds: string[];
    notes?: string;
    /** How many days before today the received date may be. Required; no default (decision D4 is pending). */
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<RecordDuesPaymentResult> {
  const { context, studentId, receivedOn, tender, method, obligationIds, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");

  // ---- input validation (no database access) ----
  if (typeof studentId !== "string" || studentId === "") return refuse("invalid");
  if (!Array.isArray(obligationIds) || obligationIds.length < 1 || obligationIds.length > MAX_SELECTED) return refuse("invalid");
  if (obligationIds.some((id) => typeof id !== "string" || id === "") || new Set(obligationIds).size !== obligationIds.length) return refuse("invalid");
  if (!(CURRENCIES as readonly string[]).includes(tender?.currency)) return refuse("invalid");
  const parsedAmount = parseMoney(tender.amount, { allowZero: false });
  if (!parsedAmount.ok) return refuse("invalid");
  const tenderMinor = decimalToMinor(parsedAmount.value);
  if (!(Object.values(PaymentMethod) as string[]).includes(method)) return refuse("invalid");
  if (!receivedOn || !isRealDate(receivedOn)) return refuse("invalid");
  if (!Number.isInteger(maxBackdateDays) || maxBackdateDays < 0 || maxBackdateDays > MAX_BACKDATE_DAYS) return refuse("invalid");
  if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTES)) return refuse("invalid");

  // Re-read the student scoped to the organization; a forged or foreign id is `notFound`, never trusted.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  try {
    return await prisma.$transaction(async (tx): Promise<RecordDuesPaymentResult> => {
      // The student row FOR UPDATE serializes every ledger write for this student. This path reads only the obligations' immutable
      // snapshots, so it needs no configuration lock.
      const locked = await lockStudent(tx, organizationId, student.id);
      if (!locked || locked.homeAcademyId !== student.homeAcademyId) return refuse("conflict");
      const branch = await tx.academy.findFirst({ where: { id: student.homeAcademyId, organizationId }, select: { timezone: true } });
      if (!branch) return refuse("notFound");

      const today = todayIn(branch.timezone, (deps.now ?? (() => new Date()))());
      if (compareDates(receivedOn, today) > 0) return refuse("futureDate");
      if (compareDates(receivedOn, minusDays(today, maxBackdateDays)) < 0) return refuse("tooOld");

      // ---- load, then validate. NOTHING is written until every check below has passed. ----
      const all = await tx.duesObligation.findMany({
        where: { organizationId, studentId: student.id, type: "MONTHLY" },
        include: { lateFees: true, settlements: { where: { reversedAt: null }, select: { id: true } } },
      });
      const byId = new Map(all.map((o) => [o.id, o]));
      const selected = obligationIds.map((id) => byId.get(id));
      // an unknown id, another student's, another organization's, or a non-monthly one: all look the same, and nothing is revealed
      if (selected.some((o) => o === undefined)) return refuse("notFound");
      const chosen = selected as NonNullable<(typeof selected)[number]>[];

      // A replay (a lost response resent) finds its own obligations already settled: refused, never re-applied to later months.
      const settledIds = chosen.filter((o) => o.settlements.length > 0).map((o) => o.id);
      if (settledIds.length > 0) return refuse("alreadySettled", { alreadySettledIds: settledIds });

      const open = all.filter((o) => o.settlements.length === 0);
      const asTerms = (o: (typeof all)[number]): ObligationTerms => {
        if (o.graceDeadline === null) throw new Error(`Monthly obligation ${o.id} has no grace deadline`);
        const removed = o.lateFees[0]?.removedAt != null;
        return {
          id: o.id,
          coverage: { year: o.coverageYear, month: o.coverageMonth },
          currency: o.currency,
          tuitionMinor: columnToMinor(o.amount),
          // a waived or voided fee is not owed: preserved as it is, never re-charged
          lateFeeMinor: removed || o.lateFeeAmount === null ? 0 : columnToMinor(o.lateFeeAmount),
          graceDeadline: fromDbDate(o.graceDeadline),
        };
      };
      const openTerms = open.map(asTerms);

      // Oldest first, and the chosen ids must be exactly the first k outstanding: nothing older may be skipped.
      const ordered = orderOldestFirst(openTerms.map((t) => ({ id: t.id, coverage: t.coverage })));
      const firstK = ordered.slice(0, chosen.length).map((t) => t.id);
      const chosenIds = new Set(chosen.map((o) => o.id));
      if (firstK.length !== chosen.length || !firstK.every((id) => chosenIds.has(id))) return refuse("notOldestFirst");

      // Fee state of the chosen obligations. An active fee already assessed cannot be removed by an earlier received date here.
      const termsById = new Map(openTerms.map((t) => [t.id, t]));
      const feeOwed = new Map<string, boolean>();
      for (const o of chosen) {
        const t = termsById.get(o.id)!;
        const late = lateFeeApplies(receivedOn, t.graceDeadline);
        const feeRow = o.lateFees[0] ?? null;
        const removed = feeRow?.removedAt != null;
        if (!late && feeRow && !removed) return refuse("feeAlreadyAssessed");
        feeOwed.set(o.id, late && t.lateFeeMinor > 0);
      }

      // The exact total: the tender must equal the running total of the first k obligations at their amount due on the received date,
      // in one currency (PR 1's validator), AND that k must be the number of obligations the caller chose.
      const items = outstandingItems(openTerms, receivedOn);

      // The oldest outstanding obligation's own amount due can itself exceed what a payment column can hold (tuition plus its own
      // applicable fee, each individually in range, summed). Oldest-first admits no way to settle anything while it stands, so this is
      // refused explicitly here — before the totals below are even built — never split, waived or clamped.
      if (items.length > 0 && items[0].amountMinor > MAX_MINOR_UNITS) return refuse("amountUnsupported");

      const result = settleReceipt(items, tenderMinor, tender.currency);
      if (!result.ok) {
        return result.reason === "CURRENCY_MISMATCH" ? refuse("currencyMismatch") : refuse("notASelectableTotal", { selectableTotals: selectablePrefixTotals(items) });
      }
      if (result.settledIds.length !== chosen.length || !result.settledIds.every((id) => chosenIds.has(id))) {
        return refuse("totalMismatch", { selectableTotals: selectablePrefixTotals(items) });
      }

      // ---- every check passed: write, atomically ----
      const settlementOrder = chosen.slice().sort((x, y) => firstK.indexOf(x.id) - firstK.indexOf(y.id));
      const feeIds: string[] = [];
      const lateFeeFor = new Map<string, string | null>();
      for (const o of settlementOrder) {
        // assessLateFeeInTx re-reads obligation/settlement/fee state itself, fresh, under this same lock — it does not trust the
        // `feeOwed`/`o.lateFees` snapshot validation already computed above. `asOf: receivedOn`: lateness is judged by the RECEIVED
        // date of THIS settlement, not by whatever the real clock reads while this transaction happens to run.
        const assessed = await assessLateFeeInTx(tx, { context, obligationId: o.id, asOf: receivedOn, actorId: context.actorUserId }, deps);
        // Under this held lock, re-reading the same data validation already read cannot disagree — but if it somehow ever does, abort
        // the whole transaction rather than commit a settlement whose lateFeeId doesn't match what was actually decided.
        if (!assessed.ok) throw new Error(`assessLateFeeInTx unexpectedly refused (${assessed.error}) for obligation ${o.id} inside an already-validated payment`);
        const expectedOwed = feeOwed.get(o.id) ?? false;
        if (expectedOwed !== assessed.owed) {
          throw new Error(`assessLateFeeInTx's fresh read disagreed with recordDuesPayment's own validated fee state for obligation ${o.id}`);
        }
        if (assessed.created && assessed.feeId) feeIds.push(assessed.feeId);
        // lateFeeId references an ACTIVE fee only — never a waived/voided one, even if assessLateFeeInTx found that row (its
        // `feeId` answers "does a fee row exist," not "is it owed"; `owed` is the one this decision actually turns on).
        lateFeeFor.set(o.id, assessed.owed ? assessed.feeId : null);
      }

      const payment = await tx.duesPayment.create({
        data: {
          organizationId, studentId: student.id, academyId: student.homeAcademyId, receivedOn: toDbDate(receivedOn), tenderCurrency: tender.currency,
          tenderAmount: parsedAmount.value, method, recordedById: context.actorUserId, notes: notes && notes.trim() !== "" ? notes.trim() : null,
        },
      });
      const settlementIds: string[] = [];
      for (const o of settlementOrder) {
        const settlement = await tx.duesSettlement.create({
          data: { organizationId, studentId: student.id, paymentId: payment.id, obligationId: o.id, lateFeeId: lateFeeFor.get(o.id) ?? null },
        });
        settlementIds.push(settlement.id);
      }
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId, organizationId, academyId: student.homeAcademyId, action: "duesPayment.record", entityType: "DuesPayment", entityId: payment.id,
          before: Prisma.DbNull,
          after: {
            studentId: student.id, receivedOn: ymd(receivedOn), tenderCurrency: tender.currency, tenderAmount: parsedAmount.value, method,
            obligations: settlementOrder.map((o) => ({ obligationId: o.id, lateFeeId: lateFeeFor.get(o.id) ?? null })),
          },
        },
      });
      return { ok: true, paymentId: payment.id, settlementIds, feeIds, totalMinor: tenderMinor };
    });
  } catch (error) {
    // P2002 is not one thing: DuesSettlement's partial unique index (the one-active-settlement-per-obligation backstop behind the
    // student lock — a replay, not a crash) is the expected one here. A DuesLateFee collision is already handled inside
    // assessLateFeeInTx itself and should never reach this catch — if it somehow still does, that is a real anomaly this lock
    // discipline was supposed to prevent, reported as `conflict` (the same code createMonthlyObligationInTx uses for its own
    // "moved branches while we waited" case), not mislabeled as a settlement replay. Anything else is genuinely unexpected and must
    // be re-thrown, never silently absorbed into either label.
    if (isUniqueViolationOn(error, "DuesSettlement")) return refuse("alreadySettled");
    if (isUniqueViolationOn(error, "DuesLateFee")) return refuse("conflict");
    throw error;
  }
}
