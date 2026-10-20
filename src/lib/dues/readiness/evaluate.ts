import { compareDates, compareYearMonth, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import { eligibleAndAssigned, type AssignmentRow, type StatusHistoryRow } from "@/lib/dues/eligibility";
import { latestEffective } from "@/lib/dues/ledger/common";
import { decimalToMinor } from "@/lib/dues/ledger/minor-units";
import type { StudentStatus } from "@/generated/prisma/client";
import {
  FINGERPRINT_FORMAT,
  branchFingerprint,
  openingReviewBinding,
  organizationFingerprint,
  pricingAckBinding,
  studentFingerprint,
} from "@/lib/dues/readiness/fingerprint";
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

/** Stage 8c: a student's current confirmation of one kind for S (highest `sequence`), and whether it still matches the content. */
export type ConfirmationState =
  | { state: "missing" }
  | { state: "valid" | "stale"; sequence: number; confirmedAt: string; declaredNoOpeningDebt: boolean | null };

export interface StudentConfirmations {
  studentId: string;
  openingReview: ConfirmationState;
  pricingAck: ConfirmationState;
}

/** Stage 8c: ACTIVE opening drafts per branch and currency (brief §10). Separate from the MONTHLY preview; never summed across currencies. */
export interface OpeningDraftTotal {
  academyId: string;
  currency: string;
  count: number;
  total: string;
}

export interface ReadinessReport {
  candidate: YearMonth;
  ready: boolean;
  checks: ReadinessCheck[];
  warnings: { key: string; items: string[] }[];
  notes: string[];
  preview: { students: StudentPreview[]; branches: BranchPreview[] };
  fingerprints: { organization: string; branches: Record<string, string>; students: Record<string, string> };
  confirmations: StudentConfirmations[];
  openingDrafts: OpeningDraftTotal[];
}

const toDate = (iso: string): CalendarDate => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });
const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * A SUM of amounts in minor units as a two-decimal string. Not `minorToDecimal`: that one is bounded by a single column's range
 * (99,999,999.99) on purpose, and a total of several drafts may legitimately exceed it. Exact while the sum is a safe integer.
 */
function totalToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`Total out of range: ${minor}`);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

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

  // Stage 8c. A confirmation is valid only when its format is current and its binding equals the binding recomputed from THIS
  // snapshot; the current one per identity is the highest `sequence` (never a timestamp or an id).
  const studentFps = new Map(students.map((st) => [st.id, studentFingerprint(snapshot, st.id)]));
  const branchFps = new Map(snapshot.branches.map((b) => [b.id, branchFingerprint(snapshot, b.id)]));
  const confirmationState = (st: ReadinessSnapshot["students"][number], kind: "OPENING_REVIEWED" | "PRICING_ACKNOWLEDGED"): ConfirmationState => {
    const current = snapshot.confirmations
      .filter((c) => c.studentId === st.id && c.kind === kind && c.candidateYear === s.year && c.candidateMonth === s.month)
      .reduce<ReadinessSnapshot["confirmations"][number] | null>((best, c) => (best === null || c.sequence > best.sequence ? c : best), null);
    if (!current) return { state: "missing" };
    const studentFp = studentFps.get(st.id)!;
    const branchFp = branchFps.get(st.homeAcademyId);
    const expected = kind === "OPENING_REVIEWED" ? openingReviewBinding(s, studentFp) : branchFp ? pricingAckBinding(s, studentFp, branchFp) : null;
    const valid = current.fingerprintFormat === FINGERPRINT_FORMAT && current.binding === expected;
    return { state: valid ? "valid" : "stale", sequence: current.sequence, confirmedAt: current.confirmedAt, declaredNoOpeningDebt: current.declaredNoOpeningDebt };
  };
  const confirmations: StudentConfirmations[] = students.map((st) => ({
    studentId: st.id,
    openingReview: confirmationState(st, "OPENING_REVIEWED"),
    pricingAck: confirmationState(st, "PRICING_ACKNOWLEDGED"),
  }));
  const stateOf = new Map(confirmations.map((c) => [c.studentId, c]));

  // 6. Every promo/exempt student (8a's definition) has a valid pricing acknowledgement for S.
  const check6 = promoStudents.filter((id) => stateOf.get(id)?.pricingAck.state !== "valid");

  const drafts = [...snapshot.openingItems].sort((a, b) => (a.id < b.id ? -1 : 1));
  const legacyFor = (studentId: string, year: number, month: number) =>
    snapshot.legacyPayments.find((p) => p.studentId === studentId && p.year === year && p.month === month);
  // 7. No active draft over a PAID legacy month without an explicit link.
  const check7 = drafts.filter((d) => d.legacyPaymentPeriodId === null && legacyFor(d.studentId, d.coverageYear, d.coverageMonth)?.status === "PAID");
  // 8. No active draft for S or later.
  const check8 = drafts.filter((d) => compareYearMonth({ year: d.coverageYear, month: d.coverageMonth }, s) >= 0);
  // 9. U1: every currently ACTIVE student plus every student with an active draft has a valid opening review for S. Current status
  // only selects who must be reviewed; it does not decide monthly eligibility (the history-based preview above does).
  const mustReview = new Set([...active.map((st) => st.id), ...drafts.map((d) => d.studentId)]);
  const check9 = students.filter((st) => mustReview.has(st.id) && stateOf.get(st.id)!.openingReview.state !== "valid");

  // Brief §12 warnings (acknowledged, not blocking). Amounts are compared only within one currency; with no reference, no warning.
  const studentById = new Map(students.map((st) => [st.id, st]));
  const planTermsFor = (studentId: string, month: YearMonth) => {
    const assignment = latestEffective(snapshot.assignments.filter((a) => a.studentId === studentId), month);
    return assignment?.planId ? latestEffective(snapshot.terms.filter((t) => t.planId === assignment.planId), month) : null;
  };
  const linkedToPaid: string[] = [];
  const aboveReference: string[] = [];
  const currencyDiffers: string[] = [];
  for (const d of drafts) {
    const month = { year: d.coverageYear, month: d.coverageMonth };
    const linked = d.legacyPaymentPeriodId === null ? undefined : snapshot.legacyPayments.find((p) => p.id === d.legacyPaymentPeriodId);
    if (linked?.status === "PAID") linkedToPaid.push(`openingItem:${d.id}`);
    const legacy = legacyFor(d.studentId, d.coverageYear, d.coverageMonth);
    const terms = planTermsFor(d.studentId, month);
    const aboveLegacy = legacy?.amount != null && legacy.currency === d.currency && decimalToMinor(d.amount) > decimalToMinor(legacy.amount);
    const abovePlan = !!terms && terms.monthsCovered === 1 && terms.currency === d.currency && decimalToMinor(d.amount) > decimalToMinor(terms.priceAmount);
    if (aboveLegacy || abovePlan) aboveReference.push(`openingItem:${d.id}`);
    if (terms && terms.currency !== d.currency) currencyDiffers.push(`openingItem:${d.id}`);
  }

  const draftTotals = new Map<string, OpeningDraftTotal & { minor: number }>();
  for (const d of drafts) {
    const academyId = studentById.get(d.studentId)?.homeAcademyId;
    if (!academyId) continue;
    const key = `${academyId}\u0000${d.currency}`;
    const entry = draftTotals.get(key) ?? { academyId, currency: d.currency, count: 0, total: "", minor: 0 };
    entry.count += 1;
    entry.minor += decimalToMinor(d.amount);
    draftTotals.set(key, entry);
  }
  const openingDrafts: OpeningDraftTotal[] = [...draftTotals.values()]
    .sort((a, b) => (a.academyId === b.academyId ? (a.currency < b.currency ? -1 : 1) : a.academyId < b.academyId ? -1 : 1))
    .map(({ academyId, currency, count, minor }) => ({ academyId, currency, count, total: totalToDecimal(minor) }));

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
    computed(
      6,
      "pricingAcknowledged",
      check6.map((id) => `student:${id}`),
      "Every promo/exempt student has a current pricing acknowledgement for S.",
      "Promo/exempt students without a current pricing acknowledgement for S (missing, or stale since a student, price or policy change).",
    ),
    computed(
      7,
      "openingItemsOverPaidMonths",
      check7.map((d) => `openingItem:${d.id}`),
      "No opening item is over a PAID legacy month without an explicit link.",
      "Opening items over a PAID legacy month without an explicit link to that payment.",
    ),
    computed(8, "openingItemsBeforeStart", check8.map((d) => `openingItem:${d.id}`), "Every opening item is for a month before S.", "Opening items for S or a later month."),
    computed(
      9,
      "openingReviewed",
      check9.map((st) => `student:${st.id}`),
      "Every active student, and every student with an opening item, has a current opening-debt review for S.",
      "Students (active, or with an opening item) without a current opening-debt review for S (missing, or stale since a change).",
    ),
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
      wouldCreate: [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, e]) => ({ currency, count: e.count, total: totalToDecimal(e.minor) })),
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
    warnings: [
      ...(notEligibleForS.length ? [{ key: "notEligibleForStart", items: notEligibleForS }] : []),
      ...(linkedToPaid.length ? [{ key: "openingItemLinkedToPaidRow", items: linkedToPaid }] : []),
      ...(aboveReference.length ? [{ key: "openingItemAboveReference", items: aboveReference }] : []),
      ...(currencyDiffers.length ? [{ key: "openingItemCurrencyDiffersFromPlan", items: currencyDiffers }] : []),
    ],
    notes: ["Pre-switch signup debt is excluded from this activation scope (owner decision O3); it is not waived."],
    preview: { students: previews, branches },
    fingerprints: {
      organization: organizationFingerprint(snapshot, s),
      branches: Object.fromEntries(branchFps),
      students: Object.fromEntries(studentFps),
    },
    confirmations,
    openingDrafts,
  };
}
