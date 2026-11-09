import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, lockBranchShared, lockStudent } from "@/lib/dues/ledger/common";
import { lockExchangeRateNamespaceShared } from "@/lib/dues/ledger/exchange-rate";
import {
  classifyReversedObligation,
  isReversalReasonCategory,
  sameIdSet,
  storedReversalReason,
  type ReversalReasonCategory,
} from "@/lib/dues/reversal-classification";

/**
 * Payment-reversal brief, extended by O4 (owner decisions B1–B10, approved 2026-11-09; docs/dues/O4-PREPAYMENT-REVERSAL-PLAN.md):
 * reverse a recorded payment and every one of its active settlements, atomically, in one transaction. A plain library function
 * (its one caller is the owner-only `reversePaymentAction`), closed by default (see `activation.ts`).
 *
 * A REVERSAL records that the money was never validly received (bounced, not received) or that the payment was recorded in
 * error. It is NOT a refund (no money moves; refunds are not built) and NOT a membership cancellation (a status change never
 * touches payments). The reason category (B7) is required and stored as a prefix of `reversalReason`.
 *
 * What happens to each obligation the payment settled (`src/lib/dues/reversal-classification.ts`, decided under the locks below):
 *  - R1 `cancel`: a prepaid (`origin: PREPAYMENT`) obligation whose ONLY settlement ever is this payment's, for a month after the
 *    current month in the student's home-branch timezone → its settlement is reversed, the obligation is CANCELLED and its
 *    coverage RELEASED (set-once markers). The monthly job bills that month normally when it opens, at the price then (B2).
 *  - R2 `owedStarted`: the same, but the month has started → its settlement is reversed; it is owed again.
 *  - R3 `owedIndependent`: everything else → its settlement is reversed; it is owed again, exactly as before O4.
 *  - Decision A (unchanged): a valid late fee this payment settled becomes owed again — the `DuesLateFee` row is not touched.
 * The database enforces the same rules independently (migration 20261110120000): a cancelled obligation must have had exactly
 * one settlement, by the reversed cancelling payment, no fee, a month not yet started, and all its coverage released in the same
 * transaction; a cancelled obligation can never be settled or charged a fee.
 *
 * Refusals (each writes nothing): `notActive`, `notFound` (also: owner-only, out of scope, and — B9, a launch restriction — the
 * student's home branch is no longer the payment's branch), `invalid`, `alreadyReversed`, `inconsistentState`,
 * `unsupportedObligationType` (packages, signup), `voidedFeeBlocksReversal` (Decision B, unchanged), and `changedSinceReview`:
 * the set of obligations that WOULD be cancelled, recomputed under the locks, differs from `expectedCancelledObligationIds` (what
 * the owner confirmed). Omitting `expectedCancelledObligationIds` means "I expect nothing to be cancelled", so this writer never
 * cancels anything the caller did not name.
 *
 * LOCK ORDER (the ledger's standard sequence, `common.ts`): exchange-rate namespace SHARED, the payment's branch FOR SHARE, then
 * the student FOR UPDATE. The deciding instant is captured once, AFTER the locks, and everything is re-read under them. This
 * serializes a reversal with every other ledger writer for the same student; it does not by itself prove deadlock freedom
 * against every possible future writer — the races that exist today are exercised in tests/integration/o4-reversal-races.test.ts.
 */
export type ReversePaymentError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "alreadyReversed"
  | "inconsistentState"
  | "unsupportedObligationType"
  | "voidedFeeBlocksReversal"
  | "changedSinceReview";

export type ReversePaymentResult =
  | { ok: true; paymentId: string; settlementIds: string[]; cancelledObligationIds: string[]; owedAgainObligationIds: string[] }
  | { ok: false; error: ReversePaymentError };

const refuse = (error: ReversePaymentError): ReversePaymentResult => ({ ok: false, error });

/** The database's own month-started guard (migration 20261110120000 §5) can only disagree with this writer's decision across a
 * month boundary under clock skew between servers; the whole transaction has already rolled back, so it is reported as a stale
 * review, never as an unexpected failure. */
const MONTH_STARTED_GUARD = "a month that has already started cannot be cancelled";

/** The database's own message for an error, wherever the driver adapter put it (`meta.driverAdapterError.cause`), plus the
 * error's own message. Used only to recognize the one guard above; never logged or returned. */
function databaseErrorText(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string; message?: string } } } } | undefined)?.meta?.driverAdapterError?.cause;
  return [error instanceof Error ? error.message : "", cause?.originalMessage ?? "", cause?.message ?? ""].join(" | ");
}

export async function reversePayment(
  args: {
    context: TenantContext;
    paymentId: string;
    reasonCategory: ReversalReasonCategory;
    reversalReason: string;
    /** The obligation ids the owner saw as "will be cancelled" (the preview). Omitted = none. */
    expectedCancelledObligationIds?: readonly string[];
  },
  deps: LedgerDeps = {},
): Promise<ReversePaymentResult> {
  const { context, paymentId, reasonCategory, reversalReason } = args;
  const expectedCancelled = args.expectedCancelledObligationIds ?? [];
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // B6: owner-only, checked here rather than trusted from whatever calls this.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");
  if (typeof paymentId !== "string" || paymentId === "") return refuse("invalid");
  if (!isReversalReasonCategory(reasonCategory)) return refuse("invalid");
  if (typeof reversalReason !== "string" || reversalReason.trim() === "") return refuse("invalid"); // refuse cleanly; never a raw DB constraint violation
  if (!Array.isArray(expectedCancelled) || expectedCancelled.some((id) => typeof id !== "string" || id === "")) return refuse("invalid");

  const select = {
    id: true,
    studentId: true,
    academyId: true,
    reversedAt: true,
    settlements: {
      select: {
        id: true,
        reversedAt: true,
        obligation: {
          select: {
            id: true,
            type: true,
            origin: true,
            coverageYear: true,
            coverageMonth: true,
            cancelledAt: true,
            lateFees: { select: { removalKind: true } },
            // Every settlement this obligation has EVER had (reversed ones included) — rule R1's provenance.
            settlements: { select: { paymentId: true } },
          },
        },
      },
    },
  } as const;

  const payment = await prisma.duesPayment.findFirst({ where: { id: paymentId, organizationId }, select: { id: true, studentId: true, academyId: true } });
  if (!payment || !inTenantScope(context, payment.academyId)) return refuse("notFound");

  try {
    return await prisma.$transaction(async (tx): Promise<ReversePaymentResult> => {
      await lockExchangeRateNamespaceShared(tx, organizationId);
      const branch = await lockBranchShared(tx, organizationId, payment.academyId);
      if (!branch) return refuse("notFound");
      const locked = await lockStudent(tx, organizationId, payment.studentId);
      // B9 (launch restriction): a payment recorded in a branch the student has since left is not reversible.
      if (!locked || locked.homeAcademyId !== payment.academyId) return refuse("notFound");

      const now = (deps.now ?? (() => new Date()))();
      const currentMonth = currentMonthIn(branch.timezone, now);
      if (deps.afterReversalLocksForTest) await deps.afterReversalLocksForTest(tx);

      const current = await tx.duesPayment.findFirst({ where: { id: paymentId, organizationId }, select });
      if (!current) return refuse("notFound");
      if (current.reversedAt !== null) return refuse("alreadyReversed");

      const settlements = current.settlements;
      // Defensive: nothing can reverse a settlement independently of its payment, or cancel an obligation that still has this
      // payment's active settlement — checked explicitly rather than assumed impossible.
      if (settlements.some((s) => s.reversedAt !== null || s.obligation.cancelledAt !== null)) return refuse("inconsistentState");
      if (settlements.some((s) => s.obligation.type !== "MONTHLY")) return refuse("unsupportedObligationType");
      if (settlements.some((s) => s.obligation.lateFees.some((f) => f.removalKind === "VOIDED"))) return refuse("voidedFeeBlocksReversal");

      const cancelled: string[] = [];
      const owedAgain: string[] = [];
      for (const s of settlements) {
        const cls = classifyReversedObligation(
          { origin: s.obligation.origin, coverageYear: s.obligation.coverageYear, coverageMonth: s.obligation.coverageMonth, settlementPaymentIds: s.obligation.settlements.map((x) => x.paymentId) },
          current.id,
          currentMonth,
        );
        (cls === "cancel" ? cancelled : owedAgain).push(s.obligation.id);
      }
      // The owner confirmed exactly what would be cancelled; anything else (a month boundary passed, another write landed) is
      // refused so the owner re-reviews. Nothing has been written yet.
      if (!sameIdSet(cancelled, expectedCancelled)) return refuse("changedSinceReview");

      const reason = storedReversalReason(reasonCategory, reversalReason);
      await tx.duesPayment.update({
        where: { id: current.id, organizationId },
        data: { reversedAt: now, reversedById: context.actorUserId, reversalReason: reason },
      });
      if (settlements.length > 0) {
        await tx.duesSettlement.updateMany({
          where: { organizationId, paymentId: current.id, reversedAt: null },
          data: { reversedAt: now, reversedById: context.actorUserId, reversalReason: reason },
        });
      }
      // Settlements first (the database refuses to cancel an obligation that still has an active one), then each cancelled
      // obligation and its coverage. The deferred consistency triggers check the pair at COMMIT.
      for (const obligationId of cancelled) {
        await tx.duesObligation.update({
          where: { id: obligationId, organizationId },
          data: { cancelledAt: now, cancelledById: context.actorUserId, cancellationReason: reason, cancelledByReversalOfPaymentId: current.id },
        });
        await tx.duesCoverage.updateMany({ where: { organizationId, obligationId, releasedAt: null }, data: { releasedAt: now } });
      }
      // A record only — the state above lives on the rows themselves and is never read back from here.
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId,
          academyId: payment.academyId,
          action: "duesPayment.reverse",
          entityType: "DuesPayment",
          entityId: current.id,
          before: { reversedAt: null },
          after: {
            reversedAt: now.toISOString(),
            reversedById: context.actorUserId,
            reversalReason: reason,
            settlementIds: settlements.map((s) => s.id),
            cancelledObligationIds: cancelled,
            owedAgainObligationIds: owedAgain,
          },
        },
      });

      if (deps.afterReversalMarkersForTest) await deps.afterReversalMarkersForTest();

      return { ok: true, paymentId: current.id, settlementIds: settlements.map((s) => s.id), cancelledObligationIds: cancelled, owedAgainObligationIds: owedAgain };
    });
  } catch (error) {
    if (databaseErrorText(error).includes(MONTH_STARTED_GUARD)) return refuse("changedSinceReview");
    throw error;
  }
}
