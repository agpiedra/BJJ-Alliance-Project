import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * The REAL email paths for (1) the registration-confirmation email — registerOrganization → sendTransactionalEmail →
 * the `resend` SDK — and (2) staff notification dispatch — notifyNewSignup → ALL_CHANNELS (the real InAppChannel and
 * the real EmailChannel over a real `Resend` client) → dispatchNotification, plus the weekly digest's own construction
 * (`new EmailChannel(new Resend(…))`). Only the network transport (`fetch`) is replaced: no request leaves the machine.
 *
 * resend@6.27.0 prints the provider's raw error object (`console.error("[Resend API Error]:", …)`) whenever
 * NODE_ENV !== "production"; the provider's free-text message can echo the recipient, a link or a token. Every console
 * argument captured during a send is inspected: only the fixed event, the classified outcome and an allowlisted
 * provider code (plus the internal id each line already carried) may appear.
 */
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { notifyNewSignup } = await import("../../src/lib/notifications/notify-new-signup");
const { dispatchNotification } = await import("../../src/lib/notifications/dispatch");
const { EmailChannel } = await import("../../src/lib/notifications/email-channel");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const prisma = getTestPrismaClient();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let counter = 0;
const registeredOrgIds: string[] = [];
const notifyOrgIds: string[] = [];
const userIds: string[] = [];
const studentIds: string[] = [];
let consoleCalls: unknown[][] = [];

const PROVIDER_SECRET = "SYNTH-PROVIDER-SECRET-Rk2Ld8";
const PROVIDER_TOKEN_ECHO = "SYNTH-ECHOED-TOKEN-w6Np3";
const PROVIDER_LINK_ECHO = `https://synthetic.example.test/accept-invitation?token=${PROVIDER_TOKEN_ECHO}`;
const REGISTRATION_EVENT = "[register-academy] confirmation email outcome";
const NOTIFICATION_EVENT = "notification delivery failed";

/** A provider error body that echoes the recipient and fabricated link/token/secret free text — what must not escape. */
function providerErrorBody(recipient: string, name: string, statusCode: number) {
  return JSON.stringify({
    statusCode,
    name,
    message: `${PROVIDER_SECRET}: cannot send to ${recipient} (ref ${PROVIDER_TOKEN_ECHO}, see ${PROVIDER_LINK_ECHO})`,
  });
}

function recipientOf(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
  return Array.isArray(body.to) ? body.to[0] : String(body.to);
}

function stubTransport(respond: (recipient: string) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => respond(recipientOf(init)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubNetworkFailure() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    throw new TypeError(`${PROVIDER_SECRET} connect ECONNREFUSED ${recipientOf(init)} ${PROVIDER_LINK_ECHO}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Nothing sensitive appears in ANY captured console argument, and every call is exactly the fixed event + allowlisted fields. */
function expectOnlyFixedEvent(event: string, secrets: string[], expected: Record<string, string>) {
  const captured = JSON.stringify(consoleCalls);
  for (const secret of [PROVIDER_SECRET, PROVIDER_TOKEN_ECHO, PROVIDER_LINK_ECHO, "[Resend API Error]", ...secrets]) {
    expect(secret.length).toBeGreaterThan(0);
    expect(captured, `console contains ${secret}`).not.toContain(secret);
  }
  expect(consoleCalls.length, "exactly one log line per failed send").toBe(1);
  for (const call of consoleCalls) {
    expect(call).toHaveLength(2);
    expect(call[0]).toBe(event);
    // Keys that would survive a structured-log serializer; `providerCode: undefined` (no fixed code) is not a field.
    expect(Object.keys(JSON.parse(JSON.stringify(call[1]))).sort()).toEqual(Object.keys(expected).sort());
    expect(call[1]).toEqual(expected);
  }
}

beforeEach(async () => {
  consoleCalls = [];
  vi.stubEnv("RESEND_API_KEY", "re_synthetic_test_key");
  vi.stubEnv("EMAIL_FROM", "MATROOM <noreply@example.test>");
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  // Outside a request, registerOrganization rate-limits every call under ip="unknown" (see organization-registration.test.ts).
  await prisma.registrationAttempt.deleteMany({ where: { ip: "unknown" } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.registrationAttempt.deleteMany({ where: { ip: "unknown" } });
  await prisma.beltRank.deleteMany({ where: { organizationId: { in: registeredOrgIds } } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: registeredOrgIds } } });
  await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: registeredOrgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: registeredOrgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: registeredOrgIds } } });

  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.beltRank.deleteMany({ where: { organizationId: { in: notifyOrgIds } } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: notifyOrgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: notifyOrgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. Registration confirmation
// ---------------------------------------------------------------------------------------------------------------------

function registrationForm() {
  counter += 1;
  const fd = new FormData();
  const fields: Record<string, string> = {
    organizationName: `Email Log Academy ${suffix}-${counter}`,
    desiredSlug: `email-log-${suffix}-${counter}`,
    country: "Costa Rica",
    city: "Heredia",
    contactName: "Synthetic Contact",
    contactEmail: `email-log-contact-${counter}-${suffix}@example.com`,
    contactPhone: "88880000",
    studentCountBand: "1-25",
    preferredLocale: "es",
    termsAccepted: "on",
  };
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return { fd, email: fields.contactEmail, slug: fields.desiredSlug };
}

async function register() {
  const { fd, email, slug } = registrationForm();
  const result = await registerOrganization({}, fd);
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  registeredOrgIds.push(organization.id);
  return { result, email, organizationId: organization.id };
}

describe("registration-confirmation email logging (real helper + real Resend SDK, fetch mocked)", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    it(`REQUIRED (NODE_ENV=${nodeEnv}): a provider rejection with secret-bearing free text logs only the fixed event; registration still succeeds`, async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const fetchMock = stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error", 422), { status: 422 }));

      const { result, email, organizationId } = await register();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/emails");
      expect(recipientOf(fetchMock.mock.calls[0][1])).toBe(email);
      expect(result).toEqual({ ok: true });
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).status).toBe("PENDING");
      expectOnlyFixedEvent(REGISTRATION_EVENT, [email], { organizationId, outcome: "rejected", providerCode: "validation_error" });
    });
  }

  it("REQUIRED: a provider-side error and a network failure are 'unknown'; nothing from the SDK or the thrown error escapes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    stubTransport((recipient) => new Response(providerErrorBody(recipient, "internal_server_error", 500), { status: 500 }));
    const providerSide = await register();
    expect(providerSide.result).toEqual({ ok: true });
    expectOnlyFixedEvent(REGISTRATION_EVENT, [providerSide.email], {
      organizationId: providerSide.organizationId,
      outcome: "unknown",
      providerCode: "internal_server_error",
    });

    consoleCalls = [];
    const failingFetch = stubNetworkFailure();
    const network = await register();
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(network.result).toEqual({ ok: true });
    expectOnlyFixedEvent(REGISTRATION_EVENT, [network.email, "ECONNREFUSED"], {
      organizationId: network.organizationId,
      outcome: "unknown",
      providerCode: "application_error",
    });
  });

  it("REQUIRED (NODE_ENV=production): the application's own line carries no provider text — the SDK is silent there by itself", async () => {
    vi.stubEnv("NODE_ENV", "production");
    stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error", 422), { status: 422 }));

    const { result, email, organizationId } = await register();

    expect(result).toEqual({ ok: true });
    expectOnlyFixedEvent(REGISTRATION_EVENT, [email], { organizationId, outcome: "rejected", providerCode: "validation_error" });
  });

  it("an unconfigured provider makes no request and logs only 'not_configured' — no environment detail", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = stubTransport(() => new Response("{}", { status: 200 }));

    const { result, email, organizationId } = await register();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    expectOnlyFixedEvent(REGISTRATION_EVENT, [email, "RESEND_API_KEY"], { organizationId, outcome: "not_configured" });
  });

  it("an accepted send logs nothing", async () => {
    stubTransport(() => new Response(JSON.stringify({ id: "synthetic-accepted" }), { status: 200 }));
    const { result } = await register();
    expect(result).toEqual({ ok: true });
    expect(consoleCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Staff notification dispatch
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A fresh organization whose ONLY staff is one Owner — resolveStaffRecipients is organization-scoped, so the real
 * InAppChannel writes a Notification row for this fixture's Owner and nobody else's.
 */
async function newSignupFixture() {
  counter += 1;
  const organization = await prisma.organization.create({
    data: { slug: `email-log-notify-${suffix}-${counter}`, name: `Email log notify ${counter}`, status: "ACTIVE", city: "Heredia" },
  });
  notifyOrgIds.push(organization.id);
  const academy = await prisma.academy.create({
    data: {
      organizationId: organization.id,
      name: `Email log notify academy ${counter}`,
      slug: `email-log-notify-academy-${suffix}-${counter}`,
      kioskTokenHash: digestLookupSecret(`email-log-kiosk-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
    },
  });
  const owner = await prisma.user.create({
    data: { email: `email-log-owner-${counter}-${suffix}@example.com`, passwordHash: "x", role: "ADMIN", active: true, locale: "en" },
  });
  userIds.push(owner.id);
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: organization.id, role: "ADMIN" } });
  // A student's rank must belong to its own organization (composite FK), so a fresh organization needs its own.
  const rank = await prisma.beltRank.create({
    data: {
      organizationId: organization.id,
      track: "ADULT",
      code: "WHITE",
      labelEs: "Blanco",
      labelEn: "White",
      primaryColor: "#F0EBE0",
      barColor: "#111116",
      order: 0,
      maxStripes: 4,
      attendancesPerStripe: 30,
      attendancesForExam: 120,
      stripeColors: ["#000000", "#000000", "#000000", "#000000"],
      visibleStripeSlots: 4,
    },
  });
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academy.id,
      organizationId: organization.id,
      firstName: "Synthetic",
      lastName: `Signup${counter}`,
      phone: "8888-1111",
      email: `email-log-student-${counter}-${suffix}@example.com`,
      currentRankId: rank.id,
      currentStripes: 0,
      codeHash: await hashSecret(`email-log-code-${suffix}-${counter}`),
      status: "PENDING",
    },
  });
  studentIds.push(student.id);
  return { organizationId: organization.id, owner, student };
}

/** Drives the real trigger through the real ALL_CHANNELS and checks the in-app half is unaffected by the email outcome. */
async function notify(fixture: Awaited<ReturnType<typeof newSignupFixture>>) {
  await notifyNewSignup(fixture.student.id, fixture.organizationId);
  expect(await prisma.notification.count({ where: { userId: fixture.owner.id, type: "NEW_SIGNUP" } })).toBe(1);
}

describe("staff notification dispatch logging (real EmailChannel + real Resend SDK, fetch mocked)", () => {
  it("REQUIRED (NODE_ENV=development): a provider rejection through ALL_CHANNELS logs only the fixed event; the in-app notification is still written", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fixture = await newSignupFixture();
    const fetchMock = stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error", 422), { status: 422 }));

    await notify(fixture);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recipientOf(fetchMock.mock.calls[0][1])).toBe(fixture.owner.email);
    expectOnlyFixedEvent(NOTIFICATION_EVENT, [fixture.owner.email], {
      userId: fixture.owner.id,
      type: "NEW_SIGNUP",
      outcome: "rejected",
      providerCode: "validation_error",
    });
  });

  it("REQUIRED: an unparseable error body and a network failure log only 'unknown'; nothing from the SDK or the thrown error escapes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const unparseable = await newSignupFixture();
    stubTransport((recipient) => new Response(`<html>${PROVIDER_SECRET} ${recipient} ${PROVIDER_LINK_ECHO}</html>`, { status: 502 }));
    await notify(unparseable);
    expectOnlyFixedEvent(NOTIFICATION_EVENT, [unparseable.owner.email], {
      userId: unparseable.owner.id,
      type: "NEW_SIGNUP",
      outcome: "unknown",
      providerCode: "application_error",
    });

    consoleCalls = [];
    const network = await newSignupFixture();
    const failingFetch = stubNetworkFailure();
    await notify(network);
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expectOnlyFixedEvent(NOTIFICATION_EVENT, [network.owner.email, "ECONNREFUSED"], {
      userId: network.owner.id,
      type: "NEW_SIGNUP",
      outcome: "unknown",
      providerCode: "application_error",
    });
  });

  it("REQUIRED (NODE_ENV=production): the dispatch line carries no provider text", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = await newSignupFixture();
    stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error", 422), { status: 422 }));

    await notify(fixture);

    expectOnlyFixedEvent(NOTIFICATION_EVENT, [fixture.owner.email], {
      userId: fixture.owner.id,
      type: "NEW_SIGNUP",
      outcome: "rejected",
      providerCode: "validation_error",
    });
  });

  it("a missing sender address makes no request and logs only 'not_configured' — no environment detail", async () => {
    vi.stubEnv("EMAIL_FROM", "");
    const fixture = await newSignupFixture();
    const fetchMock = stubTransport(() => new Response("{}", { status: 200 }));

    await notify(fixture);

    expect(fetchMock).not.toHaveBeenCalled();
    expectOnlyFixedEvent(NOTIFICATION_EVENT, [fixture.owner.email, "EMAIL_FROM"], {
      userId: fixture.owner.id,
      type: "NEW_SIGNUP",
      outcome: "not_configured",
    });
  });

  it("REQUIRED (NODE_ENV=development): the weekly digest's own client construction — new EmailChannel(new Resend(key)) — is silenced too; counts unchanged", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const recipient = { userId: "synthetic-user-id", email: `email-log-digest-${suffix}@example.com`, locale: "en", organizationId: "synthetic-org-id" };
    stubTransport((to) => new Response(providerErrorBody(to, "validation_error", 422), { status: 422 }));

    const counts = await dispatchNotification(
      [recipient],
      { type: "WEEKLY_DIGEST", title: "Weekly digest", body: `Synthetic body ${PROVIDER_LINK_ECHO}` },
      [new EmailChannel(new Resend("re_synthetic_test_key"))],
    );

    expect(counts).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expectOnlyFixedEvent(NOTIFICATION_EVENT, [recipient.email], {
      userId: recipient.userId,
      type: "WEEKLY_DIGEST",
      outcome: "rejected",
      providerCode: "validation_error",
    });
  });
});
