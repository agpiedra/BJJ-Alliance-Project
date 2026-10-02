import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { genuineReturnChargeInTx } from "../../src/lib/dues/ledger/genuine-return-charge";
import { resolveTrustworthyArchiveEvent } from "../../src/lib/students/archive-event";

// returnToTraining (a real server action) calls resolveActionContext -> auth(), which needs a Next.js request
// scope that doesn't exist here — mocked exactly as resume-charge.test.ts/student-status-history.test.ts already do.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { returnToTraining } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");

/**
 * Genuine-return-to-training brief: `genuineReturnChargeInTx`'s gated financial path, its archive-event binding
 * (§4), and `returnToTraining`'s own composition of it, proved against the REAL test database.
 * `restoreStudent`'s and `archiveStudent`'s own existing suites are untouched by this file.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year, matching resume-charge.test.ts
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let a2: { id: string }; // A's second branch, for the cross-branch Director authorization test
let director1: { id: string }; // Director of A's first branch
let director2: { id: string }; // Director of A's second branch
let planA: { id: string };
let termsA: { id: string }; // dueDay 20
let policyA: { id: string }; // dueDay 20, graceDay 5

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

function actAs(userId: string, role = "ADMIN") {
  currentSession = { user: { id: userId, role } };
}

let studentCounter = 0;
/** A student currently ARCHIVED, with `statusBeforeArchive` set, and — unless `source` is overridden — ONE
 * `StudentStatusChange` row (`status: ARCHIVED`, `sequence: 1`, `source: "EVENT"`) representing the archive event
 * itself. Returns the student and the resolved archive-event id (or `null` if `source` is not `"EVENT"`). */
async function newArchivedStudent(statusBeforeArchive: "ACTIVE" | "INACTIVE" | "PENDING" | null, label: string, source: "EVENT" | "BASELINE" | "NONE" = "EVENT") {
  const n = ++studentCounter;
  const student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Return", lastName: `${label}${n}`, phone: "00000000",
      email: `return-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `return-${label}-${n}-${suffix}`,
      status: "ARCHIVED", statusBeforeArchive,
    },
  });
  if (source !== "NONE") {
    await prisma.studentStatusChange.create({
      data: { organizationId: a.org.id, studentId: student.id, status: "ARCHIVED", effectiveOn: new Date("2030-01-01"), sequence: 1, source, actorId: a.admin.id },
    });
  }
  const resolved = await resolveTrustworthyArchiveEvent(appPrisma, a.org.id, student.id);
  return { student, archiveEventId: resolved.ok ? resolved.archiveEventId : null };
}

async function assign(studentId: string, planId: string | null, effectiveYear = 2020, effectiveMonth = 1) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId, effectiveYear, effectiveMonth, createdById: a.admin.id } });
}

async function ledgerCounts() {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id } }),
    signups: await prisma.duesObligation.count({ where: { organizationId: a.org.id, type: "SIGNUP" } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId: a.org.id } }),
    statusChanges: await prisma.studentStatusChange.count({ where: { organizationId: a.org.id } }),
    audits: await prisma.auditLog.count({ where: { organizationId: a.org.id } }),
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Waits until Postgres reports a session genuinely blocked on a lock matching every string in `matches` — the
 * established pattern, reused verbatim from resume-charge.test.ts/prepay-monthly.test.ts. */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "return-a");
  currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
  a2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Return A2", slug: `return-a2-${suffix}`, kioskTokenHash: `return-a2-${suffix}` } });
  const dir1User = await prisma.user.create({ data: { email: `return-d1-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: dir1User.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: dir1User.id, academyId: a.academy.id, organizationId: a.org.id, role: "DIRECTOR" } });
  director1 = dir1User;
  const dir2User = await prisma.user.create({ data: { email: `return-d2-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: dir2User.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: dir2User.id, academyId: a2.id, organizationId: a.org.id, role: "DIRECTOR" } });
  director2 = dir2User;

  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Return plan ${suffix}` } });
  planA = plan;
  termsA = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policyA = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesCoverage", "DuesObligation", "StudentStatusChange", "StudentPlanAssignment"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 30_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: a.org.id, userId: { in: [director1.id, director2.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [director1.id, director2.id] } } });
  await prisma.academy.deleteMany({ where: { id: a2.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
});

describe("billing inactive: the gated branch is structurally unreachable", () => {
  it("returnToTraining's own exported signature carries no deps/activation/date parameter", () => {
    expect(returnToTraining.length).toBe(3);
  });

  it("genuineReturnChargeInTx refuses notActive before any lock, with default deps", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "inactive");
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, {}),
    );
    expect(result).toEqual({ ok: false, error: "notActive" });
    expect(await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).toMatchObject({ status: "ARCHIVED" });
  });
});

describe("eligibility (D20): status + statusBeforeArchive", () => {
  it("statusBeforeArchive PENDING refuses notEligible, zero writes", async () => {
    const { student } = await newArchivedStudent("PENDING", "pendingbefore");
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "whatever" }, deps({ now: at("2030-05-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "notEligible" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("statusBeforeArchive null (legacy, pre-column) refuses notEligible", async () => {
    const { student } = await newArchivedStudent(null, "nullbefore");
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "whatever" }, deps({ now: at("2030-05-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "notEligible" });
  });

  it("a non-ARCHIVED student refuses notEligible", async () => {
    const student = await prisma.student.create({
      data: { organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Return", lastName: `active${++studentCounter}`, phone: "0", email: `return-active-${studentCounter}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `return-active-${studentCounter}-${suffix}`, status: "ACTIVE" },
    });
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "whatever" }, deps({ now: at("2030-05-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "notEligible" });
  });
});

describe("the missing-trustworthy-event case (§4): never falls back to status-only", () => {
  it("a BASELINE-sourced latest ARCHIVED row refuses noTrustworthyArchiveEvent", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "baseline", "BASELINE");
    expect(archiveEventId).toBeNull(); // resolveTrustworthyArchiveEvent itself already refuses this at render time
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "some-id" }, deps({ now: at("2030-05-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "noTrustworthyArchiveEvent" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("no StudentStatusChange row at all despite ARCHIVED status (defensive) refuses noTrustworthyArchiveEvent", async () => {
    const { student, archiveEventId } = await newArchivedStudent("INACTIVE", "nohistory", "NONE");
    expect(archiveEventId).toBeNull();
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "some-id" }, deps({ now: at("2030-05-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "noTrustworthyArchiveEvent" });
  });
});

describe("archive-event binding (§4): fresh vs. stale", () => {
  it("the correct, current archive-event id proceeds", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "fresh");
    await assign(student.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-06-10T12:00:00") })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("a wrong/fabricated archive-event id refuses staleArchiveEvent, zero writes", async () => {
    const { student } = await newArchivedStudent("ACTIVE", "wrongid");
    await assign(student.id, planA.id);
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: "not-the-real-id" }, deps({ now: at("2030-06-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "staleArchiveEvent" });
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("billing active: configuration resolves, month not yet covered", () => {
  it("returns succeeds, creates one MONTHLY (never a SIGNUP), dueOn = max(normal due date, return date), status ACTIVE, statusBeforeArchive cleared", async () => {
    const { student, archiveEventId } = await newArchivedStudent("INACTIVE", "newcharge");
    await assign(student.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-07-25T12:00:00") })),
    );
    expect(result).toMatchObject({ ok: true });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.status).toBe("ACTIVE"); // unconditionally ACTIVE, never back to the stored INACTIVE
    expect(after.statusBeforeArchive).toBeNull();
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 7 } });
    expect(obligation.type).toBe("MONTHLY");
    expect(obligation.dueOn!.toISOString().slice(0, 10)).toBe("2030-07-25"); // raised past the normal 20th
    expect(obligation.graceDeadline!.toISOString().slice(0, 10)).toBe("2030-08-05");
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, type: "SIGNUP" } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: a.org.id, entityId: student.id, action: "student.returnToTraining" } });
    expect(audit).toBeTruthy();
  });
});

describe("billing active: the month is already covered", () => {
  it("an existing MONTHLY for the return month: succeeds, that obligation stays completely unchanged, no SIGNUP", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "existingmonthly");
    await assign(student.id, planA.id);
    const existing = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: student.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF",
        coverageYear: 2030, coverageMonth: 8, monthsCovered: 1, amount: "100.00", currency: "USD", lateFeeAmount: "20.00",
        dueOn: new Date(Date.UTC(2030, 7, 20)), graceDeadline: new Date(Date.UTC(2030, 8, 5)), planTermsId: termsA.id, policyVersionId: policyA.id, createdById: a.admin.id,
      },
    });
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-08-15T12:00:00") })),
    );
    expect(result).toMatchObject({ ok: true });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 8 } })).toBe(1);
    const after = await prisma.duesObligation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.dueOn).toEqual(existing.dueOn);
  });
});

describe("billing active: a genuine configuration gap refuses the WHOLE attempt", () => {
  it("no plan assignment at all: refuses inapplicable, status/history/audit/ledger all stay unchanged", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "noassignment");
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-09-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    expect(await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).toMatchObject({ status: "ARCHIVED" });
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("unexpected failure after a provisional write rolls back everything", () => {
  it("a forced failure right after the obligation write rolls back the obligation, status, history and audit together", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "forcedfail");
    await assign(student.id, planA.id);
    const before = await ledgerCounts();
    await expect(
      appPrisma.$transaction((tx) =>
        genuineReturnChargeInTx(
          tx,
          { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! },
          deps({ now: at("2030-09-15T12:00:00"), afterGenuineReturnObligationWrittenForTest: async () => { throw new Error("forced failure for test"); } }),
        ),
      ),
    ).rejects.toThrow("forced failure for test");
    expect(await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).toMatchObject({ status: "ARCHIVED" });
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("retry rule (§5): committed vs. never-committed is the determining line", () => {
  it("committed-earlier-attempt: an immediate retry with the SAME archive-event id refuses (status has moved on)", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "committedretry");
    await assign(student.id, planA.id);
    const first = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    expect(first).toMatchObject({ ok: true });
    const before = await ledgerCounts();
    const retry = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-10-05T12:05:00") })),
    );
    expect(retry).toEqual({ ok: false, error: "notEligible" }); // no longer ARCHIVED at all
    expect(await ledgerCounts()).toEqual(before); // no second charge
  });

  it("the exact September->October->November->December cross-archive sequence: the delayed retry of October's request refuses in December", async () => {
    // September: archived (the event the eventually-delayed request will name).
    const { student, archiveEventId: septemberEventId } = await newArchivedStudent("ACTIVE", "sepoctnovdec");
    await assign(student.id, planA.id);

    // October: the genuine return succeeds, charging October.
    const october = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: septemberEventId! }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    expect(october).toMatchObject({ ok: true });

    // November: archived again — a NEW, later archive event.
    await prisma.student.update({ where: { id: student.id }, data: { status: "ARCHIVED", statusBeforeArchive: "ACTIVE" } });
    await prisma.studentStatusChange.create({
      data: { organizationId: a.org.id, studentId: student.id, status: "ARCHIVED", effectiveOn: new Date("2030-11-01"), sequence: 3, source: "EVENT", actorId: a.admin.id },
    });

    // December: a delayed, lost-response retry of the ORIGINAL October request arrives, still naming September's event.
    const before = await ledgerCounts();
    const decemberRetry = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: septemberEventId! }, deps({ now: at("2030-12-05T12:00:00") })),
    );
    expect(decemberRetry).toEqual({ ok: false, error: "staleArchiveEvent" });
    expect(await ledgerCounts()).toEqual(before); // zero December writes
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 12 } })).toBe(0);
  });

  it("never-committed (config-gap): a later retry with the SAME still-current event succeeds, charging the month it actually executes in", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "nevercommitted");
    // deliberately no assign() yet — the first attempt hits a genuine configuration gap
    const first = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    expect(first).toEqual({ ok: false, error: "inapplicable" }); // zero writes, same event stays current
    await assign(student.id, planA.id); // staff fixes the configuration before retrying
    const retry = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2030-11-20T12:00:00") })),
    );
    expect(retry).toMatchObject({ ok: true });
    // charges NOVEMBER (when the retry actually ran), never a stored October date
    expect(await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 11 } })).toBeTruthy();
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 10 } })).toBe(0);
  });

  it("a later, genuine second archive-and-return cycle charges its OWN month in full, not blocked by the first cycle's coverage", async () => {
    const { student, archiveEventId: firstEventId } = await newArchivedStudent("ACTIVE", "secondcycle");
    await assign(student.id, planA.id);
    const firstReturn = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: firstEventId! }, deps({ now: at("2031-01-05T12:00:00") })),
    );
    expect(firstReturn).toMatchObject({ ok: true });

    await prisma.student.update({ where: { id: student.id }, data: { status: "ARCHIVED", statusBeforeArchive: "ACTIVE" } });
    await prisma.studentStatusChange.create({
      data: { organizationId: a.org.id, studentId: student.id, status: "ARCHIVED", effectiveOn: new Date("2031-02-01"), sequence: 3, source: "EVENT", actorId: a.admin.id },
    });
    const secondEvent = await resolveTrustworthyArchiveEvent(appPrisma, a.org.id, student.id);
    expect(secondEvent.ok).toBe(true);
    if (!secondEvent.ok) throw new Error("unreachable");

    const secondReturn = await appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: secondEvent.archiveEventId }, deps({ now: at("2031-03-05T12:00:00") })),
    );
    expect(secondReturn).toMatchObject({ ok: true });
    expect(await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2031, coverageMonth: 1 } })).toBeTruthy();
    expect(await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2031, coverageMonth: 3 } })).toBeTruthy();
  });
});

describe("genuine concurrency: two attempts for the SAME student and archive event", () => {
  it("one commits; the other, once it acquires the student lock, finds the event superseded and refuses — PID/lock-scoped, not Promise.all timing", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "racewin");
    await assign(student.id, planA.id);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    const first = appPrisma.$transaction((tx) =>
      genuineReturnChargeInTx(
        tx,
        { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! },
        deps({ now: at("2031-04-05T12:00:00"), afterGenuineReturnLocksForTest: async () => { pausedResolve(); await gate; } }),
      ),
    );

    try {
      await paused; // the first attempt holds the student FOR UPDATE lock, still open

      let secondDone = false;
      const second = appPrisma.$transaction((tx) =>
        genuineReturnChargeInTx(tx, { context: context(), student: { id: student.id, homeAcademyId: a.academy.id, userId: null }, archiveEventId: archiveEventId! }, deps({ now: at("2031-04-05T12:00:01") })),
      ).then((r) => ((secondDone = true), r));

      const blocked = await waitUntilBlockedOnLock(['FROM "Student"']);
      expect(blocked, "the second attempt must genuinely block behind the first's student row lock").toBe(true);
      expect(secondDone).toBe(false);

      release();
      expect(await first).toMatchObject({ ok: true });
      // The winner's own commit already flips status to ACTIVE before the loser's blocked lock is granted — the
      // loser's fresh re-check hits the status gate (notEligible) before it ever compares archive-event ids. The
      // id-mismatch path (staleArchiveEvent) is for a DIFFERENT case: the student is ARCHIVED again by the time of
      // the re-check (a later, separate archive-and-return cycle), covered by the cross-archive sequence test above.
      expect(await second).toEqual({ ok: false, error: "notEligible" });
    } finally {
      release();
      await Promise.allSettled([first]);
    }
  }, 20_000);
});

describe("authorization (D21): ADMIN, or a DIRECTOR scoped to the student's own branch", () => {
  // returnToTraining (the real "use server" action) always composes genuineReturnChargeInTx with the default,
  // empty deps ({}) — by design (§7), it has no non-gated fallback and no way to inject active billing from the
  // action layer. So a session that PASSES authorization cannot observe `ok: true` here; it observes the next gate
  // instead (`notActive`, from inside the transaction) — a DIFFERENT, later refusal than a session that fails
  // authorization/scope (`notFound`, before the transaction even opens). That distinction IS the authorization proof.
  it("ADMIN passes authorization: reaches the transaction, refused only by the inactive billing gate", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "adminauth");
    await assign(student.id, planA.id);
    actAs(a.admin.id, "ADMIN");
    const result = await returnToTraining(a.org.id, {}, form({ studentId: student.id, archiveEventId: archiveEventId! }));
    expect(result).toEqual({ error: "notActive" });
  });

  it("the student's own-branch Director passes authorization: reaches the transaction, refused only by the inactive billing gate", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "ownbranchdir");
    await assign(student.id, planA.id);
    actAs(director1.id, "DIRECTOR");
    const result = await returnToTraining(a.org.id, {}, form({ studentId: student.id, archiveEventId: archiveEventId! }));
    expect(result).toEqual({ error: "notActive" });
  });

  it("a Director of a DIFFERENT branch is refused with notFound, zero writes", async () => {
    const { student, archiveEventId } = await newArchivedStudent("ACTIVE", "wrongbranchdir");
    await assign(student.id, planA.id);
    actAs(director2.id, "DIRECTOR"); // director2 is A2's director; this student is at A1
    const before = await ledgerCounts();
    const result = await returnToTraining(a.org.id, {}, form({ studentId: student.id, archiveEventId: archiveEventId! }));
    expect(result).toEqual({ error: "notFound" });
    expect(await ledgerCounts()).toEqual(before);
    actAs(a.admin.id, "ADMIN"); // restore the default session for later tests
  });
});
