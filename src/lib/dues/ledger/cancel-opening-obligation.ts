import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { ledgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { lockOrganizationGate } from "@/lib/dues/activation-gate";
import { inTenantScope, lockStudent } from "@/lib/dues/ledger/common";
import { isOpeningCancellationCategory, storedCategorizedReason, type OpeningCancellationCategory } from "@/lib/dues/reversal-classification";

/**
 * O2 (owner decision, approved A3–A4 2026-11-10; docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md PR 9-2): the owner cancels an
 * erroneous OPENING obligation. Owner only; a required category plus required text, stored as `[CATEGORY] text` (O4's format);
 * no time limit. Refused while any payment is CURRENTLY applied to it (A3): reverse that payment first — a reversed settlement
 * no longer blocks. Never a refund, never a write to any payment.
 *
 * Reuses O4's database safeguards (migration 20261112120100 widens them by type): the cancellation marker is set once and never
 * removed; the cancelling UPDATE is refused while an active settlement exists; once cancelled, no settlement can be inserted
 * against it (a concurrent payment either commits first — and this refuses — or waits on the row and is refused). The writer's
 * own checks below are the friendly refusals; the database is the backstop.
 */
export type CancelOpeningObligationError = "notActive" | "invalid" | "notFound" | "alreadyCancelled" | "hasActivePayment";

export type CancelOpeningObligationResult = { ok: true; obligationId: string } | { ok: false; error: CancelOpeningObligationError };

const refuse = (error: CancelOpeningObligationError): CancelOpeningObligationResult => ({ ok: false, error });

export async function cancelOpeningObligation(
  args: { context: TenantContext; obligationId: string; reasonCategory: OpeningCancellationCategory; reason: string },
  deps: LedgerDeps = {},
): Promise<CancelOpeningObligationResult> {
  const { context, obligationId, reasonCategory, reason } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? ledgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner only, checked here, never trusted from the caller.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");
  if (typeof obligationId !== "string" || obligationId === "") return refuse("invalid");
  if (!isOpeningCancellationCategory(reasonCategory)) return refuse("invalid");
  if (typeof reason !== "string" || reason.trim() === "") return refuse("invalid");

  // Includes cancelled rows on purpose (O4's T10 guard: the read names `cancelledAt`): a cancelled one is `alreadyCancelled`,
  // not `notFound`. Advisory only — re-read under the lock below.
  const pre = await prisma.duesObligation.findFirst({
    where: { id: obligationId, organizationId, type: "OPENING" },
    select: { id: true, studentId: true, academyId: true, cancelledAt: true },
  });
  if (!pre || !inTenantScope(context, pre.academyId)) return refuse("notFound");
  if (pre.cancelledAt !== null) return refuse("alreadyCancelled");

  return await prisma.$transaction(async (tx): Promise<CancelOpeningObligationResult> => {
    await lockOrganizationGate(tx, organizationId); // stage 9 rule 9k
    // The student row FOR UPDATE serializes this against a payment for the same student (which takes the same lock).
    const locked = await lockStudent(tx, organizationId, pre.studentId);
    if (!locked) return refuse("notFound");

    const current = await tx.duesObligation.findFirst({
      where: { id: pre.id, organizationId, type: "OPENING" },
      select: { id: true, cancelledAt: true, settlements: { where: { reversedAt: null }, select: { id: true } } },
    });
    if (!current) return refuse("notFound");
    if (current.cancelledAt !== null) return refuse("alreadyCancelled");
    if (current.settlements.length > 0) return refuse("hasActivePayment");

    const now = (deps.now ?? (() => new Date()))();
    const stored = storedCategorizedReason(reasonCategory, reason);
    await tx.duesObligation.update({
      where: { id: current.id, organizationId },
      data: { cancelledAt: now, cancelledById: context.actorUserId, cancellationReason: stored },
    });
    // A record only: the state lives on the obligation row itself and is never read back from here.
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        academyId: pre.academyId,
        action: "duesObligation.cancelOpening",
        entityType: "DuesObligation",
        entityId: current.id,
        before: { cancelledAt: null },
        after: { cancelledAt: now.toISOString(), cancelledById: context.actorUserId, cancellationReason: stored },
      },
    });
    return { ok: true, obligationId: current.id };
  });
}
