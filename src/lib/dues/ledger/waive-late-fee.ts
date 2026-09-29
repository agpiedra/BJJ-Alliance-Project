import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { versionRevision } from "@/lib/dues/config-input";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, lockStudent } from "@/lib/dues/ledger/common";

/**
 * Late-fee-waiver brief: an owner forgives a genuinely, correctly assessed fee anyway — a policy decision, unlike
 * `correctLateFeeAndSettle`'s VOID (a factual correction to a fee that was never actually owed, given the owner's attested
 * receivedOn). A plain library function: no server action, route, job or scheduler entry, closed by default (see `activation.ts`).
 *
 * TOUCHES EXACTLY ONE ROW, PLUS ITS AUDIT ENTRY. Verified, not assumed: every reader that decides whether a fee is currently
 * owed already keys off `DuesLateFee.removedAt` alone, never `removalKind` (`record-payment.ts`, `late-fee-assessment.ts`) — a
 * waived fee is excluded from `amountDueMinor` and never re-assessed, for free, the same as a voided one. Unlike voiding,
 * waiving an unpaid fee unblocks no payment that was blocked, so this writer never composes `recordDuesPaymentInTx`: no
 * settlement, no obligation, no coverage write, no tuition change, ever.
 *
 * ALREADY-PAID FEES ARE REFUSED (`alreadyPaid`), NOT SILENTLY CREDITED OR REFUNDED. An ACTIVE (`reversedAt: null`)
 * `DuesSettlement` pointing at this fee means the money has already been received and recorded — "waiving" it now would mean a
 * refund, a credit, or a retroactive rewrite of a historical settlement, none of which this system decides (see
 * LATE-FEE-WAIVER-BRIEF.md §5). A settlement whose OWN `reversedAt` is set is history, not payment: it does not block a waiver,
 * and once a fee's only settlement is reversed, the fee is unpaid again (Decision A) and waives normally.
 *
 * PRESERVES `reversePayment`'s VOIDED-only reversal restriction — this writer changes nothing about `reverse-payment.ts`. A
 * VOID's premise is a specific, timing-dependent claim a reversal could call into question; a WAIVER's premise is not tied to
 * any payment's existence or timing, so reversing a payment behind a waived fee's obligation needs no special handling.
 *
 * Trusts nothing from before the student lock: the fee's removal state is re-read fresh under `lockStudent`, the same
 * discipline `correctLateFeeAndSettle` and `reversePayment` already established.
 */
export type WaiveLateFeeError = "notActive" | "invalid" | "notFound" | "stale" | "alreadyRemoved" | "alreadyPaid";

export type WaiveLateFeeResult = { ok: true; feeId: string } | { ok: false; error: WaiveLateFeeError };

const refuse = (error: WaiveLateFeeError): WaiveLateFeeResult => ({ ok: false, error });

/** The fee's own mutable state a stale view could disagree with — the same shape `correctLateFeeAndSettle`'s `lateFeeRevision` uses. */
function lateFeeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

export async function waiveLateFee(
  args: { context: TenantContext; lateFeeId: string; expectedRevision: string; removalReason: string },
  deps: LedgerDeps = {},
): Promise<WaiveLateFeeResult> {
  const { context, lateFeeId, expectedRevision, removalReason } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline
  // `correctLateFeeAndSettle` and `reversePayment` already apply to their own role requirement.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");
  if (typeof lateFeeId !== "string" || lateFeeId === "") return refuse("invalid");
  if (typeof expectedRevision !== "string" || expectedRevision === "") return refuse("invalid");
  if (typeof removalReason !== "string" || removalReason.trim() === "") return refuse("invalid"); // refuse cleanly; don't let a blank reason surface as a raw DB constraint violation

  const fee = await prisma.duesLateFee.findFirst({
    where: { id: lateFeeId, organizationId },
    select: { id: true, obligation: { select: { id: true, studentId: true, academyId: true } } },
  });
  if (!fee || !inTenantScope(context, fee.obligation.academyId)) return refuse("notFound");

  return await prisma.$transaction(async (tx): Promise<WaiveLateFeeResult> => {
    // The student row FOR UPDATE serializes this waiver against a concurrent payment, assessment run, correction, reversal, or a
    // second waiver/void attempt on the same fee — whichever acquires the lock first fully determines what the others see.
    const locked = await lockStudent(tx, organizationId, fee.obligation.studentId);
    if (!locked || locked.homeAcademyId !== fee.obligation.academyId) return refuse("notFound");

    // Re-read the fee's own row under the lock (the pre-lock read above could be stale) — this is the authoritative state
    // expectedRevision and the removal check below are judged against.
    const current = await tx.duesLateFee.findFirst({ where: { id: lateFeeId, organizationId }, select: { id: true, removedAt: true, removalKind: true } });
    if (!current) return refuse("notFound");
    // A fee already removed, either kind, is a one-time marker, not re-appliable — its existing removalKind/removalReason are
    // left exactly as they are, never touched here.
    if (current.removedAt !== null) return refuse("alreadyRemoved");
    if (lateFeeRevision(current) !== expectedRevision) return refuse("stale");

    // alreadyPaid: an ACTIVE (unreversed) settlement already includes this fee. A settlement whose OWN reversedAt is set is
    // history, not payment, and does not count — re-read fresh under the lock, not from any pre-lock snapshot.
    const activeSettlement = await tx.duesSettlement.findFirst({ where: { organizationId, lateFeeId: current.id, reversedAt: null }, select: { id: true } });
    if (activeSettlement) return refuse("alreadyPaid");

    const removedAt = (deps.now ?? (() => new Date()))();
    const reason = removalReason.trim();
    await tx.duesLateFee.update({
      where: { id: current.id, organizationId },
      data: { removedAt, removalKind: "WAIVED", removedById: context.actorUserId, removalReason: reason },
    });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        academyId: fee.obligation.academyId,
        action: "duesLateFee.waive",
        entityType: "DuesLateFee",
        entityId: current.id,
        before: { removedAt: null, removalKind: null },
        after: { removedAt: removedAt.toISOString(), removalKind: "WAIVED", removedById: context.actorUserId, removalReason: reason },
      },
    });

    if (deps.afterWaiveMarkersForTest) await deps.afterWaiveMarkersForTest();

    return { ok: true, feeId: current.id };
  });
}
