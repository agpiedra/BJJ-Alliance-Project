import "dotenv/config";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";

const { checkKioskRateLimit, recordKioskAttempt } = await import("../../src/lib/kiosk/rate-limit");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

let escazuId: string;

beforeAll(async () => {
  const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
  escazuId = escazu.id;
});

function uniqueIp(tag: string) {
  return `10.99.${Math.floor(Math.random() * 255)}.${Date.now() % 255}-${tag}`;
}

afterEach(async () => {
  await prisma.kioskAttempt.deleteMany({ where: { ipAddress: { startsWith: "10.99." } } });
});

describe("kiosk rate limiting", () => {
  it("allows a fresh IP with no prior attempts", async () => {
    const ip = uniqueIp("fresh");
    const result = await checkKioskRateLimit(escazuId, ip);
    expect(result).toEqual({ allowed: true });
  });

  it("rate-limits after 10 attempts (any mix of success/fail) within the window", async () => {
    const ip = uniqueIp("ratelimit");
    // Keep failures under the lockout threshold (5) so this exercises the rate-limit path in
    // isolation; the precedence between the two conditions is covered separately below.
    for (let i = 0; i < 10; i++) {
      await recordKioskAttempt(escazuId, ip, i < 6);
    }
    const result = await checkKioskRateLimit(escazuId, ip);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("rate_limited");
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("locks out after exactly 5 failures (fewer than 10 total attempts) within 60s", async () => {
    const ip = uniqueIp("lockout");
    for (let i = 0; i < 5; i++) {
      await recordKioskAttempt(escazuId, ip, false);
    }
    const result = await checkKioskRateLimit(escazuId, ip);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("locked_out");
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("prefers locked_out over rate_limited when both conditions apply simultaneously", async () => {
    const ip = uniqueIp("precedence");
    const now = Date.now();
    // 5 failures + 3 successes + 2 more failures = 10 attempts within the window, with 7 of
    // them failures — both the >=10-total and >=5-failures conditions are true. Seeded
    // directly (bypassing recordKioskAttempt's own gating, which would otherwise refuse to
    // insert once locked out) so this test only exercises the reason-precedence decision.
    const successPattern = [false, false, false, false, false, true, true, true, false, false];
    await prisma.kioskAttempt.createMany({
      data: successPattern.map((success, i) => ({
        academyId: escazuId,
        ipAddress: ip,
        success,
        createdAt: new Date(now - (successPattern.length - i) * 1000),
      })),
    });

    const result = await checkKioskRateLimit(escazuId, ip);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("locked_out");
    }
  });

  it("never records more than 5 attempts as allowed under concurrent load before lockout engages", async () => {
    const ip = uniqueIp("concurrency");
    const CONCURRENT_CALLS = 15;

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CALLS }, () => recordKioskAttempt(escazuId, ip, false)),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const lockedOutCount = results.filter((r) => !r.allowed && r.reason === "locked_out").length;
    expect(allowedCount).toBeLessThanOrEqual(5);
    expect(allowedCount + lockedOutCount).toBe(CONCURRENT_CALLS);

    // The atomic gate must also have refused to insert once locked out, not merely reported it.
    const recordedCount = await prisma.kioskAttempt.count({ where: { academyId: escazuId, ipAddress: ip } });
    expect(recordedCount).toBe(allowedCount);
    expect(recordedCount).toBeLessThanOrEqual(5);
  });

  it("scopes rate limiting per academy+IP: a different IP or a different academy is unaffected", async () => {
    const lockedIp = uniqueIp("scope-locked");
    for (let i = 0; i < 5; i++) {
      await recordKioskAttempt(escazuId, lockedIp, false);
    }
    const lockedResult = await checkKioskRateLimit(escazuId, lockedIp);
    expect(lockedResult.allowed).toBe(false);

    // A different IP at the same academy is unaffected.
    const otherIp = uniqueIp("scope-other-ip");
    const otherIpResult = await checkKioskRateLimit(escazuId, otherIp);
    expect(otherIpResult).toEqual({ allowed: true });

    // The same IP at a different academy is unaffected.
    const otherAcademy = await prisma.academy.findFirstOrThrow({ where: { slug: { not: "escazu" } } });
    const otherAcademyResult = await checkKioskRateLimit(otherAcademy.id, lockedIp);
    expect(otherAcademyResult).toEqual({ allowed: true });
  });
});
