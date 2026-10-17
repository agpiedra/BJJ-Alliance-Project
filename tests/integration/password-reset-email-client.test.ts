import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { hashSecret } from "../../src/lib/crypto";

/**
 * The REAL email-client path for a password-reset send: requestPasswordResetCore → after-response step →
 * sendTransactionalEmail → the real `resend` SDK. Only the network transport (`fetch`) is replaced, so the SDK's own
 * request building, error parsing and error logging all run. No request leaves the machine.
 *
 * resend@6.27.0 prints the provider's raw error object whenever NODE_ENV !== "production" (vitest runs with "test"),
 * so these tests fail if that output ever reaches the console during a reset send.
 */
const scheduledTasks: Array<() => Promise<void>> = [];
vi.mock("@/lib/after-response", () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    scheduledTasks.push(task);
    return true;
  },
}));

const { requestPasswordResetCore } = await import("../../src/lib/auth/password-reset");
const { sendTransactionalEmail } = await import("../../src/lib/email/send-transactional-email");

const prisma = getTestPrismaClient();
const createdUserIds: string[] = [];
let consoleCalls: unknown[][] = [];

const PROVIDER_SECRET = "SYNTH-PROVIDER-SECRET-K4q9Zm";
const PROVIDER_TOKEN_ECHO = "SYNTH-ECHOED-TOKEN-p2Lx8";

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      email: `pwreset-client-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.test`,
      passwordHash: await hashSecret("Original-Passw0rd"),
      role: "ADMIN",
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** A provider error body that echoes the recipient and other synthetic secrets — the free text that must not escape. */
function providerErrorBody(recipient: string, name: string) {
  return JSON.stringify({
    statusCode: 422,
    name,
    message: `${PROVIDER_SECRET}: cannot send to ${recipient} (ref ${PROVIDER_TOKEN_ECHO})`,
  });
}

function stubTransport(respond: (recipient: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    return respond(Array.isArray(body.to) ? body.to[0] : String(body.to));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  scheduledTasks.length = 0;
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
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.passwordResetRequest.deleteMany({});
});

async function runResetSend(recipientUser: { email: string }) {
  await requestPasswordResetCore({ email: recipientUser.email, locale: "en", ip: null });
  expect(scheduledTasks).toHaveLength(1);
  await scheduledTasks.pop()!();
}

function expectNothingEscaped(recipient: string, fetchMock: ReturnType<typeof stubTransport>) {
  const captured = JSON.stringify(consoleCalls);
  const sentBody = String(fetchMock.mock.calls[0][1]?.body ?? "");
  const link = (JSON.parse(sentBody) as { html: string }).html.match(/https?:\/\/[^\s"<]+reset-password\?token=[A-Za-z0-9_-]+/)?.[0];
  expect(link, "the real SDK request carried the reset link").toBeDefined();
  for (const secret of [PROVIDER_SECRET, PROVIDER_TOKEN_ECHO, recipient, link!, "[Resend API Error]"]) {
    expect(captured, `console contains ${secret}`).not.toContain(secret);
  }
  for (const call of consoleCalls) expect(call[0]).toBe("[password-reset]");
}

describe("password-reset send through the real Resend SDK (fetch mocked)", () => {
  it("REQUIRED: a provider rejection with secret-bearing free text logs only the fixed event; nothing from the provider escapes", async () => {
    const user = await makeUser();
    const fetchMock = stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error"), { status: 422 }));

    await runResetSend(user);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/emails");
    expectNothingEscaped(user.email, fetchMock);
    expect(consoleCalls).toContainEqual(["[password-reset]", { event: "password_reset.email", outcome: "rejected", providerCode: "validation_error" }]);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(0);
  });

  it("REQUIRED: a provider-side error is 'unknown', keeps the token, and still logs nothing from the provider", async () => {
    const user = await makeUser();
    const fetchMock = stubTransport((recipient) => new Response(providerErrorBody(recipient, "internal_server_error"), { status: 500 }));

    await runResetSend(user);

    expectNothingEscaped(user.email, fetchMock);
    expect(consoleCalls).toContainEqual(["[password-reset]", { event: "password_reset.email", outcome: "unknown", providerCode: "internal_server_error" }]);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
  });

  it("REQUIRED: an unparseable error body and a network failure are 'unknown' and log nothing from the SDK", async () => {
    const unparseable = await makeUser();
    const fetchMock = stubTransport((recipient) => new Response(`<html>${PROVIDER_SECRET} ${recipient}</html>`, { status: 502 }));
    await runResetSend(unparseable);
    expectNothingEscaped(unparseable.email, fetchMock);

    consoleCalls = [];
    const network = await makeUser();
    const failingFetch = vi.fn(async () => {
      throw new TypeError(`${PROVIDER_SECRET} connect ECONNREFUSED ${network.email}`);
    });
    vi.stubGlobal("fetch", failingFetch);
    await runResetSend(network);
    expect(failingFetch).toHaveBeenCalledTimes(1);
    const captured = JSON.stringify(consoleCalls);
    for (const secret of [PROVIDER_SECRET, network.email, "[Resend API Error]"]) expect(captured).not.toContain(secret);
    expect(consoleCalls).toContainEqual(["[password-reset]", { event: "password_reset.email", outcome: "unknown", providerCode: "application_error" }]);
  });

  it("existing callers are unchanged: without the option, the SDK still prints its own error output (the behavior the reset path now suppresses)", async () => {
    stubTransport((recipient) => new Response(providerErrorBody(recipient, "validation_error"), { status: 422 }));

    const result = await sendTransactionalEmail("someone@example.test", "subject", ["line"]);

    expect(result).toMatchObject({ success: false, outcome: "rejected", providerCode: "validation_error" });
    expect(consoleCalls.some((call) => call[0] === "[Resend API Error]:")).toBe(true);
  });
});
