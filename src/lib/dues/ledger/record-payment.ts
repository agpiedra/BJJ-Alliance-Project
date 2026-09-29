import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { compareDates, type CalendarDate } from "@/lib/dues/calendar";
import { parseMoney } from "@/lib/dues/config-input";
import { amountDueMinor, feeAssessableFrom, lateFeeApplies, lateFeeToAssessMinor, orderOldestFirst, outstandingItems, settleReceipt, type ObligationTerms, type SettlementItem } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { fromDbDate, inTenantScope, isRealDate, lockStudent, minusDays, todayIn, toDbDate, type Tx } from "@/lib/dues/ledger/common";
import { MAX_MINOR_UNITS, columnToMinor, decimalToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";
import { isUniqueViolationOnConstraint } from "@/lib/dues/ledger/unique-violation";
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
  // Corrected: a caught P2002 cannot be recovered from with a follow-up query in the SAME transaction — Postgres aborts a
  // transaction the instant any statement inside it fails, and every later statement (even a plain SELECT) then fails too with
  // "current transaction is aborted" until a ROLLBACK. `ON CONFLICT DO NOTHING` never throws for the race it targets in the first
  // place, so there is nothing to recover from: it either wins (a row comes back) or loses (nothing comes back, no exception,
  // transaction fully healthy either way) — proven against a real duplicate insert, not assumed. `id` is generated here, not left
  // to a DB default, because Prisma's `@default(cuid())` is applied client-side, not by the column itself.
  if (deps.beforeLateFeeInsert) await deps.beforeLateFeeInsert(obligation.id);
  const newId = crypto.randomUUID();
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "DuesLateFee" ("id", "organizationId", "obligationId", "assessableFrom")
    VALUES (${newId}, ${organizationId}, ${obligation.id}, ${toDbDate(assessable)})
    ON CONFLICT ("obligationId") DO NOTHING
    RETURNING "id"
  `;
  if (inserted.length > 0) {
    const feeId = inserted[0].id;
    await tx.auditLog.create({
      data: {
        actorId, organizationId, academyId: obligation.academyId, action: "duesLateFee.assess", entityType: "DuesLateFee", entityId: feeId,
        before: Prisma.DbNull, after: { obligationId: obligation.id, assessableFrom: ymd(assessable), amount: minorToDecimal(owedMinor), currency: obligation.currency },
      },
    });
    return { ok: true, feeId, owed: true, created: true };
  }
  // Lost the race: no row was inserted, nothing threw, the transaction is fully usable. A plain read finds the winner's row.
  const wonByOther = await tx.duesLateFee.findFirst({ where: { organizationId, obligationId: obligation.id }, select: { id: true, removedAt: true } });
  if (!wonByOther) {
    throw new Error(`DuesLateFee insert conflicted for obligation ${obligation.id} but no row was found immediately after — impossible under ON CONFLICT DO NOTHING`);
  }
  return { ok: true, feeId: wonByOther.id, owed: wonByOther.removedAt === null, created: false };
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
 * Package-purchase brief §5: one thing this writer's shared settlement core settles, already priced and ordered by its
 * caller. `feeEligible` is true only for a `MONTHLY` item that should go through `assessLateFeeInTx`; a package item is
 * never fee-eligible (packages structurally cannot carry a late fee — `DuesObligation_shape_by_type`).
 */
export type SettlementLineItem = { obligationId: string; currency: Currency; amountMinor: number; feeEligible: boolean };

/**
 * The running totals, oldest first, this writer could actually offer for a refusal message: at most `MAX_SELECTED` obligations, and only
 * while the cumulative amount still fits `Decimal(10,2)` (`MAX_MINOR_UNITS`). Stops at the first count or amount it cannot represent — a
 * later, larger total is simply never offered; it never withholds an earlier, still-payable prefix.
 */
export function selectablePrefixTotals(items: readonly { amountMinor: number }[]): string[] {
  const totals: string[] = [];
  let running = 0;
  for (let i = 0; i < items.length && i < MAX_SELECTED; i++) {
    running += items[i].amountMinor;
    if (running > MAX_MINOR_UNITS) break;
    totals.push(minorToDecimal(running));
  }
  return totals;
}

/**
 * Late-fee-correction brief §2: the same format checks the public wrapper below already ran, extracted so `recordDuesPaymentInTx`
 * can re-run them itself for a direct caller (the correction writer) that bypasses the wrapper entirely — one validator, not two
 * copies that could drift apart. Does not validate `studentId`/tenant scope; those depend on what shape the student arrives in at
 * each call site (a raw id for the wrapper, an already-resolved row for a direct caller) and are checked separately at each site.
 */
function validatePaymentInput(input: {
  receivedOn: CalendarDate;
  tender: { currency: Currency; amount: string };
  method: PaymentMethod;
  obligationIds: string[];
  notes?: string;
  maxBackdateDays: number;
}): RecordDuesPaymentError | null {
  if (!Array.isArray(input.obligationIds) || input.obligationIds.length < 1 || input.obligationIds.length > MAX_SELECTED) return "invalid";
  if (input.obligationIds.some((id) => typeof id !== "string" || id === "") || new Set(input.obligationIds).size !== input.obligationIds.length) return "invalid";
  if (!(CURRENCIES as readonly string[]).includes(input.tender?.currency)) return "invalid";
  if (!parseMoney(input.tender.amount, { allowZero: false }).ok) return "invalid";
  if (!(Object.values(PaymentMethod) as string[]).includes(input.method)) return "invalid";
  if (!input.receivedOn || !isRealDate(input.receivedOn)) return "invalid";
  if (!Number.isInteger(input.maxBackdateDays) || input.maxBackdateDays < 0 || input.maxBackdateDays > MAX_BACKDATE_DAYS) return "invalid";
  if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > MAX_NOTES)) return "invalid";
  return null;
}

/**
 * Package-purchase brief §5: `recordDuesPaymentInTx`'s own "load every open `MONTHLY` obligation, validate the caller's
 * chosen ids are exactly the oldest-first prefix, refuse a re-chargeable `feeAlreadyAssessed` case" logic, extracted so the
 * package writer can validate ITS OWN named current-debt ids the identical way — not a second, drifting copy of this
 * validation. Returns two things: `chosenItems` (only the caller's own ids, in settlement order, each already priced) for a
 * caller building its own combined item list (the package writer appends its package item after these); `allOpenItems`
 * (every open `MONTHLY` obligation, oldest first) for a caller that offers `settleReceipt` totals against the FULL picture,
 * not just what was chosen (`recordDuesPaymentInTx`'s own, unchanged behavior).
 */
export type ResolveMonthlyDebtResult =
  | { ok: true; chosenItems: SettlementLineItem[]; allOpenItems: SettlementItem[] }
  | { ok: false; error: "notFound" | "alreadySettled" | "notOldestFirst" | "feeAlreadyAssessed"; alreadySettledIds?: string[] };

export async function resolveMonthlyDebtItemsInTx(
  tx: Tx,
  args: { organizationId: string; studentId: string; obligationIds: string[]; receivedOn: CalendarDate },
): Promise<ResolveMonthlyDebtResult> {
  const { organizationId, studentId, obligationIds, receivedOn } = args;
  const all = await tx.duesObligation.findMany({
    where: { organizationId, studentId, type: "MONTHLY" },
    include: { lateFees: true, settlements: { where: { reversedAt: null }, select: { id: true } } },
  });
  const byId = new Map(all.map((o) => [o.id, o]));
  const selected = obligationIds.map((id) => byId.get(id));
  // an unknown id, another student's, another organization's, or a non-monthly one: all look the same, and nothing is revealed
  if (selected.some((o) => o === undefined)) return { ok: false, error: "notFound" };
  const chosen = selected as NonNullable<(typeof selected)[number]>[];

  // A replay (a lost response resent) finds its own obligations already settled: refused, never re-applied to later months.
  const settledIds = chosen.filter((o) => o.settlements.length > 0).map((o) => o.id);
  if (settledIds.length > 0) return { ok: false, error: "alreadySettled", alreadySettledIds: settledIds };

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
  if (firstK.length !== chosen.length || !firstK.every((id) => chosenIds.has(id))) return { ok: false, error: "notOldestFirst" };

  // Fee state of the chosen obligations. An active fee already assessed cannot be removed by an earlier received date here.
  const termsById = new Map(openTerms.map((t) => [t.id, t]));
  for (const o of chosen) {
    const t = termsById.get(o.id)!;
    const late = lateFeeApplies(receivedOn, t.graceDeadline);
    const feeRow = o.lateFees[0] ?? null;
    const removed = feeRow?.removedAt != null;
    if (!late && feeRow && !removed) return { ok: false, error: "feeAlreadyAssessed" };
  }

  const allOpenItems = outstandingItems(openTerms, receivedOn);
  const settlementOrder = chosen.slice().sort((x, y) => firstK.indexOf(x.id) - firstK.indexOf(y.id));
  const chosenItems: SettlementLineItem[] = settlementOrder.map((o) => {
    const t = termsById.get(o.id)!;
    return { obligationId: o.id, currency: t.currency, amountMinor: amountDueMinor(t, receivedOn), feeEligible: true };
  });
  return { ok: true, chosenItems, allOpenItems };
}

/**
 * Package-purchase brief §5: `recordDuesPaymentInTx`'s own final write ("every check passed: write, atomically") — assess a
 * fee per fee-eligible item, create the payment, one settlement per item, and the audit row — extracted so the package
 * writer can settle its OWN combined list (current debt, plus exactly one package item, never fee-eligible) through the
 * identical write path, rather than a second, duplicated one. Assumes every validation has already passed: it does not
 * re-run `settleReceipt` or any oldest-first/currency/total check itself — the caller decides `settledItems`, already
 * ordered, already exactly what is being settled.
 */
export async function writeSettlementInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    student: { id: string; homeAcademyId: string };
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    settledItems: SettlementLineItem[];
  },
  deps: LedgerDeps = {},
): Promise<{ paymentId: string; settlementIds: string[]; feeIds: string[] }> {
  const { context, student, receivedOn, tender, method, notes, settledItems } = args;
  const organizationId = context.organizationId;

  const feeIds: string[] = [];
  const lateFeeFor = new Map<string, string | null>();
  for (const item of settledItems) {
    if (item.feeEligible) {
      // assessLateFeeInTx re-reads obligation/settlement/fee state itself, fresh, under this same lock — it does not trust
      // whatever validation already read. asOf: receivedOn — lateness is judged by the RECEIVED date of THIS settlement.
      const assessed = await assessLateFeeInTx(tx, { context, obligationId: item.obligationId, asOf: receivedOn, actorId: context.actorUserId }, deps);
      if (!assessed.ok) throw new Error(`assessLateFeeInTx unexpectedly refused (${assessed.error}) for obligation ${item.obligationId} inside an already-validated payment`);
      if (assessed.created && assessed.feeId) feeIds.push(assessed.feeId);
      // lateFeeId references an ACTIVE fee only — never a waived/voided one.
      lateFeeFor.set(item.obligationId, assessed.owed ? assessed.feeId : null);
    } else {
      lateFeeFor.set(item.obligationId, null);
    }
  }

  const parsedAmount = parseMoney(tender.amount, { allowZero: false });
  if (!parsedAmount.ok) throw new Error(`writeSettlementInTx received an unparseable tender amount after the caller's own validation: ${tender.amount}`);

  const payment = await tx.duesPayment.create({
    data: {
      organizationId, studentId: student.id, academyId: student.homeAcademyId, receivedOn: toDbDate(receivedOn), tenderCurrency: tender.currency,
      tenderAmount: parsedAmount.value, method, recordedById: context.actorUserId, notes: notes && notes.trim() !== "" ? notes.trim() : null,
    },
  });
  const settlementIds: string[] = [];
  for (const item of settledItems) {
    const settlement = await tx.duesSettlement.create({
      data: { organizationId, studentId: student.id, paymentId: payment.id, obligationId: item.obligationId, lateFeeId: lateFeeFor.get(item.obligationId) ?? null },
    });
    settlementIds.push(settlement.id);
  }
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId, organizationId, academyId: student.homeAcademyId, action: "duesPayment.record", entityType: "DuesPayment", entityId: payment.id,
      before: Prisma.DbNull,
      after: {
        studentId: student.id, receivedOn: ymd(receivedOn), tenderCurrency: tender.currency, tenderAmount: parsedAmount.value, method,
        obligations: settledItems.map((item) => ({ obligationId: item.obligationId, lateFeeId: lateFeeFor.get(item.obligationId) ?? null })),
      },
    },
  });
  return { paymentId: payment.id, settlementIds, feeIds };
}

/**
 * Late-fee-correction brief §2: `recordDuesPayment`'s validate-then-write transaction body, extracted so the correction writer can
 * compose it inside its own already-open transaction (which has already voided a fee and needs the settlement in the SAME
 * transaction) instead of nesting a second `prisma.$transaction` inside the first — the exact composition mistake found and
 * reverted earlier this session. Trusts nothing from its caller: repeats the activation check, re-validates input format, and
 * re-checks `inTenantScope` on the given `student` even though it arrives pre-resolved — the same "trust nothing" discipline
 * `createMonthlyObligationInTx`/`assessLateFeeInTx` already apply, extended here to the largest of the four extractions this
 * session. `P2002` classification is NOT handled here — a caller that opens the transaction must catch it, since this function
 * never calls `prisma.$transaction` itself (see `classifyRecordPaymentError`, reused by both this file's own public wrapper and
 * the correction writer).
 */
export async function recordDuesPaymentInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    student: { id: string; homeAcademyId: string };
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    obligationIds: string[];
    notes?: string;
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<RecordDuesPaymentResult> {
  const { context, student, receivedOn, tender, method, obligationIds, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  const inputError = validatePaymentInput({ receivedOn, tender, method, obligationIds, notes, maxBackdateDays });
  if (inputError) return refuse(inputError);
  if (typeof student?.id !== "string" || student.id === "" || typeof student?.homeAcademyId !== "string" || student.homeAcademyId === "") return refuse("invalid");
  if (!inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  const parsedAmount = parseMoney(tender.amount, { allowZero: false });
  if (!parsedAmount.ok) return refuse("invalid"); // re-validated above; narrows the type for the write below
  const tenderMinor = decimalToMinor(parsedAmount.value);

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
  const debtResult = await resolveMonthlyDebtItemsInTx(tx, { organizationId, studentId: student.id, obligationIds, receivedOn });
  if (!debtResult.ok) return refuse(debtResult.error, { alreadySettledIds: debtResult.alreadySettledIds });
  const { chosenItems, allOpenItems } = debtResult;
  const chosenIds = new Set(chosenItems.map((i) => i.obligationId));

  // The oldest outstanding obligation's own amount due can itself exceed what a payment column can hold (tuition plus its own
  // applicable fee, each individually in range, summed). Oldest-first admits no way to settle anything while it stands, so this is
  // refused explicitly here — before the totals below are even built — never split, waived or clamped.
  if (allOpenItems.length > 0 && allOpenItems[0].amountMinor > MAX_MINOR_UNITS) return refuse("amountUnsupported");

  // The exact total: the tender must equal the running total of the first k obligations at their amount due on the received date,
  // in one currency (PR 1's validator), AND that k must be the number of obligations the caller chose. Offered against every open
  // obligation (not just the chosen ones), so a caller who under-selects still gets useful selectableTotals.
  const result = settleReceipt(allOpenItems, tenderMinor, tender.currency);
  if (!result.ok) {
    return result.reason === "CURRENCY_MISMATCH" ? refuse("currencyMismatch") : refuse("notASelectableTotal", { selectableTotals: selectablePrefixTotals(allOpenItems) });
  }
  if (result.settledIds.length !== chosenItems.length || !result.settledIds.every((id) => chosenIds.has(id))) {
    return refuse("totalMismatch", { selectableTotals: selectablePrefixTotals(allOpenItems) });
  }

  // ---- every check passed: write, atomically ----
  const written = await writeSettlementInTx(tx, { context, student, receivedOn, tender, method, notes, settledItems: chosenItems }, deps);
  return { ok: true, paymentId: written.paymentId, settlementIds: written.settlementIds, feeIds: written.feeIds, totalMinor: tenderMinor };
}

/**
 * `recordDuesPaymentInTx`'s only failure mode that isn't a typed refusal: a `P2002` thrown from inside its own transaction, which
 * only ever reaches a CALLER of `prisma.$transaction` (this function is never inside one itself). Not one thing: identify the
 * CONSTRAINT, not the table (a table can have more than one unique index — this schema's own `DuesLateFee` does). Returns `null`
 * for anything unrecognized — including a PK collision or the composite `DuesLateFee_organizationId_id_obligationId_key` — so the
 * caller re-throws it, never silently absorbing a genuinely unexpected error into either label below.
 */
export function classifyRecordPaymentError(error: unknown): RecordDuesPaymentResult | null {
  // DuesSettlement's partial unique index (the one-active-settlement-per-obligation backstop behind the student lock — a replay,
  // not a crash) is the expected one here.
  if (isUniqueViolationOnConstraint(error, "DuesSettlement_one_active_per_obligation_key")) return refuse("alreadySettled");
  // DuesLateFee_obligationId_key is kept here as a documented, unreachable backstop, not live code: assessLateFeeInTx no longer
  // performs an unprotected insert that could violate it (it uses `INSERT ... ON CONFLICT DO NOTHING`, which cannot throw for this
  // constraint), so this branch has no path to it today. Left in deliberately, matching this codebase's existing precedent of a
  // documented defensive check with no live path (eligibility.ts's branch-scope check, 5.4) — if a future change ever reintroduces
  // an unprotected insert somewhere in this transaction, this is what stops it from being misreported as `alreadySettled`.
  if (isUniqueViolationOnConstraint(error, "DuesLateFee_obligationId_key")) return refuse("conflict");
  return null;
}

/**
 * Record ONE payment and its settlements, atomically (ledger writer 2 of 2, PR 4a) — a thin wrapper. Its own
 * pre-transaction checks (activation, format validation, the student lookup) are unchanged from before this function's transaction
 * body was extracted into `recordDuesPaymentInTx`, above; it then opens one transaction and delegates to that function, which
 * repeats every one of these checks itself for a caller that reaches it directly (the late-fee-correction writer composes it
 * inside its own transaction, never through this wrapper).
 */
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

  if (typeof studentId !== "string" || studentId === "") return refuse("invalid");
  const inputError = validatePaymentInput({ receivedOn, tender, method, obligationIds, notes, maxBackdateDays });
  if (inputError) return refuse(inputError);

  // Re-read the student scoped to the organization; a forged or foreign id is `notFound`, never trusted.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  try {
    return await prisma.$transaction((tx) => recordDuesPaymentInTx(tx, { context, student, receivedOn, tender, method, obligationIds, notes, maxBackdateDays }, deps));
  } catch (error) {
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified;
    throw error;
  }
}
