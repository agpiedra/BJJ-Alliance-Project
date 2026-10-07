import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.1/§7: the "load more" action bridge, called exactly as a real
 * client would (no `deps` override exists on its public signature) — proves `resolveActionContext` is genuinely
 * re-resolved on EVERY call (never a staleness window inherited from an earlier one), and that the three staff
 * roles (not ADMIN-only) can view history. Models `financial-corrections-actions-auth.test.ts`'s own
 * `actAs`/session-mocking precedent.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { getPaymentHistoryPage } = await import("../../src/app/[locale]/(staff)/students/[id]/payment-history-actions");

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

let a: Fixture;
let director: { id: string };

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "pmthistact-a");

  const directorUser = await prisma.user.create({ data: { email: `pmthistact-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (director) {
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
  }
  await a?.drop();
}, 120_000);

// This action has NO `deps` parameter on its public signature (by design — a real caller could never supply one),
// so every call here runs under the REAL, unmodified, hardcoded-false `inactiveLedgerActivation` default. A
// genuinely authorized caller therefore always observes `notActive` — that IS the proof the role/membership check
// passed, the identical framing `financial-corrections-actions-auth.test.ts` already established for its own
// writer actions. Real pagination/cursor/branch-scope behavior is already proven at the READER level (with a
// `deps.activation` override) by `payment-history-queries.test.ts`'s own PR #95 tests — this file's job is
// authorization only.
describe("getPaymentHistoryPage: authorization, under the real unmodified activation default", () => {
  it("an unauthenticated caller gets notFound, never reaching the reader", async () => {
    actAs(null);
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notFound" });
  });

  it("a genuine ADMIN gets notActive — proving the role check passed", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notActive" });
  });

  it("a genuine DIRECTOR gets notActive too — payment-history viewing is NOT ADMIN-only, unlike financial-corrections", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notActive" });
  });

  it("a genuine INSTRUCTOR gets notActive too — the third allowed view-only role", async () => {
    const instructorUser = await prisma.user.create({ data: { email: `pmthistact-instr-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" } });
    await prisma.organizationMembership.create({ data: { userId: instructorUser.id, organizationId: a.org.id, role: "INSTRUCTOR" } });
    actAs(instructorUser.id, a.org.id, "INSTRUCTOR");
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notActive" });
    await prisma.organizationMembership.deleteMany({ where: { userId: instructorUser.id } });
    await prisma.user.deleteMany({ where: { id: instructorUser.id } });
  });
});

describe("getPaymentHistoryPage: fresh authorization on every call", () => {
  it("a DIRECTOR's membership revoked between two calls is honored on the SECOND call, never grandfathered from the first", async () => {
    // Call 1: a genuine, currently-member DIRECTOR — reaches the reader (notActive), proving the role check passed.
    actAs(director.id, a.org.id, "DIRECTOR");
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notActive" });

    // Revoke membership entirely — a real DB change between the two calls. `resolveActionContext` must re-resolve
    // this FRESH on the next call, never reuse a session/membership check it already performed once.
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id, organizationId: a.org.id } });

    // Call 2: the SAME action, same arguments, same mocked session — must now refuse at the membership check,
    // never fall through to `notActive` as if nothing changed.
    expect(await getPaymentHistoryPage(a.org.id, "whatever")).toEqual({ ok: false, error: "notFound" });

    // Restore membership so `afterAll`'s own cleanup (staffAssignment -> membership -> user, in that FK order)
    // still finds a row to delete.
    await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  });
});
