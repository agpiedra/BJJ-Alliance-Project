import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { hashSecret } from "../../src/lib/crypto";

/**
 * The platform panel's "Resend invitation" result: approveOrganizationAction → approveOrganization →
 * sendTransactionalEmail → the REAL `resend` SDK. Only the network transport (`fetch`) is replaced, so the SDK's request
 * building and error parsing, and PR #133's outcome classification, all run unmocked. No request leaves the machine.
 *
 * The lifecycle under each outcome (docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md): the earlier link is retired only when
 * the provider accepts the new email; a rejected or unconfigured send withdraws the new link and leaves the earlier one;
 * an unknown send leaves both. Races and failures are in invitation-lifecycle.test.ts.
 */
let currentSession: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { approveOrganizationAction } = await import("../../src/app/[locale]/platform/organizations/actions");

const prisma = getTestPrismaClient();
const cleanupOrgIds: string[] = [];
const cleanupEmails: string[] = [];
let consoleCalls: unknown[][] = [];

const PROVIDER_SECRET = "SYNTH-PROVIDER-SECRET-r7Qw2";
const LOG_PREFIX = "[approve-organization] invitation email outcome";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeUser(isSuperAdmin: boolean) {
  const email = `resend-inv-${isSuperAdmin ? "super" : "admin"}-${uniqueSuffix()}@example.test`;
  cleanupEmails.push(email);
  return prisma.user.create({ data: { email, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin } });
}

function stubTransport(respond: (recipient: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    return respond(Array.isArray(body.to) ? body.to[0] : String(body.to));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const accepting = () => new Response(JSON.stringify({ id: "synthetic-email-id" }), { status: 200 });

/** A provider error body that echoes the recipient — the free text that must not reach the action result or logs. */
function providerError(recipient: string, name: string, status: number) {
  return new Response(JSON.stringify({ statusCode: status, name, message: `${PROVIDER_SECRET}: cannot send to ${recipient}` }), { status });
}

/** An ACTIVE organization approved through the panel action (accepting transport), with a super-admin session. */
async function activeOrganizationWithSession() {
  const superAdmin = await makeUser(true);
  currentSession = { user: { id: superAdmin.id } };
  const suffix = uniqueSuffix();
  const contactEmail = `resend-inv-owner-${suffix}@example.test`;
  cleanupEmails.push(contactEmail);
  const org = await prisma.organization.create({
    data: { slug: `resend-inv-${suffix}`, name: `Resend Inv ${suffix}`, status: "PENDING", city: "Test City", country: "Costa Rica", contactEmail },
  });
  cleanupOrgIds.push(org.id);
  stubTransport(accepting);
  expect(await approveOrganizationAction(org.id)).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "settled" });
  const first = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id, usedAt: null, revokedAt: null } });
  consoleCalls = [];
  return { org, contactEmail, first };
}

const live = (organizationId: string) =>
  prisma.invitation.findMany({ where: { organizationId, usedAt: null, revokedAt: null }, orderBy: { createdAt: "asc" } });

/** Accepted: the earlier link is retired (revokedAt — never usedAt, which now means accepted), one fresh live link. */
async function expectEarlierRetired(organizationId: string, first: { id: string; tokenHash: string }) {
  const earlier = await prisma.invitation.findUniqueOrThrow({ where: { id: first.id } });
  expect(earlier.revokedAt).not.toBeNull();
  expect(earlier.usedAt).toBeNull();
  const rows = await live(organizationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].tokenHash).not.toBe(first.tokenHash);
}

/** Rejected / not configured: the new link is withdrawn and the earlier one is the only live link, untouched. */
async function expectNewWithdrawnEarlierKept(organizationId: string, first: { id: string }) {
  expect((await live(organizationId)).map((row) => row.id)).toEqual([first.id]);
  const withdrawn = await prisma.invitation.findMany({ where: { organizationId, id: { not: first.id } } });
  expect(withdrawn).toHaveLength(1);
  expect(withdrawn[0].revokedAt).not.toBeNull();
}

/** Unknown: nothing retired — the earlier link and the new one are both live. */
async function expectBothLive(organizationId: string, first: { id: string }) {
  const rows = await live(organizationId);
  expect(rows).toHaveLength(2);
  expect(rows[0].id).toBe(first.id);
}

/** Nothing from the provider, the address or the invitation link appears in console output or the action result. */
function expectNothingEscaped(result: unknown, recipient: string, fetchMock?: ReturnType<typeof stubTransport>) {
  const captured = JSON.stringify(consoleCalls) + JSON.stringify(result);
  const secrets = [PROVIDER_SECRET, recipient, "token=", "[Resend API Error]"];
  if (fetchMock) {
    const html = (JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { html: string }).html;
    const link = html.match(/https?:\/\/[^\s"<]+accept-invitation\?token=[A-Za-z0-9_-]+/)?.[0];
    expect(link, "the real SDK request carried the invitation link").toBeDefined();
    secrets.push(link!);
  }
  for (const secret of secrets) expect(captured, `output contains ${secret}`).not.toContain(secret);
}

/** An "unknown" send may have been accepted: exactly one neutral outcome entry, and no output claims otherwise. */
function expectNoNonAcceptanceClaim(organizationId: string) {
  const entries = consoleCalls.filter((call) => String(call[0]).startsWith("[approve-organization]"));
  expect(entries).toHaveLength(1);
  expect(entries[0][0]).toBe(LOG_PREFIX);
  expect(entries[0][1]).toMatchObject({ organizationId, outcome: "unknown" });
  expect(JSON.stringify(consoleCalls)).not.toMatch(/not accepted|not sent|reject|undelivered/i);
}

beforeEach(() => {
  consoleCalls = [];
  vi.stubEnv("RESEND_API_KEY", "re_synthetic_test_key");
  vi.stubEnv("EMAIL_FROM", "MATROOM <noreply@example.test>");
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  currentSession = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  await prisma.user.deleteMany({ where: { email: { in: cleanupEmails } } });
});

describe("platform resend invitation reports the real email outcome (real Resend SDK, fetch mocked)", () => {
  it("REQUIRED: provider accepted → 'accepted'; the earlier link is retired only now", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    const fetchMock = stubTransport(accepting);

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "settled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/emails");
    await expectEarlierRetired(org.id, first);
    expectNothingEscaped(result, contactEmail, fetchMock);
  });

  it("REQUIRED: explicit provider rejection → 'rejected', the new link withdrawn, the earlier one kept; logged as outcome + fixed code only", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    const fetchMock = stubTransport((recipient) => providerError(recipient, "validation_error", 422));

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "rejected", invitationSettlement: "settled" });
    await expectNewWithdrawnEarlierKept(org.id, first);
    expect(consoleCalls).toContainEqual([LOG_PREFIX, { organizationId: org.id, outcome: "rejected", providerCode: "validation_error" }]);
    expectNothingEscaped(result, contactEmail, fetchMock);
  });

  it("REQUIRED: provider-side 5xx error → 'unknown', never 'rejected'; both links stay", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    const fetchMock = stubTransport((recipient) => providerError(recipient, "internal_server_error", 500));

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "unknown", invitationSettlement: "settled" });
    await expectBothLive(org.id, first);
    expect(consoleCalls).toContainEqual([LOG_PREFIX, { organizationId: org.id, outcome: "unknown", providerCode: "internal_server_error" }]);
    expectNoNonAcceptanceClaim(org.id);
    expectNothingEscaped(result, contactEmail, fetchMock);
  });

  it("REQUIRED: unparseable provider response → 'unknown'", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    const fetchMock = stubTransport((recipient) => new Response(`<html>${PROVIDER_SECRET} ${recipient}</html>`, { status: 502 }));

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "unknown", invitationSettlement: "settled" });
    await expectBothLive(org.id, first);
    expectNoNonAcceptanceClaim(org.id);
    expectNothingEscaped(result, contactEmail, fetchMock);
  });

  it("REQUIRED: network failure → 'unknown'; the thrown message is not logged", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    const failingFetch = vi.fn(async () => {
      throw new TypeError(`${PROVIDER_SECRET} connect ECONNREFUSED ${contactEmail}`);
    });
    vi.stubGlobal("fetch", failingFetch);

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "unknown", invitationSettlement: "settled" });
    expect(failingFetch).toHaveBeenCalledTimes(1);
    await expectBothLive(org.id, first);
    expectNoNonAcceptanceClaim(org.id);
    expectNothingEscaped(result, contactEmail);
  });

  it("REQUIRED: missing email configuration → 'not_configured', no request made, the env-var error text not logged", async () => {
    const { org, contactEmail, first } = await activeOrganizationWithSession();
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = stubTransport(accepting);

    const result = await approveOrganizationAction(org.id);

    expect(result).toEqual({ ok: true, invitationEmail: "not_configured", invitationSettlement: "settled" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNewWithdrawnEarlierKept(org.id, first);
    expect(JSON.stringify(consoleCalls)).not.toContain("RESEND_API_KEY");
    expectNothingEscaped(result, contactEmail);
  });

  it("REQUIRED (defect D1): repeated resends keep issuing until genuine acceptance — a superseded link never blocks", async () => {
    const { org } = await activeOrganizationWithSession();

    for (let i = 0; i < 5; i += 1) {
      const fetchMock = stubTransport(accepting);
      expect(await approveOrganizationAction(org.id)).toEqual({ ok: true, invitationEmail: "accepted", invitationSettlement: "settled" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    expect(await live(org.id)).toHaveLength(1);
    expect(await prisma.invitation.count({ where: { organizationId: org.id } })).toBe(6);
    expect(await prisma.invitation.count({ where: { organizationId: org.id, usedAt: { not: null } } })).toBe(0);
  });

  it("REQUIRED: authorization preserved — a non-super-admin and an anonymous caller are refused; nothing is issued or sent", async () => {
    const { org, first } = await activeOrganizationWithSession();
    const fetchMock = stubTransport(accepting);

    currentSession = { user: { id: (await makeUser(false)).id } };
    expect(await approveOrganizationAction(org.id)).toEqual({ error: "notFound" });
    currentSession = null;
    expect(await approveOrganizationAction(org.id)).toEqual({ error: "notFound" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await live(org.id)).map((invitation) => invitation.id)).toEqual([first.id]);
    expect(await prisma.invitation.count({ where: { organizationId: org.id } })).toBe(1);
  });
});
