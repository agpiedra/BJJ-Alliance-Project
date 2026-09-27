import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { compareDates, type CalendarDate } from "@/lib/dues/calendar";
import { parseMoney } from "@/lib/dues/config-input";
import { feeAssessableFrom, lateFeeApplies, orderOldestFirst, outstandingItems, settleReceipt, type ObligationTerms } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { fromDbDate, inTenantScope, isRealDate, lockStudent, minusDays, todayIn, toDbDate } from "@/lib/dues/ledger/common";
import { columnToMinor, decimalToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";
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
 */
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
  | "conflict";

export type RecordDuesPaymentResult =
  | { ok: true; paymentId: string; settlementIds: string[]; feeIds: string[]; totalMinor: number }
  | { ok: false; error: RecordDuesPaymentError; selectableTotals?: string[]; alreadySettledIds?: string[] };

const MAX_SELECTED = 60;
const MAX_BACKDATE_DAYS = 3660;
const MAX_NOTES = 500;

const refuse = (error: RecordDuesPaymentError, extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {}): RecordDuesPaymentResult => ({ ok: false, error, ...extra });
const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

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
      const result = settleReceipt(items, tenderMinor, tender.currency);
      if (!result.ok) {
        return result.reason === "CURRENCY_MISMATCH"
          ? refuse("currencyMismatch")
          : refuse("notASelectableTotal", { selectableTotals: result.selectableTotalsMinor.map(minorToDecimal) });
      }
      if (result.settledIds.length !== chosen.length || !result.settledIds.every((id) => chosenIds.has(id))) {
        return refuse("totalMismatch", { selectableTotals: items.map((_, i) => minorToDecimal(items.slice(0, i + 1).reduce((sum, item) => sum + item.amountMinor, 0))) });
      }

      // ---- every check passed: write, atomically ----
      const settlementOrder = chosen.slice().sort((x, y) => firstK.indexOf(x.id) - firstK.indexOf(y.id));
      const feeIds: string[] = [];
      const lateFeeFor = new Map<string, string | null>();
      for (const o of settlementOrder) {
        if (!feeOwed.get(o.id)) {
          lateFeeFor.set(o.id, null);
          continue;
        }
        const existingFee = o.lateFees[0] ?? null;
        if (existingFee) {
          lateFeeFor.set(o.id, existingFee.id); // reuse the one active fee row
          continue;
        }
        const t = termsById.get(o.id)!;
        const assessable = feeAssessableFrom(t.graceDeadline);
        const fee = await tx.duesLateFee.create({ data: { organizationId, obligationId: o.id, assessableFrom: toDbDate(assessable) } });
        await tx.auditLog.create({
          data: {
            actorId: context.actorUserId, organizationId, academyId: student.homeAcademyId, action: "duesLateFee.assess", entityType: "DuesLateFee", entityId: fee.id,
            before: Prisma.DbNull, after: { obligationId: o.id, assessableFrom: ymd(assessable), amount: minorToDecimal(t.lateFeeMinor), currency: o.currency },
          },
        });
        feeIds.push(fee.id);
        lateFeeFor.set(o.id, fee.id);
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
    // The one-active-settlement index is the backstop behind the student lock: losing that race is a replay, not a crash.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return refuse("alreadySettled");
    throw error;
  }
}
