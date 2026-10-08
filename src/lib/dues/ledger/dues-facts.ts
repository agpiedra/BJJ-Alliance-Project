import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { branchScopeWhere } from "@/lib/tenant/context";
import type { Currency } from "@/generated/prisma/client";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { todayIn, fromDbDate, latestEffective } from "@/lib/dues/ledger/common";
import { lateFeeApplies, lateFeeToAssessMinor } from "@/lib/dues/settlement";
import { eligibleAndAssigned, type StatusHistoryRow, type AssignmentRow } from "@/lib/dues/eligibility";
import { columnToMinor } from "@/lib/dues/ledger/minor-units";
import { awaitingRateReceiptSnapshotSchema } from "@/lib/dues/ledger/awaiting-rate-receipt";
import { isValidCoverageMonth } from "@/lib/dues/ledger/create-monthly-obligation";
import type { YearMonth } from "@/lib/dues/calendar";

/**
 * PAYMENT-UI-CONSUMER-INTEGRATION-BRIEF.md §6: a shared, batched, tenant-scoped READ model over the dues ledger —
 * never a writer, never participates in any transaction, never takes a lock. "Built dark" exactly like every other
 * ledger reader/writer: `LedgerActivation`-gated, no route/action/scheduler entry, registered in
 * `scripts/pending-callers.ts`. Zero UI integration in this PR (brief §7 is later work).
 *
 * AS-OF-OVER-CURRENT-RECORDS, NOT A HISTORICAL RECONSTRUCTION (brief §6): every fact here compares CURRENT stored
 * rows against the captured `asOf` instant for TIMING purposes only (is this now past grace, as of today). A later
 * event — a reversal last week, a late correction — is visible in "current records" regardless of which `asOf`/
 * `month` was requested; a query about three months ago reflects everything known NOW about that period, never a
 * frozen snapshot of what the system would have shown back then. A genuine point-in-time historical report is a
 * different, unbuilt capability.
 */

/** A session's own linked student id, non-null — the structural guarantee `getOwnDuesFacts` (below) relies on
 * instead of a runtime check: the type itself makes "request someone else's id" inexpressible, since the function
 * takes no `studentIds` parameter at all. Keyed on `linkedStudentId` (role-independent — "this account's own
 * training record"), never `selfStudentId` (role-gated to STUDENT, and drives ROSTER scoping instead — see
 * `TenantContext`'s own doc comments, `src/lib/tenant/types.ts:20-37`). A staff member who also trains has a
 * non-null `linkedStudentId` too, and must reach their own portal data exactly like a pure student. */
export type PortalSelfContext = TenantContext & { linkedStudentId: string };

export type DuesEligibilityFact =
  | { outcome: "UNDECIDABLE" | "NOT_ELIGIBLE" | "NO_ASSIGNMENT" }
  | { outcome: "MISSING_CONFIGURATION" }
  /** Brief §4.1.5: eligible + configured, but no MONTHLY exists for this period — an OBSERVED discrepancy, never an
   * asserted cause. This resolver has no execution log; it cannot and must not claim WHY (job hasn't run, a run
   * failed, or something else). Never produced for SIGNUP or an event-triggered (resume/return) MONTHLY — those are
   * created by a one-time event, not a periodic eligibility sweep, and `eligibleAndAssigned` says nothing about them. */
  | { outcome: "OBSERVED_DISCREPANCY" }
  | { outcome: "RESOLVED"; planId: string };

export type DuesOutstandingFact = {
  obligationId: string;
  type: "MONTHLY" | "SIGNUP" | "PACKAGE";
  currency: Currency;
  coverageYear: number;
  coverageMonth: number;
  settled: boolean;
  /** 0 when settled (the historical fee, if any, was already paid atomically — never re-reported as owed); tuition
   * (+ fee, MONTHLY only) when not. See §5.1 of the brief for the exact algorithm this reuses. */
  outstandingAmountMinor: number;
  /** `null` for SIGNUP/PACKAGE (never late-fee eligible by shape) or once settled — a distinct "not applicable"
   * value, never 0-as-a-stand-in and never silently coerced. */
  outstandingFeeMinor: number | null;
  /** ISO date; `null` for PACKAGE (no `dueOn` by shape). */
  dueOn: string | null;
  /** `null` for SIGNUP/PACKAGE or once settled — see `outstandingFeeMinor`. */
  pastGrace: boolean | null;
};

/** A malformed stored snapshot, or one whose own `kind` disagrees with the receipt row's real `kind` column, is a
 * data-integrity hazard — never silently degraded to empty components, which would be indistinguishable from a
 * receipt that genuinely references nothing. A discriminated union forces every consumer to handle this case. */
export type DuesPendingReceiptFact =
  | {
      ok: true;
      receiptId: string;
      kind: "ORDINARY" | "PREPAYMENT" | "PACKAGE";
      tenderCurrency: Currency;
      /** The raw, UNCONVERTED tender — never subtracted from `outstanding` above, never implies settlement. */
      tenderAmountMinor: number;
      /** Component A (brief §4.3): real ids, already present in `outstanding` too, unmodified by the receipt's mere
       * existence — a receipt never changes an obligation's own outstanding fact until it actually resolves. */
      referencedExistingObligationIds: string[];
      /** Component B (brief §4.3): nothing exists in `DuesObligation` for these months yet — a pending PURCHASE
       * INTENT, never confirmed debt, never merged into `outstanding`. Empty for `ORDINARY` (nothing is proposed,
       * only referenced). */
      proposedCoverage: Array<{ year: number; month: number }>;
    }
  | {
      ok: false;
      receiptId: string;
      /** The receipt row's own REAL `kind` column — still reported even on failure, since it never depends on the
       * untrusted snapshot. */
      kind: "ORDINARY" | "PREPAYMENT" | "PACKAGE";
      tenderCurrency: Currency;
      tenderAmountMinor: number;
      error: "snapshotIntegrityFailure";
    };

export type DuesFactsForStudent = {
  studentId: string;
  /** Governs NEW obligation creation for the requested period only — says nothing about old, unrelated debt; see
   * `outstanding` below, which is reported independently. */
  eligibility: DuesEligibilityFact;
  /** Any period, any type, independent of `eligibility` above — a NOT_ELIGIBLE/unassigned student can still have
   * real, old, unsettled obligations from a period when they were eligible and assigned. */
  outstanding: DuesOutstandingFact[];
  /** Every real `DuesCoverage` row for this student (brief §4) — a claim from a real table, independent of
   * `outstanding`'s settlement/debt facts: a MONTHLY's unpaid status and its coverage claim are two separate facts,
   * both true simultaneously. SIGNUP never appears here (it writes zero `DuesCoverage` rows, by design). Survives a
   * payment reversal untouched (`reverse-payment.ts` never touches `DuesCoverage`). */
  coverage: Array<{ year: number; month: number; obligationId: string }>;
  pendingReceipts: DuesPendingReceiptFact[];
};

/** This ledger's own established per-call ceiling, matching `record-payment.ts`/`purchase-package.ts` exactly. */
const MAX_SELECTED = 60;

/** `ScopedDb` (the tenant-scoped client) does not expose `studentStatusChange`/`duesObligation` at all — this
 * resolver uses the plain `prisma` client throughout instead, exactly like every other ledger reader/writer, and
 * scopes every query by `organizationId` explicitly itself (never trusting a bare id). */
type FactsDb = Pick<typeof prisma, "student" | "studentStatusChange" | "studentPlanAssignment" | "paymentPlanTerms" | "duesPolicyVersion" | "duesObligation" | "duesCoverage" | "awaitingRateReceipt">;

const isoDate = (d: Date): string => {
  const c = fromDbDate(d);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
};

const isRealClock = (now: Date): boolean => now instanceof Date && !Number.isNaN(now.getTime());

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * The one shared, batched computation both public functions below compose — never a per-student query loop (the
 * "bounded batching" requirement, brief §6): a fixed, small number of queries regardless of how many students are
 * requested. `academyScope` is the staff-mode branch restriction (`branchScopeWhere`'s own shape); omitted entirely
 * for self-mode, which needs none.
 */
async function computeDuesFactsForStudents(
  db: FactsDb,
  organizationId: string,
  studentIds: readonly string[],
  month: YearMonth | undefined,
  now: Date,
  academyScope?: { academyId?: { in: string[] } },
): Promise<DuesFactsForStudent[]> {
  const students = await db.student.findMany({
    where: { id: { in: [...studentIds] }, organizationId, ...(academyScope?.academyId ? { homeAcademyId: academyScope.academyId } : {}) },
    select: { id: true, homeAcademyId: true, homeAcademy: { select: { timezone: true } } },
  });
  if (students.length === 0) return [];
  const ids = students.map((s) => s.id);

  const [statusRows, assignmentRows, obligations, coverageRows, receipts] = await Promise.all([
    db.studentStatusChange.findMany({ where: { organizationId, studentId: { in: ids } }, select: { studentId: true, effectiveOn: true, sequence: true, status: true } }),
    db.studentPlanAssignment.findMany({
      where: { organizationId, studentId: { in: ids } },
      select: { studentId: true, effectiveYear: true, effectiveMonth: true, planId: true, plan: { select: { academyId: true } } },
    }),
    db.duesObligation.findMany({
      where: { organizationId, studentId: { in: ids } },
      include: { lateFees: true, settlements: { where: { reversedAt: null }, select: { id: true } } },
    }),
    db.duesCoverage.findMany({ where: { organizationId, studentId: { in: ids } }, select: { studentId: true, year: true, month: true, obligationId: true } }),
    db.awaitingRateReceipt.findMany({
      where: { organizationId, studentId: { in: ids }, status: "PENDING" },
      select: { id: true, studentId: true, kind: true, tenderCurrency: true, tenderAmount: true, snapshot: true },
    }),
  ]);

  const planIds = [...new Set(assignmentRows.map((a) => a.planId).filter((id): id is string => id !== null))];
  const academyIds = [...new Set(students.map((s) => s.homeAcademyId))];
  const [termsRows, policyRows] = await Promise.all([
    planIds.length > 0
      ? db.paymentPlanTerms.findMany({ where: { organizationId, planId: { in: planIds } }, select: { planId: true, effectiveYear: true, effectiveMonth: true, currency: true, monthsCovered: true } })
      : Promise.resolve([]),
    db.duesPolicyVersion.findMany({ where: { organizationId, academyId: { in: academyIds } }, select: { academyId: true, effectiveYear: true, effectiveMonth: true, lateFeeCurrency: true } }),
  ]);

  const statusByStudent = groupBy(statusRows, (r) => r.studentId);
  const assignmentsByStudent = groupBy(assignmentRows, (r) => r.studentId);
  const obligationsByStudent = groupBy(obligations, (r) => r.studentId);
  const coverageByStudent = groupBy(coverageRows, (r) => r.studentId);
  const receiptsByStudent = groupBy(receipts, (r) => r.studentId);

  return students.map((student): DuesFactsForStudent => {
    const timezone = student.homeAcademy.timezone;
    const today = todayIn(timezone, now);
    const targetMonth: YearMonth = month ?? { year: today.year, month: today.month };

    // ---- eligibility (current-period only; brief §4.1) ----
    const statusHistory: StatusHistoryRow[] = (statusByStudent.get(student.id) ?? []).map((r) => ({ effectiveOn: fromDbDate(r.effectiveOn), sequence: r.sequence, status: r.status }));
    const assignments: AssignmentRow[] = (assignmentsByStudent.get(student.id) ?? []).map((r) => ({
      effectiveYear: r.effectiveYear,
      effectiveMonth: r.effectiveMonth,
      planId: r.planId,
      planAcademyId: r.plan?.academyId ?? null,
    }));
    const elig = eligibleAndAssigned(statusHistory, assignments, student.homeAcademyId, targetMonth);
    const studentCoverage = (coverageByStudent.get(student.id) ?? []).map((c) => ({ year: c.year, month: c.month, obligationId: c.obligationId }));
    let eligibility: DuesEligibilityFact;
    if (elig.outcome !== "ELIGIBLE") {
      eligibility = { outcome: elig.outcome };
    } else {
      const termsCandidate = latestEffective(termsRows.filter((t) => t.planId === elig.planId), targetMonth);
      const policyCandidate = latestEffective(policyRows.filter((p) => p.academyId === student.homeAcademyId), targetMonth);
      // Mirrors writeMonthlyObligationInTx's own `inapplicable` (no effective terms/policy, wrong monthsCovered — a
      // package plan resolves here too, deliberately: this read model has no "unsupported plan" outcome slot, and a
      // package-shaped terms row genuinely cannot back a MONTHLY, which is exactly what MISSING_CONFIGURATION means)
      // / `currencyMismatch` refusals — never a second, drifting re-derivation of that check.
      if (!termsCandidate || !policyCandidate || termsCandidate.monthsCovered !== 1 || termsCandidate.currency !== policyCandidate.lateFeeCurrency) {
        eligibility = { outcome: "MISSING_CONFIGURATION" };
      } else {
        // Mirrors checkMonthCoverageInTx's own two-check shape (monthly-config-resolution.ts): either an existing
        // MONTHLY obligation for this month, OR a real DuesCoverage row from any other obligation (e.g. an active
        // PACKAGE) — "already covered" means exactly the same thing here as it does when a writer checks it.
        const hasMonthlyThisPeriod = (obligationsByStudent.get(student.id) ?? []).some(
          (o) => o.type === "MONTHLY" && o.coverageYear === targetMonth.year && o.coverageMonth === targetMonth.month,
        );
        const hasCoverageThisPeriod = hasMonthlyThisPeriod || studentCoverage.some((c) => c.year === targetMonth.year && c.month === targetMonth.month);
        eligibility = hasCoverageThisPeriod ? { outcome: "RESOLVED", planId: elig.planId } : { outcome: "OBSERVED_DISCREPANCY" };
      }
    }

    // ---- outstanding (any period; brief §4.2/§5.1 — settlement state checked FIRST, before any fee calculation) ----
    const outstanding: DuesOutstandingFact[] = (obligationsByStudent.get(student.id) ?? []).map((o) => {
      const settled = o.settlements.length > 0;
      if (settled) {
        return {
          obligationId: o.id, type: o.type, currency: o.currency, coverageYear: o.coverageYear, coverageMonth: o.coverageMonth,
          settled: true, outstandingAmountMinor: 0,
          outstandingFeeMinor: o.type === "MONTHLY" ? 0 : null,
          dueOn: o.dueOn ? isoDate(o.dueOn) : null,
          pastGrace: null,
        };
      }
      // Unsettled — never paid, or a payment that once settled it was later reversed. Reopens under the identical
      // logic below with no special-casing: a reversed settlement is simply absent from the `reversedAt: null`
      // filter above, so `settled` is already false again.
      let outstandingAmountMinor = columnToMinor(o.amount);
      let outstandingFeeMinor: number | null = null;
      let pastGrace: boolean | null = null;
      if (o.type === "MONTHLY") {
        const graceDeadline = fromDbDate(o.graceDeadline!); // always set for MONTHLY by DB shape
        const feeRow = o.lateFees[0] ?? null;
        // The exact `asTerms` (record-payment.ts) removal-handling pattern, reused, not re-derived.
        const removed = feeRow?.removedAt != null;
        const effectiveLateFeeMinor = removed || o.lateFeeAmount === null ? 0 : columnToMinor(o.lateFeeAmount);
        pastGrace = lateFeeApplies(today, graceDeadline);
        // settledOn: null is deliberate — this obligation is UNSETTLED; there is no settledOn to pass.
        // lateFeeToAssessMinor is the single source of truth this entire ledger uses for "is a fee owed right now" —
        // never inferred from "a DuesLateFee row exists," which is only written lazily at assessment time.
        outstandingFeeMinor = lateFeeToAssessMinor(
          { id: o.id, coverage: { year: o.coverageYear, month: o.coverageMonth }, currency: o.currency, tuitionMinor: outstandingAmountMinor, lateFeeMinor: effectiveLateFeeMinor, graceDeadline, settledOn: null },
          today,
        );
        outstandingAmountMinor += outstandingFeeMinor;
      }
      // SIGNUP/PACKAGE: pastGrace/outstandingFeeMinor stay null — never late-fee eligible by shape.
      return {
        obligationId: o.id, type: o.type, currency: o.currency, coverageYear: o.coverageYear, coverageMonth: o.coverageMonth,
        settled: false, outstandingAmountMinor, outstandingFeeMinor,
        dueOn: o.dueOn ? isoDate(o.dueOn) : null, pastGrace,
      };
    });

    // ---- pending receipts, decomposed into Component A / Component B (brief §4.3) ----
    const pendingReceipts: DuesPendingReceiptFact[] = (receiptsByStudent.get(student.id) ?? []).map((r) => {
      const parsed = awaitingRateReceiptSnapshotSchema.safeParse(r.snapshot);
      // A parse failure, OR a well-formed snapshot whose own `kind` disagrees with the receipt row's REAL `kind`
      // column — two independent sources of truth that should never disagree — are both the same integrity failure.
      // Never silently degraded to empty components, which would be indistinguishable from "genuinely references
      // nothing": this is a typed, explicit fact a consumer must handle.
      if (!parsed.success || parsed.data.kind !== r.kind) {
        return { ok: false, receiptId: r.id, kind: r.kind, tenderCurrency: r.tenderCurrency, tenderAmountMinor: columnToMinor(r.tenderAmount), error: "snapshotIntegrityFailure" };
      }
      let referencedExistingObligationIds: string[];
      let proposedCoverage: Array<{ year: number; month: number }>;
      if (parsed.data.kind === "ORDINARY") {
        referencedExistingObligationIds = parsed.data.obligationIds;
        proposedCoverage = [];
      } else if (parsed.data.kind === "PREPAYMENT") {
        referencedExistingObligationIds = parsed.data.existingObligationIds;
        proposedCoverage = parsed.data.months.map((m) => m.coverage);
      } else {
        referencedExistingObligationIds = parsed.data.existingObligationIds;
        proposedCoverage = parsed.data.coverageMonths;
      }
      return { ok: true, receiptId: r.id, kind: r.kind, tenderCurrency: r.tenderCurrency, tenderAmountMinor: columnToMinor(r.tenderAmount), referencedExistingObligationIds, proposedCoverage };
    });

    return { studentId: student.id, eligibility, outstanding, coverage: studentCoverage, pendingReceipts };
  });
}

export type ListDuesFactsResult = { ok: true; facts: DuesFactsForStudent[] } | { ok: false; error: "invalid" | "notActive" };

/**
 * Staff mode (brief §6): bounded by `branchScopeWhere(context)`, exactly like `listOverdueStudents`/
 * `listCurrentPaymentStatus`. A requested id outside the caller's own branch scope is silently excluded from the
 * result — not an error, the same scoping behavior `getScopedDb` already produces elsewhere; no different
 * information is leaked (the id simply does not appear, as if it had never been requested).
 *
 * No role gate of its own — the same "plain function, caller already resolved scope" precedent `getCurrentPaymentPeriod`
 * establishes; each caller applies its own role restriction.
 */
export async function listDuesFactsForStudents(
  context: TenantContext,
  studentIds: string[],
  month?: YearMonth,
  deps: LedgerDeps = {},
): Promise<ListDuesFactsResult> {
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(context.organizationId))) return { ok: false, error: "notActive" };
  if (!Array.isArray(studentIds)) return { ok: false, error: "invalid" };
  if (studentIds.length > MAX_SELECTED) return { ok: false, error: "invalid" };
  if (studentIds.some((id) => typeof id !== "string" || id.trim().length === 0)) return { ok: false, error: "invalid" };
  if (month !== undefined && !isValidCoverageMonth(month)) return { ok: false, error: "invalid" };
  if (studentIds.length === 0) return { ok: true, facts: [] };

  const now = (deps.now ?? (() => new Date()))();
  if (!isRealClock(now)) return { ok: false, error: "invalid" };

  const scope = branchScopeWhere(context);
  const facts = await computeDuesFactsForStudents(prisma, context.organizationId, studentIds, month, now, scope);
  return { ok: true, facts };
}

/**
 * Student-self mode (brief §6): takes NO `studentIds` parameter at all — the caller's own linked student id
 * (`context.linkedStudentId`) is implicit, never a request parameter. This structurally eliminates "could a caller
 * request someone else's data" as a question, rather than relying on a runtime check that could have a bug: a
 * caller that somehow holds a foreign id has no parameter to put it in.
 *
 * No branch check of any kind, deliberately (STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §2.5/§3.2): unlike staff
 * mode's `branchScopeWhere`, this function never consults `context.academyIds`. A staff member whose own linked
 * student is homed at a branch outside their own staff-assignment scope must still see their own real data —
 * `academyIds` answers "which students may I see as STAFF," a different question from "is this my own record."
 */
export async function getOwnDuesFacts(context: PortalSelfContext, month?: YearMonth, deps: LedgerDeps = {}): Promise<DuesFactsForStudent | null> {
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(context.organizationId))) return null;
  if (typeof context.linkedStudentId !== "string" || context.linkedStudentId.trim().length === 0) return null;
  if (month !== undefined && !isValidCoverageMonth(month)) return null;
  const now = (deps.now ?? (() => new Date()))();
  if (!isRealClock(now)) return null;
  const facts = await computeDuesFactsForStudents(prisma, context.organizationId, [context.linkedStudentId], month, now);
  return facts[0] ?? null;
}
