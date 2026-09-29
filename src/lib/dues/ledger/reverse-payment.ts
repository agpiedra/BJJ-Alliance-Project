import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, lockStudent } from "@/lib/dues/ledger/common";

/**
 * Payment-reversal brief: reverse a recorded payment and every one of its active settlements, atomically, in one transaction. A
 * plain library function: no server action, route, job or scheduler entry, closed by default (see `activation.ts`).
 *
 * Reversing a settlement is enough on its own to make its obligation unpaid again — verified, not new logic here:
 * `recordDuesPayment`/`recordDuesPaymentInTx` and `assessLateFeeInTx` already filter `settlements: { where: { reversedAt: null } }`
 * everywhere they decide what's outstanding. This writer never touches `DuesObligation` or `DuesCoverage` at all; it has no code
 * path that reaches either.
 *
 * TWO POLICY DECISIONS, BOTH APPROVED (see PAYMENT-REVERSAL-BRIEF.md §2):
 *  - Decision A: reversing a settlement that included a valid, never-voided late fee makes BOTH the tuition and the fee owed
 *    again. This needs no special handling — the `DuesLateFee` row is never touched here, so it is already exactly where it
 *    should be; a later payment naturally re-includes it (`asTerms`/`feeOwed` in `record-payment.ts` depend only on `removedAt`).
 *  - Decision B, a TEMPORARY RESTRICTION, not a permanent policy: if any obligation behind the settlements being reversed has a
 *    `DuesLateFee` row with `removalKind: "VOIDED"`, this refuses the WHOLE reversal (`voidedFeeBlocksReversal`) and writes
 *    nothing. This is a conservative check keyed on the obligation's CURRENT fee state alone — it does not claim, and does not
 *    need to prove, that the specific payment being reversed is what caused that void. No provenance field links a settlement to
 *    "the void it caused," and none is added here; restoring, cancelling, or otherwise deciding what happens to a voided fee is
 *    explicitly out of scope until that policy is decided.
 *
 * MONTHLY-PREPAYMENT BRIEF §8, APPROVED, A READINESS-REVIEW ITEM: if any obligation behind the settlements being reversed has
 * `origin: "PREPAYMENT"`, this refuses the WHOLE reversal (`prepaymentBlocksReversal`), PERMANENTLY — `origin` never changes
 * back, so this restriction never lifts once the obligation's coverage month becomes current or past, even though it then looks,
 * in every other respect, like an ordinary settled obligation. A `MONTHLY` `type` alone cannot distinguish a prepayment purchase
 * from an ordinary obligation (prepayment would plausibly also use `type: MONTHLY`, just a not-yet-current `coverageMonth`), so
 * `origin` is what this check is keyed on instead. Because reversal is whole-payment, not partial, a payment that combined
 * ordinary current debt with even one prepaid future month becomes entirely unreversible through this writer — including the
 * ordinary-debt portion. This is deliberate and conservative, pending a real prepayment-reversal/cancellation policy this writer
 * does not design, and is tracked as a standing limitation for the readiness/activation review (`scripts/pending-callers.ts`).
 *
 * SUPPORTED SCOPE: `type: "MONTHLY"` obligations only, refused otherwise (`unsupportedObligationType`) — a defensive boundary
 * checked at runtime, not proof that nothing else can exist. `DuesSettlement`'s own foreign key carries no type restriction, and
 * `type: "MONTHLY"` does NOT distinguish an ordinary obligation from a future prepayment purchase (prepayment would plausibly
 * also use `type: MONTHLY`, just a not-yet-current `coverageMonth` — `createMonthlyObligation`'s unconditional `futureMonth`
 * refusal is the only reason no such row exists yet, not the type column). Supporting prepayment or package settlements later
 * means this writer must be revisited and re-verified BEFORE either of those writers is ever exposed to production use — this
 * check is what stops it from silently mishandling a case nobody has designed for yet, today with no live path to reach it.
 *
 * Trusts nothing from before the student lock: the payment, its settlements, and their obligations' fee state are all re-read
 * fresh under `lockStudent`, the same discipline `correctLateFeeAndSettle` already established. Also refuses
 * (`inconsistentState`) if the payment and its settlements ever disagree about being reversed — a state nothing today can
 * produce (this is the only reversal writer), checked explicitly rather than assumed impossible.
 */
export type ReversePaymentError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "alreadyReversed"
  | "inconsistentState"
  | "unsupportedObligationType"
  | "voidedFeeBlocksReversal"
  | "prepaymentBlocksReversal";

export type ReversePaymentResult = { ok: true; paymentId: string; settlementIds: string[] } | { ok: false; error: ReversePaymentError };

const refuse = (error: ReversePaymentError): ReversePaymentResult => ({ ok: false, error });

type SettlementState = { id: string; reversedAt: Date | null; obligation: { type: string; origin: string; lateFees: { removalKind: string | null }[] } };

export async function reversePayment(
  args: { context: TenantContext; paymentId: string; reversalReason: string },
  deps: LedgerDeps = {},
): Promise<ReversePaymentResult> {
  const { context, paymentId, reversalReason } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  // Owner-only, checked here rather than trusted from whatever eventually calls this — the same discipline
  // `correctLateFeeAndSettle` already applied to its own role requirement.
  if (context.organizationRole !== "ADMIN") return refuse("notFound");
  if (typeof paymentId !== "string" || paymentId === "") return refuse("invalid");
  if (typeof reversalReason !== "string" || reversalReason.trim() === "") return refuse("invalid"); // refuse cleanly; don't let a blank reason surface as a raw DB constraint violation

  const select = {
    id: true,
    studentId: true,
    academyId: true,
    reversedAt: true,
    settlements: {
      select: {
        id: true,
        reversedAt: true,
        obligation: { select: { type: true, origin: true, lateFees: { select: { removalKind: true } } } },
      },
    },
  } as const;

  const payment = await prisma.duesPayment.findFirst({ where: { id: paymentId, organizationId }, select });
  if (!payment || !inTenantScope(context, payment.academyId)) return refuse("notFound");

  return await prisma.$transaction(async (tx): Promise<ReversePaymentResult> => {
    // The student row FOR UPDATE serializes this reversal against a concurrent payment, assessment run, or correction attempt
    // for the same student — whichever acquires the lock first fully determines what the others see.
    const locked = await lockStudent(tx, organizationId, payment.studentId);
    if (!locked || locked.homeAcademyId !== payment.academyId) return refuse("notFound");

    // Re-read everything fresh under the lock — the pre-lock read above could already be stale by the time the lock is held.
    const current = await tx.duesPayment.findFirst({ where: { id: paymentId, organizationId }, select });
    if (!current) return refuse("notFound");
    if (current.reversedAt !== null) return refuse("alreadyReversed");

    // Defensive: nothing today can reverse a settlement independent of its payment, so this shouldn't be reachable — checked
    // explicitly rather than assumed impossible, the same "trust nothing" discipline applied everywhere else in this ledger.
    const settlements = current.settlements as SettlementState[];
    if (settlements.some((s) => s.reversedAt !== null)) return refuse("inconsistentState");

    if (settlements.some((s) => s.obligation.type !== "MONTHLY")) return refuse("unsupportedObligationType");
    if (settlements.some((s) => s.obligation.lateFees.some((f) => f.removalKind === "VOIDED"))) return refuse("voidedFeeBlocksReversal");
    if (settlements.some((s) => s.obligation.origin === "PREPAYMENT")) return refuse("prepaymentBlocksReversal");

    const reversedAt = (deps.now ?? (() => new Date()))();
    const reason = reversalReason.trim();
    await tx.duesPayment.update({
      where: { id: current.id, organizationId },
      data: { reversedAt, reversedById: context.actorUserId, reversalReason: reason },
    });
    if (settlements.length > 0) {
      await tx.duesSettlement.updateMany({
        where: { organizationId, paymentId: current.id, reversedAt: null },
        data: { reversedAt, reversedById: context.actorUserId, reversalReason: reason },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        academyId: payment.academyId,
        action: "duesPayment.reverse",
        entityType: "DuesPayment",
        entityId: current.id,
        before: { reversedAt: null },
        after: { reversedAt: reversedAt.toISOString(), reversedById: context.actorUserId, reversalReason: reason, settlementIds: settlements.map((s) => s.id) },
      },
    });

    if (deps.afterReversalMarkersForTest) await deps.afterReversalMarkersForTest();

    return { ok: true, paymentId: current.id, settlementIds: settlements.map((s) => s.id) };
  });
}
