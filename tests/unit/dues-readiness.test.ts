import { describe, expect, it } from "vitest";
import type { ReadinessSnapshot } from "../../src/lib/dues/readiness/snapshot";
import { branchFingerprint, openingReviewBinding, organizationFingerprint, pricingAckBinding, studentFingerprint } from "../../src/lib/dues/readiness/fingerprint";
import { evaluateReadiness } from "../../src/lib/dues/readiness/evaluate";

/**
 * Stage 8 PR 8a — the pure parts: content fingerprints and the readiness evaluation. Synthetic fixtures; every test changes
 * exactly one thing against a known-good snapshot. Database behaviour (snapshot isolation, authorization, no writes,
 * equivalence with the real monthly writer) is in tests/integration/dues-readiness.test.ts.
 */
const S = { year: 2031, month: 3 };

/** Two branches (USD and CRC), each with a monthly plan, terms and a policy effective before S; three ACTIVE students with
 * history before S and an assignment. Checks 1-5 all pass on this snapshot. */
function base(): ReadinessSnapshot {
  return {
    organization: { id: "org", currency: "USD" },
    branches: [
      { id: "b-usd", timezone: "America/Costa_Rica" },
      { id: "b-crc", timezone: "America/Costa_Rica" },
    ],
    plans: [
      { id: "p-usd", academyId: "b-usd", name: "Monthly", active: true },
      { id: "p-crc", academyId: "b-crc", name: "Mensual", active: true },
    ],
    terms: [
      { id: "t-usd", planId: "p-usd", effectiveYear: 2031, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1 },
      { id: "t-crc", planId: "p-crc", effectiveYear: 2031, effectiveMonth: 1, priceAmount: "25000.00", currency: "CRC", monthsCovered: 1 },
    ],
    policies: [
      { id: "pol-usd", academyId: "b-usd", effectiveYear: 2031, effectiveMonth: 1, dueDay: 10, graceDay: 5, lateFeeAmount: "10.00", lateFeeCurrency: "USD", maxPrepaidMonths: null },
      { id: "pol-crc", academyId: "b-crc", effectiveYear: 2031, effectiveMonth: 1, dueDay: 10, graceDay: 5, lateFeeAmount: "2000.00", lateFeeCurrency: "CRC", maxPrepaidMonths: null },
    ],
    students: [
      { id: "s1", homeAcademyId: "b-usd", status: "ACTIVE" },
      { id: "s2", homeAcademyId: "b-usd", status: "ACTIVE" },
      { id: "s3", homeAcademyId: "b-crc", status: "ACTIVE" },
    ],
    statusChanges: [
      { id: "h1", studentId: "s1", status: "ACTIVE", effectiveOn: "2031-01-15", sequence: 1, source: "BASELINE" },
      { id: "h2", studentId: "s2", status: "ACTIVE", effectiveOn: "2031-01-15", sequence: 1, source: "BASELINE" },
      { id: "h3", studentId: "s3", status: "ACTIVE", effectiveOn: "2031-02-28", sequence: 1, source: "EVENT" },
    ],
    assignments: [
      { id: "a1", studentId: "s1", planId: "p-usd", effectiveYear: 2031, effectiveMonth: 3 },
      { id: "a2", studentId: "s2", planId: "p-usd", effectiveYear: 2031, effectiveMonth: 2 },
      { id: "a3", studentId: "s3", planId: "p-crc", effectiveYear: 2031, effectiveMonth: 3 },
    ],
    legacyPayments: [
      { id: "l1", studentId: "s1", year: 2031, month: 1, status: "PENDING", amount: "100.00", currency: "USD", planId: "p-usd", promoName: null, promoRecurring: false },
      { id: "l2", studentId: "s3", year: 2031, month: 2, status: "PAID", amount: "25000.00", currency: "CRC", planId: "p-crc", promoName: null, promoRecurring: false },
    ],
    monthlyObligations: [],
    coverage: [],
  };
}
const clone = (s: ReadinessSnapshot): ReadinessSnapshot => structuredClone(s);
const check = (snapshot: ReadinessSnapshot, id: number) => evaluateReadiness(snapshot, S).checks.find((c) => c.id === id)!;

describe("fingerprints are deterministic", () => {
  it("row order and object key order never change any fingerprint", () => {
    const a = base();
    const b = clone(a);
    for (const key of Object.keys(b) as (keyof ReadinessSnapshot)[]) {
      const value = b[key];
      if (Array.isArray(value)) (b as unknown as Record<string, unknown[]>)[key] = [...value].reverse().map((row) => Object.fromEntries(Object.entries(row as object).reverse()));
    }
    expect(organizationFingerprint(b, S)).toBe(organizationFingerprint(a, S));
    expect(studentFingerprint(b, "s1")).toBe(studentFingerprint(a, "s1"));
    expect(branchFingerprint(b, "b-usd")).toBe(branchFingerprint(a, "b-usd"));
  });

  it("the same snapshot twice gives the same fingerprints", () => {
    expect(evaluateReadiness(base(), S).fingerprints).toEqual(evaluateReadiness(base(), S).fingerprints);
  });
});

describe("fingerprints change when reviewed content changes — including in-place edits with the same id", () => {
  const studentEdits: [string, (s: ReadinessSnapshot) => void][] = [
    ["legacy status edited in place (PENDING -> PAID, same id)", (s) => void (s.legacyPayments[0].status = "PAID")],
    ["legacy amount edited in place", (s) => void (s.legacyPayments[0].amount = "90.00")],
    ["legacy currency edited in place", (s) => void (s.legacyPayments[0].currency = "CRC")],
    ["legacy promo flag edited in place", (s) => void (s.legacyPayments[0].promoRecurring = true)],
    ["a new legacy row (carry-forward)", (s) => void s.legacyPayments.push({ ...s.legacyPayments[0], id: "l9", month: 2 })],
    ["status row", (s) => void (s.statusChanges[0].status = "INACTIVE")],
    ["assignment plan", (s) => void (s.assignments[0].planId = null)],
    ["Student.status", (s) => void (s.students[0].status = "INACTIVE")],
    ["an existing MONTHLY obligation", (s) => void s.monthlyObligations.push({ id: "o1", studentId: "s1", coverageYear: 2031, coverageMonth: 3 })],
  ];
  it.each(studentEdits)("student fingerprint: %s", (_label, edit) => {
    const changed = clone(base());
    edit(changed);
    expect(studentFingerprint(changed, "s1")).not.toBe(studentFingerprint(base(), "s1"));
    expect(organizationFingerprint(changed, S)).not.toBe(organizationFingerprint(base(), S));
    // Another student's fingerprint is unaffected.
    expect(studentFingerprint(changed, "s3")).toBe(studentFingerprint(base(), "s3"));
  });

  const branchEdits: [string, (s: ReadinessSnapshot) => void][] = [
    ["terms price corrected in place (same id)", (s) => void (s.terms[0].priceAmount = "110.00")],
    ["terms currency", (s) => void (s.terms[0].currency = "CRC")],
    ["policy due day corrected in place (D25)", (s) => void (s.policies[0].dueDay = 12)],
    ["policy late fee amount", (s) => void (s.policies[0].lateFeeAmount = "15.00")],
    ["policy prepayment limit", (s) => void (s.policies[0].maxPrepaidMonths = 3)],
    ["plan name (drives promo classification)", (s) => void (s.plans[0].name = "Promo")],
    ["plan deactivated", (s) => void (s.plans[0].active = false)],
    ["branch timezone", (s) => void (s.branches[0].timezone = "America/New_York")],
  ];
  it.each(branchEdits)("branch fingerprint: %s", (_label, edit) => {
    const changed = clone(base());
    edit(changed);
    expect(branchFingerprint(changed, "b-usd")).not.toBe(branchFingerprint(base(), "b-usd"));
    expect(branchFingerprint(changed, "b-crc")).toBe(branchFingerprint(base(), "b-crc"));
    expect(organizationFingerprint(changed, S)).not.toBe(organizationFingerprint(base(), S));
  });

  it("organization fingerprint depends on the candidate month and the organization currency", () => {
    expect(organizationFingerprint(base(), { year: 2031, month: 4 })).not.toBe(organizationFingerprint(base(), S));
    const changed = clone(base());
    changed.organization.currency = "CRC";
    expect(organizationFingerprint(changed, S)).not.toBe(organizationFingerprint(base(), S));
  });
});

describe("confirmation bindings (used by stage 8c)", () => {
  const studentFp = studentFingerprint(base(), "s1");
  const branchFp = branchFingerprint(base(), "b-usd");
  it("a branch price or policy change invalidates the pricing acknowledgement but not the opening review", () => {
    const changed = clone(base());
    changed.policies[0].lateFeeAmount = "15.00";
    const changedBranchFp = branchFingerprint(changed, "b-usd");
    expect(pricingAckBinding(S, studentFp, changedBranchFp)).not.toBe(pricingAckBinding(S, studentFp, branchFp));
    expect(openingReviewBinding(S, studentFingerprint(changed, "s1"))).toBe(openingReviewBinding(S, studentFp));
  });
  it("both depend on the candidate month and the student content, and never collide with each other", () => {
    const next = { year: 2031, month: 4 };
    expect(openingReviewBinding(next, studentFp)).not.toBe(openingReviewBinding(S, studentFp));
    expect(pricingAckBinding(next, studentFp, branchFp)).not.toBe(pricingAckBinding(S, studentFp, branchFp));
    expect(openingReviewBinding(S, studentFp)).not.toBe(pricingAckBinding(S, studentFp, branchFp));
  });
});

describe("readiness: checks 1-5 are computed", () => {
  it("all five pass on the known-good snapshot", () => {
    const report = evaluateReadiness(base(), S);
    expect(report.checks.slice(0, 5).map((c) => [c.id, c.status])).toEqual([
      [1, "pass"], [2, "pass"], [3, "pass"], [4, "pass"], [5, "pass"],
    ]);
  });

  it("1 fails for an ACTIVE student whose only status row is ON the 1st of S (strict before), and lists them", () => {
    const s = base();
    s.statusChanges[2].effectiveOn = "2031-03-01";
    expect(check(s, 1)).toMatchObject({ status: "fail", items: ["student:s3"] });
  });
  it("1 fails for an ACTIVE student with no status history at all", () => {
    const s = base();
    s.statusChanges = s.statusChanges.filter((r) => r.studentId !== "s2");
    expect(check(s, 1)).toMatchObject({ status: "fail", items: ["student:s2"] });
  });
  it("1 ignores students who are not ACTIVE", () => {
    const s = base();
    s.students[1].status = "INACTIVE";
    s.statusChanges = s.statusChanges.filter((r) => r.studentId !== "s2");
    expect(check(s, 1).status).toBe("pass");
  });

  it("2 fails when Student.status disagrees with the latest row, using sequence to break a same-day tie", () => {
    const s = base();
    s.statusChanges.push({ id: "h1b", studentId: "s1", status: "INACTIVE", effectiveOn: "2031-01-15", sequence: 2, source: "EVENT" });
    expect(check(s, 2)).toMatchObject({ status: "fail", items: ["student:s1"] });
    const t = base();
    t.statusChanges.push({ id: "h1b", studentId: "s1", status: "INACTIVE", effectiveOn: "2031-01-15", sequence: 0, source: "EVENT" });
    expect(check(t, 2).status).toBe("pass");
  });

  it("3 fails for a branch with ACTIVE students but no policy effective for S", () => {
    const s = base();
    s.policies[1].effectiveMonth = 4; // CRC policy only from April
    const c = check(s, 3);
    expect(c.status).toBe("fail");
    expect(c.items).toContain("branch:b-crc");
    expect(c.items).toContain("student:s3"); // and the student it would have charged is a configuration gap
  });
  it("3 fails for a package plan assigned as monthly (inapplicable) and for a terms/fee currency mismatch", () => {
    const pkg = base();
    pkg.terms[0].monthsCovered = 3;
    expect(check(pkg, 3).items).toEqual(expect.arrayContaining(["student:s1", "student:s2"]));
    const mismatch = base();
    mismatch.policies[1].lateFeeCurrency = "USD";
    expect(check(mismatch, 3).items).toEqual(["student:s3"]);
  });

  it("4 fails for an ACTIVE student with no assignment effective for S (a future one does not count)", () => {
    const s = base();
    s.assignments[2].effectiveMonth = 4;
    expect(check(s, 4)).toMatchObject({ status: "fail", items: ["student:s3"] });
  });
  it("4 accepts an explicit 'no plan' and lists the student as such in the preview", () => {
    const s = base();
    s.assignments[2].planId = null;
    expect(check(s, 4).status).toBe("pass");
    const crc = evaluateReadiness(s, S).preview.branches.find((b) => b.academyId === "b-crc")!;
    expect(crc.explicitNoPlan).toEqual(["s3"]);
    expect(crc.unassigned).toEqual([]);
  });
  it("4 fails for an assignment to another branch's plan", () => {
    const s = base();
    s.assignments[2].planId = "p-usd";
    expect(check(s, 4)).toMatchObject({ status: "fail", items: ["student:s3"] });
  });

  it("5 fails for a legacy row in S or later, never for earlier months", () => {
    const s = base();
    s.legacyPayments.push({ ...s.legacyPayments[0], id: "l-march", month: 3 }, { ...s.legacyPayments[0], id: "l-april", month: 4 });
    expect(check(s, 5)).toMatchObject({ status: "fail", items: ["legacy:l-march", "legacy:l-april"] });
    expect(check(base(), 5).status).toBe("pass");
  });
});

describe("readiness: never falsely ready", () => {
  it("checks 6-12 are notImplemented and 13 is decisionPending, even when 1-5 pass", () => {
    const report = evaluateReadiness(base(), S);
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      [1, "pass"], [2, "pass"], [3, "pass"], [4, "pass"], [5, "pass"],
      [6, "notImplemented"], [7, "notImplemented"], [8, "notImplemented"], [9, "notImplemented"],
      [10, "notImplemented"], [11, "notImplemented"], [12, "notImplemented"], [13, "decisionPending"],
    ]);
    expect(report.ready).toBe(false);
  });

  it("check 6 is never silently empty: it lists every promo/exempt student", () => {
    const s = base();
    s.legacyPayments[1].status = "EXEMPT";
    s.legacyPayments.push({ ...s.legacyPayments[0], id: "l-promo", studentId: "s2", status: "PROMO" });
    expect(check(s, 6)).toMatchObject({ status: "notImplemented", items: ["student:s2", "student:s3"] });
  });

  it("check 12 is about the mechanism existing, not about the organization being active", () => {
    expect(check(base(), 12).detail).toMatch(/mechanism/);
  });
});

describe("dry-run preview", () => {
  it("totals are per branch and per currency, in exact minor units, never summed across currencies", () => {
    const branches = evaluateReadiness(base(), S).preview.branches;
    expect(branches.find((b) => b.academyId === "b-usd")!.wouldCreate).toEqual([{ currency: "USD", count: 2, total: "200.00" }]);
    expect(branches.find((b) => b.academyId === "b-crc")!.wouldCreate).toEqual([{ currency: "CRC", count: 1, total: "25000.00" }]);
    expect(JSON.stringify(branches)).not.toMatch(/25200|25100/);
  });

  it("classifies students in the monthly writer's order: eligibility, effective versions, existing coverage, applicability, currency", () => {
    const s = base();
    s.monthlyObligations.push({ id: "o1", studentId: "s1", coverageYear: 2031, coverageMonth: 3 });
    s.coverage.push({ id: "c2", studentId: "s2", year: 2031, month: 3 });
    s.students.push({ id: "s4", homeAcademyId: "b-usd", status: "INACTIVE" });
    s.statusChanges.push({ id: "h4", studentId: "s4", status: "INACTIVE", effectiveOn: "2031-01-15", sequence: 1, source: "EVENT" });
    const byId = Object.fromEntries(evaluateReadiness(s, S).preview.students.map((p) => [p.studentId, p]));
    expect(byId.s1).toMatchObject({ outcome: "alreadyCovered", reason: "existingObligation" });
    expect(byId.s2).toMatchObject({ outcome: "alreadyCovered", reason: "packageCoverage" });
    expect(byId.s3).toMatchObject({ outcome: "created", amount: "25000.00", currency: "CRC" });
    expect(byId.s4).toMatchObject({ outcome: "notEligible", reason: "NOT_ELIGIBLE" });
    // An existing obligation is only reported once the versions resolve — exactly like the writer, which checks versions first.
    const noVersion = clone(s);
    noVersion.terms = noVersion.terms.filter((t) => t.planId !== "p-usd");
    expect(evaluateReadiness(noVersion, S).preview.students.find((p) => p.studentId === "s1")).toMatchObject({ outcome: "configurationGap", reason: "noEffectiveVersion" });
  });

  it("uses the version effective for S, not a later one", () => {
    const s = base();
    s.terms.push({ id: "t-usd-apr", planId: "p-usd", effectiveYear: 2031, effectiveMonth: 4, priceAmount: "120.00", currency: "USD", monthsCovered: 1 });
    expect(evaluateReadiness(s, S).preview.branches.find((b) => b.academyId === "b-usd")!.wouldCreate).toEqual([{ currency: "USD", count: 2, total: "200.00" }]);
  });

  it("states that pre-switch signup debt is excluded, not waived", () => {
    expect(evaluateReadiness(base(), S).notes.join(" ")).toMatch(/excluded.*not waived/);
  });
});
