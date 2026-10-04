import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";

// Same mocking convention as exchange-rate-actions-auth.test.ts, this feature's own precedent for testing a
// "use server" action's real authorization path against the real test database.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { resolveReceipt, cancelReceipt, getReceiptStatus, listReceipts } = await import("../../src/lib/dues/awaiting-rate-receipt-actions");

/**
 * Owner awaiting-rate receipt queue brief §5.2 (action-authorization tier): the real "use server" actions, called
 * exactly as a real caller would through the real `resolveActionContext` — no `deps` parameter exists on any of the
 * four public signatures to override. Reuses the exact verified `resolveActionContext` outcomes PR #87 established
 * (cited directly, not re-derived): a non-member/inactive-org caller resolves `{ ok: false }` (mapped to `notFound`),
 * while a GENUINE member with the wrong role hits `requireOrganizationAccess`'s bare `Error("FORBIDDEN")`, which
 * `resolveActionContext` does NOT catch — it propagates straight out, uncaught. Also proves `notActive` under the
 * REAL, unmodified, hardcoded-false `inactiveLedgerActivation` default for a genuine ADMIN — there is no `deps`
 * parameter on `resolveReceipt`/`cancelReceipt` through which any caller could ever make it otherwise. `getReceiptStatus`/
 * `listReceipts` are deliberately NOT activation-gated (reads), confirmed by their own tests below.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let a: Fixture;
let b: Fixture;
let director: { id: string };
let student: { id: string };
let receiptId: string;

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "recauth-a");
  b = await makeAccountingOrg("CUMULATIVE", "recauth-b");
  director = await prisma.user.create({ data: { email: `recauth-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Auth", lastName: `Student-${suffix}`, phone: "00000000",
      email: `recauth-student-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `recauth-student-${suffix}`, status: "ACTIVE",
    },
  });
  const receipt = await prisma.awaitingRateReceipt.create({
    data: {
      organizationId: a.org.id, studentId: student.id, academyId: a.academy.id, kind: "ORDINARY", status: "PENDING",
      receivedOn: new Date("2031-01-01"), tenderCurrency: "CRC", tenderAmount: "100.00", method: "EFECTIVO",
      capturedAt: new Date(), capturedById: a.admin.id, snapshot: { kind: "ORDINARY", obligationIds: ["ob-1"] },
    },
  });
  receiptId = receipt.id;
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (director) {
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
  }
  // AwaitingRateReceipt rows are never deleted by the application (a DB trigger enforces it) — bypassed here for
  // test cleanup only, the same technique awaiting-rate-receipt.test.ts's own afterAll already uses.
  for (const fixture of [a, b]) {
    if (!fixture) continue;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRawUnsafe(`DELETE FROM "AwaitingRateReceipt" WHERE "organizationId" = $1`, fixture.org.id);
      },
      { timeout: 60_000 },
    );
  }
  await a?.drop();
  await b?.drop();
}, 60_000);

describe("resolveReceipt: resolveActionContext's two distinct refusal shapes", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await resolveReceipt(a.org.id, {}, formData({ receiptId }))).toEqual({ error: "notFound" });
  });

  it("a real member of a DIFFERENT organization resolves notFound (cross-organization disclosure rule)", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await resolveReceipt(a.org.id, {}, formData({ receiptId }))).toEqual({ error: "notFound" });
  });

  it("a GENUINE member of the organization with the wrong role (DIRECTOR) rejects with a thrown FORBIDDEN — never a resolved notFound ActionState", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(resolveReceipt(a.org.id, {}, formData({ receiptId }))).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN member, under the real, unmodified, hardcoded-false production activation default, gets notActive — no deps parameter exists through which anything could ever make it otherwise", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await resolveReceipt(a.org.id, {}, formData({ receiptId }))).toEqual({ error: "notActive" });
  });
});

describe("cancelReceipt: the same two refusal shapes, plus the required-reason guard", () => {
  it("an unauthenticated caller resolves notFound", async () => {
    actAs(null);
    expect(await cancelReceipt(a.org.id, {}, formData({ receiptId, reason: "test" }))).toEqual({ error: "notFound" });
  });

  it("a genuine member with the wrong role rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(cancelReceipt(a.org.id, {}, formData({ receiptId, reason: "test" }))).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN member under real inactive activation gets notActive even with a valid reason", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await cancelReceipt(a.org.id, {}, formData({ receiptId, reason: "test" }))).toEqual({ error: "notActive" });
  });
});

describe("getReceiptStatus: the same two refusal outcomes, but NOT activation-gated (a read)", () => {
  it("an unauthenticated caller gets null, never a thrown error", async () => {
    actAs(null);
    expect(await getReceiptStatus(a.org.id, receiptId)).toBeNull();
  });

  it("a real member of a different organization gets null", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await getReceiptStatus(a.org.id, receiptId)).toBeNull();
  });

  it("a genuine member with the wrong role rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getReceiptStatus(a.org.id, receiptId)).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN member gets the real status — confirms this read is reachable even under the real inactive activation default", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getReceiptStatus(a.org.id, receiptId)).toEqual({ status: "PENDING" });
  });
});

describe("listReceipts: the same two refusal outcomes, but NOT activation-gated (a read)", () => {
  it("an unauthenticated caller gets an empty page, never a thrown error", async () => {
    actAs(null);
    expect(await listReceipts(a.org.id, {})).toEqual({ rows: [], nextCursor: null });
  });

  it("a genuine member with the wrong role rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(listReceipts(a.org.id, {})).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN member gets the real list — confirms this read is reachable even under the real inactive activation default", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    const result = await listReceipts(a.org.id, { status: "PENDING" });
    expect(result.rows.some((r) => r.id === receiptId)).toBe(true);
  });
});
