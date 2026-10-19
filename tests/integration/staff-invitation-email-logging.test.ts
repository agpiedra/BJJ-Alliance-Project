import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * The REAL email-client path for a staff invitation: the Owner's inviteStaff / resendInvitation action → staff-service
 * → sendTransactionalEmail → the real `resend` SDK. Only the network transport (`fetch`) is replaced, so the SDK's own
 * request building, error parsing and error logging all run. No request leaves the machine.
 *
 * resend@6.27.0 prints the provider's raw error object (`console.error("[Resend API Error]:", …)`) whenever
 * NODE_ENV !== "production", and the provider's free-text message can echo the recipient or request details. Every
 * console argument captured during a send is inspected: only the fixed event, the classified outcome and an allowlisted
 * provider code may appear.
 */
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
// Page revalidation needs a request store a direct call does not have; its own (unrelated) log would otherwise be captured.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));

const { inviteStaff, resendInvitation } = await import("../../src/lib/staff/staff-actions");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const prisma = getTestPrismaClient();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
let counter = 0;
let consoleCalls: unknown[][] = [];

const PROVIDER_SECRET = "SYNTH-PROVIDER-SECRET-Vt7Qw2";
const PROVIDER_TOKEN_ECHO = "SYNTH-ECHOED-TOKEN-h3Jr9";
const EVENT = "[staff] invitation email outcome";

async function newOrganization() {
  counter += 1;
  const organization = await prisma.organization.create({
    data: { slug: `staff-log-${suffix}-${counter}`, name: `Staff log ${counter}`, status: "ACTIVE", city: "Heredia", contactEmail: `staff-log-owner-${counter}-${suffix}@example.com` },
  });
  orgIds.push(organization.id);
  const academy = await prisma.academy.create({
    data: {
      organizationId: organization.id,
      name: `Staff log academy ${counter}`,
      slug: `staff-log-academy-${suffix}-${counter}`,
      kioskTokenHash: digestLookupSecret(`staff-log-kiosk-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
    },
  });
  const owner = await prisma.user.create({
    data: { email: organization.contactEmail!, passwordHash: await hashSecret("owner-password-123"), role: "ADMIN" },
  });
  userIds.push(owner.id);
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: organization.id, role: "ADMIN" } });
  currentSession = { user: { id: owner.id, role: "ADMIN" }, activeOrganizationId: organization.id };
  return { organizationId: organization.id, academyId: academy.id };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** A provider error body that echoes the recipient, the link and other fabricated secrets — the free text that must not escape. */
function providerErrorBody(recipient: string, link: string, name: string, statusCode: number) {
  return JSON.stringify({
    statusCode,
    name,
    message: `${PROVIDER_SECRET}: cannot send to ${recipient} (ref ${PROVIDER_TOKEN_ECHO}, body ${link})`,
  });
}

/** The real SDK's request, as the transport saw it — the recipient and the invitation link it carried. */
function sentRequest(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; html?: string };
  const recipient = Array.isArray(body.to) ? body.to[0] : String(body.to);
  const link = body.html?.match(/https?:\/\/[^\s"<]+accept-invitation\?token=[A-Za-z0-9_-]+/)?.[0] ?? "";
  return { recipient, link };
}

function stubTransport(respond: (recipient: string, link: string) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { recipient, link } = sentRequest(init);
    return respond(recipient, link);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Every captured console call is exactly the fixed event with allowlisted fields, and nothing sensitive appears anywhere. */
function expectOnlyFixedEvent(secrets: string[], expected: { organizationId: string; outcome: string; providerCode?: string }) {
  const captured = JSON.stringify(consoleCalls);
  for (const secret of [PROVIDER_SECRET, PROVIDER_TOKEN_ECHO, "[Resend API Error]", ...secrets]) {
    expect(secret.length).toBeGreaterThan(0);
    expect(captured, `console contains ${secret}`).not.toContain(secret);
  }
  expect(consoleCalls.length, "exactly one log line per failed send").toBe(1);
  for (const call of consoleCalls) {
    expect(call).toHaveLength(2);
    expect(call[0]).toBe(EVENT);
    // Keys that would survive a structured-log serializer; `providerCode: undefined` (no fixed code) is not a field.
    expect(Object.keys(JSON.parse(JSON.stringify(call[1]))).sort()).toEqual(Object.keys(expected).sort());
    expect(call[1]).toEqual(expected);
  }
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("staff invitation email logging through the real Resend SDK (fetch mocked)", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    it(`REQUIRED (NODE_ENV=${nodeEnv}): an invite the provider rejects with secret-bearing free text logs only the fixed event; issuance and the return value are unchanged`, async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const org = await newOrganization();
      const email = `staff-log-invitee-${nodeEnv}-${suffix}@example.com`;
      const fetchMock = stubTransport((recipient, link) => new Response(providerErrorBody(recipient, link, "validation_error", 422), { status: 422 }));

      const result = await inviteStaff(org.organizationId, {}, form({ email, role: "INSTRUCTOR", academyIds: org.academyId }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/emails");
      const sent = sentRequest(fetchMock.mock.calls[0][1]);
      expect(sent.recipient).toBe(email);
      expect(sent.link).not.toBe("");
      expect(result).toMatchObject({ ok: true, emailOutcome: "rejected", settlement: "settled" });
      const link = (result as { invitationLink: string }).invitationLink;
      expect(link).toBe(sent.link);
      expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email, usedAt: null, revokedAt: null } })).toBe(1);
      expectOnlyFixedEvent([email, link, tokenOf(link)], { organizationId: org.organizationId, outcome: "rejected", providerCode: "validation_error" });
    });
  }

  it("REQUIRED: a resend hit by a provider-side error logs only 'unknown' + the fixed code; an unknown send leaves the earlier link live and returns the new one", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const org = await newOrganization();
    const email = `staff-log-resend-${suffix}@example.com`;
    stubTransport(() => new Response(JSON.stringify({ id: "synthetic-accepted" }), { status: 200 }));
    const first = await inviteStaff(org.organizationId, {}, form({ email, role: "DIRECTOR", academyIds: org.academyId }));
    expect(first).toMatchObject({ ok: true, emailOutcome: "accepted", settlement: "settled" });
    expect(consoleCalls, "an accepted send logs nothing").toEqual([]);
    const original = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email } });

    const fetchMock = stubTransport((recipient, link) => new Response(providerErrorBody(recipient, link, "internal_server_error", 500), { status: 500 }));
    const resent = await resendInvitation(org.organizationId, original.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resent).toMatchObject({ ok: true, emailOutcome: "unknown", settlement: "settled" });
    const newLink = (resent as { invitationLink: string }).invitationLink;
    const oldLink = (first as { invitationLink: string }).invitationLink;
    expect(newLink).not.toBe(oldLink);
    // An unknown outcome invalidates nothing (docs/STAFF_INVITATION_RESEND_PLAN.md D1).
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: original.id } })).revokedAt).toBeNull();
    expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email, usedAt: null, revokedAt: null } })).toBe(2);
    expectOnlyFixedEvent([email, newLink, tokenOf(newLink), oldLink, tokenOf(oldLink)], {
      organizationId: org.organizationId,
      outcome: "unknown",
      providerCode: "internal_server_error",
    });
  });

  it("REQUIRED: an unparseable error body and a network failure log only 'unknown'; nothing from the SDK or the thrown error escapes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const org = await newOrganization();

    const unparseableEmail = `staff-log-html-${suffix}@example.com`;
    stubTransport((recipient, link) => new Response(`<html>${PROVIDER_SECRET} ${recipient} ${link}</html>`, { status: 502 }));
    const unparseable = await inviteStaff(org.organizationId, {}, form({ email: unparseableEmail, role: "INSTRUCTOR", academyIds: org.academyId }));
    expect(unparseable).toMatchObject({ ok: true, emailOutcome: "unknown", settlement: "settled" });
    const unparseableLink = (unparseable as { invitationLink: string }).invitationLink;
    expectOnlyFixedEvent([unparseableEmail, unparseableLink, tokenOf(unparseableLink)], {
      organizationId: org.organizationId,
      outcome: "unknown",
      providerCode: "application_error",
    });

    consoleCalls = [];
    const networkEmail = `staff-log-network-${suffix}@example.com`;
    const failingFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { recipient, link } = sentRequest(init);
      throw new TypeError(`${PROVIDER_SECRET} connect ECONNREFUSED ${recipient} ${link}`);
    });
    vi.stubGlobal("fetch", failingFetch);
    const network = await inviteStaff(org.organizationId, {}, form({ email: networkEmail, role: "INSTRUCTOR", academyIds: org.academyId }));
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(network).toMatchObject({ ok: true, emailOutcome: "unknown", settlement: "settled" });
    const networkLink = (network as { invitationLink: string }).invitationLink;
    expectOnlyFixedEvent([networkEmail, networkLink, tokenOf(networkLink), "ECONNREFUSED"], {
      organizationId: org.organizationId,
      outcome: "unknown",
      providerCode: "application_error",
    });
  });

  it("REQUIRED (NODE_ENV=production): the application's own line carries no provider text either — the SDK is silent there by itself", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const org = await newOrganization();
    const email = `staff-log-prod-${suffix}@example.com`;
    stubTransport((recipient, link) => new Response(providerErrorBody(recipient, link, "validation_error", 422), { status: 422 }));

    const result = await inviteStaff(org.organizationId, {}, form({ email, role: "INSTRUCTOR", academyIds: org.academyId }));

    const link = (result as { invitationLink: string }).invitationLink;
    expectOnlyFixedEvent([email, link, tokenOf(link)], { organizationId: org.organizationId, outcome: "rejected", providerCode: "validation_error" });
  });

  it("an unconfigured provider makes no request and logs only 'not_configured' — no environment detail", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const org = await newOrganization();
    const email = `staff-log-unconfigured-${suffix}@example.com`;
    const fetchMock = stubTransport(() => new Response("{}", { status: 200 }));

    const result = await inviteStaff(org.organizationId, {}, form({ email, role: "INSTRUCTOR", academyIds: org.academyId }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, emailOutcome: "not_configured", settlement: "settled" });
    const link = (result as { invitationLink: string }).invitationLink;
    expectOnlyFixedEvent([email, link, tokenOf(link), "RESEND_API_KEY"], { organizationId: org.organizationId, outcome: "not_configured" });
  });
});
