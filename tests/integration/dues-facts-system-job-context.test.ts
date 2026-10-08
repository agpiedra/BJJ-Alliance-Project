import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { resolveSystemJobContext } from "../../src/lib/tenant/context";
import type { KioskContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { listDuesFactsForStudents } from "../../src/lib/dues/ledger/dues-facts";
import { listRosterPaymentFacts } from "../../src/lib/dues/roster-payment-facts-queries";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §4/§7 (PR 1): `listDuesFactsForStudents`/`listRosterPaymentFacts` widened to
 * accept a real `SystemJobContext` (the digest's own future reuse) alongside `TenantContext`, never a fabricated
 * ADMIN context or an unsafe cast. This file proves, against the real test database:
 *
 * 1. A genuinely resolved `SystemJobContext` (via `resolveSystemJobContext`, never hand-built) reaches the batched
 *    reader and returns real ledger facts.
 * 2. Cross-organization isolation holds under that context exactly as it does under `TenantContext` — a foreign
 *    organization's student id never returns data, proven against a REAL foreign student plus an authorized
 *    positive control in the same call.
 * 3. The reader never silently expands a caller-supplied, academy-filtered student id list back out to "every
 *    student in the organization" — it returns exactly the requested subset.
 * 4. `KioskContext` is rejected by both signatures at COMPILE TIME (`@ts-expect-error`), never merely a runtime
 *    arity assertion.
 *
 * Existing tenant/branch and portal-self coverage for both functions is unchanged and lives in
 * `dues-facts.test.ts`/`roster-payment-facts-queries.test.ts` — this file adds only the new `SystemJobContext`
 * path, it does not duplicate that coverage.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const NOW = new Date("2030-06-15T12:00:00-06:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: () => NOW, ...extra });

let a: Fixture; // primary organization — the one the real SystemJobContext resolves against
let b: Fixture; // a genuinely different organization, for cross-org isolation (requirement 2)
let academyTwo: { id: string };
const termsByAcademy: Record<string, { id: string }> = {};
const policyByAcademy: Record<string, { id: string }> = {};

async function seedPlanAndPolicy(org: Fixture, academyId: string) {
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `SysJob plan ${suffix}-${academyId}` } });
  termsByAcademy[academyId] = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  policyByAcademy[academyId] = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear: 2030, effectiveMonth: 1, dueDay: 1, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: org.admin.id },
  });
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "SysJob", lastName: `S${n}`, phone: "00000000",
      email: `sysjob-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `sysjob-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newObligation(org: Fixture, studentId: string, academyId: string, month: number) {
  return prisma.duesObligation.create({
    data: {
      organizationId: org.org.id, studentId, academyId, origin: "STAFF", type: "MONTHLY",
      coverageYear: 2030, coverageMonth: month, monthsCovered: 1, amount: "100.00", currency: "USD",
      dueOn: new Date(`2030-${String(month).padStart(2, "0")}-01`), graceDeadline: new Date(`2030-${String(month).padStart(2, "0")}-06`),
      lateFeeAmount: "20.00", planTermsId: termsByAcademy[academyId]!.id, policyVersionId: policyByAcademy[academyId]!.id, createdById: org.admin.id,
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "sysjob-a");
  b = await makeAccountingOrg("CUMULATIVE", "sysjob-b");
  academyTwo = await prisma.academy.create({ data: { organizationId: a.org.id, name: "SysJob A2", slug: `sysjob-a2-${suffix}`, kioskTokenHash: `sysjob-a2-${suffix}` } });
  await seedPlanAndPolicy(a, a.academy.id);
  await seedPlanAndPolicy(a, academyTwo.id);
  await seedPlanAndPolicy(b, b.academy.id);
}, 60_000);

/** `DuesObligation` carries a DB-level "never deleted" guard (`dues_ledger: rows are never deleted`) — the same
 * raw-SQL bypass `dues-facts.test.ts`/`roster-payment-facts-queries.test.ts` already establish for teardown. */
async function dropObligations(organizationId: string) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe(`DELETE FROM "DuesObligation" WHERE "organizationId" = $1`, organizationId);
    },
    { timeout: 30_000 },
  );
}

afterAll(async () => {
  if (a) {
    await dropObligations(a.org.id);
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.student.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.academy.deleteMany({ where: { id: academyTwo.id } });
  }
  if (b) {
    await dropObligations(b.org.id);
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: b.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: b.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: b.org.id } });
    await prisma.student.deleteMany({ where: { organizationId: b.org.id } });
  }
  await a?.drop();
  await b?.drop();
}, 60_000);

describe("a genuinely resolved SystemJobContext reaches the batched reader with real facts (requirement 1)", () => {
  it("listRosterPaymentFacts: real SystemJobContext, real obligation, real non-vacuous debt", async () => {
    const student = await newStudent(a, a.academy.id);
    await newObligation(a, student.id, a.academy.id, 1);

    const jobContext = await resolveSystemJobContext(a.org.id, "weekly-digest");
    expect(jobContext).not.toBeNull();
    if (!jobContext) throw new Error("unreachable");
    expect(jobContext.kind).toBe("system-job");

    const { byStudentId } = await listRosterPaymentFacts(jobContext, [student.id], NOW, deps());
    const fact = byStudentId.get(student.id);
    expect(fact?.ok).toBe(true);
    if (!fact?.ok) throw new Error("expected ok fact");
    expect(fact.facts.outstanding).toHaveLength(1);
    expect(fact.facts.outstanding[0]!.outstandingAmountMinor).toBeGreaterThan(0);
  });

  it("listDuesFactsForStudents: the same real SystemJobContext reaches it directly and returns real facts", async () => {
    const student = await newStudent(a, a.academy.id);
    await newObligation(a, student.id, a.academy.id, 2);

    const jobContext = await resolveSystemJobContext(a.org.id, "weekly-digest");
    if (!jobContext) throw new Error("unreachable");

    const result = await listDuesFactsForStudents(jobContext, [student.id], undefined, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.studentId).toBe(student.id);
    expect(result.facts[0]!.outstanding).toHaveLength(1);
  });

  it("resolveSystemJobContext itself refuses a non-ACTIVE organization — the trust boundary this reuse depends on, unchanged", async () => {
    const suspended = await makeAccountingOrg("CUMULATIVE", "sysjob-suspended");
    try {
      await prisma.organization.update({ where: { id: suspended.org.id }, data: { status: "SUSPENDED" } });
      const jobContext = await resolveSystemJobContext(suspended.org.id, "weekly-digest");
      expect(jobContext).toBeNull();
    } finally {
      await prisma.organization.update({ where: { id: suspended.org.id }, data: { status: "ACTIVE" } }).catch(() => {});
      await suspended.drop();
    }
  });
});

describe("cross-organization isolation holds under SystemJobContext (requirement 2)", () => {
  it("a foreign organization's student id never returns data, alongside a real authorized positive control", async () => {
    const ownStudent = await newStudent(a, a.academy.id); // positive control: genuinely belongs to org a
    await newObligation(a, ownStudent.id, a.academy.id, 3);
    const foreignStudent = await newStudent(b, b.academy.id); // genuinely belongs to a DIFFERENT organization
    await newObligation(b, foreignStudent.id, b.academy.id, 3);

    const jobContext = await resolveSystemJobContext(a.org.id, "weekly-digest"); // resolved against ORG A only
    if (!jobContext) throw new Error("unreachable");

    const { byStudentId } = await listRosterPaymentFacts(jobContext, [ownStudent.id, foreignStudent.id], NOW, deps());
    expect(byStudentId.get(ownStudent.id)?.ok).toBe(true); // the positive control genuinely resolves
    // `listRosterPaymentFacts` gives every REQUESTED id its own entry (real or `{ok:false}`) — never a silent gap —
    // so the foreign id IS a key here, but its value must be exactly `{ ok: false }`: no `facts` property exists on
    // that shape at all, so there is structurally no way for org b's real data to be present under it.
    expect(byStudentId.get(foreignStudent.id)).toEqual({ ok: false });

    const directResult = await listDuesFactsForStudents(jobContext, [ownStudent.id, foreignStudent.id], undefined, deps());
    if (!directResult.ok) throw new Error("unreachable");
    expect(directResult.facts.map((f) => f.studentId)).toEqual([ownStudent.id]);
  });
});

describe("the reader respects a caller-supplied subset — never silently every student in the organization (requirement 3)", () => {
  it("an academy-filtered student id list (the digest's own query shape) returns only those students", async () => {
    const academyOneStudent = await newStudent(a, a.academy.id);
    await newObligation(a, academyOneStudent.id, a.academy.id, 4);
    const academyTwoStudent = await newStudent(a, academyTwo.id); // same organization, a DIFFERENT academy
    await newObligation(a, academyTwoStudent.id, academyTwo.id, 4);

    const jobContext = await resolveSystemJobContext(a.org.id, "weekly-digest");
    if (!jobContext) throw new Error("unreachable");

    // Mirrors list-overdue.ts's own digest-facing query shape (REMAINING-LEDGER-CONSUMERS-BRIEF.md §4): the caller
    // resolves its OWN academy-filtered id list before calling the batched reader — the reader itself gains no
    // academyId parameter.
    const academyOneIds = (
      await prisma.student.findMany({ where: { organizationId: a.org.id, homeAcademyId: a.academy.id, status: "ACTIVE" }, select: { id: true } })
    ).map((s) => s.id);
    expect(academyOneIds).toContain(academyOneStudent.id);
    expect(academyOneIds).not.toContain(academyTwoStudent.id);

    const { byStudentId } = await listRosterPaymentFacts(jobContext, academyOneIds, NOW, deps());
    expect(byStudentId.has(academyOneStudent.id)).toBe(true);
    expect(byStudentId.has(academyTwoStudent.id)).toBe(false); // never returned — not requested, despite being in the same organization
    expect(byStudentId.size).toBe(academyOneIds.length); // exactly the requested subset, never the whole organization
  });
});

describe("KioskContext is rejected by both signatures — a real compile-time proof (requirement 5)", () => {
  it("listDuesFactsForStudents: a KioskContext fails to type-check against the widened context parameter", () => {
    const kiosk: KioskContext = { kind: "kiosk", organizationId: "fake-org", academyId: "fake-academy" };
    // @ts-expect-error — KioskContext does not satisfy TenantContext | SystemJobContext; this line must fail tsc.
    const call = listDuesFactsForStudents(kiosk, ["s1"]);
    void call;
  });

  it("listRosterPaymentFacts: a KioskContext fails to type-check against the widened context parameter", () => {
    const kiosk: KioskContext = { kind: "kiosk", organizationId: "fake-org", academyId: "fake-academy" };
    // @ts-expect-error — KioskContext does not satisfy TenantContext | SystemJobContext; this line must fail tsc.
    const call = listRosterPaymentFacts(kiosk, ["s1"], new Date());
    void call;
  });
});
