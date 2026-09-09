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
    for (let i = 0; i < 10; i++) {
      await recordKioskAttempt(escazuId, ip, i % 2 === 0);
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
