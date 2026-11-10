import { createHash } from "node:crypto";
import type { YearMonth } from "@/lib/dues/calendar";
import type { ReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Deterministic content fingerprints (docs/dues/STAGE-8-READINESS-BRIEF.md §4/§6). They hash the reviewed CONTENT, not
 * ids or timestamps: a legacy payment edited in place keeps its id and createdAt, and a D25 correction rewrites a future
 * version in place — both must still change the fingerprint. Rows are sorted by id and object keys are sorted, so the
 * order the database returned them in never matters. `FORMAT` is hashed in so a future change of what is covered can
 * never collide with an old fingerprint.
 *
 * r2 (stage 8b) adds opening-debt drafts to the student fingerprint: an active draft's full content, and for every withdrawn
 * draft only its id, kind and successor (never its amount, currency or note). Drafts are never deleted, so a draft that ever
 * existed changes the hash for good and a confirmation bound before it can never become valid again (plan §5).
 * Confirmations themselves are in no hash: including them would make every confirmation invalidate itself.
 *
 * r3 (stage 9 PR 9-3, A8): the student fingerprint is per candidate month S. A legacy row for S or later that is an unpaid
 * placeholder (`isLegacyPlaceholder`) is left out: it is superseded by the ledger's charge and re-read by check 5 at the switch, so
 * a carry-forward placeholder created after the 1st does not make a student's review stale. Every other legacy row stays in, now
 * with its `method` and `notes` (what decides whether a pending row is ambiguous).
 */
export const FINGERPRINT_FORMAT = "r3";

type LegacyRow = ReadinessSnapshot["legacyPayments"][number];

/**
 * A8 rule 8 (approved 2026-11-10): an unpaid placeholder is `PENDING`, with no method, no notes (null or blank) and an amount null
 * or greater than 0. Stored fields only.
 */
export function isLegacyPlaceholder(row: Pick<LegacyRow, "status" | "method" | "notes" | "amount">): boolean {
  return row.status === "PENDING" && row.method === null && (row.notes === null || row.notes.trim() === "") && (row.amount === null || Number(row.amount) > 0);
}

/**
 * A8 rules 8–10 for a legacy row of S or later, from stored fields only (never audit rows, never free-text interpretation):
 * - `placeholder`: rule 8, does not block;
 * - `ambiguousPending`: rule 9, `PENDING` with amount null or > 0 and a method or notes — blocks unless the owner acknowledged it;
 * - `recordedPayment` (`PAID`/`PROMO` > 0), `waiver` (`PAID`/`PROMO`/`EXEMPT` = 0) and `inconsistent` (`PENDING` = 0 or negative,
 *   `PAID`/`PROMO` without an amount, and anything rules 8–10 do not name, such as `EXEMPT` without an amount): rule 10, always
 *   block and can never be acknowledged. Resolution: move S.
 */
export type LegacyRowClass = "placeholder" | "ambiguousPending" | "recordedPayment" | "waiver" | "inconsistent";

export function classifyLegacyRow(row: Pick<LegacyRow, "status" | "method" | "notes" | "amount">): LegacyRowClass {
  const amount = row.amount === null ? null : Number(row.amount);
  if (row.status === "PENDING") {
    if (amount !== null && amount <= 0) return "inconsistent";
    return isLegacyPlaceholder(row) ? "placeholder" : "ambiguousPending";
  }
  if (amount === 0 && (row.status === "PAID" || row.status === "PROMO" || row.status === "EXEMPT")) return "waiver";
  if ((row.status === "PAID" || row.status === "PROMO") && amount !== null && amount > 0) return "recordedPayment";
  return "inconsistent";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const ym = (m: YearMonth) => `${m.year}-${String(m.month).padStart(2, "0")}`;

export function studentFingerprint(snapshot: ReadinessSnapshot, studentId: string, candidate: YearMonth): string {
  const student = snapshot.students.find((s) => s.id === studentId);
  if (!student) throw new Error(`studentFingerprint: unknown student ${studentId}`);
  const mine = <T extends { studentId: string; id: string }>(rows: readonly T[]) => byId(rows.filter((r) => r.studentId === studentId));
  const fromStart = (r: LegacyRow) => r.year > candidate.year || (r.year === candidate.year && r.month >= candidate.month);
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "student",
    candidate: ym(candidate),
    student: { id: student.id, status: student.status, homeAcademyId: student.homeAcademyId },
    statusChanges: mine(snapshot.statusChanges).map(({ id, status, effectiveOn, sequence, source }) => ({ id, status, effectiveOn, sequence, source })),
    assignments: mine(snapshot.assignments).map(({ id, planId, effectiveYear, effectiveMonth }) => ({ id, planId, effectiveYear, effectiveMonth })),
    legacyPayments: mine(snapshot.legacyPayments)
      .filter((r) => !(fromStart(r) && isLegacyPlaceholder(r)))
      .map(({ id, year, month, status, amount, currency, planId, promoName, promoRecurring, method, notes }) => ({
        id, year, month, status, amount, currency, planId, promoName, promoRecurring, method, notes,
      })),
    monthlyObligations: mine(snapshot.monthlyObligations).map(({ id, coverageYear, coverageMonth }) => ({ id, coverageYear, coverageMonth })),
    coverage: mine(snapshot.coverage).map(({ id, year, month }) => ({ id, year, month })),
    openingItems: mine(snapshot.openingItems).map(({ id, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }) => ({
      id, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId,
    })),
    withdrawnOpeningItems: mine(snapshot.withdrawnOpeningItems).map(({ id, withdrawalKind, supersededById }) => ({ id, withdrawalKind, supersededById })),
  });
}

export function branchFingerprint(snapshot: ReadinessSnapshot, academyId: string): string {
  const branch = snapshot.branches.find((b) => b.id === academyId);
  if (!branch) throw new Error(`branchFingerprint: unknown branch ${academyId}`);
  const plans = byId(snapshot.plans.filter((p) => p.academyId === academyId));
  const planIds = new Set(plans.map((p) => p.id));
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "branch",
    branch: { id: branch.id, timezone: branch.timezone },
    policies: byId(snapshot.policies.filter((p) => p.academyId === academyId)).map(
      ({ id, effectiveYear, effectiveMonth, dueDay, graceDay, lateFeeAmount, lateFeeCurrency, maxPrepaidMonths }) => ({
        id, effectiveYear, effectiveMonth, dueDay, graceDay, lateFeeAmount, lateFeeCurrency, maxPrepaidMonths,
      }),
    ),
    plans: plans.map(({ id, name, active }) => ({ id, name, active })),
    terms: byId(snapshot.terms.filter((t) => planIds.has(t.planId))).map(({ id, planId, effectiveYear, effectiveMonth, priceAmount, currency, monthsCovered }) => ({
      id, planId, effectiveYear, effectiveMonth, priceAmount, currency, monthsCovered,
    })),
  });
}

export function organizationFingerprint(snapshot: ReadinessSnapshot, candidate: YearMonth): string {
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "organization",
    candidate: ym(candidate),
    organization: { id: snapshot.organization.id, currency: snapshot.organization.currency },
    branches: byId(snapshot.branches).map((b) => ({ id: b.id, fingerprint: branchFingerprint(snapshot, b.id) })),
    students: byId(snapshot.students).map((s) => ({ id: s.id, fingerprint: studentFingerprint(snapshot, s.id, candidate) })),
  });
}

/**
 * Stage 9 A1: the CONFIGURATION an approval fixes — organization currency, the branch set and every branch's timezone, policy
 * versions, plans (legacy plans included) and terms. Students are not in it: student content may change after approval and is
 * re-confirmed instead. A configuration change after approval means the switch refuses and the owner moves S.
 */
export function configurationFingerprint(snapshot: ReadinessSnapshot): string {
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "configuration",
    organization: { id: snapshot.organization.id, currency: snapshot.organization.currency },
    branches: byId(snapshot.branches).map((b) => ({ id: b.id, fingerprint: branchFingerprint(snapshot, b.id) })),
  });
}

/**
 * A8 (b): what a `LEGACY_NO_MONEY` acknowledgement is bound to — one legacy row's exact stored content, including `recordedAt`,
 * which every legacy write sets. Any later write to the row changes the binding, so the acknowledgement is stale for good.
 */
export function legacyNoMoneyBinding(candidate: YearMonth, row: LegacyRow): string {
  const { id, studentId, year, month, status, amount, currency, planId, promoName, promoRecurring, method, notes, recordedAt } = row;
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "LEGACY_NO_MONEY",
    candidate: ym(candidate),
    row: { id, studentId, year, month, status, amount, currency, planId, promoName, promoRecurring, method, notes, recordedAt },
  });
}

/** What an `OPENING_REVIEWED` confirmation (stage 8c) will be bound to: the student's content for one candidate month. */
export function openingReviewBinding(candidate: YearMonth, studentFp: string): string {
  return hash({ format: FINGERPRINT_FORMAT, kind: "OPENING_REVIEWED", candidate: ym(candidate), student: studentFp });
}

/** What a `PRICING_ACKNOWLEDGED` confirmation (stage 8c) will be bound to: the student's content AND their branch's prices and
 * policy, so a price, policy, plan or timezone change alone invalidates it. */
export function pricingAckBinding(candidate: YearMonth, studentFp: string, branchFp: string): string {
  return hash({ format: FINGERPRINT_FORMAT, kind: "PRICING_ACKNOWLEDGED", candidate: ym(candidate), student: studentFp, branch: branchFp });
}
