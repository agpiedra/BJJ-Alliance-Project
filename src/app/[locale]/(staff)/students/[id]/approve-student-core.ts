import { StudentStatus } from "@/generated/prisma/client";
import { grantStudentMembership } from "@/lib/students/student-membership";
import { lockStudent, type Tx } from "@/lib/students/lock";
import { appendStatusChange, todayInAsDbDate } from "@/lib/students/status-history";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { latestEffective, lockBranchShared, todayIn, toDbDate } from "@/lib/dues/ledger/common";
import { enrollmentChargeInTx } from "@/lib/dues/ledger/enrollment-charge";
import { assignPlanInTx } from "@/lib/dues/assignment-core";
import { EnrollmentRefusedError } from "@/lib/dues/enrollment-refused-error";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Deliberately NOT a "use server" file. `approveStudentInTx` takes an already-open `tx` and plain, already-trusted
 * arguments (a `TenantContext`, a pre-resolved student ref, an already-authorization-checked `planId`) and performs
 * NO authentication/authorization/tenant-scoping of its own — it trusts the locks and validation `approveStudent`
 * (`./actions.ts`) already did before opening its transaction. In Next.js, every exported async function in a
 * "use server" file becomes a directly client-invocable server action with a stable reference regardless of
 * intent — called directly, a client could forge a `TenantContext` claiming ADMIN in any organization, any student
 * id, and bypass `resolveActionContext`/`isAcademyInTenantScope` entirely. `actions.ts` imports this module and
 * exports only its genuinely public, already-authenticated actions.
 *
 * `StudentWriteMissError` also lives here (moved from `actions.ts`, message/name unchanged) rather than being
 * re-declared in both files: `instanceof` only matches the same class identity across a module boundary, and
 * `actions.ts` itself is "use server" (which may only export async functions) — the shared error class has to live
 * in a plain module either side can import, not in the "use server" file.
 *
 * Thrown inside a transaction purely to roll it back when the scoped `updateMany` matched no row (the row moved
 * academy, or was deleted, between the scope check and the write). Never surfaces to the caller — each action
 * catches it and returns the same `notFound`/`notPending`/etc. the pre-audit code did.
 */
export class StudentWriteMissError extends Error {
  constructor() {
    super("STUDENT_WRITE_MISS");
    this.name = "StudentWriteMissError";
  }
}

/**
 * Enrollment/resume integration plan §7.5-§7.6: the gated financial half of `approveStudent` (`./actions.ts`),
 * extracted into this `deps`-injectable core so `approveStudent`'s own exported signature never needs an activation
 * or date override — the identical composition boundary `resumeChargeInTx` already established in `actions.ts`.
 * `approveStudent` calls this with the default production `deps` ({}); only a test, importing `approveStudentInTx`
 * directly, ever exercises the branch below `notActive`.
 *
 * `planId` is the already-resolved, already-authorization-checked value `approveStudent` computed BEFORE opening
 * the transaction (via `resolvePlanId`) — this function trusts the LOCKS its caller does not yet hold (it takes its
 * own, in the established branch-then-student order) but re-validates the student's status/branch fresh under them,
 * exactly like `resumeChargeInTx`.
 *
 * Every refusal reached once a provisional write exists (a new `StudentPlanAssignment` row) THROWS
 * `EnrollmentRefusedError` — never `return`s — so `approveStudent`'s own `$transaction` rolls it back.
 * `StudentWriteMissError` (the PENDING precondition / a lost status-update race) is unchanged from this file's own
 * established pattern on both branches below.
 */
export async function approveStudentInTx(
  tx: Tx,
  args: { context: TenantContext; student: { id: string; organizationId: string; homeAcademyId: string; timezone: string; userId: string | null }; planId: string | null },
  deps: LedgerDeps = {},
): Promise<void> {
  const { context, student, planId } = args;
  const activation = deps.activation ?? inactiveLedgerActivation;
  const isActive = await activation.isActive(student.organizationId);

  if (!isActive) {
    // Byte-identical to today's code: no branch lock, no plan resolution, no ledger composition of any kind.
    const locked = await lockStudent(tx, student.organizationId, student.id);
    if (!locked) throw new StudentWriteMissError();
    const result = await tx.student.updateMany({
      where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.PENDING },
      data: { status: StudentStatus.ACTIVE },
    });
    if (result.count === 0) throw new StudentWriteMissError();
    const membership = await grantStudentMembership(tx, student);
    await appendStatusChange(tx, {
      organizationId: student.organizationId,
      studentId: student.id,
      status: StudentStatus.ACTIVE,
      effectiveOn: todayInAsDbDate(student.timezone, new Date()),
      source: "EVENT",
      actorId: context.actorUserId,
    });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId, organizationId: student.organizationId, academyId: student.homeAcademyId,
        action: "student.approve", entityType: "Student", entityId: student.id,
        before: { status: StudentStatus.PENDING }, after: { status: StudentStatus.ACTIVE, membership },
      },
    });
    return;
  }

  // Lock order: branch FOR SHARE, then student FOR UPDATE — this ledger's own established sequence, reversing
  // approveStudent's own inactive-path order on this gated path only (the identical reordering §2-§4 already proved
  // out for resumeStudent).
  const branch = await lockBranchShared(tx, student.organizationId, student.homeAcademyId);
  if (!branch) throw new StudentWriteMissError();
  const locked = await lockStudent(tx, student.organizationId, student.id);
  if (!locked || locked.homeAcademyId !== student.homeAcademyId) throw new StudentWriteMissError();
  const fresh = await tx.student.findUniqueOrThrow({ where: { id: student.id, organizationId: student.organizationId }, select: { status: true } });
  if (fresh.status !== StudentStatus.PENDING) throw new StudentWriteMissError();

  // ONE enrollment instant, captured under lock — reused for both the status-history effectiveOn and the ledger
  // charge's own enrollment date, never a second clock read (D13: a self-registered student's E is the branch-local
  // APPROVAL date).
  const now = (deps.now ?? (() => new Date()))();
  const enrollmentDate = todayIn(branch.timezone, now);

  const assignments = await tx.studentPlanAssignment.findMany({ where: { organizationId: student.organizationId, studentId: student.id }, select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true } });
  const existing = latestEffective(assignments, enrollmentDate);
  let assignedPlanId: string | null;
  if (existing) {
    // §7.6: an existing assignment for the enrollment month is reused, never silently overwritten. A DIFFERENT
    // supplied plan is a conflict, not an update — StudentPlanAssignment correction is `correctAssignment`'s own,
    // separate, deliberate action.
    if (planId !== null && planId !== existing.planId) throw new EnrollmentRefusedError("planConflict");
    assignedPlanId = existing.planId;
  } else if (planId !== null) {
    // Creating a NEW assignment is ADMIN-only (assignPlan's own existing restriction, §7.6) — a DIRECTOR supplying
    // one here is refused explicitly, never silently ignored and never silently allowed.
    if (context.organizationRole !== "ADMIN") throw new EnrollmentRefusedError("requiresAdmin");
    const assigned = await assignPlanInTx(tx, {
      context, studentId: student.id, homeAcademyId: student.homeAcademyId, timezone: branch.timezone,
      planId, effectiveYear: enrollmentDate.year, effectiveMonth: enrollmentDate.month,
    });
    // pastMonth is structurally unreachable here (enrollmentDate is THIS transaction's own "now", by construction
    // never in the past) — treated as a genuine refusal if it ever occurs, never silently ignored.
    if (!assigned.ok) throw new EnrollmentRefusedError("inapplicable");
    assignedPlanId = planId;
  } else {
    // No existing assignment and none supplied: assignedPlanId stays null — enrollmentChargeInTx correctly refuses
    // this as a genuine configuration gap (§7.5), not a special case here.
    assignedPlanId = null;
  }

  const charge = await enrollmentChargeInTx(tx, { context, student: { id: student.id, homeAcademyId: student.homeAcademyId }, enrollmentDate, assignedPlanId }, deps);
  if (!charge.ok) {
    if (charge.error === "notActive" || charge.error === "notFound") throw new EnrollmentRefusedError("inapplicable");
    throw new EnrollmentRefusedError(charge.error);
  }

  const result = await tx.student.updateMany({
    where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.PENDING },
    data: { status: StudentStatus.ACTIVE },
  });
  if (result.count === 0) throw new StudentWriteMissError();
  const membership = await grantStudentMembership(tx, student);
  await appendStatusChange(tx, {
    organizationId: student.organizationId, studentId: student.id, status: StudentStatus.ACTIVE,
    effectiveOn: toDbDate(enrollmentDate), source: "EVENT", actorId: context.actorUserId,
  });
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId, organizationId: student.organizationId, academyId: student.homeAcademyId,
      action: "student.approve", entityType: "Student", entityId: student.id,
      before: { status: StudentStatus.PENDING }, after: { status: StudentStatus.ACTIVE, membership, signupObligationId: charge.signupObligationId, monthlyObligationId: charge.monthlyObligationId },
    },
  });
}
