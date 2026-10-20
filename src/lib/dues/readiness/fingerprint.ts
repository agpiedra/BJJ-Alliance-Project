import { createHash } from "node:crypto";
import type { YearMonth } from "@/lib/dues/calendar";
import type { ReadinessSnapshot } from "@/lib/dues/readiness/snapshot";

/**
 * Deterministic content fingerprints (docs/dues/STAGE-8-READINESS-BRIEF.md §4/§6). They hash the reviewed CONTENT, not
 * ids or timestamps: a legacy payment edited in place keeps its id and createdAt, and a D25 correction rewrites a future
 * version in place — both must still change the fingerprint. Rows are sorted by id and object keys are sorted, so the
 * order the database returned them in never matters. `FORMAT` is hashed in so a future change of what is covered can
 * never collide with an old fingerprint.
 */
export const FINGERPRINT_FORMAT = "r1";

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

export function studentFingerprint(snapshot: ReadinessSnapshot, studentId: string): string {
  const student = snapshot.students.find((s) => s.id === studentId);
  if (!student) throw new Error(`studentFingerprint: unknown student ${studentId}`);
  const mine = <T extends { studentId: string; id: string }>(rows: readonly T[]) => byId(rows.filter((r) => r.studentId === studentId));
  return hash({
    format: FINGERPRINT_FORMAT,
    kind: "student",
    student: { id: student.id, status: student.status, homeAcademyId: student.homeAcademyId },
    statusChanges: mine(snapshot.statusChanges).map(({ id, status, effectiveOn, sequence, source }) => ({ id, status, effectiveOn, sequence, source })),
    assignments: mine(snapshot.assignments).map(({ id, planId, effectiveYear, effectiveMonth }) => ({ id, planId, effectiveYear, effectiveMonth })),
    legacyPayments: mine(snapshot.legacyPayments).map(({ id, year, month, status, amount, currency, planId, promoName, promoRecurring }) => ({
      id, year, month, status, amount, currency, planId, promoName, promoRecurring,
    })),
    monthlyObligations: mine(snapshot.monthlyObligations).map(({ id, coverageYear, coverageMonth }) => ({ id, coverageYear, coverageMonth })),
    coverage: mine(snapshot.coverage).map(({ id, year, month }) => ({ id, year, month })),
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
    students: byId(snapshot.students).map((s) => ({ id: s.id, fingerprint: studentFingerprint(snapshot, s.id) })),
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
