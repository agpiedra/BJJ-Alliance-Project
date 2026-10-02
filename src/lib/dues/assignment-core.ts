import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isPackagePlan } from "@/lib/dues/package-plans";
import { compareYearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { type Tx } from "@/lib/students/lock";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Deliberately NOT a "use server" file. `assignPlanInTx` and `resolvePlanId` take an already-open `tx` or plain,
 * already-trusted arguments (a `TenantContext`, resolved ids) and perform NO authentication, authorization, or
 * tenant-scoping of their own — they trust locks and validation their caller (`assignPlan`/`correctAssignment`
 * below, or the enrollment composition in `approve-student-core.ts`/`create-student-core.ts`) already did. In
 * Next.js, every exported async function in a "use server" file becomes a directly client-invocable server action
 * with a stable reference, regardless of intent — so these must live in a plain module, never a "use server" one,
 * or any client could call them with forged arguments and bypass every check their real callers perform.
 *
 * `assignment-actions.ts` (the "use server" file) imports both of these and exports only `assignPlan` and
 * `correctAssignment` — the genuinely public, already-authenticated actions.
 */

/**
 * Enrollment/resume integration plan §7.6: the transaction-aware core of `assignPlan`'s own create path, extracted
 * so the enrollment composition (`approveStudentInTx`, `createStudentInTx`) can create a NEW assignment inside its
 * OWN transaction, which already holds the branch+student locks in the established order BEFORE calling this —
 * exactly `writeMonthlyObligationInTx`'s own "narrow transaction-aware extraction" shape. Takes NO lock of its own
 * (the caller's student lock already provides what `assignPlan`'s own standalone `lockStudent` call exists to
 * give); trusts nothing else from its caller, repeating the identical fresh, under-the-lock current-month check
 * `assignPlan` already performs. The unique constraint on `(studentId, effectiveYear, effectiveMonth)` is the
 * backstop against a concurrent duplicate — this function does NOT catch that violation itself; it propagates to
 * the caller's own `$transaction`, to be caught OUTSIDE it, exactly like `assignPlan`'s own existing `catch`.
 */
export async function assignPlanInTx(
  tx: Tx,
  args: { context: TenantContext; studentId: string; homeAcademyId: string; timezone: string; planId: string | null; effectiveYear: number; effectiveMonth: number },
): Promise<{ ok: true; assignmentId: string } | { ok: false; error: "pastMonth" }> {
  const { context, studentId, homeAcademyId, timezone, planId, effectiveYear, effectiveMonth } = args;
  if (compareYearMonth({ year: effectiveYear, month: effectiveMonth }, currentMonthIn(timezone)) < 0) return { ok: false, error: "pastMonth" };
  const created = await tx.studentPlanAssignment.create({
    data: { organizationId: context.organizationId, studentId, planId, effectiveYear, effectiveMonth, createdById: context.actorUserId },
  });
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId: context.organizationId,
      academyId: homeAcademyId,
      action: "studentPlanAssignment.create",
      entityType: "StudentPlanAssignment",
      entityId: created.id,
      before: Prisma.DbNull,
      after: { studentId: created.studentId, planId: created.planId, effectiveYear: created.effectiveYear, effectiveMonth: created.effectiveMonth },
    },
  });
  return { ok: true, assignmentId: created.id };
}

/**
 * `planId` re-validated against the student's own branch and refused if it names a package plan (packages are bought explicitly, never assigned this way — PR 3's isolation design). Empty/blank means "explicitly unassigned" (null).
 * Reused by `assignPlan`/`correctAssignment` below and by the enrollment composition (`approveStudentInTx`, `createStudentInTx`) for a staff-supplied plan id, rather than a second, drifting copy.
 */
export async function resolvePlanId(organizationId: string, academyId: string, raw: string | null): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (raw === null || raw === "") return { ok: true, value: null };
  const plan = await prisma.paymentPlan.findUnique({ where: { id: raw, organizationId }, select: { id: true, academyId: true } });
  if (!plan || plan.academyId !== academyId) return { ok: false };
  if (await isPackagePlan(organizationId, plan.id)) return { ok: false };
  return { ok: true, value: plan.id };
}
