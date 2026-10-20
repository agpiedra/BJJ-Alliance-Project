import "dotenv/config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import enMessages from "../../messages/en.json";

/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §7.2): the readiness screen's forms against the REAL actions and the REAL
 * isolated test database, with two private temporary organizations (removed in afterAll). Names, amounts and months are synthetic.
 *
 * "Through the rendered form fields": the screen is rendered on the server exactly as the page renders it, the ids and revision
 * tokens are read from its hidden fields, and the real bound actions are called with a FormData built from them. The review and
 * pricing controls carry no hidden fields (their FormData is built from the props the page passes — `student.openingBinding` /
 * `pricingBinding` — which tests/unit/dues-readiness-forms.test.tsx pins); those bindings are taken from the same read model.
 *
 * 8c's own suite (dues-opening-actions.test.ts) already proves the actions' authorization, validation, lock order, audit rollback
 * and constrained pools; these tests cover what the screen adds and do not repeat those proofs.
 */
type MockSession = { user: { id: string; role?: string }; activeOrganizationId: string | null; access?: unknown } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn(), unstable_update: vi.fn(async () => null) }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("next/navigation", async () => ({ ...(await vi.importActual<object>("next/navigation")), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("../../messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace } as never),
    getLocale: async () => "en",
  };
});

const { getReadinessScreenForOwner } = await import("../../src/lib/dues/readiness/screen");
const opening = await import("../../src/lib/dues/readiness/opening-actions");
const core = await import("../../src/lib/dues/readiness/opening-core");
const { runStatusHistoryBaseline } = await import("../../src/lib/students/baseline-action");
const { assignPlan, correctAssignment } = await import("../../src/lib/dues/assignment-actions");
const { BeforeStart, Students } = await import("../../src/app/[locale]/(staff)/payments/readiness/readiness-view");
const { ReadinessClientRoot } = await import("../../src/app/[locale]/(staff)/payments/readiness/use-readiness-action");

const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2026, month: 12 };

let a: Fixture;
let b: Fixture;
let director: { id: string };
let planA: { id: string };
let packageA: { id: string };
let planB: { id: string };
let n = 0;

const owner = (fx: Fixture) => (currentSession = { user: { id: fx.admin.id, role: "ADMIN" }, activeOrganizationId: fx.org.id, access: { staff: true, portal: false } });
const asDirector = () => (currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: a.org.id, access: { staff: true, portal: false } });
const ctx = (fx: Fixture): TenantContext => ({
  kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});
const fd = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const draftFields = (year: number, month: number, amount: string, currency = "CRC", note = `Unpaid ${year}-${month}`, link = "") => ({
  coverageYear: String(year), coverageMonth: String(month), amount, currency, note, legacyPaymentPeriodId: link,
});

async function newStudent(fx: Fixture, first: string, opts: { history?: boolean; status?: "ACTIVE" | "INACTIVE" } = {}) {
  n++;
  const status = opts.status ?? "ACTIVE";
  const s = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: first, lastName: `Forms${n}`, phone: "00000000",
      email: `forms-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `forms-${n}-${suffix}`, status,
    },
  });
  if (opts.history !== false) {
    await prisma.studentStatusChange.create({
      data: { organizationId: fx.org.id, studentId: s.id, status, effectiveOn: new Date(Date.UTC(2024, 0, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
    });
  }
  return s.id;
}

async function screenFor(fx: Fixture, hooks: { afterFirstRead?: () => Promise<void> } = {}) {
  owner(fx);
  const result = await getReadinessScreenForOwner(fx.org.id, S, hooks);
  if (!result.ok) throw new Error("expected a screen");
  return result.screen;
}

/** The server-rendered forms, exactly as the page mounts them. */
async function renderedForms(fx: Fixture) {
  const screen = await screenFor(fx);
  const html = renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: "en", messages: enMessages } as never,
      createElement(
        ReadinessClientRoot,
        { asOf: screen.asOf.toISOString() } as { asOf: string; children: React.ReactNode },
        createElement("div", null, await BeforeStart({ screen, candidate: S, locale: "en", organizationId: fx.org.id })),
        createElement("div", null, await Students({ screen, candidate: S, locale: "en", organizationId: fx.org.id })),
      ),
    ),
  );
  const decode = (v: string) => v.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const hidden = (name: string) => [...html.matchAll(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`, "g"))].map((m) => decode(m[1]));
  return { screen, html, hidden };
}

async function counts(fx: Fixture) {
  const where = { organizationId: fx.org.id };
  return {
    drafts: await prisma.duesOpeningItem.count({ where }),
    confirmations: await prisma.duesReadinessConfirmation.count({ where }),
    assignments: await prisma.studentPlanAssignment.count({ where }),
    statusRows: await prisma.studentStatusChange.count({ where }),
    audit: await prisma.auditLog.count({ where }),
    obligations: await prisma.duesObligation.count({ where }),
    coverage: await prisma.duesCoverage.count({ where }),
    periods: await prisma.paymentPeriod.count({ where }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "forms-a");
  b = await makeAccountingOrg("CUMULATIVE", "forms-b");
  planA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Monthly ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2024, effectiveMonth: 1, priceAmount: "25000.50", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
  });
  packageA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Package ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packageA.id, effectiveYear: 2024, effectiveMonth: 1, priceAmount: "60000.00", currency: "CRC", monthsCovered: 3, createdById: a.admin.id },
  });
  planB = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `B monthly ${suffix}` } });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2024, effectiveMonth: 1, dueDay: 10, graceDay: 5, lateFeeAmount: "1000.00", lateFeeCurrency: "CRC", createdById: a.admin.id },
  });
  director = await prisma.user.create({ data: { email: `forms-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: director.id, academyId: a.academy.id, organizationId: a.org.id, role: "DIRECTOR" } });
}, 120_000);

afterAll(async () => {
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    // Test-only: 8b drafts and confirmations reject DELETE; removed with the triggers off for this transaction alone.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesReadinessConfirmation", "DuesOpeningItem"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
      }
    });
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await fx.drop();
  }
  if (director) await prisma.user.deleteMany({ where: { id: director.id } });
}, 120_000);

describe("the screen's ids, revisions and bindings drive the real actions unchanged", () => {
  it("add → replace → review, a promo acknowledgement, an assignment and a future correction, all from what the screen rendered", async () => {
    const x = await newStudent(a, "Xenia");
    const promo = await newStudent(a, "Pablo");
    await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId: promo, academyId: a.academy.id, year: 2025, month: 4, planId: planA.id, status: "PROMO", amount: "0.00", currency: "CRC", promoName: "Familia", recordedById: a.admin.id },
    });

    let forms = await renderedForms(a);
    expect(forms.hidden("studentId")).toContain(x); // the add-draft and assign forms name the student
    owner(a);
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: x, ...draftFields(2025, 3, "25000.50") }))).toEqual({ ok: true });

    forms = await renderedForms(a);
    const draft = forms.screen.activeDrafts.find((d) => d.studentId === x)!;
    expect(forms.hidden("draftId")).toContain(draft.id);
    owner(a);
    expect(await opening.replaceOpeningDraft(a.org.id, {}, fd({ draftId: draft.id, ...draftFields(2025, 5, "0.51") }))).toEqual({ ok: true });

    forms = await renderedForms(a);
    const student = forms.screen.students.find((s) => s.id === x)!;
    owner(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, fd({ studentId: x, candidateYear: "2026", candidateMonth: "12", binding: student.openingBinding, declaration: "itemsAsShown" }))).toEqual({ ok: true });
    const promoStudent = forms.screen.students.find((s) => s.id === promo)!;
    expect(promoStudent.pricingBinding).toMatch(/^[0-9a-f]{64}$/);
    owner(a);
    expect(await opening.acknowledgePricing(a.org.id, {}, fd({ studentId: promo, candidateYear: "2026", candidateMonth: "12", binding: promoStudent.pricingBinding! }))).toEqual({ ok: true });
    // Only monthly plans are offered (the package plan is not), with exact terms for S.
    expect(forms.screen.branches[0].plans.map((p) => p.id)).toEqual([planA.id]);
    expect(forms.html).toContain("₡ 25,000.50");

    owner(a);
    expect(await assignPlan(a.org.id, {}, fd({ studentId: x, effectiveYear: "2027", effectiveMonth: "1", planId: planA.id }))).toEqual({ ok: true });
    forms = await renderedForms(a);
    const future = forms.screen.students.find((s) => s.id === x)!.assignment.future;
    expect(future).toHaveLength(1);
    expect(forms.hidden("assignmentId")).toContain(future[0].id);
    const revision = forms.hidden("expectedRevision")[forms.hidden("assignmentId").indexOf(future[0].id)];
    owner(a);
    expect(await correctAssignment(a.org.id, {}, fd({ assignmentId: future[0].id, expectedRevision: revision, planId: "" }))).toEqual({ ok: true });

    const after = await screenFor(a);
    const c = after.report.confirmations.find((r) => r.studentId === x)!;
    expect(c.openingReview.state).toBe("stale"); // the later assignment changed the student; the review must be renewed
    expect(after.report.confirmations.find((r) => r.studentId === promo)!.pricingAck.state).toBe("valid");
    expect(after.students.find((s) => s.id === x)!.assignment.future[0].planId).toBeNull();
  });

  it("same snapshot: a draft committed mid-load makes THAT load's binding stale (nothing written); the next load's is accepted", async () => {
    const y = await newStudent(a, "Yara");
    const screen = await screenFor(a, {
      afterFirstRead: async () => {
        expect(await core.createOpeningDraftCore(ctx(a), y, { coverageYear: 2025, coverageMonth: 2, amount: "10.00", currency: "USD", note: "mid-load", legacyPaymentPeriodId: null })).toEqual({ ok: true });
      },
    });
    const binding = screen.students.find((s) => s.id === y)!.openingBinding;
    expect(screen.activeDrafts.some((d) => d.studentId === y)).toBe(false); // the draft is invisible to this snapshot
    const before = await counts(a);
    owner(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, fd({ studentId: y, candidateYear: "2026", candidateMonth: "12", binding, declaration: "noOpeningDebt" }))).toEqual({ error: "stale" });
    expect(await counts(a)).toEqual(before);
    const fresh = (await screenFor(a)).students.find((s) => s.id === y)!.openingBinding;
    owner(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, fd({ studentId: y, candidateYear: "2026", candidateMonth: "12", binding: fresh, declaration: "itemsAsShown" }))).toEqual({ ok: true });
  });
});

describe("tampered references and bindings write nothing", () => {
  it("foreign ids are notFound, mismatched or invalid references are field errors, altered bindings are stale or invalid", async () => {
    const z = await newStudent(a, "Zoe");
    const other = await newStudent(a, "Otto");
    const bStudent = await newStudent(b, "Bruno");
    owner(b);
    expect(await opening.createOpeningDraft(b.org.id, {}, fd({ studentId: bStudent, ...draftFields(2025, 1, "5.00") }))).toEqual({ ok: true });
    const bDraft = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: b.org.id, studentId: bStudent } })).id;
    const bLegacy = await prisma.paymentPeriod.create({
      data: { organizationId: b.org.id, studentId: bStudent, academyId: b.academy.id, year: 2025, month: 1, planId: planB.id, status: "PAID", amount: "5.00", currency: "CRC", recordedById: b.admin.id },
    });
    const otherLegacy = await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId: other, academyId: a.academy.id, year: 2025, month: 1, planId: planA.id, status: "PAID", amount: "5.00", currency: "CRC", recordedById: a.admin.id },
    });
    owner(b);
    expect(await assignPlan(b.org.id, {}, fd({ studentId: bStudent, effectiveYear: "2027", effectiveMonth: "2", planId: planB.id }))).toEqual({ ok: true });
    const bAssignment = (await prisma.studentPlanAssignment.findFirstOrThrow({ where: { organizationId: b.org.id, studentId: bStudent } })).id;
    owner(a);
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: z, ...draftFields(2025, 6, "7.00") }))).toEqual({ ok: true });
    const zDraft = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: z } })).id;
    const screen = await screenFor(a);
    const binding = screen.students.find((s) => s.id === z)!.openingBinding;
    const futureA = await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: z, planId: planA.id, effectiveYear: 2027, effectiveMonth: 3, createdById: a.admin.id } });
    // The fixture assignment above changed Zoe's content after `screen` was read; reread so the binding cases test only tampering.
    const zBinding = (await screenFor(a)).students.find((s) => s.id === z)!.openingBinding;
    expect(zBinding).not.toBe(binding);

    const before = { a: await counts(a), b: await counts(b) };
    owner(a);
    const review = (fields: Record<string, string>) => opening.recordOpeningReview(a.org.id, {}, fd({ studentId: z, candidateYear: "2026", candidateMonth: "12", binding: zBinding, declaration: "itemsAsShown", ...fields }));
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: bStudent, ...draftFields(2025, 2, "1.00") }))).toEqual({ error: "notFound" });
    expect(await opening.replaceOpeningDraft(a.org.id, {}, fd({ draftId: bDraft, ...draftFields(2025, 2, "1.00") }))).toEqual({ error: "notFound" });
    expect(await opening.withdrawOpeningDraft(a.org.id, {}, fd({ draftId: bDraft, reason: "x" }))).toEqual({ error: "notFound" });
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: z, ...draftFields(2025, 1, "1.00", "CRC", "n", bLegacy.id) }))).toEqual({ error: "notFound" });
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: z, ...draftFields(2025, 1, "1.00", "CRC", "n", otherLegacy.id) }))).toEqual({ error: "invalid", fieldErrors: { legacyPaymentPeriodId: ["mismatch"] } });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: z, effectiveYear: "2027", effectiveMonth: "4", planId: planB.id }))).toEqual({ error: "invalid", fieldErrors: { planId: ["invalid"] } });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: z, effectiveYear: "2027", effectiveMonth: "4", planId: packageA.id }))).toEqual({ error: "invalid", fieldErrors: { planId: ["invalid"] } });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: bStudent, effectiveYear: "2027", effectiveMonth: "4", planId: planA.id }))).toEqual({ error: "notFound" });
    expect(await correctAssignment(a.org.id, {}, fd({ assignmentId: bAssignment, expectedRevision: "x", planId: "" }))).toEqual({ error: "notFound" });
    expect(await correctAssignment(a.org.id, {}, fd({ assignmentId: futureA.id, expectedRevision: '[["planId","forged"]]', planId: "" }))).toEqual({ error: "stale" });
    expect(await review({ binding })).toEqual({ error: "stale" }); // the screen's older binding
    const flipped = (zBinding[0] === "0" ? "1" : "0") + zBinding.slice(1);
    expect(await review({ binding: flipped })).toEqual({ error: "stale" });
    expect(await review({ binding: "not-a-binding" })).toMatchObject({ error: "invalid", fieldErrors: { binding: ["invalid"] } });
    expect(await review({ candidateMonth: "11" })).toEqual({ error: "stale" }); // S is inside the binding
    expect(await review({ declaration: "noOpeningDebt" })).toEqual({ error: "invalid", fieldErrors: { declaration: ["mismatch"] } });
    expect(await opening.acknowledgePricing(a.org.id, {}, fd({ studentId: z, candidateYear: "2026", candidateMonth: "12", binding: zBinding }))).toEqual({ error: "stale" }); // a review binding is not a pricing binding
    expect({ a: await counts(a), b: await counts(b) }).toEqual(before);
    // Withdrawn here only so later tests in this organization start without it.
    expect(await opening.withdrawOpeningDraft(a.org.id, {}, fd({ draftId: zDraft, reason: "test cleanup" }))).toEqual({ ok: true });
  });
});

describe("stale tabs: a page loaded before another tab's change is refused, never merged", () => {
  it("each form submitted from the older page gets the documented refusal and writes nothing", async () => {
    const t = await newStudent(a, "Tabata");
    owner(a);
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: t, ...draftFields(2025, 7, "70.00") }))).toEqual({ ok: true });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: t, effectiveYear: "2027", effectiveMonth: "5", planId: planA.id }))).toEqual({ ok: true });
    const tabA = await renderedForms(a);
    const tabAStudent = tabA.screen.students.find((s) => s.id === t)!;
    const tabADraft = tabA.screen.activeDrafts.find((d) => d.studentId === t)!;
    const tabAFuture = tabAStudent.assignment.future[0];

    // Tab B: replace the draft, add another month, assign a month, correct the future assignment.
    owner(a);
    expect(await opening.replaceOpeningDraft(a.org.id, {}, fd({ draftId: tabADraft.id, ...draftFields(2025, 7, "71.00") }))).toEqual({ ok: true });
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: t, ...draftFields(2025, 8, "80.00") }))).toEqual({ ok: true });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: t, effectiveYear: "2026", effectiveMonth: "12", planId: planA.id }))).toEqual({ ok: true });
    expect(await correctAssignment(a.org.id, {}, fd({ assignmentId: tabAFuture.id, expectedRevision: tabAFuture.revision, planId: "" }))).toEqual({ ok: true });

    const before = await counts(a);
    owner(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, fd({ studentId: t, candidateYear: "2026", candidateMonth: "12", binding: tabAStudent.openingBinding, declaration: "itemsAsShown" }))).toEqual({ error: "stale" });
    expect(await opening.replaceOpeningDraft(a.org.id, {}, fd({ draftId: tabADraft.id, ...draftFields(2025, 7, "72.00") }))).toEqual({ error: "stale" });
    expect(await opening.withdrawOpeningDraft(a.org.id, {}, fd({ draftId: tabADraft.id, reason: "from tab A" }))).toEqual({ error: "stale" });
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: t, ...draftFields(2025, 8, "81.00") }))).toEqual({ error: "monthHasDraft" });
    expect(await assignPlan(a.org.id, {}, fd({ studentId: t, effectiveYear: "2026", effectiveMonth: "12", planId: planA.id }))).toEqual({ error: "monthAssigned" });
    expect(await correctAssignment(a.org.id, {}, fd({ assignmentId: tabAFuture.id, expectedRevision: tabAFuture.revision, planId: planA.id }))).toEqual({ error: "stale" });
    expect(await counts(a)).toEqual(before);
  });

  it("a pricing acknowledgement from before a branch price change is stale", async () => {
    const p = await newStudent(a, "Priya");
    await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId: p, academyId: a.academy.id, year: 2025, month: 2, planId: planA.id, status: "EXEMPT", amount: "0.00", currency: "CRC", recordedById: a.admin.id },
    });
    const binding = (await screenFor(a)).students.find((s) => s.id === p)!.pricingBinding!;
    // Another tab adds a future price to the branch's plan (a branch-fingerprint change).
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2027, effectiveMonth: 6, priceAmount: "26000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
    });
    owner(a);
    expect(await opening.acknowledgePricing(a.org.id, {}, fd({ studentId: p, candidateYear: "2026", candidateMonth: "12", binding }))).toEqual({ error: "stale" });
  });
});

describe("duplicate submissions (plan §4.5)", () => {
  it("create, replace, withdraw and assign refuse the repeat; correct repeats harmlessly; a review repeat appends a second row with the same binding", async () => {
    const d = await newStudent(a, "Dupla");
    const create = fd({ studentId: d, ...draftFields(2025, 9, "9.00") });
    owner(a);
    expect(await opening.createOpeningDraft(a.org.id, {}, create)).toEqual({ ok: true });
    expect(await opening.createOpeningDraft(a.org.id, {}, create)).toEqual({ error: "monthHasDraft" });
    const draftId = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: d, withdrawnAt: null } })).id;
    const replace = fd({ draftId, ...draftFields(2025, 9, "9.50") });
    expect(await opening.replaceOpeningDraft(a.org.id, {}, replace)).toEqual({ ok: true });
    expect(await opening.replaceOpeningDraft(a.org.id, {}, replace)).toEqual({ error: "stale" });
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId: d, withdrawnAt: null } })).toBe(1);
    const successor = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: d, withdrawnAt: null } })).id;
    const withdraw = fd({ draftId: successor, reason: "duplicate test" });
    expect(await opening.withdrawOpeningDraft(a.org.id, {}, withdraw)).toEqual({ ok: true });
    expect(await opening.withdrawOpeningDraft(a.org.id, {}, withdraw)).toEqual({ error: "stale" });

    const assign = fd({ studentId: d, effectiveYear: "2027", effectiveMonth: "7", planId: planA.id });
    expect(await assignPlan(a.org.id, {}, assign)).toEqual({ ok: true });
    const assignAudit = await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "studentPlanAssignment.create" } });
    expect(await assignPlan(a.org.id, {}, assign)).toEqual({ error: "monthAssigned" }); // rolled back: no second row, no audit row
    expect(await prisma.studentPlanAssignment.count({ where: { organizationId: a.org.id, studentId: d } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "studentPlanAssignment.create" } })).toBe(assignAudit);

    const screen = await screenFor(a);
    const row = screen.students.find((s) => s.id === d)!;
    const correct = fd({ assignmentId: row.assignment.future[0].id, expectedRevision: row.assignment.future[0].revision, planId: planA.id });
    owner(a);
    expect(await correctAssignment(a.org.id, {}, correct)).toEqual({ ok: true });
    expect(await correctAssignment(a.org.id, {}, correct)).toEqual({ ok: true }); // same planId, same revision: harmless

    const binding = (await screenFor(a)).students.find((s) => s.id === d)!.openingBinding;
    const reviewForm = fd({ studentId: d, candidateYear: "2026", candidateMonth: "12", binding, declaration: "noOpeningDebt" });
    owner(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, reviewForm)).toEqual({ ok: true });
    const others = await counts(a);
    expect(await opening.recordOpeningReview(a.org.id, {}, reviewForm)).toEqual({ ok: true }); // D3: accepted, documented
    const rows = await prisma.duesReadinessConfirmation.findMany({ where: { organizationId: a.org.id, studentId: d }, orderBy: { sequence: "asc" } });
    expect(rows.map((r) => [r.sequence, r.binding])).toEqual([[1, binding], [2, binding]]);
    expect((await screenFor(a)).report.confirmations.find((c) => c.studentId === d)!.openingReview).toMatchObject({ state: "valid", sequence: 2 });
    const after = await counts(a);
    expect({ ...after, confirmations: 0, audit: 0 }).toEqual({ ...others, confirmations: 0, audit: 0 });
    expect(after.confirmations).toBe(others.confirmations + 1);
  });
});

describe("concurrent replacement and withdrawal of one draft", () => {
  for (const first of ["withdraw", "replace"] as const) {
    it(`${first} holds the student lock first: exactly one terminal marker, the other is stale`, async () => {
      const r = await newStudent(a, `Race${first}`);
      expect(await core.createOpeningDraftCore(ctx(a), r, { coverageYear: 2025, coverageMonth: 10, amount: "10.00", currency: "CRC", note: "race", legacyPaymentPeriodId: null })).toEqual({ ok: true });
      const draftId = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: r } })).id;
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      let locked!: () => void;
      const isLocked = new Promise<void>((res) => (locked = res));
      const hooks = { afterLocks: async () => { locked(); await held; } };
      const withdraw = () => core.withdrawOpeningDraftCore(ctx(a), draftId, "race", first === "withdraw" ? hooks : {});
      const replace = () => core.replaceOpeningDraftCore(ctx(a), draftId, { coverageYear: 2025, coverageMonth: 11, amount: "11.00", currency: "CRC", note: "race replacement", legacyPaymentPeriodId: null }, first === "replace" ? hooks : {});
      const holder = first === "withdraw" ? withdraw() : replace();
      await isLocked;
      const waiter = first === "withdraw" ? replace() : withdraw();
      await new Promise((res) => setTimeout(res, 150)); // the waiter is now blocked on the student lock
      release();
      expect(await holder).toEqual({ ok: true });
      expect(await waiter).toEqual({ error: "stale" });
      const rows = await prisma.duesOpeningItem.findMany({ where: { organizationId: a.org.id, studentId: r } });
      const original = rows.find((x) => x.id === draftId)!;
      expect(original.withdrawalKind).toBe(first === "withdraw" ? "WITHDRAWN" : "EDITED");
      expect(rows.filter((x) => x.withdrawnAt === null)).toHaveLength(first === "withdraw" ? 0 : 1);
    });
  }
});

describe("authorization of the screen's actions", () => {
  it("a Director gets notFound from the 8c actions; the baseline and assignment actions keep their existing FORBIDDEN throw; nothing is written", async () => {
    const v = await newStudent(a, "Vera");
    const before = await counts(a);
    asDirector();
    expect(await opening.createOpeningDraft(a.org.id, {}, fd({ studentId: v, ...draftFields(2025, 1, "1.00") }))).toEqual({ error: "notFound" });
    expect(await opening.recordOpeningReview(a.org.id, {}, fd({ studentId: v, candidateYear: "2026", candidateMonth: "12", binding: "a".repeat(64), declaration: "noOpeningDebt" }))).toEqual({ error: "notFound" });
    await expect(runStatusHistoryBaseline(a.org.id, {}, new FormData())).rejects.toThrow("FORBIDDEN");
    await expect(assignPlan(a.org.id, {}, fd({ studentId: v, effectiveYear: "2027", effectiveMonth: "1", planId: planA.id }))).rejects.toThrow("FORBIDDEN");
    await expect(correctAssignment(a.org.id, {}, fd({ assignmentId: "x", expectedRevision: "x", planId: "" }))).rejects.toThrow("FORBIDDEN");
    expect(await counts(a)).toEqual(before);
  });
});

describe("which assignments the screen offers to correct", () => {
  it("only strictly future months, relative to the branch's own current month: never the current or a past month", async () => {
    const f = await newStudent(a, "Fausto");
    const current = (await screenFor(a)).branches[0].currentMonth;
    const shift = (m: { year: number; month: number }, by: number) => {
      const index = m.year * 12 + (m.month - 1) + by;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    };
    for (const by of [-1, 0, 1]) {
      const m = shift(current, by);
      await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: f, planId: planA.id, effectiveYear: m.year, effectiveMonth: m.month, createdById: a.admin.id } });
    }
    const future = (await screenFor(a)).students.find((s) => s.id === f)!.assignment.future;
    expect(future.map((x) => ({ year: x.year, month: x.month }))).toEqual([shift(current, 1)]);
  });
});

describe("the baseline from the screen", () => {
  it("the screen's count is what the baseline records; a rerun records nothing; S in the future means a baseline today can help", async () => {
    const w = await newStudent(a, "Walter", { history: false });
    const u = await newStudent(a, "Ursula", { history: false, status: "INACTIVE" });
    const screen = await screenFor(a);
    expect(screen.baseline).toMatchObject({ total: 2, active: 1 });
    expect(screen.branches[0].baselineHelpsS).toBe(true);
    owner(a);
    expect(await runStatusHistoryBaseline(a.org.id, {}, new FormData())).toEqual({ ok: true, count: 2 });
    expect(await runStatusHistoryBaseline(a.org.id, {}, new FormData())).toEqual({ ok: true, count: 0 });
    expect((await screenFor(a)).baseline.total).toBe(0);
    expect(await prisma.studentStatusChange.count({ where: { organizationId: a.org.id, studentId: { in: [w, u] }, source: "BASELINE" } })).toBe(2);
  });

  it("for a start month already begun, the screen says a baseline today cannot help", async () => {
    owner(a);
    const result = await getReadinessScreenForOwner(a.org.id, { year: 2026, month: 1 });
    if (!result.ok) throw new Error("expected a screen");
    expect(result.screen.branches[0].baselineHelpsS).toBe(false);
  });
});

describe("no financial effect", () => {
  it("the whole session above created no ledger or coverage row; legacy rows are only this file's fixtures", async () => {
    for (const fx of [a, b]) {
      const c = await counts(fx);
      expect([c.obligations, c.coverage]).toEqual([0, 0]);
    }
    expect((await counts(a)).periods).toBe(3);
    expect((await counts(b)).periods).toBe(1);
  });
});
