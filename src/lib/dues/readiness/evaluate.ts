import { compareDates, compareYearMonth, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import { eligibleAndAssigned, type AssignmentRow, type StatusHistoryRow } from "@/lib/dues/eligibility";
import { latestEffective } from "@/lib/dues/ledger/common";
import { decimalToMinor, minorToDecimal } from "@/lib/dues/ledger/minor-units";
import type { StudentStatus } from "@/generated/prisma/client";
import { branchFingerprint, organizationFingerprint, studentFingerprint } from "@/lib/dues/readiness/fingerprint";
import type { ReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Stage 8 PR 8a (docs/dues/STAGE-8-READINESS-BRIEF.md §10/§12): a pure evaluation of one organization's snapshot for a
 * candidate start month S. It writes nothing, reads no clock and calls no writer.
 *
 * NEVER FALSELY READY: `ready` is true only when every check is `pass`. Checks whose machinery does not exist yet report
 * `notImplemented`, and an undecided owner policy reports `decisionPending` — neither is ever treated as passing, so on
 * today's code `ready` is always false.
 */
export type CheckStatus = "pass" | "fail" | "notImplemented" | "decisionPending";

export interface ReadinessCheck {
  id: number;
  key: string;
  status: CheckStatus;
  detail: string;
  /** Affected rows, as `student:<id>`, `branch:<id>` or `legacy:<id>`. */
  items: string[];
}

/** What `generateMonthlyObligationForStudent` would do for this student and S, decided by the same rules in the same order. */
export type StudentPreview =
  | { studentId: string; academyId: string; outcome: "created"; amount: string; currency: string }
  | { studentId: string; academyId: string; outcome: "alreadyCovered"; reason: "existingObligation" | "packageCoverage" }
  | { studentId: string; academyId: string; outcome: "notEligible"; reason: "UNDECIDABLE" | "NOT_ELIGIBLE" | "NO_ASSIGNMENT" }
  | { studentId: string; academyId: string; outcome: "configurationGap"; reason: "noEffectiveVersion" | "inapplicable" | "currencyMismatch" };

export interface BranchPreview {
  academyId: string;
  /** One entry per currency; amounts are never added across currencies. */
  wouldCreate: { currency: string; count: number; total: string }[];
  undecidable: string[];
  notEligible: string[];
  explicitNoPlan: string[];
  unassigned: string[];
  configurationGap: string[];
}

export interface ReadinessReport {
  candidate: YearMonth;
  ready: boolean;
  checks: ReadinessCheck[];
  warnings: { key: string; items: string[] }[];
  notes: string[];
  preview: { students: StudentPreview[]; branches: BranchPreview[] };
  fingerprints: { organization: string; branches: Record<string, string>; students: Record<string, string> };
}

const toDate = (iso: string): CalendarDate => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });
const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

function previewStudent(snapshot: ReadinessSnapshot, student: ReadinessSnapshot["students"][number], s: YearMonth): StudentPreview {
  const base = { studentId: student.id, academyId: student.homeAcademyId };
  const planAcademy = new Map(snapshot.plans.map((p) => [p.id, p.academyId]));
  const statusHistory: StatusHistoryRow[] = snapshot.statusChanges
    .filter((r) => r.studentId === student.id)
    .map((r) => ({ effectiveOn: toDate(r.effectiveOn), sequence: r.sequence, status: r.status as StudentStatus }));
  const assignments: AssignmentRow[] = snapshot.assignments
    .filter((r) => r.studentId === student.id)
    .map((r) => ({ effectiveYear: r.effectiveYear, effectiveMonth: r.effectiveMonth, planId: r.planId, planAcademyId: r.planId ? (planAcademy.get(r.planId) ?? null) : null }));

  // Same rules, same order as generateMonthlyObligationForStudent → createMonthlyObligationInTx (without their locks). The
  // writer's run-time `futureMonth` refusal (S later than its own clock) is deliberately not mirrored: this predicts the run
  // DURING S, when S is the current month (tests/integration/dues-readiness.test.ts runs the writer with its clock in S).
  const eligibility = eligibleAndAssigned(statusHistory, assignments, student.homeAcademyId, s);
  if (eligibility.outcome !== "ELIGIBLE") return { ...base, outcome: "notEligible", reason: eligibility.outcome };

  const terms = latestEffective(snapshot.terms.filter((t) => t.planId === eligibility.planId), s);
  const policy = latestEffective(snapshot.policies.filter((p) => p.academyId === student.homeAcademyId), s);
  if (!terms || !policy) return { ...base, outcome: "configurationGap", reason: "noEffectiveVersion" };

  if (snapshot.monthlyObligations.some((o) => o.studentId === student.id && o.coverageYear === s.year && o.coverageMonth === s.month)) {
    return { ...base, outcome: "alreadyCovered", reason: "existingObligation" };
  }
  if (snapshot.coverage.some((c) => c.studentId === student.id && c.year === s.year && c.month === s.month)) {
    return { ...base, outcome: "alreadyCovered", reason: "packageCoverage" };
  }

  if (planAcademy.get(terms.planId) !== student.homeAcademyId || policy.academyId !== student.homeAcademyId || terms.monthsCovered !== 1) {
    return { ...base, outcome: "configurationGap", reason: "inapplicable" };
  }
  if (terms.currency !== policy.lateFeeCurrency) return { ...base, outcome: "configurationGap", reason: "currencyMismatch" };
  return { ...base, outcome: "created", amount: terms.priceAmount, currency: terms.currency };
}

export function evaluateReadiness(snapshot: ReadinessSnapshot, candidate: YearMonth): ReadinessReport {
  const s = candidate;
  const gOfS: CalendarDate = { year: s.year, month: s.month, day: 1 };
  const students = [...snapshot.students].sort((a, b) => (a.id < b.id ? -1 : 1));
  const previews = students.map((student) => previewStudent(snapshot, student, s));
  const active = students.filter((st) => st.status === "ACTIVE");
  const planAcademy = new Map(snapshot.plans.map((p) => [p.id, p.academyId]));
  const effectiveAssignment = (studentId: string) => latestEffective(snapshot.assignments.filter((a) => a.studentId === studentId), s);

  // 1. Every ACTIVE student has a status row strictly before G(S) (otherwise S is UNDECIDABLE and silently not charged).
  const check1 = active.filter((st) => !snapshot.statusChanges.some((r) => r.studentId === st.id && compareDates(toDate(r.effectiveOn), gOfS) < 0));

  // 2. Student.status matches the latest status row (by effectiveOn, then sequence).
  const check2 = students.filter((st) => {
    const rows = snapshot.statusChanges.filter((r) => r.studentId === st.id);
    if (rows.length === 0) return false;
    const latest = rows.reduce((a, b) => {
      const byDate = compareDates(toDate(b.effectiveOn), toDate(a.effectiveOn));
      return byDate > 0 || (byDate === 0 && b.sequence > a.sequence) ? b : a;
    });
    return latest.status !== st.status;
  });

  // 3. Every branch with ACTIVE students has a policy effective for S, and no eligible student has a configuration gap.
  const branchesWithoutPolicy = sortedIds(active.map((st) => st.homeAcademyId)).filter(
    (academyId) => !latestEffective(snapshot.policies.filter((p) => p.academyId === academyId), s),
  );
  const configGaps = previews.filter((p) => p.outcome === "configurationGap");

  // 4. Every ACTIVE student has an assignment effective for S (an explicit "no plan" counts), on a plan of their own branch.
  const check4 = active.filter((st) => {
    const assignment = effectiveAssignment(st.id);
    if (!assignment) return true;
    return assignment.planId !== null && planAcademy.get(assignment.planId) !== st.homeAcademyId;
  });

  // 5. No legacy PaymentPeriod for S or later (the legacy one-month-ahead window): it would be charged twice.
  const check5 = snapshot.legacyPayments.filter((p) => compareYearMonth({ year: p.year, month: p.month }, s) >= 0);

  const promoStudents = sortedIds(
    snapshot.legacyPayments.filter((p) => p.status === "PROMO" || p.status === "EXEMPT" || p.promoRecurring).map((p) => p.studentId),
  );

  const computed = (id: number, key: string, failing: string[], passDetail: string, failDetail: string): ReadinessCheck => ({
    id,
    key,
    status: failing.length === 0 ? "pass" : "fail",
    detail: failing.length === 0 ? passDetail : failDetail,
    items: failing,
  });

  const checks: ReadinessCheck[] = [
    computed(1, "statusBeforeStart", check1.map((st) => `student:${st.id}`), "Every active student has status history before the 1st of S.", "Active students with no status row before the 1st of S (take the baseline before S)."),
    computed(2, "statusConsistent", check2.map((st) => `student:${st.id}`), "Every student's status matches their latest status row.", "Students whose status disagrees with their latest status row."),
    computed(
      3,
      "branchConfiguration",
      [...branchesWithoutPolicy.map((id) => `branch:${id}`), ...configGaps.map((p) => `student:${p.studentId}`)],
      "Every branch with active students has a policy for S, and no eligible student has a configuration gap.",
      "Branches without a policy for S, or eligible students without applicable terms or policy for S.",
    ),
    computed(4, "assignments", check4.map((st) => `student:${st.id}`), "Every active student has a plan (or an explicit 'no plan') effective for S.", "Active students with no assignment effective for S, or one on another branch's plan."),
    computed(5, "noLegacyFromStart", check5.map((p) => `legacy:${p.id}`), "No legacy payment exists for S or later.", "Legacy payments recorded for S or later would be charged again."),
    {
      id: 6,
      key: "pricingAcknowledged",
      status: "notImplemented",
      detail: "Pricing acknowledgements are not implemented yet (stage 8b/8c). These promo/exempt students will need one.",
      items: promoStudents.map((id) => `student:${id}`),
    },
    { id: 7, key: "openingItemsOverPaidMonths", status: "notImplemented", detail: "Opening-item drafts are not implemented yet (stage 8b/8c).", items: [] },
    { id: 8, key: "openingItemsBeforeStart", status: "notImplemented", detail: "Opening-item drafts are not implemented yet (stage 8b/8c).", items: [] },
    { id: 9, key: "openingReviewed", status: "notImplemented", detail: "Opening-debt review confirmations are not implemented yet (stage 8b/8c).", items: [] },
    { id: 10, key: "monthlyGenerationScheduled", status: "notImplemented", detail: "The monthly-generation trigger is not built or scheduled.", items: [] },
    { id: 11, key: "openingCancellationAvailable", status: "notImplemented", detail: "The approved owner cancellation of erroneous opening obligations (O2) is not implemented.", items: [] },
    {
      id: 12,
      key: "activationMechanismAvailable",
      status: "notImplemented",
      detail: "The stage 9 activation mechanism (approval, manual activation, legacy refusal, gate lock) is not implemented. This check is about the mechanism existing, not about the organization being active.",
      items: [],
    },
    { id: 13, key: "prepaidReversalPolicy", status: "decisionPending", detail: "The prepaid-payment reversal policy (O4) is undecided and blocks activation.", items: [] },
  ];

  const branches: BranchPreview[] = sortedIds(snapshot.branches.map((b) => b.id)).map((academyId) => {
    const mine = previews.filter((p) => p.academyId === academyId);
    const byCurrency = new Map<string, { count: number; minor: number }>();
    for (const p of mine) {
      if (p.outcome !== "created") continue;
      const entry = byCurrency.get(p.currency) ?? { count: 0, minor: 0 };
      entry.count += 1;
      entry.minor += decimalToMinor(p.amount);
      byCurrency.set(p.currency, entry);
    }
    const notEligibleBecause = (reason: string) => mine.filter((p) => p.outcome === "notEligible" && p.reason === reason);
    return {
      academyId,
      wouldCreate: [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, e]) => ({ currency, count: e.count, total: minorToDecimal(e.minor) })),
      undecidable: notEligibleBecause("UNDECIDABLE").map((p) => p.studentId),
      notEligible: notEligibleBecause("NOT_ELIGIBLE").map((p) => p.studentId),
      explicitNoPlan: notEligibleBecause("NO_ASSIGNMENT").filter((p) => effectiveAssignment(p.studentId)?.planId === null).map((p) => p.studentId),
      unassigned: notEligibleBecause("NO_ASSIGNMENT").filter((p) => effectiveAssignment(p.studentId)?.planId !== null).map((p) => p.studentId),
      configurationGap: mine.filter((p) => p.outcome === "configurationGap").map((p) => p.studentId),
    };
  });

  const notEligibleForS = previews.filter((p) => p.outcome === "notEligible" && p.reason === "NOT_ELIGIBLE").map((p) => `student:${p.studentId}`);

  return {
    candidate: { year: s.year, month: s.month },
    ready: checks.every((c) => c.status === "pass"),
    checks,
    warnings: notEligibleForS.length ? [{ key: "notEligibleForStart", items: notEligibleForS }] : [],
    notes: ["Pre-switch signup debt is excluded from this activation scope (owner decision O3); it is not waived."],
    preview: { students: previews, branches },
    fingerprints: {
      organization: organizationFingerprint(snapshot, s),
      branches: Object.fromEntries(snapshot.branches.map((b) => [b.id, branchFingerprint(snapshot, b.id)])),
      students: Object.fromEntries(students.map((st) => [st.id, studentFingerprint(snapshot, st.id)])),
    },
  };
}
