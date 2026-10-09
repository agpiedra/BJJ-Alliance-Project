import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { ZONE } from "../../src/lib/scheduling/zone";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import * as getCurrentPeriodModule from "../../src/lib/payments/get-current-period";
import * as overdueModule from "../../src/lib/payments/overdue";

let mockActive = false;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

const { listStudentsToContact } = await import("../../src/lib/students/contact-list");

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.3 (PR 3): `listStudentsToContact` had no dedicated test file before this
 * PR at all — this closes that real gap AND proves the ledger cutover. Population/attendance-selection/
 * authorization are UNCHANGED (still `status: "ACTIVE"`-only, still the same 7+ days-absent query) — only the
 * per-student `paymentStatus` fact changes with `ledgerActive`. "No debt" is proven NEVER equated with "paid",
 * "covered", or "eligible" — the ledger branch only ever reports the roster's own independent-facts shape
 * (`RosterLedgerEntry`), never a collapsed boolean or a legacy status label.
 *
 * `listStudentsToContact`'s own `ledgerActive: boolean` parameter (the PAGE-level display decision) and
 * `listRosterPaymentFacts`/`listDuesFactsForStudents`'s internal `LedgerDeps.activation` (the ENGINE-level
 * enforcement) are the SAME underlying activation state read twice, not two independent toggles — neither this
 * function nor any production caller passes a `deps` override, so `listStudentsToContact(context, true, ...)`
 * alone still hits the real, unmocked `inactiveLedgerActivation` default inside the engine and gets refused.
 * Mocking `@/lib/dues/ledger/activation` (the SAME sanctioned test seam `payments-page-card-gating.test.ts`
 * already established) makes both reads consistent, exactly as a future real activation implementation would.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const NOW = DateTime.fromISO("2030-12-15T12:00:00", { zone: ZONE });
const TODAY = { year: NOW.year, month: NOW.month, day: NOW.day };
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: () => NOW.toJSDate(), ...extra });

let a: Fixture;
let terms: { id: string };
let policy: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

async function newStudent(label: string, opts: { status?: "ACTIVE" | "INACTIVE" | "ARCHIVED"; daysAbsent?: number } = {}) {
  const n = `${label}-${suffix}`;
  const student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "ContactList", lastName: n, phone: "00000000",
      email: `contactlist-${n}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `contactlist-${n}`, status: opts.status ?? "ACTIVE",
    },
  });
  if (opts.daysAbsent !== undefined) {
    await prisma.attendanceRecord.create({
      data: {
        organizationId: a.org.id, academyId: a.academy.id, studentId: student.id, type: "CHECKIN", source: "KIOSK",
        occurredAt: NOW.minus({ days: opts.daysAbsent }).toJSDate(), date: NOW.minus({ days: opts.daysAbsent }).toJSDate(),
      },
    });
  }
  return student;
}

async function newMonthlyObligation(studentId: string, month: number) {
  const r = await createMonthlyObligation(
    { context: context(), studentId, coverage: { year: 2030, month }, planTermsId: terms.id, policyVersionId: policy.id },
    deps(),
  );
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "contactlist-a");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `ContactList plan ${suffix}` } });
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2030, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.attendanceRecord.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

describe("listStudentsToContact: inactive path — unchanged legacy behavior", () => {
  it("reports the legacy ContactPaymentStatus exactly as before, never touching the ledger reader", async () => {
    mockActive = false;
    const student = await newStudent("legacy-overdue", { daysAbsent: 10 });
    const result = await listStudentsToContact(context(), false, 7, TODAY, NOW);
    const entry = result.find((e) => e.studentId === student.id);
    expect(entry).toBeDefined();
    // No PaymentPeriod row exists for this student, and TODAY.day (15) is past DEFAULT_OVERDUE_CUTOFF_DAY (5) —
    // the legacy isOverdue rule's own "missing row past the cutoff day" case.
    expect(entry!.paymentStatus).toEqual({ source: "legacy", status: "OVERDUE" });
  });
});

describe("listStudentsToContact: active path — independent ledger facts, never a collapsed boolean", () => {
  it("REQUIRED: a real unsettled MONTHLY obligation past grace reports debt via the SAME RosterLedgerEntry shape the roster uses — never a legacy status label", async () => {
    mockActive = true;
    const student = await newStudent("ledger-debt", { daysAbsent: 10 });
    await newMonthlyObligation(student.id, 1); // 2030-01, long past grace relative to NOW (2030-12-15)

    const result = await listStudentsToContact(context(), true, 7, TODAY, NOW);
    const entry = result.find((e) => e.studentId === student.id);
    expect(entry).toBeDefined();
    expect(entry!.paymentStatus.source).toBe("ledger");
    if (entry!.paymentStatus.source !== "ledger") throw new Error("unreachable");
    expect(entry!.paymentStatus.entry.kind).toBe("ledger");
    if (entry!.paymentStatus.entry.kind !== "ledger") throw new Error("unreachable");
    expect(entry!.paymentStatus.entry.display.flags.debt).toBe(true);
    expect(entry!.paymentStatus.entry.display.flags.monthlyPastGrace).toBe(true);
    expect(entry!.paymentStatus.entry.display.totals.length).toBeGreaterThan(0);
  });

  it("REQUIRED: no debt reports noDebt — never rendered or reported as paid, covered, or eligible", async () => {
    mockActive = true;
    const student = await newStudent("ledger-clean", { daysAbsent: 10 });
    const result = await listStudentsToContact(context(), true, 7, TODAY, NOW);
    const entry = result.find((e) => e.studentId === student.id);
    expect(entry).toBeDefined();
    expect(entry!.paymentStatus.source).toBe("ledger");
    if (entry!.paymentStatus.source !== "ledger") throw new Error("unreachable");
    expect(entry!.paymentStatus.entry.kind).toBe("ledger");
    if (entry!.paymentStatus.entry.kind !== "ledger") throw new Error("unreachable");
    expect(entry!.paymentStatus.entry.display.flags.noDebt).toBe(true);
    expect(entry!.paymentStatus.entry.display.totals).toEqual([]);
    // Structurally cannot say "paid"/"covered"/"eligible" — RosterLedgerDisplay carries no such field at all.
    expect(entry!.paymentStatus.entry.display).not.toHaveProperty("status");
  });

  it("REQUIRED: a failed read renders unavailable — never a false empty/zero-debt row", async () => {
    mockActive = true;
    const student = await newStudent("ledger-failread", { daysAbsent: 10 });
    const real = appPrisma.student.findMany.bind(appPrisma.student) as unknown as (...args: unknown[]) => Promise<unknown>;
    let call = 0;
    const spy = vi.spyOn(appPrisma.student, "findMany").mockImplementation((async (...args: unknown[]) => {
      call++;
      // The FIRST call is this file's own cohort query (already resolved by the time listStudentsToContact
      // calls listRosterPaymentFacts); the SECOND is listRosterPaymentFacts's own timezone lookup — failing it
      // reproduces a genuine chunk-level read failure, the same technique roster-payment-facts-queries.test.ts
      // already established.
      if (call === 2) throw new Error("simulated transient failure");
      return real(...args);
    }) as unknown as typeof appPrisma.student.findMany);
    let result;
    try {
      result = await listStudentsToContact(context(), true, 7, TODAY, NOW);
    } finally {
      spy.mockRestore();
    }
    const entry = result.find((e) => e.studentId === student.id);
    expect(entry).toBeDefined();
    expect(entry!.paymentStatus).toEqual({ source: "ledger", entry: { kind: "unavailable" } });
  });

  it("REQUIRED: the active path never calls the legacy getCurrentPaymentPeriod/isOverdue — proven via real-module spies", async () => {
    mockActive = true;
    const student = await newStudent("ledger-spy", { daysAbsent: 10 });
    const periodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const overdueSpy = vi.spyOn(overdueModule, "isOverdue");
    try {
      await listStudentsToContact(context(), true, 7, TODAY, NOW);
      expect(periodSpy).not.toHaveBeenCalled();
      expect(overdueSpy).not.toHaveBeenCalled();
    } finally {
      periodSpy.mockRestore();
      overdueSpy.mockRestore();
    }
    void student;
  });

  it("the inactive path still calls the legacy getCurrentPaymentPeriod/isOverdue — unchanged behavior, proven the same way", async () => {
    mockActive = false;
    const student = await newStudent("legacy-spy", { daysAbsent: 10 });
    const periodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const overdueSpy = vi.spyOn(overdueModule, "isOverdue");
    try {
      await listStudentsToContact(context(), false, 7, TODAY, NOW);
      expect(periodSpy).toHaveBeenCalled();
      expect(overdueSpy).toHaveBeenCalled();
    } finally {
      periodSpy.mockRestore();
      overdueSpy.mockRestore();
    }
    void student;
  });
});

describe("listStudentsToContact: population stays ACTIVE-only and attendance-driven, unchanged by the ledger (Decision 2)", () => {
  it("REQUIRED: an ARCHIVED student with real qualifying old debt never appears, regardless of ledgerActive", async () => {
    mockActive = true;
    const archived = await newStudent("archived-with-debt", { status: "ARCHIVED", daysAbsent: 30 });
    await newMonthlyObligation(archived.id, 1);

    const activeResult = await listStudentsToContact(context(), true, 7, TODAY, NOW);
    const inactiveResult = await listStudentsToContact(context(), false, 7, TODAY, NOW);
    expect(activeResult.find((e) => e.studentId === archived.id)).toBeUndefined();
    expect(inactiveResult.find((e) => e.studentId === archived.id)).toBeUndefined();
  });

  it("a student under the 7-day absence threshold never appears, regardless of ledgerActive (attendance selection unchanged)", async () => {
    mockActive = true;
    const recent = await newStudent("recently-attended", { daysAbsent: 1 });
    await newMonthlyObligation(recent.id, 1);

    const activeResult = await listStudentsToContact(context(), true, 7, TODAY, NOW);
    expect(activeResult.find((e) => e.studentId === recent.id)).toBeUndefined();
  });
});

describe("listStudentsToContact: the ledger instant is independent from the attendance clock (review fix)", () => {
  it("REQUIRED: a different ledgerNow never changes which students qualify by attendance — only the ledger facts it reads", async () => {
    mockActive = true;
    const nearThreshold = await newStudent("near-threshold", { daysAbsent: 6 }); // below the 7-day cutoff under NOW
    const qualifying = await newStudent("ledgernow-independent", { daysAbsent: 8 });

    // A dedicated policy/terms (graceDay 15), used ONLY by this test. Coverage {2030, 11} + graceDay 15 ⇒
    // graceDeadlineFor (next month's graceDay) = 2030-12-15 — exactly NOW's own calendar date.
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `ContactList ledgerNow plan ${suffix}` } });
    const boundaryTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 2, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const boundaryPolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2030, effectiveMonth: 2, dueDay: 20, graceDay: 15, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
    const r = await createMonthlyObligation(
      { context: context(), studentId: qualifying.id, coverage: { year: 2030, month: 11 }, planTermsId: boundaryTerms.id, policyVersionId: boundaryPolicy.id },
      deps(),
    );
    if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);

    const LEDGER_NOW_A = NOW.toJSDate(); // 2030-12-15: on the grace deadline itself — not yet past grace
    const LEDGER_NOW_B = NOW.plus({ days: 1 }).toJSDate(); // 2030-12-16: one day past it

    // `now` (the attendance clock) is held FIXED at `NOW` across both calls — only `ledgerNow` differs.
    const resultA = await listStudentsToContact(context(), true, 7, TODAY, NOW, LEDGER_NOW_A);
    const resultB = await listStudentsToContact(context(), true, 7, TODAY, NOW, LEDGER_NOW_B);

    // Attendance inclusion never moves with `ledgerNow`: the under-threshold student stays excluded in BOTH
    // calls, and the qualifying student stays included in BOTH — proving `ledgerNow` has zero say over who
    // appears on this list.
    expect(resultA.find((e) => e.studentId === nearThreshold.id)).toBeUndefined();
    expect(resultB.find((e) => e.studentId === nearThreshold.id)).toBeUndefined();
    const entryA = resultA.find((e) => e.studentId === qualifying.id);
    const entryB = resultB.find((e) => e.studentId === qualifying.id);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();

    // `ledgerNow` DOES control the ledger facts themselves — proving the two instants are genuinely independent,
    // not that `ledgerNow` is simply ignored everywhere.
    expect(entryA!.paymentStatus.source).toBe("ledger");
    if (entryA!.paymentStatus.source !== "ledger") throw new Error("unreachable");
    expect(entryA!.paymentStatus.entry.kind).toBe("ledger");
    if (entryA!.paymentStatus.entry.kind !== "ledger") throw new Error("unreachable");
    expect(entryA!.paymentStatus.entry.display.flags.monthlyPastGrace).toBe(false);

    expect(entryB!.paymentStatus.source).toBe("ledger");
    if (entryB!.paymentStatus.source !== "ledger") throw new Error("unreachable");
    expect(entryB!.paymentStatus.entry.kind).toBe("ledger");
    if (entryB!.paymentStatus.entry.kind !== "ledger") throw new Error("unreachable");
    expect(entryB!.paymentStatus.entry.display.flags.monthlyPastGrace).toBe(true);
  });
});
