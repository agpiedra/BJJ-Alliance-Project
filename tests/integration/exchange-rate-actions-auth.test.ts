import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";

// The actions read the session through next-auth's `auth()`, which needs a real request — same mocking convention
// as tests/integration/dues-owner-config.test.ts, this feature's own precedent for testing a "use server" action's
// real authorization path against the real test database.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { enterOrCorrectExchangeRate, getExchangeRateCorrectionWarning } = await import("../../src/lib/dues/exchange-rate-actions");

/**
 * Owner exchange-rate UI brief §5.2: the real "use server" actions, called exactly as a real caller would through
 * the real `resolveActionContext` — no `deps` parameter exists on either public signature to override, so this
 * proves the two genuinely distinct `resolveActionContext` outcomes this feature's own brief corrected after
 * reading its actual source (`src/lib/tenant/context.ts`): a non-member/inactive-org caller resolves
 * `{ ok: false }` (mapped to `notFound`), while a GENUINE member with the wrong role hits
 * `requireOrganizationAccess`'s bare `Error("FORBIDDEN")`, which `resolveActionContext` does NOT catch — it
 * propagates straight out, uncaught, exactly like `dues-owner-config.test.ts`'s own "FORBIDDEN, not notFound"
 * precedent for every other owner-only action in this codebase. Also proves `"notActive"` under the REAL,
 * unmodified, hardcoded-false `inactiveLedgerActivation` default for a genuine ADMIN — there is no `deps`
 * parameter on either export through which any caller could ever make it otherwise.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let a: Fixture;
let b: Fixture;
let director: { id: string };

function actAs(userId: string | null, organizationId?: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const VALID_FIELDS = { quoteYear: "2032", quoteMonth: "2", quoteDay: "10", value: "505.37", expectedCurrentRevision: "0" };

async function counts(organizationId: string) {
  return { quotes: await prisma.exchangeRateQuote.count({ where: { organizationId } }), audits: await prisma.auditLog.count({ where: { organizationId, action: "exchangeRateQuote.enter" } }) };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "exauth-a");
  b = await makeAccountingOrg("CUMULATIVE", "exauth-b");
  director = await prisma.user.create({ data: { email: `exauth-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (director) {
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
  }
  await prisma.exchangeRateQuote.deleteMany({ where: { organizationId: { in: [a?.org.id, b?.org.id].filter(Boolean) as string[] } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [a?.org.id, b?.org.id].filter(Boolean) as string[] } } });
  await a?.drop();
  await b?.drop();
}, 60_000);

describe("enterOrCorrectExchangeRate: resolveActionContext's two distinct refusal shapes", () => {
  it("an unauthenticated caller resolves notFound, writing nothing", async () => {
    actAs(null);
    const before = await counts(a.org.id);
    expect(await enterOrCorrectExchangeRate(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("a real member of a DIFFERENT organization resolves notFound (cross-organization disclosure rule), writing nothing", async () => {
    actAs(b.admin.id, b.org.id);
    const before = await counts(a.org.id);
    expect(await enterOrCorrectExchangeRate(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("a GENUINE member of the organization with the wrong role (DIRECTOR) rejects with a thrown FORBIDDEN — never a resolved notFound ActionState — writing nothing", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    const before = await counts(a.org.id);
    await expect(enterOrCorrectExchangeRate(a.org.id, {}, formData(VALID_FIELDS))).rejects.toThrow("FORBIDDEN");
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("a genuine ADMIN member, under the real, unmodified, hardcoded-false production activation default, gets notActive — this action's public signature carries no deps parameter through which anything could ever make it otherwise", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    const before = await counts(a.org.id);
    expect(await enterOrCorrectExchangeRate(a.org.id, {}, formData(VALID_FIELDS))).toEqual({ error: "notActive" });
    expect(await counts(a.org.id)).toEqual(before);
  });
});

describe("getExchangeRateCorrectionWarning: the same two outcomes, read-only", () => {
  it("an unauthenticated caller gets 0, never a thrown error", async () => {
    actAs(null);
    expect(await getExchangeRateCorrectionWarning(a.org.id, "whatever-id")).toBe(0);
  });

  it("a real member of a different organization gets 0", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await getExchangeRateCorrectionWarning(a.org.id, "whatever-id")).toBe(0);
  });

  it("a genuine member with the wrong role rejects with a thrown FORBIDDEN", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    await expect(getExchangeRateCorrectionWarning(a.org.id, "whatever-id")).rejects.toThrow("FORBIDDEN");
  });

  it("a genuine ADMIN member gets a real count (0, for a quote id that does not exist) — the read itself is not activation-gated", async () => {
    actAs(a.admin.id, a.org.id, "ADMIN");
    expect(await getExchangeRateCorrectionWarning(a.org.id, "nonexistent-quote-id")).toBe(0);
  });
});
