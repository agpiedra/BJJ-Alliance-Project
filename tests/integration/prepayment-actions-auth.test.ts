import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";

/**
 * Monthly-prepayment UI brief §8 tier 2 — mirrors `package-purchase-actions-auth.test.ts` exactly. No `deps`
 * parameter exists on any of the three public signatures to override, so this proves authorization is genuinely
 * checked by `resolveActionContext(organizationId, ["ADMIN"])` and that activation is the real, unmodified,
 * hardcoded-false `inactiveLedgerActivation` default.
 *
 * `prepayMonthlyObligationsWithSubmissionIdentity` is hard-coded ADMIN-only in the engine itself
 * (`purchase-submission-identity.ts:337`), identical to the package writer — a genuine DIRECTOR is rejected with a
 * thrown FORBIDDEN here, never admitted through to a `notActive` result the way an ADMIN is.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { prepayMonths, getFirstAvailablePrepaymentMonth, getMonthPrices } = await import("../../src/lib/dues/prepayment-actions");

let a: Fixture;
let b: Fixture;
let director: { id: string };
let instructor: { id: string };

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, v);
    else fd.set(key, value);
  }
  return fd;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "prepayauth-a");
  b = await makeAccountingOrg("CUMULATIVE", "prepayauth-b");

  const directorUser = await prisma.user.create({ data: { email: `prepayauth-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;

  const instructorUser = await prisma.user.create({ data: { email: `prepayauth-instructor-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" } });
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

const VALID_FIELDS = {
  studentId: "irrelevant",
  requestedMonths: ["2027-06"],
  receivedOn: "2027-06-01",
  tenderCurrency: "USD",
  tenderAmount: "100.00",
  method: "EFECTIVO",
  submissionId: `sub-${suffix}`,
};

describe("prepayMonths: authorization, under the real unmodified activation default (no deps override exists)", () => {
  it("an unauthenticated caller resolves notFound, writing nothing", async () => {
    actAs(null);
    expect(await prepayMonths(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });

  it("a real member of a DIFFERENT organization resolves notFound (cross-organization disclosure rule)", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await prepayMonths(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notFound" });
  });

  it("a GENUINE member with the wrong role (INSTRUCTOR) rejects with a thrown FORBIDDEN — never a resolved notFound", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(prepayMonths(a.org.id, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine own-branch DIRECTOR ALSO rejects with a thrown FORBIDDEN — like the package writer, this one is ADMIN-only", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(prepayMonths(a.org.id, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN, under the real, unmodified, hardcoded-false activation default, gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await prepayMonths(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ ok: false, error: "notActive" });
  });
});

describe("getFirstAvailablePrepaymentMonth: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await getFirstAvailablePrepaymentMonth(a.org.id, "whatever")).toEqual({ ok: false, error: "notFound" });
  });

  it("a genuine DIRECTOR rejects with a thrown FORBIDDEN — this read is ADMIN-only too, matching the card's own display gate", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getFirstAvailablePrepaymentMonth(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine member with the wrong role (INSTRUCTOR) rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(getFirstAvailablePrepaymentMonth(a.org.id, "whatever")).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN resolves notFound for a studentId that doesn't exist — proving the role check passed (this read has no activation gate)", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getFirstAvailablePrepaymentMonth(a.org.id, "no-such-student")).toEqual({ ok: false, error: "notFound" });
  });
});

describe("getMonthPrices: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await getMonthPrices(a.org.id, "whatever", [{ year: 2027, month: 6 }])).toEqual({ ok: false, error: "notFound" });
  });

  it("a genuine DIRECTOR rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getMonthPrices(a.org.id, "whatever", [{ year: 2027, month: 6 }])).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine member with the wrong role (INSTRUCTOR) rejects with a thrown FORBIDDEN", async () => {
    actAs(instructor.id, a.org.id, "INSTRUCTOR");
    await expect(getMonthPrices(a.org.id, "whatever", [{ year: 2027, month: 6 }])).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN resolves notFound for a studentId that doesn't exist — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getMonthPrices(a.org.id, "no-such-student", [{ year: 2027, month: 6 }])).toEqual({ ok: false, error: "notFound" });
  });
});
