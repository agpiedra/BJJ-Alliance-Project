import { describe, expect, it } from "vitest";
import type { ReadinessSnapshot } from "../../src/lib/dues/readiness/snapshot";
import { FINGERPRINT_FORMAT, branchFingerprint, openingReviewBinding, organizationFingerprint, pricingAckBinding, studentFingerprint } from "../../src/lib/dues/readiness/fingerprint";
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
    openingItems: [],
    withdrawnOpeningItems: [],
    confirmations: [],
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

describe("stage 8b: opening-debt drafts in the student fingerprint (format r2)", () => {
  type Active = ReadinessSnapshot["openingItems"][number];
  type Withdrawn = ReadinessSnapshot["withdrawnOpeningItems"][number];
  const draft = (id: string, over: Partial<Active> = {}): Active => ({
    id, studentId: "s1", coverageYear: 2031, coverageMonth: 1, amount: "100.00", currency: "USD", note: "Unpaid January", legacyPaymentPeriodId: null, ...over,
  });
  const withdrawn = (id: string, withdrawalKind: Withdrawn["withdrawalKind"], supersededById: string | null = null): Withdrawn => ({
    id, studentId: "s1", withdrawalKind, supersededById,
  });
  const state = (active: Active[], gone: Withdrawn[]) => {
    const s = clone(base());
    s.openingItems.push(...active);
    s.withdrawnOpeningItems.push(...gone);
    return s;
  };
  const binding = (s: ReadinessSnapshot) => openingReviewBinding(S, studentFingerprint(s, "s1"));

  // The binding an owner's "no opening debt" confirmation (B0) was stored with must never come back once a draft has existed.
  it("revival regression: add then withdraw does not return to the no-draft binding", () => {
    const b0 = binding(base());
    const b1 = binding(state([draft("d1")], []));
    const b2 = binding(state([], [withdrawn("d1", "WITHDRAWN")]));
    expect(b2).not.toBe(b0);
    expect(b2).not.toBe(b1);
  });

  it("revival regression: edit then withdraw does not return to the no-draft binding", () => {
    const bindings = [
      binding(base()),
      binding(state([draft("d1")], [])),
      binding(state([draft("d2", { amount: "80.00" })], [withdrawn("d1", "EDITED", "d2")])),
      binding(state([], [withdrawn("d1", "EDITED", "d2"), withdrawn("d2", "WITHDRAWN")])),
    ];
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it("revival regression: edit then revert (the original values re-entered) is a new id, hence a new binding", () => {
    const original = binding(state([draft("d1")], []));
    const reverted = binding(state([draft("d3")], [withdrawn("d1", "EDITED", "d2"), withdrawn("d2", "EDITED", "d3")]));
    expect(reverted).not.toBe(original);
  });

  const activeEdits: [string, (d: Active) => void][] = [
    ["amount", (d) => void (d.amount = "90.00")],
    ["currency", (d) => void (d.currency = "CRC")],
    ["note", (d) => void (d.note = "Unpaid January (corrected)")],
    ["month", (d) => void (d.coverageMonth = 2)],
    ["year", (d) => void (d.coverageYear = 2030)],
    ["legacy link", (d) => void (d.legacyPaymentPeriodId = "l1")],
  ];
  it.each(activeEdits)("an active draft's %s changes the student and organization fingerprints and the opening binding, not other students'", (_label, edit) => {
    const before = state([draft("d1")], []);
    const after = clone(before);
    edit(after.openingItems[0]);
    expect(studentFingerprint(after, "s1")).not.toBe(studentFingerprint(before, "s1"));
    expect(organizationFingerprint(after, S)).not.toBe(organizationFingerprint(before, S));
    expect(binding(after)).not.toBe(binding(before));
    expect(studentFingerprint(after, "s3")).toBe(studentFingerprint(before, "s3"));
  });

  it("a withdrawn draft contributes only its id, kind and successor: an amount, currency or note on it is never hashed", () => {
    const plain = state([], [withdrawn("d1", "WITHDRAWN")]);
    const carryingMoney = clone(plain);
    Object.assign(carryingMoney.withdrawnOpeningItems[0], { amount: "999.00", currency: "CRC", note: "should not count" });
    expect(studentFingerprint(carryingMoney, "s1")).toBe(studentFingerprint(plain, "s1"));
    expect(studentFingerprint(state([], [withdrawn("d1", "EDITED", "d2")]), "s1")).not.toBe(studentFingerprint(plain, "s1"));
    expect(studentFingerprint(state([], [withdrawn("d9", "WITHDRAWN")]), "s1")).not.toBe(studentFingerprint(plain, "s1"));
  });

  it("an active draft and a withdrawn row with the same id never hash alike", () => {
    expect(studentFingerprint(state([draft("d1")], []), "s1")).not.toBe(studentFingerprint(state([], [withdrawn("d1", "WITHDRAWN")]), "s1"));
  });

  // Recorded from the stage 8a (r1) code on 6c907cf for this exact base() snapshot, before the r2 change.
  const R1 = {
    student: "0d03de7a4afb9b6c33a92a64bc1a24bfac92b95ff25a0a6b1354ce0efd331414",
    branch: "885bbb43512f7af19940ff460e595da15401e5f537716cbab4a6f2141c66d904",
    organization: "3b69fa6b240a47d2ecf21641336ccd74cff10cdb98bf0e67a32b51291d14f47b",
    openingReview: "c0d823f3ba2417b90b0a53fc1f9752f504d1a350295bcca50005220b9f6322b7",
  };
  it("format r2: no fingerprint or binding equals the r1 value for the same content", () => {
    expect(FINGERPRINT_FORMAT).toBe("r2");
    expect(studentFingerprint(base(), "s1")).not.toBe(R1.student);
    expect(branchFingerprint(base(), "b-usd")).not.toBe(R1.branch);
    expect(organizationFingerprint(base(), S)).not.toBe(R1.organization);
    expect(binding(base())).not.toBe(R1.openingReview);
  });

  it("a branch-only change still invalidates the pricing acknowledgement with drafts present", () => {
    const s = state([draft("d1")], [withdrawn("d0", "WITHDRAWN")]);
    const changed = clone(s);
    changed.terms[0].priceAmount = "110.00";
    const studentFp = studentFingerprint(s, "s1");
    expect(studentFingerprint(changed, "s1")).toBe(studentFp);
    expect(pricingAckBinding(S, studentFp, branchFingerprint(changed, "b-usd"))).not.toBe(pricingAckBinding(S, studentFp, branchFingerprint(s, "b-usd")));
  });

  it("drafts (active or withdrawn) never change the MONTHLY preview, its totals or any check; ready stays false", () => {
    const withDrafts = state(
      [draft("d1"), draft("d4", { studentId: "s3", amount: "5000.00", currency: "CRC" })],
      [withdrawn("d0", "WITHDRAWN"), { ...withdrawn("d5", "WITHDRAWN"), studentId: "s2" }],
    );
    const before = evaluateReadiness(base(), S);
    const after = evaluateReadiness(withDrafts, S);
    expect(after.preview).toEqual(before.preview);
    expect(after.checks).toEqual(before.checks);
    expect(after.ready).toBe(false);
    expect(after.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([10, 11, 12]);
    expect(after.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
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
  it("stage 8c: checks 6-9 are computed, 10-12 stay notImplemented and 13 decisionPending; 9 fails with no reviews", () => {
    const report = evaluateReadiness(base(), S);
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      [1, "pass"], [2, "pass"], [3, "pass"], [4, "pass"], [5, "pass"],
      [6, "pass"], [7, "pass"], [8, "pass"], [9, "fail"],
      [10, "notImplemented"], [11, "notImplemented"], [12, "notImplemented"], [13, "decisionPending"],
    ]);
    expect(report.ready).toBe(false);
  });

  it("check 6 is never silently empty: it fails listing every promo/exempt student without an acknowledgement", () => {
    const s = base();
    s.legacyPayments[1].status = "EXEMPT";
    s.legacyPayments.push({ ...s.legacyPayments[0], id: "l-promo", studentId: "s2", status: "PROMO" });
    expect(check(s, 6)).toMatchObject({ status: "fail", items: ["student:s2", "student:s3"] });
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

describe("stage 8c: confirmations, checks 6-9, warnings and opening totals", () => {
  type Confirmation = ReadinessSnapshot["confirmations"][number];
  type Active = ReadinessSnapshot["openingItems"][number];
  let n = 0;
  const draft = (over: Partial<Active> = {}): Active => ({
    id: `d${++n}`, studentId: "s1", coverageYear: 2031, coverageMonth: 1, amount: "100.00", currency: "USD", note: "Unpaid", legacyPaymentPeriodId: null, ...over,
  });
  /** A confirmation bound to `snap` as it is now (what the 8c writer stores after a matching review). */
  const confirm = (snap: ReadinessSnapshot, studentId: string, kind: "OPENING_REVIEWED" | "PRICING_ACKNOWLEDGED", over: Partial<Confirmation> = {}): Confirmation => {
    const studentFp = studentFingerprint(snap, studentId);
    const home = snap.students.find((st) => st.id === studentId)!.homeAcademyId;
    const binding = kind === "OPENING_REVIEWED" ? openingReviewBinding(S, studentFp) : pricingAckBinding(S, studentFp, branchFingerprint(snap, home));
    return {
      id: `c${++n}`, studentId, candidateYear: S.year, candidateMonth: S.month, kind, sequence: 1, fingerprintFormat: FINGERPRINT_FORMAT, binding,
      declaredNoOpeningDebt: kind === "OPENING_REVIEWED" ? true : null, confirmedAt: "2031-02-20T10:00:00.000Z", ...over,
    };
  };
  const reviewAll = (snap: ReadinessSnapshot) => {
    for (const st of snap.students) snap.confirmations.push(confirm(snap, st.id, "OPENING_REVIEWED"));
    return snap;
  };
  const report = (snap: ReadinessSnapshot) => evaluateReadiness(snap, S);
  const stateOf = (snap: ReadinessSnapshot, id: string) => report(snap).confirmations.find((c) => c.studentId === id)!;

  it("confirmation records are in no fingerprint", () => {
    const s = clone(base());
    const before = report(s).fingerprints;
    reviewAll(s);
    s.confirmations.push(confirm(s, "s1", "PRICING_ACKNOWLEDGED"));
    expect(report(s).fingerprints).toEqual(before);
  });

  it("check 9 passes when every active student has a valid review; ready stays false with checks 1-9 passing", () => {
    const r = report(reviewAll(clone(base())));
    expect(r.checks.filter((c) => c.id <= 9).every((c) => c.status === "pass")).toBe(true);
    expect(r.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([10, 11, 12]);
    expect(r.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
    expect(r.ready).toBe(false);
  });

  it("check 9 (U1): an inactive student needs a review only with an active draft; withdrawing it does not revive an older review", () => {
    const s = reviewAll(clone(base()));
    s.students.push({ id: "s4", homeAcademyId: "b-usd", status: "INACTIVE" });
    expect(check(s, 9).status).toBe("pass"); // s4 is inactive with no draft: not listed
    s.openingItems.push(draft({ id: "d-s4", studentId: "s4" }));
    expect(check(s, 9)).toMatchObject({ status: "fail", items: ["student:s4"] });
    const reviewed = clone(s);
    reviewed.confirmations.push(confirm(reviewed, "s4", "OPENING_REVIEWED", { declaredNoOpeningDebt: false }));
    expect(check(reviewed, 9).status).toBe("pass");
    // The draft is withdrawn: s4 is no longer required, but its earlier review does not become valid again.
    reviewed.openingItems = reviewed.openingItems.filter((d) => d.id !== "d-s4");
    reviewed.withdrawnOpeningItems.push({ id: "d-s4", studentId: "s4", withdrawalKind: "WITHDRAWN", supersededById: null });
    expect(stateOf(reviewed, "s4").openingReview.state).toBe("stale");
  });

  it("an added draft makes a no-opening-debt review stale, and add-then-withdraw does not revive it", () => {
    const s = reviewAll(clone(base()));
    expect(stateOf(s, "s1").openingReview.state).toBe("valid");
    s.openingItems.push(draft({ id: "d-x" }));
    expect(stateOf(s, "s1").openingReview.state).toBe("stale");
    s.openingItems = [];
    s.withdrawnOpeningItems.push({ id: "d-x", studentId: "s1", withdrawalKind: "WITHDRAWN", supersededById: null });
    expect(stateOf(s, "s1").openingReview.state).toBe("stale");
    expect(check(s, 9)).toMatchObject({ status: "fail", items: ["student:s1"] });
  });

  it("the current confirmation is the highest sequence, whatever the timestamps; an old format or another S never counts", () => {
    const s = clone(base());
    const valid = confirm(s, "s1", "OPENING_REVIEWED", { sequence: 1, confirmedAt: "2031-02-20T10:00:00.000Z" });
    const staleLater = { ...valid, id: "c-stale", sequence: 2, binding: "f".repeat(64) }; // the same timestamp
    s.confirmations.push(valid, staleLater);
    expect(stateOf(s, "s1").openingReview).toMatchObject({ state: "stale", sequence: 2 });
    s.confirmations = [
      { ...staleLater, sequence: 1, confirmedAt: "2031-02-21T00:00:00.000Z" },
      { ...valid, sequence: 2, confirmedAt: "2031-02-01T00:00:00.000Z" }, // older timestamp, higher sequence
    ];
    expect(stateOf(s, "s1").openingReview).toMatchObject({ state: "valid", sequence: 2 });
    s.confirmations = [{ ...valid, fingerprintFormat: "r1" }];
    expect(stateOf(s, "s1").openingReview.state).toBe("stale");
    s.confirmations = [{ ...valid, candidateMonth: S.month + 1 }];
    expect(stateOf(s, "s1").openingReview.state).toBe("missing");
  });

  it("check 6: a promo student passes with a valid acknowledgement; a branch price or policy change alone makes it stale", () => {
    const s = clone(base());
    s.legacyPayments.push({ ...s.legacyPayments[0], id: "l-promo", studentId: "s2", status: "PROMO" });
    expect(check(s, 6)).toMatchObject({ status: "fail", items: ["student:s2"] });
    s.confirmations.push(confirm(s, "s2", "PRICING_ACKNOWLEDGED"));
    expect(check(s, 6).status).toBe("pass");
    const priced = clone(s);
    priced.terms[0].priceAmount = "110.00"; // a D25 correction on s2's branch
    expect(check(priced, 6)).toMatchObject({ status: "fail", items: ["student:s2"] });
    expect(stateOf(priced, "s2").pricingAck.state).toBe("stale");
    const policy = clone(s);
    policy.policies[0].graceDay = 6;
    expect(check(policy, 6).status).toBe("fail");
    const otherBranch = clone(s);
    otherBranch.terms[1].priceAmount = "26000.00"; // the CRC branch, not s2's
    expect(check(otherBranch, 6).status).toBe("pass");
  });

  it("check 7: an active draft over a PAID month without a link fails; with the link it passes and warns; withdrawn drafts and PENDING months are ignored", () => {
    const s = clone(base()); // l2: s3, 2031-02, PAID, CRC
    s.openingItems.push(draft({ id: "d-paid", studentId: "s3", coverageMonth: 2, currency: "CRC", amount: "5000.00" }));
    expect(check(s, 7)).toMatchObject({ status: "fail", items: ["openingItem:d-paid"] });
    s.openingItems[0].legacyPaymentPeriodId = "l2";
    expect(check(s, 7).status).toBe("pass");
    expect(report(s).warnings).toContainEqual({ key: "openingItemLinkedToPaidRow", items: ["openingItem:d-paid"] });
    const pending = clone(base()); // l1: s1, 2031-01, PENDING
    pending.openingItems.push(draft({ id: "d-pending" }));
    expect(check(pending, 7).status).toBe("pass");
    const gone = clone(base());
    gone.withdrawnOpeningItems.push({ id: "d-gone", studentId: "s3", withdrawalKind: "WITHDRAWN", supersededById: null });
    expect(check(gone, 7).status).toBe("pass");
  });

  it("check 8: an active draft for S or later fails; the month before S passes; a withdrawn one is ignored", () => {
    const s = clone(base());
    s.openingItems.push(draft({ id: "d-s", coverageYear: S.year, coverageMonth: S.month }), draft({ id: "d-before", coverageMonth: 2 }));
    expect(check(s, 8)).toMatchObject({ status: "fail", items: ["openingItem:d-s"] });
    s.openingItems = s.openingItems.filter((d) => d.id !== "d-s");
    s.withdrawnOpeningItems.push({ id: "d-s", studentId: "s1", withdrawalKind: "WITHDRAWN", supersededById: null });
    expect(check(s, 8).status).toBe("pass");
  });

  it("warnings: above the legacy amount or the plan price (same currency only), a currency differing from the plan; no reference, no amount warning", () => {
    const s = clone(base()); // s1: legacy 2031-01 100.00 USD; plan p-usd 100.00 USD from 2031-01
    s.assignments.push({ id: "a1-early", studentId: "s1", planId: "p-usd", effectiveYear: 2031, effectiveMonth: 1 });
    s.openingItems.push(
      draft({ id: "d-above-legacy", coverageMonth: 1, amount: "100.01" }),
      draft({ id: "d-equal", studentId: "s2", coverageMonth: 2, amount: "100.00" }),
      draft({ id: "d-crc", studentId: "s1", coverageMonth: 2, amount: "99999.00", currency: "CRC" }),
      draft({ id: "d-noref", studentId: "s2", coverageYear: 2030, coverageMonth: 12, amount: "999.00" }),
      // s3's legacy row for 2031-02 is 25000.00 CRC: a larger NUMBER in another currency is not "above" it.
      draft({ id: "d-usd-vs-crc-legacy", studentId: "s3", coverageMonth: 2, amount: "30000.00", currency: "USD" }),
    );
    const warnings = Object.fromEntries(report(s).warnings.map((w) => [w.key, w.items]));
    expect(warnings.openingItemAboveReference).toEqual(["openingItem:d-above-legacy"]);
    // d-usd-vs-crc-legacy: s3's assignment starts in 2031-03, so no plan terms exist for 2031-02 and no currency warning either.
    expect(warnings.openingItemCurrencyDiffersFromPlan).toEqual(["openingItem:d-crc"]);
    expect(warnings.openingItemLinkedToPaidRow).toBeUndefined();
  });

  it("the plan reference alone raises the amount warning (no legacy row for that month)", () => {
    const s = clone(base());
    s.openingItems.push(draft({ id: "d-above-plan", studentId: "s2", coverageMonth: 2, amount: "150.00" })); // a2: p-usd from 2031-02
    expect(report(s).warnings).toContainEqual({ key: "openingItemAboveReference", items: ["openingItem:d-above-plan"] });
  });

  it("opening totals are per branch and per currency, active drafts only, never summed across currencies; the MONTHLY preview is untouched", () => {
    const s = clone(base());
    s.openingItems.push(
      draft({ id: "d1a", amount: "10.10" }),
      draft({ id: "d1b", studentId: "s2", coverageMonth: 2, amount: "0.90" }),
      draft({ id: "d1c", studentId: "s2", coverageMonth: 1, amount: "5000.00", currency: "CRC" }),
      draft({ id: "d3", studentId: "s3", amount: "25000.00", currency: "CRC" }),
    );
    s.withdrawnOpeningItems.push({ id: "d-w", studentId: "s1", withdrawalKind: "WITHDRAWN", supersededById: null });
    expect(report(s).openingDrafts).toEqual([
      { academyId: "b-crc", currency: "CRC", count: 1, total: "25000.00" },
      { academyId: "b-usd", currency: "CRC", count: 1, total: "5000.00" },
      { academyId: "b-usd", currency: "USD", count: 2, total: "11.00" },
    ]);
    expect(report(s).preview).toEqual(report(base()).preview);
  });

  it("regression: opening totals above one column's maximum (99,999,999.99) are reported exactly, never a thrown report", () => {
    const s = clone(base());
    s.openingItems.push(
      draft({ id: "d-max", amount: "99999999.99", currency: "CRC" }),
      draft({ id: "d-more", studentId: "s2", coverageMonth: 2, amount: "0.02", currency: "CRC" }),
    );
    expect(report(s).openingDrafts).toEqual([{ academyId: "b-usd", currency: "CRC", count: 2, total: "100000000.01" }]);
  });
});

describe("regression: MONTHLY wouldCreate totals above one column's maximum (99,999,999.99)", () => {
  /**
   * Each charge below is individually valid (at most the column's 99,999,999.99); only their SUM per branch and currency
   * crosses the single-column limit. Before the fix the whole report threw a RangeError from `minorToDecimal`.
   * s1 stays on p-usd; s2 moves to a second USD plan of the same branch; s3 stays on the CRC branch.
   */
  function withPrices(usd1: string, usd2: string, crc: string): ReadinessSnapshot {
    const s = clone(base());
    s.plans.push({ id: "p-usd2", academyId: "b-usd", name: "Monthly 2", active: true });
    s.terms[0].priceAmount = usd1;
    s.terms.push({ id: "t-usd2", planId: "p-usd2", effectiveYear: 2031, effectiveMonth: 1, priceAmount: usd2, currency: "USD", monthsCovered: 1 });
    s.terms[1].priceAmount = crc;
    s.assignments[1].planId = "p-usd2";
    return s;
  }
  const wouldCreate = (snap: ReadinessSnapshot) =>
    Object.fromEntries(evaluateReadiness(snap, S).preview.branches.map((b) => [b.academyId, b.wouldCreate]));

  it("a branch total of exactly 99,999,999.99 is reported exactly", () => {
    expect(wouldCreate(withPrices("99999999.98", "0.01", "25000.00"))).toEqual({
      "b-usd": [{ currency: "USD", count: 2, total: "99999999.99" }],
      "b-crc": [{ currency: "CRC", count: 1, total: "25000.00" }],
    });
  });

  it("a total above the limit, from individually valid charges, is reported to the exact cent; other branches and currencies stay separate", () => {
    const snap = withPrices("99999999.98", "0.05", "99999999.99");
    expect(wouldCreate(snap)).toEqual({
      "b-usd": [{ currency: "USD", count: 2, total: "100000000.03" }],
      "b-crc": [{ currency: "CRC", count: 1, total: "99999999.99" }],
    });
    expect(wouldCreate(withPrices("99999999.99", "99999999.99", "25000.00"))["b-usd"]).toEqual([{ currency: "USD", count: 2, total: "199999999.98" }]);
  });

  it("student outcomes, amounts and checks are unchanged; ready stays false", () => {
    const report = evaluateReadiness(withPrices("99999999.98", "0.05", "25000.00"), S);
    expect(report.preview.students.map((p) => [p.studentId, p.outcome, p.outcome === "created" ? `${p.amount} ${p.currency}` : ""])).toEqual([
      ["s1", "created", "99999999.98 USD"],
      ["s2", "created", "0.05 USD"],
      ["s3", "created", "25000.00 CRC"],
    ]);
    expect(report.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([10, 11, 12]);
    expect(report.ready).toBe(false);
  });
});
