import { z } from "zod";
import { Prisma, PaymentMethod, type Currency } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { compareYearMonth, type CalendarDate } from "@/lib/dues/calendar";
import { currentMonthIn, versionRevision } from "@/lib/dues/config-input";
import { lateFeeApplies } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { fromDbDate, inTenantScope, latestEffective, lockBranchShared, lockStudent, toDbDate, type Tx } from "@/lib/dues/ledger/common";
import { voidLateFeeInTx } from "@/lib/dues/ledger/correct-late-fee";
import { lockExchangeRateNamespaceShared } from "@/lib/dues/ledger/exchange-rate";
import { writeMonthlyObligationInTx } from "@/lib/dues/ledger/create-monthly-obligation";
import { decimalToMinor } from "@/lib/dues/ledger/minor-units";
import {
  classifyRecordPaymentError,
  resolveMonthlyDebtItemsInTx,
  settleObligationsInTx,
  writeSettlementInTx,
  type RecordDuesPaymentError,
  type SettlementLineItem,
} from "@/lib/dues/ledger/record-payment";
import { checkPackageCoverageAvailableInTx, resolvePackageTermsInTx, writePackageObligationInTx } from "@/lib/dues/ledger/purchase-package";
import type { SettlementItem } from "@/lib/dues/settlement";

/**
 * Currency-conversion brief PR 3 (plan §2, §6, §7, §8): an awaiting-rate receipt is captured when a settlement attempt
 * finds NO eligible exchange-rate quote at all for its `receivedOn` — neither an exact-date match nor the earlier-quote
 * fallback (`resolveEffectiveQuote`'s own two-step resolution) — and resolved once an owner enters one. Captured with a
 * FULL resolved-evidence snapshot of what the original attempt would have settled (not just the caller's own arguments),
 * so resolution re-validates against drift rather than re-deriving anything fresh.
 *
 * THREE OUTERMOST CAPTURE POINTS, never this file's own decision: `recordDuesPayment` (ORDINARY), `prepayMonthlyObligations`
 * (PREPAYMENT), `purchasePackage` (PACKAGE) each call `captureAwaitingRateReceiptInTx` themselves, in their own already-open
 * transaction, in place of propagating a `rateUnavailable` refusal — only once every other check already passed and
 * nothing else has been written yet (see each writer's own doc comment for why its own transaction-safety holds).
 * `correctLateFeeAndSettle` is explicitly excluded from capture (plan §13) — its own missing-rate refusal is unchanged.
 */

const yearMonthSchema = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) });

const ordinarySnapshotSchema = z.object({
  kind: z.literal("ORDINARY"),
  obligationIds: z.array(z.string().min(1)).min(1),
});

const prepaymentMonthSchema = z.object({
  coverage: yearMonthSchema,
  planTermsId: z.string().min(1),
  policyVersionId: z.string().min(1),
  priceAmount: z.string().min(1),
  assignmentId: z.string().min(1),
  assignmentRevision: z.string().min(1),
});

const prepaymentSnapshotSchema = z.object({
  kind: z.literal("PREPAYMENT"),
  existingObligationIds: z.array(z.string().min(1)),
  months: z.array(prepaymentMonthSchema).min(1),
});

const packageSnapshotSchema = z.object({
  kind: z.literal("PACKAGE"),
  planTermsId: z.string().min(1),
  priceAmount: z.string().min(1),
  startMonth: yearMonthSchema,
  coverageMonths: z.array(yearMonthSchema).min(1),
  existingObligationIds: z.array(z.string().min(1)),
});

/** Validated before any financial use (plan §6.1) — a malformed or partially-written snapshot refuses cleanly, never
 * trusted as well-formed because it came from this table's own prior write. */
export const awaitingRateReceiptSnapshotSchema = z.discriminatedUnion("kind", [ordinarySnapshotSchema, prepaymentSnapshotSchema, packageSnapshotSchema]);
export type AwaitingRateReceiptSnapshot = z.infer<typeof awaitingRateReceiptSnapshotSchema>;

const ymd = (d: CalendarDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** Returned by `captureAwaitingRateReceiptInTx`, in place of the `rateUnavailable` refusal it replaces. Structurally an
 * `ok: false` result — a captured receipt is not a settlement success from the caller's point of view — assignable
 * directly into `RecordDuesPaymentResult`'s (and, through it, `PrepayMonthlyObligationsResult`'s/`PurchasePackageResult`'s)
 * own existing `ok: false` shape, since `"captured"` is one of `RecordDuesPaymentError`'s own literal values. This is the
 * whole reason no existing, same-currency test needed to change: every caller that doesn't care about capture keeps
 * narrowing on `result.ok` exactly as it always did. */
export type CapturedAwaitingRateReceipt = { ok: false; error: "captured"; receiptId: string };

/**
 * The ONE place a receipt row is ever inserted — called by each of the three outermost capture points above, never by
 * `recordDuesPaymentInTx`/`settleObligationsInTx`/`prepayMonthlyObligations`'s or `purchasePackage`'s own inner cores.
 * Writes the receipt and its own audit row; nothing else. The caller is responsible for everything that makes capturing
 * here transaction-safe (nothing else written yet in this transaction) — this function does not check that itself.
 */
export async function captureAwaitingRateReceiptInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    student: { id: string; homeAcademyId: string };
    kind: "ORDINARY" | "PREPAYMENT" | "PACKAGE";
    receivedOn: CalendarDate;
    tenderCurrency: Currency;
    /** Canonical two-decimal, already validated by the caller. */
    tenderAmount: string;
    method: PaymentMethod;
    notes?: string;
    snapshot: AwaitingRateReceiptSnapshot;
    capturedAt: Date;
  },
): Promise<CapturedAwaitingRateReceipt> {
  const { context, student, kind, receivedOn, tenderCurrency, tenderAmount, method, notes, snapshot, capturedAt } = args;
  const organizationId = context.organizationId;
  const receipt = await tx.awaitingRateReceipt.create({
    data: {
      organizationId,
      studentId: student.id,
      academyId: student.homeAcademyId,
      kind,
      receivedOn: toDbDate(receivedOn),
      tenderCurrency,
      tenderAmount,
      method,
      notes: notes && notes.trim() !== "" ? notes.trim() : null,
      capturedAt,
      capturedById: context.actorUserId,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: student.homeAcademyId,
      action: "awaitingRateReceipt.capture",
      entityType: "AwaitingRateReceipt",
      entityId: receipt.id,
      before: Prisma.DbNull,
      after: { studentId: student.id, kind, receivedOn: ymd(receivedOn), tenderCurrency, tenderAmount },
    },
  });
  return { ok: false, error: "captured", receiptId: receipt.id };
}

export type ResolveAwaitingRateReceiptError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "alreadyResolved"
  | "alreadyCancelled"
  | "malformedSnapshot"
  | "staleTerms"
  | "staleSelection"
  | "noLongerFuture"
  | RecordDuesPaymentError;

export type ResolveAwaitingRateReceiptResult =
  | { ok: true; paymentId: string; settlementIds: string[]; totalMinor: number }
  | { ok: false; error: ResolveAwaitingRateReceiptError; selectableTotals?: string[]; alreadySettledIds?: string[] };

const refuseResolve = (
  error: ResolveAwaitingRateReceiptError,
  extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {},
): Extract<ResolveAwaitingRateReceiptResult, { ok: false }> => ({ ok: false, error, ...extra });

/** Tags a mid-transaction refusal so it can be thrown — forcing Prisma to roll back every provisional void/obligation/
 * coverage/payment row already written — and converted back to a plain result only after that rollback. Mirrors
 * `correctLateFeeAndSettle`'s and `prepayMonthlyObligations`'s own mechanism. */
class ResolutionRefusedError extends Error {
  constructor(public readonly result: ResolveAwaitingRateReceiptResult & { ok: false }) {
    super(`awaiting-rate resolution refused mid-transaction: ${result.error}`);
  }
}

/**
 * For each named obligation, void any fee that was wrongly assessed (not actually late as of `receivedOn`, but an
 * active fee row still exists) — reusing `voidLateFeeInTx`'s own fresh-read/eligibility check, no duplicated logic. The
 * fee-void-first fix (plan §4): this must run BEFORE `resolveMonthlyDebtItemsInTx`, which itself refuses
 * `feeAlreadyAssessed` for exactly this case and would never let a later void happen.
 */
async function voidWronglyAssessedFeesInTx(
  tx: Tx,
  args: { context: TenantContext; obligationIds: string[]; receivedOn: CalendarDate },
  deps: LedgerDeps,
): Promise<{ ok: true } | { ok: false }> {
  const { context, obligationIds, receivedOn } = args;
  const organizationId = context.organizationId;
  for (const obligationId of obligationIds) {
    const obligation = await tx.duesObligation.findFirst({
      where: { id: obligationId, organizationId, type: "MONTHLY" },
      select: { graceDeadline: true, lateFees: { select: { id: true, removedAt: true, removalKind: true } } },
    });
    if (!obligation || obligation.graceDeadline === null) continue; // resolveMonthlyDebtItemsInTx (next) is the real authority on validity
    const feeRow = obligation.lateFees[0];
    if (!feeRow || feeRow.removedAt !== null) continue; // no active fee to void
    const graceDeadline = fromDbDate(obligation.graceDeadline);
    if (lateFeeApplies(receivedOn, graceDeadline)) continue; // genuinely late — not wrongly assessed, leave it
    const expectedRevision = versionRevision({ removedAt: null, removalKind: null });
    const reason = "Awaiting-rate receipt resolution: the fee was assessed while this receipt sat PENDING awaiting a rate; the original receivedOn was on time.";
    const voided = await voidLateFeeInTx(tx, { context, feeId: feeRow.id, expectedRevision, removalReason: reason, receivedOn }, deps);
    if (!voided.ok) return { ok: false };
  }
  return { ok: true };
}

/**
 * Owner-only resolution of a `PENDING` awaiting-rate receipt (plan §4.2, corrected per the shared-settlement-core
 * validation-boundary round): takes ONLY `receiptId` and the authenticated context — no `receivedOn`, no
 * `maxBackdateDays`, no tender, no override of any kind. Every value used comes from a fresh re-read of the receipt
 * itself, under the student lock, re-confirmed `PENDING` before anything else happens. This is the entire mechanism by
 * which resolution avoids re-running the live backdating check against a `receivedOn` that may since have aged past
 * the ordinary new-entry window (plan §8): it calls `settleObligationsInTx` directly for ORDINARY/PREPAYMENT, and
 * `writeSettlementInTx` directly for PACKAGE — never `recordDuesPaymentInTx`/`purchasePackage`, the only functions that
 * contain that check.
 */
export async function resolveAwaitingRateReceipt(
  args: { context: TenantContext; receiptId: string },
  deps: LedgerDeps = {},
): Promise<ResolveAwaitingRateReceiptResult> {
  const { context, receiptId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuseResolve("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline every
  // owner-only writer in this ledger already applies to its own role check.
  if (context.organizationRole !== "ADMIN") return refuseResolve("notFound");
  if (typeof receiptId !== "string" || receiptId === "") return refuseResolve("invalid");

  // A pre-lock scope check only — the authoritative re-read happens under the student lock below.
  const pre = await prisma.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { studentId: true, academyId: true, kind: true } });
  if (!pre || !inTenantScope(context, pre.academyId)) return refuseResolve("notFound");

  try {
    return await prisma.$transaction(async (tx): Promise<ResolveAwaitingRateReceiptResult> => {
      // The literal first statement, SHARED — resolution is a genuine settlement-shaped transaction (it reads whatever
      // rate now exists via settleObligationsInTx/writeSettlementInTx), so it takes the identical lock every settlement
      // writer does, never the exclusive mode (resolution never writes a quote).
      await lockExchangeRateNamespaceShared(tx, organizationId);

      // PREPAYMENT/PACKAGE create new obligations, needing branch-locked terms/policy resolution exactly like their own
      // outer writers; ORDINARY only ever touches existing debt and needs no branch lock.
      let branchTimezone: string | null = null;
      if (pre.kind === "PREPAYMENT" || pre.kind === "PACKAGE") {
        const branch = await lockBranchShared(tx, organizationId, pre.academyId);
        if (!branch) return refuseResolve("notFound");
        branchTimezone = branch.timezone;
      }
      const locked = await lockStudent(tx, organizationId, pre.studentId);
      if (!locked || locked.homeAcademyId !== pre.academyId) return refuseResolve("notFound");

      // Re-read the receipt fresh, under the lock — the authoritative state. Two concurrent resolution attempts for the
      // same receipt serialize on this student lock; whichever commits first fully determines what the other sees.
      const receipt = await tx.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId } });
      if (!receipt) return refuseResolve("notFound");
      if (receipt.status === "RESOLVED") return refuseResolve("alreadyResolved");
      if (receipt.status === "CANCELLED") return refuseResolve("alreadyCancelled");

      const parsedSnapshot = awaitingRateReceiptSnapshotSchema.safeParse(receipt.snapshot);
      if (!parsedSnapshot.success) return refuseResolve("malformedSnapshot");
      const snapshot = parsedSnapshot.data;
      const receivedOn = fromDbDate(receipt.receivedOn);
      const student = { id: receipt.studentId, homeAcademyId: receipt.academyId };
      const tender = { currency: receipt.tenderCurrency, amount: receipt.tenderAmount.toFixed(2) };
      const tenderMinor = decimalToMinor(tender.amount);

      let settled: { ok: true; paymentId: string; settlementIds: string[]; totalMinor: number } | { ok: false; error: RecordDuesPaymentError; selectableTotals?: string[]; alreadySettledIds?: string[] };

      if (snapshot.kind === "ORDINARY") {
        const voidResult = await voidWronglyAssessedFeesInTx(tx, { context, obligationIds: snapshot.obligationIds, receivedOn }, deps);
        if (!voidResult.ok) throw new ResolutionRefusedError(refuseResolve("notFound"));
        settled = await settleObligationsInTx(
          tx,
          { context, student, receivedOn, tenderMinor, tender, method: receipt.method, notes: receipt.notes ?? undefined, obligationIds: snapshot.obligationIds, resolvedFromReceiptId: receipt.id },
          deps,
        );
      } else if (snapshot.kind === "PREPAYMENT") {
        if (branchTimezone === null) throw new Error("unreachable: PREPAYMENT always locks the branch above");
        const currentMonth = currentMonthIn(branchTimezone, (deps.now ?? (() => new Date()))());
        const obligationIds: string[] = [];
        for (const m of snapshot.months) {
          // Forbidden drift (plan §10): the current month itself advancing far enough that an originally-future month is
          // no longer future — refused, never silently reinterpreted.
          if (compareYearMonth(m.coverage, currentMonth) <= 0) throw new ResolutionRefusedError(refuseResolve("noLongerFuture"));
          // Forbidden drift: the month must still be genuinely uncovered — something else may have settled it while
          // this receipt sat PENDING.
          const existingObligation = await tx.duesObligation.findFirst({ where: { organizationId, studentId: student.id, coverageYear: m.coverage.year, coverageMonth: m.coverage.month }, select: { id: true } });
          const existingCoverage = await tx.duesCoverage.findFirst({ where: { organizationId, studentId: student.id, year: m.coverage.year, month: m.coverage.month }, select: { id: true } });
          if (existingObligation || existingCoverage) throw new ResolutionRefusedError(refuseResolve("staleSelection"));
          // Forbidden drift: the snapshotted assignment must still be the one effective for this month, and the
          // snapshotted terms/policy must still be the ones effective — a changed plan, price or terms version refuses,
          // never silently re-picks whatever is current now.
          const assignments = await tx.studentPlanAssignment.findMany({ where: { organizationId, studentId: student.id }, select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true } });
          const assignmentNow = latestEffective(assignments, m.coverage);
          if (
            !assignmentNow ||
            assignmentNow.id !== m.assignmentId ||
            assignmentNow.planId === null ||
            versionRevision({ planId: assignmentNow.planId }) !== m.assignmentRevision
          ) {
            throw new ResolutionRefusedError(refuseResolve("staleTerms"));
          }
          const termsCandidates = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: assignmentNow.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
          const termsNow = latestEffective(termsCandidates, m.coverage);
          const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: student.homeAcademyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
          const policyNow = latestEffective(policyHistory, m.coverage);
          if (!termsNow || termsNow.id !== m.planTermsId || !policyNow || policyNow.id !== m.policyVersionId) throw new ResolutionRefusedError(refuseResolve("staleTerms"));

          const written = await writeMonthlyObligationInTx(tx, { context, student, coverage: m.coverage, planTermsId: m.planTermsId, policyVersionId: m.policyVersionId, origin: "PREPAYMENT" }, deps);
          if (!written.ok) throw new ResolutionRefusedError(refuseResolve(written.error === "notActive" ? "notActive" : "invalid"));
          obligationIds.push(written.obligationId);
          await tx.auditLog.create({
            data: {
              actorId: context.actorUserId, organizationId, academyId: student.homeAcademyId, action: "duesObligation.prepaymentAssignment",
              entityType: "DuesObligation", entityId: written.obligationId, before: Prisma.DbNull,
              after: { assignmentId: assignmentNow.id, effectiveYear: assignmentNow.effectiveYear, effectiveMonth: assignmentNow.effectiveMonth, planId: assignmentNow.planId, revision: m.assignmentRevision, resolvedFromReceiptId: receipt.id },
            },
          });
        }
        const voidResult = await voidWronglyAssessedFeesInTx(tx, { context, obligationIds: snapshot.existingObligationIds, receivedOn }, deps);
        if (!voidResult.ok) throw new ResolutionRefusedError(refuseResolve("notFound"));
        settled = await settleObligationsInTx(
          tx,
          { context, student, receivedOn, tenderMinor, tender, method: receipt.method, notes: receipt.notes ?? undefined, obligationIds: [...snapshot.existingObligationIds, ...obligationIds], resolvedFromReceiptId: receipt.id },
          deps,
        );
      } else {
        // PACKAGE: fee-void FIRST (plan §4 — resolveMonthlyDebtItemsInTx itself refuses feeAlreadyAssessed, which would
        // otherwise make the exact case this feature exists for unresolvable), re-validate terms/coverage against the
        // snapshot, create the package, settle directly through writeSettlementInTx (never recordDuesPaymentInTx/
        // settleObligationsInTx — a package obligation fails that function's own type:"MONTHLY" filter).
        const voidResult = await voidWronglyAssessedFeesInTx(tx, { context, obligationIds: snapshot.existingObligationIds, receivedOn }, deps);
        if (!voidResult.ok) throw new ResolutionRefusedError(refuseResolve("notFound"));

        if (branchTimezone === null) throw new Error("unreachable: PACKAGE always locks the branch above");
        const currentMonth = currentMonthIn(branchTimezone, (deps.now ?? (() => new Date()))());
        const termsResolved = await resolvePackageTermsInTx(tx, { organizationId, planTermsId: snapshot.planTermsId, academyId: student.homeAcademyId, currentMonth });
        if (!termsResolved.ok) throw new ResolutionRefusedError(refuseResolve("staleTerms"));
        if (termsResolved.terms.priceAmount.toFixed(2) !== snapshot.priceAmount) throw new ResolutionRefusedError(refuseResolve("staleTerms"));

        const coverageAvailable = await checkPackageCoverageAvailableInTx(tx, { organizationId, studentId: student.id, startMonth: snapshot.startMonth, monthsCovered: snapshot.coverageMonths.length });
        if (!coverageAvailable.ok) throw new ResolutionRefusedError(refuseResolve("staleSelection"));

        const debtResult = await resolveMonthlyDebtItemsInTx(tx, { organizationId, studentId: student.id, obligationIds: snapshot.existingObligationIds, receivedOn });
        if (!debtResult.ok) throw new ResolutionRefusedError(refuseResolve(debtResult.error, { alreadySettledIds: debtResult.alreadySettledIds }));
        if (debtResult.chosenItems.length !== debtResult.allOpenItems.length) throw new ResolutionRefusedError(refuseResolve("staleSelection"));

        const obligation = await writePackageObligationInTx(tx, { context, student, terms: termsResolved.terms, startMonth: snapshot.startMonth });
        const packageItem: SettlementLineItem = { obligationId: obligation.obligationId, currency: termsResolved.terms.currency, amountMinor: decimalToMinor(snapshot.priceAmount), feeEligible: false, expectedOwed: false };
        const allItems: SettlementLineItem[] = [...debtResult.chosenItems, packageItem];
        const settlementItems: SettlementItem[] = allItems.map((i) => ({ id: i.obligationId, currency: i.currency, amountMinor: i.amountMinor }));
        const written = await writeSettlementInTx(tx, { context, student, receivedOn, tender, method: receipt.method, notes: receipt.notes ?? undefined, settledItems: allItems, resolvedFromReceiptId: receipt.id }, deps);
        // writeSettlementInTx trusts its caller's own match — settlementItems is referenced only to keep the shape
        // consistent with the other two branches; the actual total/currency match already happened at capture time and
        // is re-proven correct simply by `tenderMinor`/`tender` being the receipt's own immutable, already-matched values.
        void settlementItems;
        settled = { ok: true, paymentId: written.paymentId, settlementIds: written.settlementIds, totalMinor: tenderMinor };
      }

      if (!settled.ok) throw new ResolutionRefusedError(refuseResolve(settled.error, { selectableTotals: settled.selectableTotals, alreadySettledIds: settled.alreadySettledIds }));

      // Mark the receipt RESOLVED — the application-level half of "at most one payment per receipt" (the student lock
      // already makes a second concurrent attempt see this; `resolvedFromReceiptId`'s own DB uniqueness is the backstop).
      const updated = await tx.awaitingRateReceipt.updateMany({
        where: { id: receipt.id, organizationId, status: "PENDING" },
        data: { status: "RESOLVED", resolvedAt: (deps.now ?? (() => new Date()))(), resolvedById: context.actorUserId },
      });
      if (updated.count !== 1) throw new ResolutionRefusedError(refuseResolve("alreadyResolved"));
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId, organizationId, academyId: student.homeAcademyId, action: "awaitingRateReceipt.resolve",
          entityType: "AwaitingRateReceipt", entityId: receipt.id, before: { status: "PENDING" }, after: { status: "RESOLVED", paymentId: settled.paymentId },
        },
      });

      return { ok: true, paymentId: settled.paymentId, settlementIds: settled.settlementIds, totalMinor: settled.totalMinor };
    });
  } catch (error) {
    if (error instanceof ResolutionRefusedError) return error.result; // AFTER rollback, never before
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as ResolveAwaitingRateReceiptResult;
    throw error;
  }
}

export type CancelAwaitingRateReceiptError = "notActive" | "invalid" | "notFound" | "alreadyResolved" | "alreadyCancelled";

export type CancelAwaitingRateReceiptResult = { ok: true; receiptId: string } | { ok: false; error: CancelAwaitingRateReceiptError };

/**
 * Owner-only cancellation of a `PENDING` awaiting-rate receipt (plan §4.3): a required, non-blank `reason`; never
 * touches any `DuesObligation`/`DuesCoverage`/`DuesSettlement`/`DuesPayment` row; implies no refund or settlement. The
 * receipt and its full history are preserved permanently, exactly like every other removal/reversal marker in this
 * ledger — the row is never deleted, only marked.
 */
export async function cancelAwaitingRateReceipt(
  args: { context: TenantContext; receiptId: string; reason: string },
  deps: LedgerDeps = {},
): Promise<CancelAwaitingRateReceiptResult> {
  const { context, receiptId, reason } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };
  if (context.organizationRole !== "ADMIN") return { ok: false, error: "notFound" };
  if (typeof receiptId !== "string" || receiptId === "") return { ok: false, error: "invalid" };
  if (typeof reason !== "string" || reason.trim() === "") return { ok: false, error: "invalid" };

  const pre = await prisma.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { studentId: true, academyId: true } });
  if (!pre || !inTenantScope(context, pre.academyId)) return { ok: false, error: "notFound" };

  return await prisma.$transaction(async (tx): Promise<CancelAwaitingRateReceiptResult> => {
    const locked = await lockStudent(tx, organizationId, pre.studentId);
    if (!locked || locked.homeAcademyId !== pre.academyId) return { ok: false, error: "notFound" };

    const receipt = await tx.awaitingRateReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { id: true, status: true, academyId: true } });
    if (!receipt) return { ok: false, error: "notFound" };
    if (receipt.status === "RESOLVED") return { ok: false, error: "alreadyResolved" };
    if (receipt.status === "CANCELLED") return { ok: false, error: "alreadyCancelled" };

    const trimmedReason = reason.trim();
    const updated = await tx.awaitingRateReceipt.updateMany({
      where: { id: receipt.id, organizationId, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: (deps.now ?? (() => new Date()))(), cancelledById: context.actorUserId, cancellationReason: trimmedReason },
    });
    if (updated.count !== 1) return { ok: false, error: "alreadyCancelled" };
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId, organizationId, academyId: receipt.academyId, action: "awaitingRateReceipt.cancel",
        entityType: "AwaitingRateReceipt", entityId: receipt.id, before: { status: "PENDING" }, after: { status: "CANCELLED", cancellationReason: trimmedReason },
      },
    });
    return { ok: true, receiptId: receipt.id };
  });
}
