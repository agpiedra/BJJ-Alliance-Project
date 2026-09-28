import type { TenantContext } from "@/lib/tenant/types";
import { assessLateFeeInTx, type AssessLateFeeError } from "@/lib/dues/ledger/record-payment";
import { inTenantScope, lockStudent, todayIn } from "@/lib/dues/ledger/common";
import type { LedgerDeps } from "@/lib/dues/ledger/activation";
import { prisma } from "@/lib/prisma";

/**
 * Late-fee-assessment brief (§3, §8): the proactive runner. One transaction per student — `lockStudent` first, the exact lock
 * `recordDuesPayment` already takes for the same tables — reading that student's open `MONTHLY` obligations and calling
 * `assessLateFeeInTx` (`record-payment.ts`) for each, by id. `assessLateFeeInTx` re-reads everything itself under this same lock;
 * this runner supplies nothing but the id, `today` (in the branch's own timezone, never the server's), and `actorId: null` — the
 * existing "null for an automated system action" convention (`AuditLog.actorId`'s own doc comment), since nothing human triggered
 * this call.
 *
 * No route, no server action, no scheduler entry (`vercel.json`'s `crons` array untouched) — a plain library function, tested by
 * calling it directly, closed by the same `LedgerActivation` default `assessLateFeeInTx` itself checks.
 */
export type LateFeeAssessmentOutcome =
  | { obligationId: string; category: "assessed"; feeId: string }
  | { obligationId: string; category: "alreadyAssessed"; feeId: string }
  | { obligationId: string; category: "notOwed" }
  | { obligationId: string; category: "failure"; reason: AssessLateFeeError };

export type LateFeeAssessmentResult =
  | { ok: true; outcomes: LateFeeAssessmentOutcome[] }
  | { ok: false; reason: "notFound" | "conflict" | "unexpected"; detail?: unknown };

export async function assessLateFeesForStudent(context: TenantContext, studentId: string, deps: LedgerDeps = {}): Promise<LateFeeAssessmentResult> {
  const organizationId = context.organizationId;

  // Re-read the student scoped to the organization; a forged or foreign id is a failure, never trusted — the same discipline
  // every other ledger-adjacent caller in this codebase already uses.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { ok: false, reason: "notFound" };

  try {
    return await prisma.$transaction(async (tx): Promise<LateFeeAssessmentResult> => {
      const locked = await lockStudent(tx, organizationId, student.id);
      if (!locked || locked.homeAcademyId !== student.homeAcademyId) return { ok: false, reason: "conflict" };
      // A plain read, not a lock — exactly recordDuesPayment's own pattern (it never takes lockBranchShared either): this path
      // never touches branch-level pricing configuration, only the obligation's own immutable snapshot, so there is nothing to
      // serialize against here beyond the student lock already held.
      const branch = await tx.academy.findFirst({ where: { id: student.homeAcademyId, organizationId }, select: { timezone: true } });
      if (!branch) return { ok: false, reason: "notFound" };
      const today = todayIn(branch.timezone, (deps.now ?? (() => new Date()))());

      const obligations = await tx.duesObligation.findMany({ where: { organizationId, studentId: student.id, type: "MONTHLY" }, select: { id: true } });

      const outcomes: LateFeeAssessmentOutcome[] = [];
      for (const o of obligations) {
        const result = await assessLateFeeInTx(tx, { context, obligationId: o.id, asOf: today, actorId: null }, deps);
        if (!result.ok) {
          outcomes.push({ obligationId: o.id, category: "failure", reason: result.error });
        } else if (result.feeId === null) {
          outcomes.push({ obligationId: o.id, category: "notOwed" });
        } else {
          outcomes.push({ obligationId: o.id, category: result.created ? "assessed" : "alreadyAssessed", feeId: result.feeId });
        }
      }
      return { ok: true, outcomes };
    });
  } catch (error) {
    return { ok: false, reason: "unexpected", detail: error instanceof Error ? error.message : error };
  }
}
