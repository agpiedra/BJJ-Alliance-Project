import { describe, expect, it } from "vitest";
import { activationWindow, SWITCH_WINDOW_DAYS } from "../../src/lib/dues/readiness/candidate";
import {
  branchFingerprint,
  classifyLegacyRow,
  configurationFingerprint,
  legacyNoMoneyBinding,
  openingReviewBinding,
  pricingAckBinding,
  studentFingerprint,
  FINGERPRINT_FORMAT,
} from "../../src/lib/dues/readiness/fingerprint";
import { evaluateReadiness, studentsNeedingRefresh } from "../../src/lib/dues/readiness/evaluate";
import type { ReadinessSnapshot } from "../../src/lib/dues/readiness/snapshot";

/**
 * Stage 9 PR 9-3, the pure rules approved on 2026-11-10 (A1–A8): the activation window (P = 10, independent of due and grace
 * days), the A8 classification of old-system rows for S and later, the owner's per-row "no money received" acknowledgement bound to
 * the row's exact content, placeholders left out of the student fingerprint, the configuration fingerprint an approval fixes, and
 * which changed students must be refreshed after approval. No database.
 */
const S = { year: 2026, month: 11 };
type Legacy = ReadinessSnapshot["legacyPayments"][number];
const legacy = (over: Partial<Legacy> = {}): Legacy => ({
  id: "l1", studentId: "s1", year: 2026, month: 11, status: "PENDING", amount: "25000.00", currency: "CRC", planId: "p1", promoName: null, promoRecurring: false,
  method: null, notes: null, recordedAt: "2026-10-28T15:00:00.000Z", ...over,
});
const snapshot = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  organization: { id: "org", currency: "CRC" },
  branches: [{ id: "b1", timezone: "America/Costa_Rica" }],
  plans: [{ id: "p1", academyId: "b1", name: "Monthly", active: true }],
  terms: [{ id: "t1", planId: "p1", effectiveYear: 2026, effectiveMonth: 1, priceAmount: "25000.00", currency: "CRC", monthsCovered: 1 }],
  policies: [{ id: "v1", academyId: "b1", effectiveYear: 2026, effectiveMonth: 1, dueDay: 1, graceDay: 5, lateFeeAmount: "2000.00", lateFeeCurrency: "CRC", maxPrepaidMonths: null }],
  students: [{ id: "s1", homeAcademyId: "b1", status: "ACTIVE" }],
  statusChanges: [{ id: "h1", studentId: "s1", status: "ACTIVE", effectiveOn: "2026-01-01", sequence: 1, source: "BASELINE" }],
  assignments: [{ id: "a1", studentId: "s1", planId: "p1", effectiveYear: 2026, effectiveMonth: 1 }],
  legacyPayments: [],
  monthlyObligations: [],
  coverage: [],
  openingItems: [],
  withdrawnOpeningItems: [],
  confirmations: [],
  trigger: { scheduled: true, latestRun: { status: "SUCCEEDED", finalized: true, heartbeatStatus: "ok", alertPings: { urgent: "ok", data: "ok", workload: "ok" } }, stale: false, stuck: false },
  ...over,
});

describe("A1 window (P = 10): from the LAST branch's 00:00 on the 1st to the FIRST branch's 00:00 on the 11th; approval before the FIRST 1st", () => {
  it("one Costa Rica branch (UTC-6): approve before 1 Nov 06:00Z; switch from 1 Nov 06:00Z until (excluding) 11 Nov 06:00Z", () => {
    expect(SWITCH_WINDOW_DAYS).toBe(10);
    expect(activationWindow(S, ["America/Costa_Rica"])).toEqual({
      approvalDeadline: new Date("2026-11-01T06:00:00Z"),
      opensAt: new Date("2026-11-01T06:00:00Z"),
      closesAt: new Date("2026-11-11T06:00:00Z"),
    });
  });

  it("two branches (plan example 3): Costa Rica and New York — opens at the later midnight, closes at the earlier one", () => {
    expect(activationWindow(S, ["America/Costa_Rica", "America/New_York"])).toEqual({
      approvalDeadline: new Date("2026-11-01T04:00:00Z"), // New York reaches the 1st first (EDT, UTC-4, until 1 Nov 06:00Z)
      opensAt: new Date("2026-11-01T06:00:00Z"), // Costa Rica reaches it last
      closesAt: new Date("2026-11-11T05:00:00Z"), // New York reaches the 11th first (EST, UTC-5) = 10 Nov 23:00 in Costa Rica
    });
  });

  it("the widest spread (Kiritimati UTC+14 and Pago Pago UTC-11, 25 h apart): approval by the earliest 1st, open from the latest 1st, closed at the earliest 11th; still a 9-day window", () => {
    const w = activationWindow(S, ["Pacific/Kiritimati", "Pacific/Pago_Pago"])!;
    expect(w).toEqual({
      approvalDeadline: new Date("2026-10-31T10:00:00Z"), // Kiritimati reaches 1 Nov first
      opensAt: new Date("2026-11-01T11:00:00Z"), // Pago Pago reaches 1 Nov last
      closesAt: new Date("2026-11-10T10:00:00Z"), // Kiritimati reaches 11 Nov first
    });
    expect(w.closesAt.getTime() - w.opensAt.getTime()).toBe((9 * 24 - 1) * 3_600_000);
    // The order of the branch list never matters.
    expect(activationWindow(S, ["Pacific/Pago_Pago", "Pacific/Kiritimati"])).toEqual(w);
  });

  it("nothing can be decided without a branch or with an unknown timezone", () => {
    expect(activationWindow(S, [])).toBeNull();
    expect(activationWindow(S, ["Not/AZone"])).toBeNull();
  });
});

describe("A8: old-system rows for S and later, classified from stored fields only", () => {
  it.each([
    ["PENDING, no method, no notes, amount > 0", legacy(), "placeholder"],
    ["PENDING, no method, no notes, no amount", legacy({ amount: null }), "placeholder"],
    ["PENDING with blank notes", legacy({ notes: "   " }), "placeholder"],
    ["PENDING with a method", legacy({ method: "EFECTIVO" }), "ambiguousPending"],
    ["PENDING with notes", legacy({ notes: "paid at the desk?" }), "ambiguousPending"],
    ["PENDING with amount 0", legacy({ amount: "0.00" }), "inconsistent"],
    ["PAID > 0", legacy({ status: "PAID" }), "recordedPayment"],
    ["PROMO > 0", legacy({ status: "PROMO" }), "recordedPayment"],
    ["PAID = 0", legacy({ status: "PAID", amount: "0.00" }), "waiver"],
    ["PROMO = 0", legacy({ status: "PROMO", amount: "0.00" }), "waiver"],
    ["EXEMPT = 0", legacy({ status: "EXEMPT", amount: "0.00" }), "waiver"],
    ["PAID without an amount", legacy({ status: "PAID", amount: null }), "inconsistent"],
    ["PROMO without an amount", legacy({ status: "PROMO", amount: null }), "inconsistent"],
    ["EXEMPT without an amount (not named by rules 8-10: blocks)", legacy({ status: "EXEMPT", amount: null }), "inconsistent"],
  ] as const)("%s → %s", (_label, row, expected) => {
    expect(classifyLegacyRow(row)).toBe(expected);
  });

  const ack = (row: Legacy, over: Partial<ReadinessSnapshot["confirmations"][number]> = {}): ReadinessSnapshot["confirmations"][number] => ({
    id: "c1", studentId: row.studentId, candidateYear: S.year, candidateMonth: S.month, kind: "LEGACY_NO_MONEY", sequence: 1, fingerprintFormat: FINGERPRINT_FORMAT,
    binding: legacyNoMoneyBinding(S, row), declaredNoOpeningDebt: null, legacyPaymentPeriodId: row.id, confirmedAt: "2026-10-30T10:00:00.000Z", ...over,
  });
  const check5 = (s: ReadinessSnapshot) => evaluateReadiness(s, S).checks.find((c) => c.id === 5)!;

  it("an ambiguous row blocks until acknowledged; the acknowledgement clears it only while the row's exact content is unchanged", () => {
    const row = legacy({ method: "EFECTIVO" });
    expect(check5(snapshot({ legacyPayments: [row] }))).toMatchObject({ status: "fail", items: ["legacy:l1"] });
    expect(check5(snapshot({ legacyPayments: [row], confirmations: [ack(row)] }))).toMatchObject({ status: "pass", items: [] });
    // Any later write to the row (it sets recordedAt) invalidates it, even with identical visible fields; so does any content change.
    for (const changed of [{ ...row, recordedAt: "2026-11-02T09:00:00.000Z" }, { ...row, notes: "x" }, { ...row, amount: "1.00" }]) {
      const report = evaluateReadiness(snapshot({ legacyPayments: [changed], confirmations: [ack(row)] }), S);
      expect(report.checks.find((c) => c.id === 5)).toMatchObject({ status: "fail", items: ["legacy:l1"] });
      expect(report.legacyFromStart[0]!.acknowledgement?.state).toBe("stale");
    }
    // A newer (higher sequence) stale acknowledgement replaces an older valid one: only the current one counts.
    const stale = ack(row, { id: "c2", sequence: 2, binding: "0".repeat(64) });
    expect(check5(snapshot({ legacyPayments: [row], confirmations: [ack(row), stale] })).status).toBe("fail");
  });

  it("an acknowledgement can never override a recorded payment, a waiver or an inconsistent row (rule 10)", () => {
    for (const row of [legacy({ status: "PAID" }), legacy({ status: "EXEMPT", amount: "0.00" }), legacy({ amount: "0.00" })]) {
      const report = evaluateReadiness(snapshot({ legacyPayments: [row], confirmations: [ack(row)] }), S);
      expect(report.checks.find((c) => c.id === 5)).toMatchObject({ status: "fail", items: ["legacy:l1"] });
      expect(report.legacyFromStart[0]!.acknowledgement).toBeNull();
    }
  });

  it("an acknowledgement for another row, another candidate month or an old format does not count", () => {
    const row = legacy({ method: "SINPE" });
    for (const other of [ack(row, { legacyPaymentPeriodId: "l9" }), ack(row, { candidateMonth: 12 }), ack(row, { fingerprintFormat: "r2" })]) {
      expect(check5(snapshot({ legacyPayments: [row], confirmations: [other] })).status).toBe("fail");
    }
  });

  it("rows before S never count, and an unpaid placeholder for S or later only warns (handled by the new system)", () => {
    const report = evaluateReadiness(snapshot({ legacyPayments: [legacy({ id: "oct", month: 10, status: "PAID" }), legacy({ id: "nov" })] }), S);
    expect(report.checks.find((c) => c.id === 5)).toMatchObject({ status: "pass" });
    expect(report.warnings).toContainEqual({ key: "legacyPlaceholderHandledByNewSystem", items: ["legacy:nov"] });
    expect(report.legacyFromStart.map((r) => r.legacyId)).toEqual(["nov"]);
  });
});

describe("fingerprints (r3)", () => {
  it("a placeholder for S or later is left out of the student fingerprint (a carry-forward after the 1st does not make the review stale)", () => {
    const base = snapshot();
    expect(studentFingerprint(snapshot({ legacyPayments: [legacy()] }), "s1", S)).toBe(studentFingerprint(base, "s1", S));
    // ...but an ambiguous S row, a recorded S row and any row before S are in it.
    expect(studentFingerprint(snapshot({ legacyPayments: [legacy({ notes: "cash?" })] }), "s1", S)).not.toBe(studentFingerprint(base, "s1", S));
    expect(studentFingerprint(snapshot({ legacyPayments: [legacy({ status: "PAID" })] }), "s1", S)).not.toBe(studentFingerprint(base, "s1", S));
    expect(studentFingerprint(snapshot({ legacyPayments: [legacy({ month: 10 })] }), "s1", S)).not.toBe(studentFingerprint(base, "s1", S));
  });

  it("the system's lazily created custom-promotion plan (no terms) changes no fingerprint; given terms, it does", () => {
    const base = snapshot();
    const custom = { id: "p-custom", academyId: "b1", name: "Custom promotion", active: true };
    const withCustom = snapshot({ plans: [...base.plans, custom] });
    expect(configurationFingerprint(withCustom)).toBe(configurationFingerprint(base));
    const priced = snapshot({ plans: [...base.plans, custom], terms: [...base.terms, { ...base.terms[0]!, id: "t-custom", planId: "p-custom" }] });
    expect(configurationFingerprint(priced)).not.toBe(configurationFingerprint(base));
    // An owner plan with the same shape is configuration.
    expect(configurationFingerprint(snapshot({ plans: [...base.plans, { ...custom, name: "Weekend" }] }))).not.toBe(configurationFingerprint(base));
  });

  it("the configuration fingerprint ignores student content and changes with any price, policy, plan, branch, timezone or currency", () => {
    const base = snapshot();
    expect(configurationFingerprint(snapshot({ legacyPayments: [legacy({ month: 10 })], students: [{ id: "s1", homeAcademyId: "b1", status: "INACTIVE" }] }))).toBe(configurationFingerprint(base));
    for (const changed of [
      snapshot({ terms: [{ ...base.terms[0]!, priceAmount: "26000.00" }] }),
      snapshot({ policies: [{ ...base.policies[0]!, graceDay: 6 }] }),
      snapshot({ plans: [{ ...base.plans[0]!, active: false }] }),
      snapshot({ branches: [{ id: "b1", timezone: "America/New_York" }] }),
      snapshot({ organization: { id: "org", currency: "USD" } }),
    ]) {
      expect(configurationFingerprint(changed)).not.toBe(configurationFingerprint(base));
    }
  });
});

describe("rule 6: students changed since approval must be refreshed by confirmations recorded AFTER the approval", () => {
  const approvedAt = new Date("2026-10-30T12:00:00Z");
  it("a changed student needs a current review recorded after approval; an unchanged one needs nothing", () => {
    const before = snapshot();
    const approved = evaluateReadiness(before, S).fingerprints.students;
    const after = snapshot({ legacyPayments: [legacy({ month: 10, status: "PAID" })] }); // an October payment arriving 2 Nov
    expect(studentsNeedingRefresh({ studentFingerprints: approved, approvedAt }, before, evaluateReadiness(before, S))).toEqual({ changed: [], notRefreshed: [] });
    expect(studentsNeedingRefresh({ studentFingerprints: approved, approvedAt }, after, evaluateReadiness(after, S))).toEqual({ changed: ["s1"], notRefreshed: ["s1"] });
  });

  it("a changed promo/exempt student needs BOTH a review and a pricing acknowledgement recorded after approval; before approval never counts", () => {
    const promoRow = legacy({ id: "promo", month: 9, status: "PROMO", promoName: "Family", promoRecurring: true });
    const before = snapshot({ legacyPayments: [promoRow] });
    const approved = evaluateReadiness(before, S).fingerprints.students;
    const changedRows = [promoRow, legacy({ id: "oct", month: 10, status: "PROMO", promoName: "Family", promoRecurring: true })];
    const conf = (kind: "OPENING_REVIEWED" | "PRICING_ACKNOWLEDGED", at: string, s: ReadinessSnapshot) => {
      const fp = evaluateReadiness(s, S).fingerprints.students.s1!;
      return {
        id: `${kind}-${at}`, studentId: "s1", candidateYear: S.year, candidateMonth: S.month, kind, sequence: at > "2026-10-30" ? 2 : 1, fingerprintFormat: FINGERPRINT_FORMAT,
        binding: kind === "OPENING_REVIEWED" ? openingReviewBinding(S, fp) : pricingAckBinding(S, fp, branchFingerprint(s, "b1")),
        declaredNoOpeningDebt: kind === "OPENING_REVIEWED" ? true : null, legacyPaymentPeriodId: null, confirmedAt: at,
      };
    };
    const changed = snapshot({ legacyPayments: changedRows });
    const reviewedOnly = snapshot({ legacyPayments: changedRows, confirmations: [conf("OPENING_REVIEWED", "2026-10-31T09:00:00.000Z", changed)] });
    expect(studentsNeedingRefresh({ studentFingerprints: approved, approvedAt }, reviewedOnly, evaluateReadiness(reviewedOnly, S)).notRefreshed).toEqual(["s1"]);
    const both = snapshot({
      legacyPayments: changedRows,
      confirmations: [conf("OPENING_REVIEWED", "2026-10-31T09:00:00.000Z", changed), conf("PRICING_ACKNOWLEDGED", "2026-10-31T09:01:00.000Z", changed)],
    });
    expect(studentsNeedingRefresh({ studentFingerprints: approved, approvedAt }, both, evaluateReadiness(both, S)).notRefreshed).toEqual([]);
    // The same valid confirmations, recorded before the approval instant, do not count as a refresh.
    const early = snapshot({
      legacyPayments: changedRows,
      confirmations: [conf("OPENING_REVIEWED", "2026-10-29T09:00:00.000Z", changed), conf("PRICING_ACKNOWLEDGED", "2026-10-29T09:01:00.000Z", changed)],
    });
    expect(studentsNeedingRefresh({ studentFingerprints: approved, approvedAt }, early, evaluateReadiness(early, S)).notRefreshed).toEqual(["s1"]);
  });
});
