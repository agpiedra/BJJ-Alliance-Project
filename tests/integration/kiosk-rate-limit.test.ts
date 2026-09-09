import "dotenv/config";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";

const { reserveKioskAttempt, finalizeKioskAttempt } = await import("../../src/lib/kiosk/rate-limit");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

let escazuId: string;
let otherAcademyId: string;

beforeAll(async () => {
  const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
  escazuId = escazu.id;
  const other = await prisma.academy.findFirstOrThrow({ where: { slug: { not: "escazu" } } });
  otherAcademyId = other.id;
});

/**
 * The rate-limit key is now the VERIFIED kiosk token's digest, not the
 * caller's (spoofable) IP. These are synthetic digests carrying a shared
 * prefix so the suite can clean up after itself without touching either
 * academy's real `kioskTokenHash` or any other test's rows.
 */
const TEST_HASH_PREFIX = "test-token-hash-";

function uniqueTokenHash(tag: string) {
  return `${TEST_HASH_PREFIX}${tag}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** IP is audit-only metadata now — deliberately the same constant everywhere. */
const AUDIT_IP = "203.0.113.7";

afterEach(async () => {
  await prisma.kioskAttempt.deleteMany({ where: { kioskTokenHash: { startsWith: TEST_HASH_PREFIX } } });
});

function countAttempts(kioskTokenHash: string, academyId = escazuId) {
  return prisma.kioskAttempt.count({ where: { academyId, kioskTokenHash } });
}

describe("kiosk rate limiting (reserve/finalize, keyed on the kiosk token digest)", () => {
  it("allows a fresh token with no prior attempts, and reserves a provisional failure row", async () => {
    const hash = uniqueTokenHash("fresh");

    const reservation = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);

    expect(reservation.allowed).toBe(true);
    if (!reservation.allowed) return;

    const row = await prisma.kioskAttempt.findUniqueOrThrow({ where: { id: reservation.attemptId } });
    // Reserved BEFORE the code is evaluated, so it starts out as a failure —
    // the gate is genuinely in front of the guess.
    expect(row.success).toBe(false);
    expect(row.kioskTokenHash).toBe(hash);
    expect(row.ipAddress).toBe(AUDIT_IP);
  });

  it("finalizeKioskAttempt(true) upgrades that exact row; finalize(false) leaves it a failure", async () => {
    const hash = uniqueTokenHash("finalize");

    const success = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(success.allowed).toBe(true);
    if (!success.allowed) return;
    await finalizeKioskAttempt(success.attemptId, true);
    expect((await prisma.kioskAttempt.findUniqueOrThrow({ where: { id: success.attemptId } })).success).toBe(true);

    const failure = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(failure.allowed).toBe(true);
    if (!failure.allowed) return;
    await finalizeKioskAttempt(failure.attemptId, false);
    expect((await prisma.kioskAttempt.findUniqueOrThrow({ where: { id: failure.attemptId } })).success).toBe(false);
  });

  it("never rate-limits a burst of SUCCESSFUL check-ins — a class rush on one shared tablet", async () => {
    const hash = uniqueTokenHash("class-rush");
    const BURST = 15; // comfortably past both the old 10/60s ceiling and the 5-failure lockout

    for (let i = 0; i < BURST; i++) {
      const reservation = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
      expect(reservation.allowed).toBe(true);
      if (!reservation.allowed) return;
      await finalizeKioskAttempt(reservation.attemptId, true);
    }

    // And the very next student still gets through.
    const next = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(next.allowed).toBe(true);

    expect(await countAttempts(hash)).toBe(BURST + 1);
  });

  it("locks out after exactly 5 FAILURES within 60s, and successes in between don't bring it forward", async () => {
    const hash = uniqueTokenHash("lockout");

    // 4 failures interleaved with 3 successes: 7 attempts, still under the
    // failure threshold, so nothing is blocked yet.
    for (const isSuccess of [false, true, false, true, false, true, false]) {
      const reservation = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
      expect(reservation.allowed).toBe(true);
      if (!reservation.allowed) return;
      await finalizeKioskAttempt(reservation.attemptId, isSuccess);
    }

    // The 5th failure is itself allowed (it's the one that trips the lockout).
    const fifth = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(fifth.allowed).toBe(true);
    if (!fifth.allowed) return;
    await finalizeKioskAttempt(fifth.attemptId, false);

    const blocked = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.reason).toBe("locked_out");
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("logs a BLOCKED attempt too — spec §4.1's 'log every failed attempt' covers lockout traffic", async () => {
    const hash = uniqueTokenHash("log-blocked");
    await prisma.kioskAttempt.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        academyId: escazuId,
        kioskTokenHash: hash,
        ipAddress: AUDIT_IP,
        success: false,
        createdAt: new Date(Date.now() - (5 - i) * 1000),
      })),
    });

    const blocked = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(blocked.allowed).toBe(false);

    // 5 seeded + the rejected one, which must NOT be silently dropped.
    expect(await countAttempts(hash)).toBe(6);
  });

  it("lets the window slide: failures older than 60s no longer lock the key out", async () => {
    const hash = uniqueTokenHash("sliding");
    const wellOutsideWindow = Date.now() - 120_000;
    await prisma.kioskAttempt.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        academyId: escazuId,
        kioskTokenHash: hash,
        ipAddress: AUDIT_IP,
        success: false,
        createdAt: new Date(wellOutsideWindow + i * 1000),
      })),
    });

    const reservation = await reserveKioskAttempt(escazuId, hash, AUDIT_IP);
    expect(reservation.allowed).toBe(true);
  });

  it("caps allowed attempts at 5 under concurrent load — the gate holds before any guess is evaluated", async () => {
    const hash = uniqueTokenHash("concurrency");
    const CONCURRENT_CALLS = 20;

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CALLS }, () => reserveKioskAttempt(escazuId, hash, AUDIT_IP)),
    );

    const allowed = results.filter((r) => r.allowed);
    const lockedOut = results.filter((r) => !r.allowed && r.reason === "locked_out");
    expect(allowed).toHaveLength(5);
    expect(allowed.length + lockedOut.length).toBe(CONCURRENT_CALLS);

    // Every attempt — allowed or blocked — is on the record.
    expect(await countAttempts(hash)).toBe(CONCURRENT_CALLS);
    // ...and every reserved id is distinct, so no two callers can finalize the same row.
    const ids = new Set(allowed.map((r) => (r.allowed ? r.attemptId : "")));
    expect(ids.size).toBe(5);
  });

  it("scopes per (academy, kiosk token): a different token, or the same token at another academy, is unaffected", async () => {
    const lockedHash = uniqueTokenHash("scope-locked");
    for (let i = 0; i < 5; i++) {
      const reservation = await reserveKioskAttempt(escazuId, lockedHash, AUDIT_IP);
      expect(reservation.allowed).toBe(true);
      if (!reservation.allowed) return;
      await finalizeKioskAttempt(reservation.attemptId, false);
    }
    const lockedOut = await reserveKioskAttempt(escazuId, lockedHash, AUDIT_IP);
    expect(lockedOut.allowed).toBe(false);

    // A different kiosk token at the same academy is unaffected.
    const otherHash = uniqueTokenHash("scope-other-token");
    expect((await reserveKioskAttempt(escazuId, otherHash, AUDIT_IP)).allowed).toBe(true);

    // The same token hash at a different academy is unaffected.
    expect((await reserveKioskAttempt(otherAcademyId, lockedHash, AUDIT_IP)).allowed).toBe(true);
  });

  it("is NOT keyed on the caller-supplied IP — rotating it per request no longer evades the counter", async () => {
    const hash = uniqueTokenHash("ip-rotation");

    for (let i = 0; i < 5; i++) {
      const reservation = await reserveKioskAttempt(escazuId, hash, `198.51.100.${i}`);
      expect(reservation.allowed).toBe(true);
      if (!reservation.allowed) return;
      await finalizeKioskAttempt(reservation.attemptId, false);
    }

    // A brand-new IP, same token: still locked out.
    const blocked = await reserveKioskAttempt(escazuId, hash, "198.51.100.250");
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.reason).toBe("locked_out");
  });
});
