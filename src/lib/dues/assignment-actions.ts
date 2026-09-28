"use server";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { isPackagePlan } from "@/lib/dues/package-plans";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, parseEffectiveMonth, versionRevision } from "@/lib/dues/config-input";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { lockStudent, type Tx } from "@/lib/students/lock";
import type { ActionState } from "@/lib/action-state";

/**
 * Eligibility-prerequisites brief, section 6.1: `StudentPlanAssignment` writer, owners only (approved: NOT inferred from the
 * roster-management gate `pauseStudent`/`resumeStudent`/`archiveStudent` use — assigning a plan is a money-adjacent decision, a
 * roster one). No UI in this PR; a plain server action, tested directly, exactly like PR 4a's ledger writers before their caller.
 *
 * `planId: null` is a first-class value ("explicitly unassigned from this month" — the schema's own comment), distinct from no
 * row existing at all for that month (undecidable — section 6.2). Assignment is append-only: a month already assigned is
 * refused, never silently overwritten, and only a strictly-future assignment may be corrected (D25's own protections, reused
 * exactly: an `expectedRevision` token refuses a stale edit rather than merging over it).
 *
 * No reference-protecting trigger exists for this table (unlike PR 2B's terms/policy) — 6.1 explains why this holds only for
 * today's writers and documents the prerequisite for prepayment.
 *
 * Monthly-generation brief §5.1: `assignPlan` locks the student row (`lockStudent`, the same primitive every status action already
 * uses, imported from its neutral location so this file never imports anything under `src/lib/dues/ledger/`) before its create, so a
 * first-time current-month assignment is strictly serialized against a concurrent monthly-generation attempt for the same student —
 * whichever transaction acquires the lock first fully determines what the other sees. `correctAssignment` needs no such lock: its own
 * `notFuture` precondition already makes it structurally incapable of touching a current-month row.
 *
 * The current-month check is evaluated ONCE, inside the transaction, right after the lock — never before it. A pre-lock check would
 * race the wait itself: a month current when the check ran can turn past while this call sat blocked behind a concurrent holder.
 */

type Rejection = { rejected: string };
const reject = (code: string): Rejection => ({ rejected: code });
const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** The assignment row, `FOR UPDATE` — locked before its revision token is checked and before it is corrected. */
async function lockAssignment(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<{ id: string; planId: string | null; effectiveYear: number; effectiveMonth: number } | null> {
  const rows = await tx.$queryRaw<{ id: string; planId: string | null; effectiveYear: number; effectiveMonth: number }[]>`
    SELECT "id", "planId", "effectiveYear", "effectiveMonth" FROM "StudentPlanAssignment"
    WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return rows[0] ?? null;
}

const assignmentRevision = (row: { planId: string | null }) => versionRevision({ planId: row.planId });

/** `planId` re-validated against the student's own branch and refused if it names a package plan (packages are bought explicitly, never assigned this way — PR 3's isolation design). Empty/blank means "explicitly unassigned" (null). */
async function resolvePlanId(organizationId: string, academyId: string, raw: string | null): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (raw === null || raw === "") return { ok: true, value: null };
  const plan = await prisma.paymentPlan.findUnique({ where: { id: raw, organizationId }, select: { id: true, academyId: true } });
  if (!plan || plan.academyId !== academyId) return { ok: false };
  if (await isPackagePlan(organizationId, plan.id)) return { ok: false };
  return { ok: true, value: plan.id };
}

/** Add an effective-month plan assignment for a student. */
export async function assignPlan(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const studentId = text(formData, "studentId");
  const student = studentId
    ? await getScopedDb(context).student.findUnique({
        where: { id: studentId },
        select: { id: true, organizationId: true, homeAcademyId: true, homeAcademy: { select: { timezone: true } } },
      })
    : null;
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) return { error: "notFound" };

  const month = parseEffectiveMonth(text(formData, "effectiveYear"), text(formData, "effectiveMonth"));
  if (!month.ok) return { error: "invalid", fieldErrors: { effectiveMonth: ["invalid"] } };

  const plan = await resolvePlanId(context.organizationId, student.homeAcademyId, text(formData, "planId"));
  if (!plan.ok) return { error: "invalid", fieldErrors: { planId: ["invalid"] } };

  let outcome: Rejection | null;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const locked = await lockStudent(tx, context.organizationId, student.id);
      if (!locked) return reject("notFound"); // vanished between the pre-transaction read and the lock — no live path today
      // Evaluated fresh, under the lock, not before it: a month current when this action started can turn past while it waited
      // for a concurrent holder (monthly-generation.ts brief §5) — checking before the wait would miss that.
      if (compareYearMonth(month.value, currentMonthIn(student.homeAcademy.timezone)) < 0) return reject("pastMonth");
      const created = await tx.studentPlanAssignment.create({
        data: {
          organizationId: context.organizationId,
          studentId: student.id,
          planId: plan.value,
          effectiveYear: month.value.year,
          effectiveMonth: month.value.month,
          createdById: context.actorUserId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: student.homeAcademyId,
          action: "studentPlanAssignment.create",
          entityType: "StudentPlanAssignment",
          entityId: created.id,
          before: Prisma.DbNull,
          after: { studentId: created.studentId, planId: created.planId, effectiveYear: created.effectiveYear, effectiveMonth: created.effectiveMonth },
        },
      });
      return null;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "monthAssigned" };
    throw error;
  }

  if (outcome) return { error: outcome.rejected };
  return { ok: true };
}

/**
 * D25 for a student's plan assignment: a strictly-future assignment may be corrected in place (`planId` only — the student and
 * effective month are the row's identity and never change). Current and past assignments are immutable, full stop.
 */
export async function correctAssignment(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const assignmentId = text(formData, "assignmentId");
  const expectedRevision = text(formData, "expectedRevision");
  const found = assignmentId
    ? await prisma.studentPlanAssignment.findFirst({
        where: { id: assignmentId, organizationId: context.organizationId },
        select: { id: true, student: { select: { homeAcademyId: true, homeAcademy: { select: { timezone: true } } } } },
      })
    : null;
  if (!found || !isAcademyInTenantScope(context, found.student.homeAcademyId)) return { error: "notFound" };
  if (expectedRevision === null) return { error: "invalid", fieldErrors: { expectedRevision: ["invalid"] } };

  const plan = await resolvePlanId(context.organizationId, found.student.homeAcademyId, text(formData, "planId"));
  if (!plan.ok) return { error: "invalid", fieldErrors: { planId: ["invalid"] } };

  let outcome: Rejection | null;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const row = await lockAssignment(tx, context.organizationId, found.id);
      if (!row) return reject("notFound");
      const rowMonth: YearMonth = { year: row.effectiveYear, month: row.effectiveMonth };
      if (compareYearMonth(rowMonth, currentMonthIn(found.student.homeAcademy.timezone)) <= 0) return reject("notFuture");
      if (assignmentRevision(row) !== expectedRevision) return reject("stale");

      const updated = await tx.studentPlanAssignment.update({
        where: { id: row.id, organizationId: context.organizationId },
        data: { planId: plan.value },
      });
      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: context.organizationId,
          academyId: found.student.homeAcademyId,
          action: "studentPlanAssignment.correct",
          entityType: "StudentPlanAssignment",
          entityId: row.id,
          before: { planId: row.planId },
          after: { planId: updated.planId },
        },
      });
      return null;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "monthAssigned" };
    throw error;
  }

  if (outcome) return { error: outcome.rejected };
  return { ok: true };
}
