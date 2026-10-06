import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";

/**
 * Owner financial-corrections UI brief §7 (`exchange-rate-actions-auth.test.ts`/`package-purchase-actions-auth.test.ts`
 * precedent): the real `"use server"` actions, called exactly as a real caller would — no `deps` parameter exists on
 * any public signature to override, so this proves authorization is genuinely enforced by
 * `resolveActionContext(organizationId, ["ADMIN"])` and that activation is the real, unmodified,
 * hardcoded-false `inactiveLedgerActivation` default. All three writers are hard-coded ADMIN-only in the engine
 * itself — a genuine DIRECTOR is rejected with a thrown FORBIDDEN, never admitted through to a `notActive` result.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const {
  correctLateFee,
  reversePaymentAction,
  waiveFee,
  getCorrectableLateFees,
  getReversiblePayments,
  getLateFeeStatus,
  getPaymentStatus,
} = await import("../../src/lib/dues/financial-corrections-actions");

let a: Fixture;
let b: Fixture;
let director: { id: string };
let instructor: { id: string };

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "fcauth-a");
  b = await makeAccountingOrg("CUMULATIVE", "fcauth-b");

  const directorUser = await prisma.user.create({ data: { email: `fcauth-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;

  const instructorUser = await prisma.user.create({ data: { email: `fcauth-instructor-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" } });
  await prisma.organizationMembership.create({ data: { userId: instructorUser.id, organizationId: a.org.id, role: "INSTRUCTOR" } });
  instructor = instructorUser;
}, 60_000);

afterAll(async () => {
  currentSession = null;
  const userIds = [director?.id, instructor?.id].filter((x): x is string => !!x);
  if (userIds.length) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await a?.drop();
  await b?.drop();
}, 120_000);

const CORRECT_FIELDS = { lateFeeId: "irrelevant", expectedRevision: "irrelevant", removalReason: "test", receivedOn: "2030-06-01", tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO" };
const REVERSE_FIELDS = { paymentId: "irrelevant", reversalReason: "test" };
const WAIVE_FIELDS = { lateFeeId: "irrelevant", expectedRevision: "irrelevant", removalReason: "test" };

describe("correctLateFee: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await correctLateFee(a.org.id, {}, formData(CORRECT_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });
  it("a real member of a DIFFERENT organization resolves notFound", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await correctLateFee(a.org.id, {}, formData(CORRECT_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });
  it("a genuine INSTRUCTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(correctLateFee(a.org.id, {}, formData(CORRECT_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine own-branch DIRECTOR ALSO rejects with a thrown FORBIDDEN — ADMIN only", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(correctLateFee(a.org.id, {}, formData(CORRECT_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine ADMIN, under the real hardcoded-false activation default, gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await correctLateFee(a.org.id, {}, formData(CORRECT_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });
});

describe("reversePaymentAction: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await reversePaymentAction(a.org.id, {}, formData(REVERSE_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });
  it("a genuine INSTRUCTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(reversePaymentAction(a.org.id, {}, formData(REVERSE_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine DIRECTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(reversePaymentAction(a.org.id, {}, formData(REVERSE_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine ADMIN gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await reversePaymentAction(a.org.id, {}, formData(REVERSE_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });
});

describe("waiveFee: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await waiveFee(a.org.id, {}, formData(WAIVE_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });
  it("a genuine INSTRUCTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(waiveFee(a.org.id, {}, formData(WAIVE_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine DIRECTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(waiveFee(a.org.id, {}, formData(WAIVE_FIELDS))).rejects.toThrow("FORBIDDEN");
  });
  it("a genuine ADMIN gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await waiveFee(a.org.id, {}, formData(WAIVE_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });
});

describe("the four read bridges: authorization (no activation gate — bare reads, matching getReceiptStatus's own shape)", () => {
  it("getCorrectableLateFees: unauthenticated resolves empty, genuine DIRECTOR/INSTRUCTOR throw FORBIDDEN, genuine ADMIN resolves (empty for a nonexistent student)", async () => {
    actAs(null);
    expect(await getCorrectableLateFees(a.org.id, "whatever")).toEqual([]);
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getCorrectableLateFees(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(getCorrectableLateFees(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getCorrectableLateFees(a.org.id, "no-such-student")).toEqual([]);
  });

  it("getReversiblePayments: same shape", async () => {
    actAs(null);
    expect(await getReversiblePayments(a.org.id, "whatever")).toEqual([]);
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getReversiblePayments(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getReversiblePayments(a.org.id, "no-such-student")).toEqual([]);
  });

  it("getLateFeeStatus: same shape", async () => {
    actAs(null);
    expect(await getLateFeeStatus(a.org.id, "whatever")).toBeNull();
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getLateFeeStatus(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getLateFeeStatus(a.org.id, "no-such-fee")).toBeNull();
  });

  it("getPaymentStatus: same shape", async () => {
    actAs(null);
    expect(await getPaymentStatus(a.org.id, "whatever")).toBeNull();
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getPaymentStatus(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getPaymentStatus(a.org.id, "no-such-payment")).toBeNull();
  });
});
