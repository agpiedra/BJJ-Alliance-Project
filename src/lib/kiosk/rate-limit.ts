import { prisma } from "@/lib/prisma";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const LOCKOUT_FAILURE_THRESHOLD = 5;
const LOCKOUT_SECONDS = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "locked_out"; retryAfterSeconds: number };

export async function checkKioskRateLimit(academyId: string, ipAddress: string): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);

  const recentAttempts = await prisma.kioskAttempt.findMany({
    where: { academyId, ipAddress, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "asc" },
    select: { success: true, createdAt: true },
  });

  if (recentAttempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldestInWindow = recentAttempts[0].createdAt;
    const retryAfterSeconds = Math.max(
      1,
      RATE_LIMIT_WINDOW_SECONDS - Math.floor((Date.now() - oldestInWindow.getTime()) / 1000),
    );
    return { allowed: false, reason: "rate_limited", retryAfterSeconds };
  }

  const recentFailures = recentAttempts.filter((a) => !a.success);
  if (recentFailures.length >= LOCKOUT_FAILURE_THRESHOLD) {
    const fifthFailure = recentFailures[LOCKOUT_FAILURE_THRESHOLD - 1].createdAt;
    const lockoutEndsAt = fifthFailure.getTime() + LOCKOUT_SECONDS * 1000;
    if (Date.now() < lockoutEndsAt) {
      return {
        allowed: false,
        reason: "locked_out",
        retryAfterSeconds: Math.ceil((lockoutEndsAt - Date.now()) / 1000),
      };
    }
  }

  return { allowed: true };
}

export async function recordKioskAttempt(academyId: string, ipAddress: string, success: boolean): Promise<void> {
  await prisma.kioskAttempt.create({ data: { academyId, ipAddress, success } });
}
