import type { Currency, PaymentMethod } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import type { CalendarDate } from "@/lib/dues/calendar";
import { versionRevision } from "@/lib/dues/config-input";
import { lateFeeApplies } from "@/lib/dues/settlement";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { fromDbDate, inTenantScope, isRealDate, lockStudent, type Tx } from "@/lib/dues/ledger/common";
import { lockExchangeRateNamespace } from "@/lib/dues/ledger/exchange-rate";
import { classifyRecordPaymentError, recordDuesPaymentInTx, type RecordDuesPaymentError, type RecordDuesPaymentResult } from "@/lib/dues/ledger/record-payment";

/**
 * Late-fee-correction brief: void a fee that was wrongly assessed before an on-time payment was recorded, and record the full
 * settlement it was blocking — atomically, in one transaction. A plain library function: no server action, route, job or
 * scheduler entry, closed by default (see `activation.ts`).
 *
 * `receivedOn` is owner-confirmed, not independently verified — there is no bank integration, no receipt upload, nothing this
 * system checks the claimed date against. `lateFeeApplies(receivedOn, graceDeadline)` checks TIMELINESS GIVEN THE CLAIM: if
 * `receivedOn` is true, would it have been on time against the obligation's own stored grace deadline? It does not, and cannot,
 * verify the claim itself. `expectedRevision` (D25's pattern, reused verbatim via `versionRevision`) detects a STALE view, not
 * factual accuracy — the two checks answer different questions and neither substitutes for the other.
 *
 * VOID only. This never builds WAIVED (a genuinely-owed fee an owner forgives anyway — a policy decision, not this phase's to
 * make), never touches an existing settlement (reversal stays exactly as pending as before), and never bypasses oldest-first
 * validation: it settles the fee's own obligation through the SAME `recordDuesPaymentInTx` every ordinary payment uses, so an
 * older, still-unpaid obligation for the same student refuses this correction exactly as it would refuse an ordinary payment.
 *
 * Never commits a void without its matching full settlement: if `recordDuesPaymentInTx` refuses for ANY reason after the
 * provisional void, this throws a tagged error to force Prisma to roll back the whole transaction (a callback that RETURNS a
 * refusal value still commits — only a throw rolls back), and only converts it back to a typed result after that rollback has
 * happened. See `SettlementRefusedError` below.
 */
export type CorrectLateFeeError = "notActive" | "invalid" | "notFound" | "stale" | "alreadyRemoved" | "notOnTime" | RecordDuesPaymentError;

export type CorrectLateFeeResult =
  | { ok: true; feeId: string; paymentId: string; settlementIds: string[]; totalMinor: number }
  | { ok: false; error: CorrectLateFeeError; selectableTotals?: string[]; alreadySettledIds?: string[] };

const refuse = (error: CorrectLateFeeError, extra: { selectableTotals?: string[]; alreadySettledIds?: string[] } = {}): CorrectLateFeeResult => ({ ok: false, error, ...extra });

/** The fee's own mutable state a stale view could disagree with — the same shape `correctAssignment`'s `assignmentRevision` uses. */
function lateFeeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

/**
 * Tags a `recordDuesPaymentInTx` refusal so it can be thrown (forcing Prisma to roll back the provisional void) and converted
 * back to a plain result only after that rollback — never returned directly from inside the transaction callback.
 */
class SettlementRefusedError extends Error {
  constructor(public readonly result: RecordDuesPaymentResult & { ok: false }) {
    super(`settlement refused after provisional void: ${result.error}`);
  }
}

export type VoidLateFeeError = "notFound" | "alreadyRemoved" | "stale" | "notOnTime";

export type VoidLateFeeResult =
  | { ok: true; feeId: string; obligationId: string; studentId: string; academyId: string }
  | { ok: false; error: VoidLateFeeError };

/**
 * The provisional-void core `correctLateFeeAndSettle` composes below, extracted narrowly for later reuse (a pending-receipt
 * resolution writer, not built or consumed in this PR — nothing else calls this yet). Trusts nothing from its caller except
 * `feeId`/`expectedRevision`/`removalReason`/`receivedOn`: re-reads the fee's own row, its obligation, tenant scope and its
 * CURRENT removal state fresh, under whatever lock the caller already holds (the caller's own `lockStudent`, taken on the
 * obligation's studentId BEFORE calling this — the same "core never locks, caller already holds it" discipline every other
 * `*InTx` extraction in this ledger follows). Takes no lock itself and never opens a transaction.
 */
export async function voidLateFeeInTx(
  tx: Tx,
  args: { context: TenantContext; feeId: string; expectedRevision: string; removalReason: string; receivedOn: CalendarDate },
  deps: LedgerDeps = {},
): Promise<VoidLateFeeResult> {
  const { context, feeId, expectedRevision, removalReason, receivedOn } = args;
  const organizationId = context.organizationId;

  // Re-read the fee's own row under the caller's held lock — the authoritative state `expectedRevision` and the removal
  // check below are judged against, never whatever a caller's own earlier, possibly-stale lookup found.
  const fee = await tx.duesLateFee.findFirst({
    where: { id: feeId, organizationId },
    select: { id: true, removedAt: true, removalKind: true, obligation: { select: { id: true, studentId: true, academyId: true, graceDeadline: true } } },
  });
  if (!fee) return { ok: false, error: "notFound" };
  if (!inTenantScope(context, fee.obligation.academyId)) return { ok: false, error: "notFound" };
  if (fee.obligation.graceDeadline === null) return { ok: false, error: "notFound" };
  if (fee.removedAt !== null) return { ok: false, error: "alreadyRemoved" };
  if (lateFeeRevision(fee) !== expectedRevision) return { ok: false, error: "stale" };

  // Timeliness GIVEN THE CLAIM, not proof of the claim (see this file's own doc comment) — the one gate that stands between
  // "the owner said so" and actually voiding anything.
  const graceDeadline = fromDbDate(fee.obligation.graceDeadline);
  if (lateFeeApplies(receivedOn, graceDeadline)) return { ok: false, error: "notOnTime" };

  const removedAt = (deps.now ?? (() => new Date()))();
  await tx.duesLateFee.update({
    where: { id: fee.id, organizationId },
    data: { removedAt, removalKind: "VOIDED", removedById: context.actorUserId, removalReason: removalReason.trim() },
  });
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: fee.obligation.academyId,
      action: "duesLateFee.void",
      entityType: "DuesLateFee",
      entityId: fee.id,
      before: { removedAt: null, removalKind: null },
      after: { removedAt: removedAt.toISOString(), removalKind: "VOIDED", removedById: context.actorUserId, removalReason: removalReason.trim() },
    },
  });
  if (deps.afterVoidForTest) await deps.afterVoidForTest();

  return { ok: true, feeId: fee.id, obligationId: fee.obligation.id, studentId: fee.obligation.studentId, academyId: fee.obligation.academyId };
}

export async function correctLateFeeAndSettle(
  args: {
    context: TenantContext;
    lateFeeId: string;
    expectedRevision: string;
    removalReason: string;
    receivedOn: CalendarDate;
    tender: { currency: Currency; amount: string };
    method: PaymentMethod;
    notes?: string;
    /** How many days before today the received date may be. Required; no default — reuses the same limit an ordinary payment
     * would (decision D4 is pending, unchanged; this is not a separate, more generous correction allowance). */
    maxBackdateDays: number;
  },
  deps: LedgerDeps = {},
): Promise<CorrectLateFeeResult> {
  const { context, lateFeeId, expectedRevision, removalReason, receivedOn, tender, method, notes, maxBackdateDays } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same "trust nothing from the caller"
  // discipline already applied to scope and activation elsewhere in this ledger, extended to role since it is this action's own
  // explicit policy requirement, not a request-layer concern alone.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");
  if (typeof lateFeeId !== "string" || lateFeeId === "") return refuse("invalid");
  if (typeof expectedRevision !== "string" || expectedRevision === "") return refuse("invalid");
  if (typeof removalReason !== "string" || removalReason.trim() === "") return refuse("invalid"); // refuse cleanly; don't let a blank reason surface as a raw DB constraint violation
  // receivedOn feeds lateFeeApplies (below) before any DB read — compareDates does raw property access and arithmetic with no
  // validation of its own, so a null/undefined/malformed/impossible date must be rejected here, before that comparison and
  // before any provisional void, not left to throw uncaught or silently compare wrong. Same check recordDuesPaymentInTx's own
  // validatePaymentInput already uses for this exact field.
  if (!receivedOn || !isRealDate(receivedOn)) return refuse("invalid");

  try {
    return await prisma.$transaction(async (tx): Promise<CorrectLateFeeResult> => {
      // The literal first statement — before even the unlocked pre-read below. See lockExchangeRateNamespace's own doc
      // comment: every true outermost transaction this ledger opens takes it unconditionally, before any row lock, since
      // this correction composes recordDuesPaymentInTx (an INNER call that never takes this lock itself).
      await lockExchangeRateNamespace(tx, organizationId);

      const fee = await tx.duesLateFee.findFirst({
        where: { id: lateFeeId, organizationId },
        select: {
          id: true,
          removedAt: true,
          removalKind: true,
          obligation: { select: { id: true, studentId: true, academyId: true, graceDeadline: true } },
        },
      });
      if (!fee) return refuse("notFound");
      if (!inTenantScope(context, fee.obligation.academyId)) return refuse("notFound");
      if (fee.obligation.graceDeadline === null) return refuse("notFound");

      // The student row FOR UPDATE serializes this correction against a concurrent assessment run, an ordinary payment, or a
      // second correction attempt on the same fee — whichever acquires the lock first fully determines what the others see.
      const locked = await lockStudent(tx, organizationId, fee.obligation.studentId);
      if (!locked || locked.homeAcademyId !== fee.obligation.academyId) return refuse("notFound");

      // voidLateFeeInTx re-reads the fee's own row fresh under this lock (the pre-lock read above could be stale) — it is
      // the sole authority for `expectedRevision`, the removal state and the timeliness-given-the-claim check.
      const voided = await voidLateFeeInTx(tx, { context, feeId: lateFeeId, expectedRevision, removalReason, receivedOn }, deps);
      if (!voided.ok) return refuse(voided.error);

      // Same transaction, no nesting: recordDuesPaymentInTx re-validates everything from scratch (oldest-first, exact total,
      // backdating, activation, scope) and trusts nothing carried over from the void above.
      const settled = await recordDuesPaymentInTx(
        tx,
        {
          context,
          student: { id: voided.studentId, homeAcademyId: voided.academyId },
          receivedOn,
          tender,
          method,
          obligationIds: [voided.obligationId],
          notes,
          maxBackdateDays,
        },
        deps,
      );
      if (!settled.ok) throw new SettlementRefusedError(settled);

      return { ok: true, feeId: voided.feeId, paymentId: settled.paymentId, settlementIds: settled.settlementIds, totalMinor: settled.totalMinor };
    });
  } catch (error) {
    if (error instanceof SettlementRefusedError) return error.result; // AFTER rollback, never before
    const classified = classifyRecordPaymentError(error);
    if (classified) return classified as CorrectLateFeeResult; // RecordDuesPaymentError is a subset of CorrectLateFeeError
    throw error;
  }
}
