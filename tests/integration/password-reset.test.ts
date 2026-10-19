import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import type { TransactionalEmailResult } from "../../src/lib/email/send-transactional-email";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md (rev 2) against the isolated test database. Email dispatch is MOCKED here: nothing is
 * sent anywhere, and nothing in this file proves delivery. `scheduleAfterResponse` is replaced so each after-response
 * task can be run (or refused) explicitly.
 *
 * Ordering tests are deterministic: a raw `pg` connection holds the user's row lock (`SELECT … FOR UPDATE`), the
 * operations under test are started and confirmed to be WAITING on that lock (pg_stat_activity), then the lock is
 * released. PostgreSQL grants a row lock's waiters in arrival order, so the operation started first runs first.
 */
const sendMock = vi.fn<(to: string, subject: string, lines: string[]) => Promise<TransactionalEmailResult>>();
vi.mock("@/lib/email/send-transactional-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email/send-transactional-email")>()),
  sendTransactionalEmail: (to: string, subject: string, lines: string[]) => sendMock(to, subject, lines),
}));

let scheduleAccepts = true;
const scheduledTasks: Array<() => Promise<void>> = [];
vi.mock("@/lib/after-response", () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    if (!scheduleAccepts) return false;
    scheduledTasks.push(task);
    return true;
  },
}));

let platformNameThrows = false;
vi.mock("@/lib/platform", () => ({
  get PLATFORM_NAME() {
    if (platformNameThrows) throw new Error("synthetic failure before the provider call");
    return "MATROOM";
  },
}));

const { requestPasswordReset } = await import("../../src/app/[locale]/forgot-password/actions");
const { resetPassword } = await import("../../src/app/[locale]/reset-password/actions");
const { requestPasswordResetCore, redeemPasswordResetToken, invalidateIssuedToken } = await import("../../src/lib/auth/password-reset");
const { resetThrottleKeys, sweepExpiredResetRequests, RESET_ACCOUNT_LIMIT, RESET_IP_LIMIT } = await import(
  "../../src/lib/auth/password-reset-throttle"
);
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");

const prisma = getTestPrismaClient();
const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 6 });
const PEPPER = process.env.CODE_PEPPER as string;

const createdUserIds: string[] = [];
let consoleCalls: unknown[][] = [];

function uniq(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeUser(opts: { active?: boolean } = {}) {
  const email = `pwreset-${uniq()}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashSecret("Original-Passw0rd"), role: "ADMIN", active: opts.active ?? true },
  });
  createdUserIds.push(user.id);
  return user;
}

/** A token row created directly, so tests control its raw value and expiry. */
async function makeToken(userId: string, opts: { expiresInMs?: number; used?: boolean } = {}) {
  const raw = `raw-${uniq()}`;
  const token = await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: digestLookupSecret(raw, PEPPER),
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000)),
      usedAt: opts.used ? new Date() : null,
    },
  });
  return { raw, id: token.id };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function passwordMatches(userId: string, password: string): Promise<boolean> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  return bcrypt.compare(password, user.passwordHash);
}

async function unusedTokenIds(userId: string): Promise<string[]> {
  const rows = await prisma.passwordResetToken.findMany({ where: { userId, usedAt: null }, select: { id: true } });
  return rows.map((row) => row.id);
}

/** Opens a transaction on a raw connection holding the user's row lock. */
async function holdUserLock(userId: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SELECT 1 FROM "User" WHERE "id" = $1 FOR UPDATE`, [userId]);
  return client;
}

async function release(client: PoolClient): Promise<void> {
  await client.query("COMMIT");
  client.release();
}

/** Waits until at least `count` sessions in this database are blocked on a lock. */
async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0].n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} lock waiter(s)`);
}

function accepted(): TransactionalEmailResult {
  return { success: true, outcome: "accepted" };
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(accepted());
  scheduleAccepts = true;
  scheduledTasks.length = 0;
  platformNameThrows = false;
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.passwordResetRequest.deleteMany({});
  await pool.end();
});

describe("request: uniform public response", () => {
  it("REQUIRED: unknown, inactive, active, throttled, unscheduled and every email outcome return the identical result", async () => {
    const active = await makeUser();
    const inactive = await makeUser({ active: false });
    const results: unknown[] = [];

    results.push(await requestPasswordReset("en", {}, form({ email: `nobody-${uniq()}@example.test` })));
    results.push(await requestPasswordReset("en", {}, form({ email: inactive.email })));
    results.push(await requestPasswordReset("en", {}, form({ email: active.email })));

    scheduleAccepts = false;
    const unscheduled = await makeUser();
    results.push(await requestPasswordReset("es", {}, form({ email: unscheduled.email })));
    scheduleAccepts = true;

    const throttled = await makeUser();
    for (let i = 0; i < RESET_ACCOUNT_LIMIT + 1; i++) {
      results.push(await requestPasswordReset("en", {}, form({ email: throttled.email })));
    }

    for (const outcome of ["accepted", "rejected", "unknown", "not_configured"] as const) {
      const user = await makeUser();
      results.push(await requestPasswordReset("en", {}, form({ email: user.email })));
      sendMock.mockResolvedValueOnce({ success: outcome === "accepted", outcome });
      await scheduledTasks.pop()!();
    }

    for (const result of results) expect(result).toEqual({ ok: true });
    expect(await requestPasswordReset("en", {}, form({ email: "not-an-email" }))).toEqual({ error: "invalidEmail" });
  });

  it("an inactive account gets no token and no email", async () => {
    const inactive = await makeUser({ active: false });
    await requestPasswordReset("en", {}, form({ email: inactive.email }));
    expect(await prisma.passwordResetToken.count({ where: { userId: inactive.id } })).toBe(0);
    expect(scheduledTasks).toHaveLength(0);
  });

  it("REQUIRED: each new request supersedes the previous link — one unused token per user", async () => {
    const user = await makeUser();
    await requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    const [first] = await unusedTokenIds(user.id);
    await requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    const unused = await unusedTokenIds(user.id);
    expect(unused).toHaveLength(1);
    expect(unused[0]).not.toBe(first);
  });
});

describe("request: throttling", () => {
  it(`REQUIRED: ${RESET_ACCOUNT_LIMIT + 7} concurrent requests for one account allow exactly ${RESET_ACCOUNT_LIMIT}`, async () => {
    const user = await makeUser();
    await Promise.all(Array.from({ length: RESET_ACCOUNT_LIMIT + 7 }, () => requestPasswordResetCore({ email: user.email, locale: "en", ip: null })));

    const keys = resetThrottleKeys(user.email, null);
    expect(await prisma.passwordResetRequest.count({ where: { keyKind: "email", keyDigest: keys.account } })).toBe(RESET_ACCOUNT_LIMIT);
    expect(scheduledTasks).toHaveLength(RESET_ACCOUNT_LIMIT);
    expect(await unusedTokenIds(user.id)).toHaveLength(1);
  });

  it(`REQUIRED: ${RESET_IP_LIMIT + 10} concurrent requests from one IP across different addresses allow exactly ${RESET_IP_LIMIT}`, async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${uniq()}`;
    await Promise.all(
      Array.from({ length: RESET_IP_LIMIT + 10 }, (_, i) => requestPasswordResetCore({ email: `nobody-${i}-${uniq()}@example.test`, locale: "en", ip })),
    );
    const keys = resetThrottleKeys("unused@example.test", ip);
    expect(await prisma.passwordResetRequest.count({ where: { keyKind: "ip", keyDigest: keys.ip! } })).toBe(RESET_IP_LIMIT);
  });

  it("REQUIRED: an address with no account is throttled exactly like a real one, and keys are never raw values", async () => {
    const email = `Nobody-${uniq()}@Example.test`;
    for (let i = 0; i < RESET_ACCOUNT_LIMIT + 2; i++) await requestPasswordResetCore({ email, locale: "en", ip: "203.0.113.9" });

    const keys = resetThrottleKeys(email.toLowerCase(), "203.0.113.9");
    expect(await prisma.passwordResetRequest.count({ where: { keyKind: "email", keyDigest: keys.account } })).toBe(RESET_ACCOUNT_LIMIT);
    const stored = JSON.stringify(await prisma.passwordResetRequest.findMany({ where: { keyDigest: { in: [keys.account, keys.ip!] } } }));
    expect(stored).not.toContain(email.toLowerCase());
    expect(stored).not.toContain("203.0.113.9");
  });
});

describe("request: bounded cleanup", () => {
  it("REQUIRED: each sweep removes at most 100 expired rows, oldest first, and never a recent row", async () => {
    await prisma.passwordResetRequest.deleteMany({});
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.passwordResetRequest.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({ keyKind: "email", keyDigest: `old-unique-${i}`, createdAt: new Date(old.getTime() - i * 1000) })),
    });
    await prisma.passwordResetRequest.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ keyKind: "email", keyDigest: `recent-${i}` })) });

    expect(await sweepExpiredResetRequests()).toBe(100);
    expect(await sweepExpiredResetRequests()).toBe(100);
    expect(await sweepExpiredResetRequests()).toBe(50);
    expect(await sweepExpiredResetRequests()).toBe(0);
    expect(await prisma.passwordResetRequest.count({ where: { keyDigest: { startsWith: "recent-" } } })).toBe(5);
  });

  // Verifies the createdAt index is USABLE for the sweep's candidate scan under a representative fixture with fresh
  // statistics — not that the production planner must always choose it. Without its own fixture this test inherited
  // whatever statistics earlier tests left; on a bloated heap the composite (keyKind, keyDigest, createdAt) index plus a
  // Sort costs within 0.01 of it and sometimes won — a valid plan returning the same rows
  // (docs/SWEEP_BOUND_INVESTIGATION.md §3). If the createdAt index were dropped or unusable, this still fails.
  it("the sweep's candidate scan can use the createdAt index (representative fixture, fresh statistics)", async () => {
    await prisma.passwordResetRequest.deleteMany({});
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.passwordResetRequest.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({ keyKind: i % 2 ? "ip" : "email", keyDigest: `plan-old-${i}`, createdAt: new Date(old.getTime() - i * 1000) })),
    });
    await prisma.passwordResetRequest.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({ keyKind: i % 2 ? "ip" : "email", keyDigest: `plan-recent-${i}` })),
    });
    await prisma.$executeRawUnsafe(`ANALYZE "PasswordResetRequest"`);
    try {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT "id" FROM "PasswordResetRequest" WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => 24) ORDER BY "createdAt" LIMIT 100`,
        );
      });
      expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("PasswordResetRequest_createdAt_idx");
    } finally {
      await prisma.passwordResetRequest.deleteMany({ where: { keyDigest: { startsWith: "plan-" } } });
      await prisma.$executeRawUnsafe(`ANALYZE "PasswordResetRequest"`);
    }
  });

  it("REQUIRED: a sweep failure is logged with an allow-listed code and does not change the response", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pwreset_test_block_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic sweep failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pwreset_test_block_delete BEFORE DELETE ON "PasswordResetRequest" FOR EACH ROW EXECUTE FUNCTION pwreset_test_block_delete()`);
    try {
      await prisma.passwordResetRequest.create({ data: { keyKind: "email", keyDigest: `expired-${uniq()}`, createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) } });
      expect(await requestPasswordReset("en", {}, form({ email: `nobody-${uniq()}@example.test` }))).toEqual({ ok: true });
      const entry = consoleCalls.find((call) => (call[1] as { event?: string })?.event === "password_reset.throttle_cleanup_failed");
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain("synthetic sweep failure");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pwreset_test_block_delete ON "PasswordResetRequest"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pwreset_test_block_delete()`);
    }
  });
});

describe("redemption", () => {
  it("a valid token sets the password once, consumes every open token, and the new password logs in", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    await makeToken(user.id);

    expect(await resetPassword({}, form({ token: token.raw, password: "Brand-New-Passw0rd" }))).toEqual({ ok: true });
    expect(await passwordMatches(user.id, "Brand-New-Passw0rd")).toBe(true);
    expect(await unusedTokenIds(user.id)).toEqual([]);
    expect(await verifyCredentials(user.email, "Brand-New-Passw0rd")).not.toBeNull();

    expect(await resetPassword({}, form({ token: token.raw, password: "Another-Passw0rd" }))).toEqual({ error: "invalidToken" });
  });

  it("REQUIRED: expired, used, unknown and inactive-account tokens are refused; the inactive token stays unused", async () => {
    const user = await makeUser();
    const expired = await makeToken(user.id, { expiresInMs: -1000 });
    const used = await makeToken(user.id, { used: true });
    const inactive = await makeUser({ active: false });
    const inactiveToken = await makeToken(inactive.id);

    for (const raw of [expired.raw, used.raw, `unknown-${uniq()}`, inactiveToken.raw]) {
      expect(await redeemPasswordResetToken({ rawToken: raw, newPassword: "Whatever-Passw0rd" })).toEqual({ ok: false, reason: "invalidToken" });
    }
    expect(await passwordMatches(user.id, "Original-Passw0rd")).toBe(true);
    expect(await unusedTokenIds(inactive.id)).toEqual([inactiveToken.id]);
  });

  it("REQUIRED: two concurrent redemptions of one token — exactly one succeeds, and exactly one password is stored", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    const gate = await holdUserLock(user.id);

    const first = redeemPasswordResetToken({ rawToken: token.raw, newPassword: "First-Passw0rd" });
    await waitForLockWaiters(1);
    const second = redeemPasswordResetToken({ rawToken: token.raw, newPassword: "Second-Passw0rd" });
    await waitForLockWaiters(2);
    await release(gate);

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: false, reason: "invalidToken" });
    expect(await passwordMatches(user.id, "First-Passw0rd")).toBe(true);
    expect(await passwordMatches(user.id, "Second-Passw0rd")).toBe(false);
  });

  it("REQUIRED: expiry is judged with fresh time after the lock — a token that expires while waiting is refused", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id, { expiresInMs: 1500 });
    const gate = await holdUserLock(user.id);

    const pending = redeemPasswordResetToken({ rawToken: token.raw, newPassword: "Late-Passw0rd" });
    await waitForLockWaiters(1); // the unlocked pre-check passed and bcrypt ran; now blocked on the user lock
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await release(gate);

    expect(await pending).toEqual({ ok: false, reason: "invalidToken" });
    expect(await passwordMatches(user.id, "Original-Passw0rd")).toBe(true);
    expect(await unusedTokenIds(user.id)).toEqual([token.id]);
  });

  it("REQUIRED: a failure after the token is consumed rolls everything back — password unchanged, token still unused", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pwreset_test_block_password() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure %', NEW."passwordHash"; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER pwreset_test_block_password BEFORE UPDATE OF "passwordHash" ON "User" FOR EACH ROW WHEN (NEW."id" = '${user.id}') EXECUTE FUNCTION pwreset_test_block_password()`,
    );
    try {
      expect(await redeemPasswordResetToken({ rawToken: token.raw, newPassword: "Never-Stored-Passw0rd" })).toEqual({ ok: false, reason: "failed" });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pwreset_test_block_password ON "User"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pwreset_test_block_password()`);
    }
    expect(await passwordMatches(user.id, "Original-Passw0rd")).toBe(true);
    expect(await unusedTokenIds(user.id)).toEqual([token.id]);

    const failure = consoleCalls.find((call) => (call[1] as { event?: string })?.event === "password_reset.redeem_failed");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("synthetic failure");
    expect(JSON.stringify(failure)).not.toContain("$2");
  });
});

describe("issuance versus redemption, deactivation versus redemption (lock-ordered)", () => {
  it("REQUIRED: issuance first — the older token is superseded and its redemption is refused", async () => {
    const user = await makeUser();
    const older = await makeToken(user.id);
    const gate = await holdUserLock(user.id);

    const issuance = requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    await waitForLockWaiters(1);
    const redemption = redeemPasswordResetToken({ rawToken: older.raw, newPassword: "Should-Not-Apply-0" });
    await waitForLockWaiters(2);
    await release(gate);

    await issuance;
    expect(await redemption).toEqual({ ok: false, reason: "invalidToken" });
    expect(await passwordMatches(user.id, "Original-Passw0rd")).toBe(true);
    const unused = await unusedTokenIds(user.id);
    expect(unused).toHaveLength(1);
    expect(unused[0]).not.toBe(older.id);
  });

  it("REQUIRED: redemption first — the password changes, then issuance creates one fresh valid token", async () => {
    const user = await makeUser();
    const older = await makeToken(user.id);
    const gate = await holdUserLock(user.id);

    const redemption = redeemPasswordResetToken({ rawToken: older.raw, newPassword: "Redeemed-First-0" });
    await waitForLockWaiters(1);
    const issuance = requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    await waitForLockWaiters(2);
    await release(gate);

    expect(await redemption).toEqual({ ok: true });
    await issuance;
    expect(await passwordMatches(user.id, "Redeemed-First-0")).toBe(true);
    const unused = await unusedTokenIds(user.id);
    expect(unused).toHaveLength(1);
    expect(unused[0]).not.toBe(older.id);
  });

  it("REQUIRED: deactivation committed first — redemption re-checks under the lock and refuses; nothing changes", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    const deactivation = await pool.connect();
    await deactivation.query("BEGIN");
    await deactivation.query(`UPDATE "User" SET "active" = false WHERE "id" = $1`, [user.id]);

    const redemption = redeemPasswordResetToken({ rawToken: token.raw, newPassword: "Should-Not-Apply-1" });
    await waitForLockWaiters(1);
    await release(deactivation);

    expect(await redemption).toEqual({ ok: false, reason: "invalidToken" });
    expect(await passwordMatches(user.id, "Original-Passw0rd")).toBe(true);
    expect(await unusedTokenIds(user.id)).toEqual([token.id]);
  });

  it("REQUIRED: redemption committed first — the password changes, then deactivation applies and login is refused", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    const gate = await holdUserLock(user.id);

    const redemption = redeemPasswordResetToken({ rawToken: token.raw, newPassword: "Redeemed-Then-Off-0" });
    await waitForLockWaiters(1);
    const deactivation = pool.query(`UPDATE "User" SET "active" = false WHERE "id" = $1`, [user.id]);
    await waitForLockWaiters(2);
    await release(gate);

    expect(await redemption).toEqual({ ok: true });
    await deactivation;
    expect(await passwordMatches(user.id, "Redeemed-Then-Off-0")).toBe(true);
    expect(await verifyCredentials(user.email, "Redeemed-Then-Off-0")).toBeNull();
  });
});

describe("after-response email step", () => {
  async function issueFor(user: { email: string }) {
    await requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    return scheduledTasks.pop()!;
  }

  it("REQUIRED: rejected and not_configured make that token unusable; unknown and accepted keep it valid", async () => {
    for (const [outcome, expectUsable] of [
      ["rejected", false],
      ["not_configured", false],
      ["unknown", true],
      ["accepted", true],
    ] as const) {
      const user = await makeUser();
      const task = await issueFor(user);
      sendMock.mockResolvedValueOnce({ success: outcome === "accepted", outcome, ...(outcome === "rejected" ? { providerCode: "validation_error" as const } : {}) });
      await task();
      expect(await unusedTokenIds(user.id), outcome).toHaveLength(expectUsable ? 1 : 0);
    }
  });

  it("REQUIRED: a send that cannot be scheduled leaves no usable token", async () => {
    const user = await makeUser();
    scheduleAccepts = false;
    await requestPasswordResetCore({ email: user.email, locale: "en", ip: null });
    expect(await unusedTokenIds(user.id)).toEqual([]);
    expect(consoleCalls.some((call) => (call[1] as { outcome?: string })?.outcome === "not_scheduled")).toBe(true);
  });

  it("REQUIRED: an exception before the provider call makes the token unusable; one after it started keeps it valid", async () => {
    const before = await makeUser();
    const beforeTask = await issueFor(before);
    platformNameThrows = true;
    await beforeTask();
    platformNameThrows = false;
    expect(sendMock).not.toHaveBeenCalled();
    expect(await unusedTokenIds(before.id)).toEqual([]);

    const after = await makeUser();
    const afterTask = await issueFor(after);
    sendMock.mockRejectedValueOnce(new Error("synthetic failure after the call started"));
    await afterTask();
    expect(await unusedTokenIds(after.id)).toHaveLength(1);

    const outcomes = consoleCalls.map((call) => (call[1] as { outcome?: string })?.outcome).filter(Boolean);
    expect(outcomes).toEqual(expect.arrayContaining(["not_attempted", "unknown"]));
  });

  it("REQUIRED: a late rejection for an older send never invalidates the newer request's token", async () => {
    const user = await makeUser();
    const olderTask = await issueFor(user);
    const newerTask = await issueFor(user);
    const [newerTokenId] = await unusedTokenIds(user.id);

    sendMock.mockResolvedValueOnce({ success: false, outcome: "rejected", providerCode: "validation_error" });
    await olderTask();
    expect(await unusedTokenIds(user.id)).toEqual([newerTokenId]);

    await newerTask();
    expect(await unusedTokenIds(user.id)).toEqual([newerTokenId]);
  });

  it("REQUIRED: a failed token cleanup is logged with an allow-listed code only, and the token stays redeemable", async () => {
    const user = await makeUser();
    const token = await makeToken(user.id);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pwreset_test_block_token() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic cleanup failure %', OLD."tokenHash"; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER pwreset_test_block_token BEFORE UPDATE ON "PasswordResetToken" FOR EACH ROW WHEN (OLD."id" = '${token.id}') EXECUTE FUNCTION pwreset_test_block_token()`,
    );
    try {
      await invalidateIssuedToken(token.id, false);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pwreset_test_block_token ON "PasswordResetToken"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pwreset_test_block_token()`);
    }
    const entry = consoleCalls.find((call) => (call[1] as { event?: string })?.event === "password_reset.token_cleanup_failed");
    expect(entry?.[1]).toMatchObject({ sendAttempted: false });
    expect(String((entry?.[1] as { error: string }).error)).toMatch(/^(P\d{4}|PrismaClient\w+|TypeError|RangeError|unrecognized_error)$/);
    expect(JSON.stringify(entry)).not.toContain("synthetic cleanup failure");
    expect(await unusedTokenIds(user.id)).toEqual([token.id]);
  });
});

describe("no secrets in logs or stored rows", () => {
  it("REQUIRED: a full request → send → redeem → throttled run never logs or stores the address, IP, link, token or password", async () => {
    const email = `synthetic.reset.Q7x9-${uniq()}@example.test`;
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashSecret("Original-Passw0rd"), role: "ADMIN" },
    });
    createdUserIds.push(user.id);
    const ip = "192.0.2.77";
    const password = "Synth-Passw0rd-ZqW8!";

    await requestPasswordResetCore({ email, locale: "en", ip });
    sendMock.mockResolvedValueOnce({ success: false, outcome: "unknown", providerCode: "application_error" });
    await scheduledTasks.pop()!();
    const sentLines = sendMock.mock.calls[0][2];
    const link = sentLines.find((line) => line.includes("/reset-password?token="))!;
    const rawToken = new URL(link).searchParams.get("token")!;
    expect(link).toContain("/en/reset-password?token=");

    expect(await resetPassword({}, form({ token: rawToken, password }))).toEqual({ ok: true });
    for (let i = 0; i < RESET_ACCOUNT_LIMIT + 1; i++) await requestPasswordResetCore({ email, locale: "en", ip });

    const logged = JSON.stringify(consoleCalls);
    const stored = JSON.stringify([
      await prisma.passwordResetRequest.findMany({ where: { keyDigest: { in: Object.values(resetThrottleKeys(email, ip)) as string[] } } }),
      await prisma.auditLog.findMany({ where: { OR: [{ actorId: user.id }, { entityId: user.id }] } }),
    ]);
    for (const secret of [email, email.toLowerCase(), ip, link, rawToken, password, user.id]) {
      expect(logged, `log contains ${secret}`).not.toContain(secret);
      expect(stored, `rows contain ${secret}`).not.toContain(secret);
    }
    expect(consoleCalls.length).toBeGreaterThan(0);
    for (const call of consoleCalls) expect(call[0]).toBe("[password-reset]");
  });
});
