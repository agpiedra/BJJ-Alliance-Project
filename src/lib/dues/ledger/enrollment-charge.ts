import { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenant/types";
import { compareDates, dueDateFor, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, latestEffective, lockPolicyShared, lockTermsShared, toDbDate, type Tx } from "@/lib/dues/ledger/common";
import { writeMonthlyObligationInTx } from "@/lib/dues/ledger/create-monthly-obligation";
import { isPackagePlan } from "@/lib/dues/package-plans";

/**
 * Enrollment/resume integration plan §7.5/§7.6: the gated financial core composed by BOTH `approveStudent` and
 * `createStudent` (actions.ts / create-student-action.ts), AFTER each has already resolved (and, for an ADMIN
 * creating a new one, written) the student's plan assignment for the enrollment month under the already-held
 * branch+student locks (§7.6's own two sequences). This function takes no lock of its own — it trusts the locks its
 * caller already holds, exactly like `assignPlanInTx` (assignment-actions.ts) — but it repeats every OTHER check
 * (activation, tenant scope, package-shape, configuration resolution) itself, trusting nothing else from its caller,
 * matching this ledger's own established "the inner function trusts nothing but the lock" discipline
 * (writeMonthlyObligationInTx is the precedent).
 *
 * `assignedPlanId: null` means "no assignment resolves for this student/month at all" — refused `inapplicable`
 * (a configuration gap), never silently skipped. The package-plan refusal (`unsupportedEnrollmentPlan`) and every
 * configuration-gap refusal (`inapplicable` / `staleVersion` / `currencyMismatch` / `notFound`) are deliberately
 * DISTINCT error values (plan §7.5: "two distinct, named refusals... never collapsed into one generic error").
 *
 * On ANY `ok: false` here, NOTHING has been written by this function — the caller's own already-provisional writes
 * (the student row for staff-creation, the assignment row for either path) must be rolled back by THROWING a
 * tagged error from inside its own `$transaction` callback, never by `return`ing one (plan §7.6: a `return` commits
 * whatever Prisma already wrote).
 */
export type EnrollmentChargeError = "notActive" | "notFound" | "unsupportedEnrollmentPlan" | "inapplicable" | "staleVersion" | "currencyMismatch";

export type EnrollmentChargeResult =
  | { ok: true; signupObligationId: string; monthlyObligationId: string | null }
  | { ok: false; error: EnrollmentChargeError };

const refuse = (error: EnrollmentChargeError): EnrollmentChargeResult => ({ ok: false, error });

export async function enrollmentChargeInTx(
  tx: Tx,
  args: {
    context: TenantContext;
    student: { id: string; homeAcademyId: string };
    /** D13: the branch-local enrollment date itself (approval date, or creation date for staff-created students). */
    enrollmentDate: CalendarDate;
    /** The student's resolved effective assignment for the enrollment month, or null for "no assignment at all". */
    assignedPlanId: string | null;
  },
  deps: LedgerDeps = {},
): Promise<EnrollmentChargeResult> {
  const { context, student, enrollmentDate, assignedPlanId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");
  if (!inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  // D14/§7.5: no assignment at all is a configuration gap, not an implicit "nothing to charge" — enrollment always
  // needs a priced monthly plan to produce the initial charge.
  if (!assignedPlanId) return refuse("inapplicable");
  // §7.3/§7.5, corrected: package-shaped terms REFUSE the whole enrollment attempt. This is checked before any
  // terms/policy resolution below, and is a DIFFERENT, named error from every configuration-gap case.
  if (await isPackagePlan(organizationId, assignedPlanId)) return refuse("unsupportedEnrollmentPlan");

  const coverage: YearMonth = { year: enrollmentDate.year, month: enrollmentDate.month };

  // Resolve the plan's effective terms for the enrollment month — the identical lock-then-read-then-staleness
  // sequence writeMonthlyObligationInTx itself uses (create-monthly-obligation.ts), not a second, drifting copy.
  const termsCandidates = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: assignedPlanId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const termsCandidate = latestEffective(termsCandidates, coverage);
  if (!termsCandidate) return refuse("inapplicable");
  if (!(await lockTermsShared(tx, organizationId, termsCandidate.id))) return refuse("notFound");
  const terms = await tx.paymentPlanTerms.findFirstOrThrow({ where: { id: termsCandidate.id, organizationId } });
  const termsHistory = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: terms.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  if (latestEffective(termsHistory, coverage)?.id !== terms.id) return refuse("staleVersion");
  const plan = await tx.paymentPlan.findFirst({ where: { id: terms.planId, organizationId }, select: { academyId: true } });
  if (!plan || plan.academyId !== student.homeAcademyId || terms.monthsCovered !== 1) return refuse("inapplicable");

  // The branch's own effective policy for the enrollment month — needed ONLY to know the branch's configured due
  // day (to decide before-vs-on/after the due day, D13/§7.2), never stored on the SIGNUP row itself (it has no
  // policyVersionId: it never incurs a late fee and is never driven by this policy's grace/fee fields).
  const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: student.homeAcademyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const policyCandidate = latestEffective(policyHistory, coverage);
  if (!policyCandidate) return refuse("inapplicable");
  if (!(await lockPolicyShared(tx, organizationId, policyCandidate.id))) return refuse("notFound");
  const policy = await tx.duesPolicyVersion.findFirstOrThrow({ where: { id: policyCandidate.id, organizationId } });
  if (latestEffective(policyHistory, coverage)?.id !== policy.id || policy.academyId !== student.homeAcademyId) return refuse("inapplicable");
  if (terms.currency !== policy.lateFeeCurrency) return refuse("currencyMismatch");

  const amount = terms.priceAmount.toFixed(2);
  const signup = await tx.duesObligation.create({
    data: {
      organizationId,
      studentId: student.id,
      academyId: student.homeAcademyId,
      type: "SIGNUP",
      origin: "STAFF",
      coverageYear: enrollmentDate.year,
      coverageMonth: enrollmentDate.month,
      monthsCovered: 1,
      amount,
      currency: terms.currency,
      lateFeeAmount: null,
      dueOn: toDbDate(enrollmentDate),
      graceDeadline: null,
      planTermsId: terms.id,
      policyVersionId: null,
      createdById: context.actorUserId,
    },
  });
  // Zero DuesCoverage rows, by design (plan §7.5): SIGNUP claims no month's coverage, which is exactly what lets it
  // coexist with the same month's own MONTHLY below without any change to DuesCoverage's own unconditional
  // per-student-per-month uniqueness.
  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: student.homeAcademyId,
      action: "duesObligation.create",
      entityType: "DuesObligation",
      entityId: signup.id,
      before: Prisma.DbNull,
      after: { studentId: student.id, type: "SIGNUP", amount, currency: terms.currency, dueOn: `${enrollmentDate.year}-${String(enrollmentDate.month).padStart(2, "0")}-${String(enrollmentDate.day).padStart(2, "0")}`, planTermsId: terms.id },
    },
  });

  // D13/§7.2: before the branch's configured due day, the enrollment month's own MONTHLY is created too; on or
  // after it, only SIGNUP — the scheduled job creates the FOLLOWING month's MONTHLY on its own normal schedule.
  const normalMonthlyDue = dueDateFor(coverage, policy.dueDay);
  let monthlyObligationId: string | null = null;
  if (compareDates(enrollmentDate, normalMonthlyDue) < 0) {
    const written = await writeMonthlyObligationInTx(tx, { context, student, coverage, planTermsId: terms.id, policyVersionId: policy.id, origin: "STAFF" }, deps);
    // Unreachable in practice for a brand-new enrollment (no coverage/obligation can already exist for a student
    // being enrolled right now) — but trusted as a REAL refusal if it ever occurs, never silently ignored: any
    // ok:false here is a genuine configuration/currency problem writeMonthlyObligationInTx itself found, and this
    // whole enrollment attempt refuses because of it (the SIGNUP row written above rolls back with everything else
    // once the caller throws on this refusal, per §7.6's throw-not-return requirement).
    if (!written.ok) {
      if (written.error === "currencyMismatch") return refuse("currencyMismatch");
      return refuse("inapplicable");
    }
    monthlyObligationId = written.obligationId;
  }

  return { ok: true, signupObligationId: signup.id, monthlyObligationId };
}
