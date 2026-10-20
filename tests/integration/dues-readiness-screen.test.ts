import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";

/**
 * Stage 8d-1 (docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md): the owner's READ-ONLY readiness screen, against the REAL isolated test
 * database with two private temporary organizations (removed in afterAll). Names, amounts and months are synthetic.
 *
 * `runReadOnlySnapshot` is wrapped with a call counter (it still runs for real), so a refused caller can be shown never to reach a
 * readiness read at all.
 */
const calls = vi.hoisted(() => ({ snapshot: 0 }));
vi.mock("@/lib/db/read-only-snapshot", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/db/read-only-snapshot")>("../../src/lib/db/read-only-snapshot");
  return {
    ...actual,
    runReadOnlySnapshot: ((...args: Parameters<typeof actual.runReadOnlySnapshot>) => {
      calls.snapshot++;
      return actual.runReadOnlySnapshot(...args);
    }) as typeof actual.runReadOnlySnapshot,
  };
});

type MockSession = { user: { id: string; role?: string }; activeOrganizationId: string | null; access?: unknown } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn(), unstable_update: vi.fn(async () => null) }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));

const { getReadinessScreenForOwner } = await import("../../src/lib/dues/readiness/screen");
const { getDuesReadinessForOwner } = await import("../../src/lib/dues/readiness");
const { defaultCandidateMonth } = await import("../../src/lib/dues/readiness/candidate");
const { createOpeningDraftCore, recordConfirmationCore } = await import("../../src/lib/dues/readiness/opening-core");
const { openingReviewBinding } = await import("../../src/lib/dues/readiness/fingerprint");
const { default: DuesReadinessPage } = await import("../../src/app/[locale]/(staff)/payments/readiness/page");

const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2026, month: 12 };
const LONG = "Maximiliano-Bartolomé de la Santísima Trinidad Fernández-Echeverría Montenegro";

let a: Fixture;
let b: Fixture;
let director: { id: string };
let plan: { id: string };
const st: Record<string, string> = {};
let n = 0;

const owner = (fx: Fixture) => (currentSession = { user: { id: fx.admin.id, role: "ADMIN" }, activeOrganizationId: fx.org.id, access: { staff: true, portal: false } });
const ctx = (fx: Fixture): TenantContext => ({
  kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});
const draft = (fx: Fixture, studentId: string, year: number, month: number, amount: string, currency: "USD" | "CRC", legacyPaymentPeriodId: string | null = null) =>
  createOpeningDraftCore(ctx(fx), studentId, { coverageYear: year, coverageMonth: month, amount, currency, note: `Unpaid ${year}-${month}`, legacyPaymentPeriodId });

async function newStudent(fx: Fixture, first: string, last: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  n++;
  const s = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: first, lastName: last, phone: "00000000",
      email: `screen-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `screen-${n}-${suffix}`, status,
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: fx.org.id, studentId: s.id, status, effectiveOn: new Date(Date.UTC(2024, 0, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
  });
  return s.id;
}

/** What `notFound()` / `redirect()` / a normal render does to a server component call. */
async function outcomeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { passedTheGate: true } as const;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.includes("404")) return { notFound: true } as const;
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] } as const;
    return { passedTheGate: true } as const; // ran past the gate (e.g. no request scope for translations in a test)
  }
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "screen-a");
  b = await makeAccountingOrg("CUMULATIVE", "screen-b");
  await prisma.academy.update({ where: { id: a.academy.id }, data: { name: `${LONG} Academy ${suffix}` } });
  plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Monthly ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2024, effectiveMonth: 1, priceAmount: "99999999.99", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
  });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2024, effectiveMonth: 1, dueDay: 10, graceDay: 5, lateFeeAmount: "1000.00", lateFeeCurrency: "CRC", createdById: a.admin.id },
  });
  st.long = await newStudent(a, LONG, "Uno");
  st.second = await newStudent(a, "Ana", "Dos");
  st.inactive = await newStudent(a, "Ina", "Tres", "INACTIVE");
  st.b = await newStudent(b, "Bea", "Otra");
  for (const id of [st.long, st.second]) {
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: id, planId: plan.id, effectiveYear: 2024, effectiveMonth: 1, createdById: a.admin.id } });
  }
  director = await prisma.user.create({ data: { email: `screen-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: director.id, academyId: a.academy.id, organizationId: a.org.id, role: "DIRECTOR" } });
  // Opening drafts through the real 8c core: two CRC drafts whose sum exceeds one column's limit, one USD draft, and one in B.
  expect(await draft(a, st.long, 2025, 1, "99999999.99", "CRC")).toEqual({ ok: true });
  expect(await draft(a, st.second, 2025, 2, "0.50", "CRC")).toEqual({ ok: true });
  expect(await draft(a, st.inactive, 2025, 3, "12.34", "USD")).toEqual({ ok: true });
  expect(await draft(b, st.b, 2025, 1, "777.77", "USD")).toEqual({ ok: true });
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

describe("authorization: the owner only, checked before any readiness read", () => {
  it("the page refuses a Director with a real 404 and never opens a readiness snapshot", async () => {
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: a.org.id, access: { staff: true, portal: false } };
    calls.snapshot = 0;
    expect(await outcomeOf(DuesReadinessPage({ searchParams: Promise.resolve({}) }))).toEqual({ notFound: true });
    expect(await outcomeOf(DuesReadinessPage({ searchParams: Promise.resolve({ s: "2026-12" }) }))).toEqual({ notFound: true });
    expect(calls.snapshot).toBe(0);
  });

  it("positive control: the owner passes the page's gate", async () => {
    owner(a);
    expect(await outcomeOf(DuesReadinessPage({ searchParams: Promise.resolve({ s: "2026-12" }) }))).toEqual({ passedTheGate: true });
  });

  it("the read model refuses a Director and another organization's owner (notFound, no snapshot); the existing security audit records the cross-organization refusal", async () => {
    calls.snapshot = 0;
    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: a.org.id };
    expect(await getReadinessScreenForOwner(a.org.id, S)).toEqual({ ok: false, error: "notFound" });
    const refusals = () => prisma.auditLog.count({ where: { organizationId: a.org.id, action: "organization.accessRefused", actorId: b.admin.id } });
    const before = await refusals();
    owner(b);
    expect(await getReadinessScreenForOwner(a.org.id, S)).toEqual({ ok: false, error: "notFound" });
    expect(await refusals()).toBe(before + 1);
    expect(calls.snapshot).toBe(0);
  });

  it("an invalid month is refused before anything else", async () => {
    owner(a);
    calls.snapshot = 0;
    expect(await getReadinessScreenForOwner(a.org.id, { year: 2026, month: 13 })).toEqual({ ok: false, error: "invalid" });
    expect(calls.snapshot).toBe(0);
  });
});

describe("the read model", () => {
  it("its report is exactly the readiness report (same semantics and fingerprints)", async () => {
    owner(a);
    const screen = await getReadinessScreenForOwner(a.org.id, S);
    const report = await getDuesReadinessForOwner(a.org.id, S);
    if (!screen.ok || !report.ok) throw new Error("expected both");
    expect(screen.screen.report).toEqual(report.report);
    expect(screen.screen.report.ready).toBe(false);
    expect(screen.screen.report.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([10, 11, 12]);
    expect(screen.screen.report.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
  });

  it("returns names and active drafts with exact amounts; totals above one column's limit stay exact; another organization never appears", async () => {
    owner(a);
    const result = await getReadinessScreenForOwner(a.org.id, S);
    if (!result.ok) throw new Error("expected a screen");
    const { screen } = result;
    expect(screen.branches).toEqual([{ id: a.academy.id, name: `${LONG} Academy ${suffix}` }]);
    expect(screen.students.find((s) => s.id === st.long)).toMatchObject({ name: `${LONG} Uno`, academyId: a.academy.id, status: "ACTIVE", promoOrExempt: false });
    expect(screen.activeDrafts.map((d) => [d.studentId, d.amount, d.currency])).toEqual([
      [st.long, "99999999.99", "CRC"],
      [st.second, "0.50", "CRC"],
      [st.inactive, "12.34", "USD"],
    ]);
    expect(screen.report.openingDrafts).toEqual([
      { academyId: a.academy.id, currency: "CRC", count: 2, total: "100000000.49" },
      { academyId: a.academy.id, currency: "USD", count: 1, total: "12.34" },
    ]);
    // MONTHLY: two students at 99,999,999.99 CRC each — individually valid, summed above the column limit, exact.
    expect(screen.report.preview.branches.find((x) => x.academyId === a.academy.id)!.wouldCreate).toEqual([{ currency: "CRC", count: 2, total: "199999999.98" }]);
    const text = JSON.stringify(screen);
    expect(text).not.toContain(st.b);
    expect(text).not.toContain(b.academy.id);
    expect(text).not.toContain("777.77");
  });

  it("without a month, uses the default from the same snapshot's branch time zones and database time", async () => {
    owner(a);
    const result = await getReadinessScreenForOwner(a.org.id, null);
    if (!result.ok) throw new Error("expected a screen");
    const academy = await prisma.academy.findUniqueOrThrow({ where: { id: a.academy.id } });
    expect(result.screen.defaultCandidate).toEqual(defaultCandidateMonth([academy.timezone], result.screen.asOf).month);
    expect(result.screen.report.candidate).toEqual(result.screen.defaultCandidate);
  });

  it("a confirmation recorded through the real 8c core shows as current, then as changed after a later draft", async () => {
    owner(a);
    const before = await getDuesReadinessForOwner(a.org.id, S);
    if (!before.ok) throw new Error("expected a report");
    const binding = openingReviewBinding(S, before.report.fingerprints.students[st.second]);
    expect(await recordConfirmationCore(ctx(a), { studentId: st.second, candidate: S, kind: "OPENING_REVIEWED", binding, declaration: "itemsAsShown" })).toEqual({ ok: true });
    let screen = await getReadinessScreenForOwner(a.org.id, S);
    if (!screen.ok) throw new Error("expected a screen");
    expect(screen.screen.report.confirmations.find((c) => c.studentId === st.second)!.openingReview).toMatchObject({ state: "valid", sequence: 1 });
    expect(await draft(a, st.second, 2025, 4, "1.00", "CRC")).toEqual({ ok: true });
    screen = await getReadinessScreenForOwner(a.org.id, S);
    if (!screen.ok) throw new Error("expected a screen");
    expect(screen.screen.report.confirmations.find((c) => c.studentId === st.second)!.openingReview.state).toBe("stale");
  });

  it("one snapshot: a rename and a new draft committed mid-load are both invisible; the next load shows them together", async () => {
    owner(a);
    const studentId = await newStudent(a, "Mid", "Load");
    const before = await getReadinessScreenForOwner(a.org.id, S);
    if (!before.ok) throw new Error("expected a screen");
    const during = await getReadinessScreenForOwner(a.org.id, S, {
      afterFirstRead: async () => {
        await prisma.student.update({ where: { id: studentId }, data: { firstName: "Renamed" } });
        expect(await draft(a, studentId, 2025, 5, "5.00", "USD")).toEqual({ ok: true });
      },
    });
    if (!during.ok) throw new Error("expected a screen");
    expect(during.screen.students.find((s) => s.id === studentId)!.name).toBe("Mid Load");
    expect(during.screen.activeDrafts.some((d) => d.studentId === studentId)).toBe(false);
    expect(during.screen.report.fingerprints).toEqual(before.screen.report.fingerprints);
    expect(during.screen.report.openingDrafts).toEqual(before.screen.report.openingDrafts);
    const after = await getReadinessScreenForOwner(a.org.id, S);
    if (!after.ok) throw new Error("expected a screen");
    expect(after.screen.students.find((s) => s.id === studentId)!.name).toBe("Renamed Load");
    expect(after.screen.activeDrafts.some((d) => d.studentId === studentId)).toBe(true);
    expect(after.screen.asOf.getTime()).toBeGreaterThanOrEqual(during.screen.asOf.getTime());
  });

  it("writes nothing: no financial, readiness or audit row changes for an authorized load", async () => {
    owner(a);
    const counts = async () => ({
      drafts: await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id } }),
      confirmations: await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id } }),
      obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id } }),
      periods: await prisma.paymentPeriod.count({ where: { organizationId: a.org.id } }),
      audit: await prisma.auditLog.count({ where: { organizationId: a.org.id } }),
    });
    const before = await counts();
    await getReadinessScreenForOwner(a.org.id, S);
    await getReadinessScreenForOwner(a.org.id, null);
    expect(await counts()).toEqual(before);
  });
});
