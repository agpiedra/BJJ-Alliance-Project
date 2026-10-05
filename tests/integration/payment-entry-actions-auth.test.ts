import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPaymentWithSubmissionIdentity } from "../../src/lib/dues/ledger/submission-identity";

/**
 * Ordinary payment-entry UI brief §8 tier 2 (corrected, point 4): the real `"use server"` actions, called exactly as
 * a real caller would — no `deps` parameter exists on any of the three public signatures to override, so this proves
 * authorization is genuinely checked by resolveActionContext and that activation is the real, unmodified,
 * hardcoded-false `inactiveLedgerActivation` default — matching `exchange-rate-actions-auth.test.ts`/
 * `awaiting-rate-receipt-actions-auth.test.ts`'s own exact precedent (read in full for this file).
 *
 * CORRECTED FROM THE ORIGINAL DISPATCH BRIEF: `recordDuesPaymentWithSubmissionIdentity`'s own read order checks
 * activation BEFORE the student/branch lookup (confirmed directly, `submission-identity.ts:174-183`) — so under the
 * real closed default, an out-of-branch DIRECTOR and an in-branch DIRECTOR are BOTH refused `notActive`, never
 * reaching the branch-scope check at all. That check's own correctness is already fully proven by PR #89's own test
 * suite (test 8c) with an injected active `deps` this action's public signature deliberately has no way to supply.
 * This file does not claim a distinction `recordPayment`/`getPayableObligations` cannot actually produce under the
 * real default. `checkSubmissionOutcome` is different: `getSubmissionOutcome` has NO activation gate at all, so its
 * own three-way authorization split (role check, then a SEPARATE branch-scope check) is fully reachable here, and is
 * tested in full below, against a REAL committed attempt row (created directly via the engine with an injected
 * active `deps`, exactly like PR #89's own fixture setup — never through the activation-gated action layer).
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { recordPayment, getPayableObligations, checkSubmissionOutcome } = await import("../../src/lib/dues/payment-entry-actions");

let a: Fixture;
let b: Fixture;
let academy2: { id: string };
let director: { id: string }; // DIRECTOR of org A, scoped to a.academy.id (the student's own branch)
let directorOtherBranch: { id: string }; // DIRECTOR of org A, scoped ONLY to academy2
let instructor: { id: string };
let usdTerms: { id: string };
let usdPolicy: { id: string };

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, v);
    else fd.set(key, value);
  }
  return fd;
}

let studentCounter = 0;
async function newStudent(academyId: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "ActionAuth", lastName: `S${n}`, phone: "00000000",
      email: `actionauth-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `actionauth-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "actauth-a");
  b = await makeAccountingOrg("CUMULATIVE", "actauth-b");
  academy2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "ActionAuth A2", slug: `actauth-a2-${suffix}`, kioskTokenHash: `actauth-a2-${suffix}` } });

  const directorUser = await prisma.user.create({ data: { email: `actauth-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;

  const directorOtherUser = await prisma.user.create({ data: { email: `actauth-director2-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorOtherUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorOtherUser.id, organizationId: a.org.id, academyId: academy2.id, role: "DIRECTOR" } });
  directorOtherBranch = directorOtherUser;

  const instructorUser = await prisma.user.create({ data: { email: `actauth-instructor-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" } });
  await prisma.organizationMembership.create({ data: { userId: instructorUser.id, organizationId: a.org.id, role: "INSTRUCTOR" } });
  instructor = instructorUser;

  const planA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `ActionAuth USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
  usdPolicy = await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2026, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id } });
}, 60_000);

afterAll(async () => {
  currentSession = null;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesPaymentAttempt", "DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  const userIds = [director?.id, directorOtherBranch?.id, instructor?.id].filter((x): x is string => !!x);
  if (userIds.length) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (academy2) await prisma.academy.deleteMany({ where: { id: academy2.id } });
  await a?.drop();
  await b?.drop();
}, 120_000);

const VALID_FIELDS = { studentId: "irrelevant", obligationIds: ["irrelevant"], receivedOn: "2026-03-01", tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", submissionId: `sub-${suffix}` };

describe("recordPayment: authorization, under the real unmodified activation default (no deps override exists)", () => {
  it("an unauthenticated caller resolves notFound, writing nothing", async () => {
    actAs(null);
    expect(await recordPayment(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });

  it("a real member of a DIFFERENT organization resolves notFound (cross-organization disclosure rule)", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await recordPayment(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });

  it("a GENUINE member with the wrong role (INSTRUCTOR) rejects with a thrown FORBIDDEN — never a resolved notFound", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(recordPayment(a.org.id, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN, under the real, unmodified, hardcoded-false activation default, gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await recordPayment(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });

  it("a genuine own-branch DIRECTOR, under the real activation default, ALSO gets notActive — the role check allows DIRECTOR too", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    expect(await recordPayment(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });
});

describe("getPayableObligations: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await getPayableObligations(a.org.id, "whatever")).toEqual({ ok: false, error: "notFound" });
  });

  it("a genuine member with the wrong role rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(getPayableObligations(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN gets notActive (the reader it wraps is activation-gated too), proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getPayableObligations(a.org.id, "whatever")).toEqual({ ok: false, error: "notActive" });
  });
});

describe("checkSubmissionOutcome: the full three-way authorization split (reachable here — getSubmissionOutcome has NO activation gate)", () => {
  let realAttemptStudent: { id: string };
  let realSubmissionId: string;

  beforeAll(async () => {
    realAttemptStudent = await newStudent(a.academy.id); // the attempt's own academyId is a.academy.id, NOT academy2
    const ob = await createMonthlyObligation({ context: context(), studentId: realAttemptStudent.id, coverage: { year: 2026, month: 2 }, planTermsId: usdTerms.id, policyVersionId: usdPolicy.id }, { activation: ACTIVE });
    if (!ob.ok) throw new Error(`fixture: obligation failed: ${ob.error}`);
    realSubmissionId = `sub-checkauth-${suffix}`;
    const written = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: realAttemptStudent.id, receivedOn: { year: 2026, month: 2, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob.obligationId], maxBackdateDays: 3660, submissionId: realSubmissionId },
      { activation: ACTIVE },
    );
    if (!written.ok) throw new Error(`fixture: write failed: ${JSON.stringify(written)}`);
  }, 30_000);

  it("(Case A) no session resolves notFound, never throws", async () => {
    actAs(null);
    expect(await checkSubmissionOutcome(a.org.id, realSubmissionId)).toEqual({ status: "notFound" });
  });

  it("(Case A) a real member of a different organization resolves notFound", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await checkSubmissionOutcome(a.org.id, realSubmissionId)).toEqual({ status: "notFound" });
  });

  it("(Case B) a genuine member with the wrong role (INSTRUCTOR) REJECTS with a thrown FORBIDDEN, never resolves", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(checkSubmissionOutcome(a.org.id, realSubmissionId)).rejects.toThrow("FORBIDDEN");
  });

  it("(Case C) a genuine DIRECTOR of a DIFFERENT branch RESOLVES notFound — a failed scope check, not a rejection", async () => {
    actAs(directorOtherBranch.id, a.org.id, "DIRECTOR");
    expect(await checkSubmissionOutcome(a.org.id, realSubmissionId)).toEqual({ status: "notFound" });
  });

  it("the own-branch DIRECTOR and the ADMIN both resolve the real committed outcome", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    const asDirector = await checkSubmissionOutcome(a.org.id, realSubmissionId);
    expect(asDirector).toMatchObject({ status: "committed" });

    actAs(a.admin.id, a.org.id, "ADMIN");
    const asAdmin = await checkSubmissionOutcome(a.org.id, realSubmissionId);
    expect(asAdmin).toEqual(asDirector);
  });
});
