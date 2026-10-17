import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md — infrastructure failures OUTSIDE the token transactions: request throttling,
 * account lookup, configuration, the preliminary token lookup and password hashing. Each failure is injected with an
 * error whose message carries distinctive synthetic secrets; every test checks the response, that nothing unintended
 * was written or sent, and that no synthetic secret reached the console.
 *
 * Injection is test-only: a Proxy around the app's Prisma client that can fail two specific lookups, a wrapper around
 * `hashSecret`, a temporary trigger in the isolated test database, and stubbed environment values.
 */
const SECRET = "SYNTH-INFRA-SECRET-v8Rk2";
let failUserLookup = false;
let failTokenLookup = false;
let failHash = false;

function syntheticError(kind: "plain" | "prisma") {
  return kind === "prisma"
    ? Object.assign(new Error(`${SECRET} connection to db failed`), { name: "PrismaClientKnownRequestError", code: "P1001" })
    : new Error(`${SECRET} unexpected`);
}

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prisma")>();
  const real = actual.prisma as unknown as Record<string | symbol, unknown>;
  const failingDelegate = (delegate: object, shouldFail: () => boolean, kind: "plain" | "prisma") =>
    new Proxy(delegate, {
      get(target, prop) {
        if (prop === "findUnique" && shouldFail()) return () => Promise.reject(syntheticError(kind));
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const prisma = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "user") return failingDelegate(value as object, () => failUserLookup, "plain");
      if (prop === "passwordResetToken") return failingDelegate(value as object, () => failTokenLookup, "prisma");
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...actual, prisma };
});

vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/crypto")>();
  return {
    ...actual,
    hashSecret: async (secret: string) => {
      if (failHash) throw new RangeError(`${SECRET} ${secret}`);
      return actual.hashSecret(secret);
    },
  };
});

const sendMock = vi.fn();
vi.mock("@/lib/email/send-transactional-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email/send-transactional-email")>()),
  sendTransactionalEmail: (...args: unknown[]) => sendMock(...args),
}));

const scheduledTasks: Array<() => Promise<void>> = [];
vi.mock("@/lib/after-response", () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    scheduledTasks.push(task);
    return true;
  },
}));

const { requestPasswordReset } = await import("../../src/app/[locale]/forgot-password/actions");
const { resetPassword } = await import("../../src/app/[locale]/reset-password/actions");
const { digestLookupSecret, hashSecret } = await import("../../src/lib/crypto");
const { resetThrottleKeys } = await import("../../src/lib/auth/password-reset-throttle");

const prisma = getTestPrismaClient();
const PEPPER = process.env.CODE_PEPPER as string;
const createdUserIds: string[] = [];
let consoleCalls: unknown[][] = [];

function uniq(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeUser() {
  const user = await prisma.user.create({
    data: { email: `pwreset-fail-${uniq()}@example.test`, passwordHash: await hashSecret("Original-Passw0rd"), role: "ADMIN" },
  });
  createdUserIds.push(user.id);
  return user;
}

async function makeToken(userId: string) {
  const raw = `raw-${uniq()}`;
  const token = await prisma.passwordResetToken.create({
    data: { userId, tokenHash: digestLookupSecret(raw, PEPPER), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return { raw, id: token.id };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function loggedEvents(): Array<Record<string, unknown>> {
  return consoleCalls.map((call) => call[1] as Record<string, unknown>);
}

function expectNoSecrets(...extra: string[]) {
  const captured = JSON.stringify(consoleCalls);
  for (const secret of [SECRET, ...extra]) expect(captured, `console contains ${secret}`).not.toContain(secret);
  for (const call of consoleCalls) expect(call[0]).toBe("[password-reset]");
}

async function expectNothingIssued(userId: string) {
  expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
  expect(scheduledTasks).toHaveLength(0);
  expect(sendMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  failUserLookup = false;
  failTokenLookup = false;
  failHash = false;
  scheduledTasks.length = 0;
  sendMock.mockReset();
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.passwordResetRequest.deleteMany({});
});

describe("request: failures stop the request and keep the response uniform", () => {
  it("REQUIRED: a throttle database failure fails closed — uniform response, no throttle row, no token, no email", async () => {
    const user = await makeUser();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pwreset_test_block_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION '${SECRET} throttle insert %', NEW."keyDigest"; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pwreset_test_block_insert BEFORE INSERT ON "PasswordResetRequest" FOR EACH ROW EXECUTE FUNCTION pwreset_test_block_insert()`);
    try {
      expect(await requestPasswordReset("en", {}, form({ email: user.email }))).toEqual({ ok: true });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pwreset_test_block_insert ON "PasswordResetRequest"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pwreset_test_block_insert()`);
    }
    await expectNothingIssued(user.id);
    expect(await prisma.passwordResetRequest.count({ where: { keyDigest: resetThrottleKeys(user.email, null).account } })).toBe(0);
    expect(loggedEvents()).toContainEqual(expect.objectContaining({ event: "password_reset.throttle_failed" }));
    expectNoSecrets(user.email);
  });

  it("REQUIRED: a throttle key that cannot be derived (missing pepper) also fails closed", async () => {
    const user = await makeUser();
    vi.stubEnv("CODE_PEPPER", "");
    expect(await requestPasswordReset("en", {}, form({ email: user.email }))).toEqual({ ok: true });
    vi.unstubAllEnvs();
    await expectNothingIssued(user.id);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.throttle_failed", error: "unrecognized_error" });
    expectNoSecrets(user.email);
  });

  it("REQUIRED: an account lookup failure stops the request — uniform response, no token, no email, sanitized code", async () => {
    const user = await makeUser();
    failUserLookup = true;
    expect(await requestPasswordReset("en", {}, form({ email: user.email }))).toEqual({ ok: true });
    failUserLookup = false;
    await expectNothingIssued(user.id);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.lookup_failed", error: "unrecognized_error" });
    expectNoSecrets(user.email);
  });

  it("REQUIRED: missing APP_URL for an existing account is caught — uniform response, no token, no email", async () => {
    const user = await makeUser();
    vi.stubEnv("APP_URL", "");
    expect(await requestPasswordReset("en", {}, form({ email: user.email }))).toEqual({ ok: true });
    vi.unstubAllEnvs();
    await expectNothingIssued(user.id);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.issue_failed", error: "unrecognized_error" });
    expectNoSecrets(user.email);
  });

  it("the same uniform response for an unknown address, so failures above are indistinguishable from it", async () => {
    expect(await requestPasswordReset("en", {}, form({ email: `nobody-${uniq()}@example.test` }))).toEqual({ ok: true });
  });
});

describe("redemption: infrastructure failures return resetFailed with no change; invalid tokens stay invalidToken", () => {
  it("REQUIRED: a preliminary token lookup failure → resetFailed, password and token untouched, Prisma code only", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    failTokenLookup = true;
    expect(await resetPassword({}, form({ token: token.raw, password: "Never-Applied-0" }))).toEqual({ error: "resetFailed" });
    failTokenLookup = false;
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    expect(after.passwordHash).toBe(user.passwordHash);
    expect(await prisma.passwordResetToken.count({ where: { id: token.id, usedAt: null } })).toBe(1);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.redeem_failed", stage: "lookup", error: "P1001" });
    expectNoSecrets(token.raw, "Never-Applied-0");
  });

  it("REQUIRED: a missing pepper during redemption → resetFailed, not invalidToken", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    vi.stubEnv("CODE_PEPPER", "");
    expect(await resetPassword({}, form({ token: token.raw, password: "Never-Applied-1" }))).toEqual({ error: "resetFailed" });
    vi.unstubAllEnvs();
    expect(await prisma.passwordResetToken.count({ where: { id: token.id, usedAt: null } })).toBe(1);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.redeem_failed", stage: "lookup", error: "unrecognized_error" });
    expectNoSecrets(token.raw, "Never-Applied-1");
  });

  it("REQUIRED: a hashing failure → resetFailed, password and token untouched, allow-listed class name only", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    failHash = true;
    expect(await resetPassword({}, form({ token: token.raw, password: "Never-Applied-2" }))).toEqual({ error: "resetFailed" });
    failHash = false;
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    expect(after.passwordHash).toBe(user.passwordHash);
    expect(await prisma.passwordResetToken.count({ where: { id: token.id, usedAt: null } })).toBe(1);
    expect(loggedEvents()).toContainEqual({ event: "password_reset.redeem_failed", stage: "hash", error: "RangeError" });
    expectNoSecrets(token.raw, "Never-Applied-2");
  });

  it("an ordinary unknown token is still invalidToken and logs nothing", async () => {
    expect(await resetPassword({}, form({ token: `unknown-${uniq()}`, password: "Whatever-Passw0rd" }))).toEqual({ error: "invalidToken" });
    expect(consoleCalls).toEqual([]);
  });
});
