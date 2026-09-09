import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { checkKioskRateLimit, recordKioskAttempt } from "@/lib/kiosk/rate-limit";
import { performCheckIn } from "@/lib/kiosk/perform-check-in";

// This route touches Prisma (via performCheckIn / rate-limit.ts), which
// requires the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * Response contract for Tasks 6 (kiosk page) and 7 (offline-replay queue):
 *
 *   200  { ok: true; student: {...}; summary: AtBeltSummary; earnedStripe: boolean; isVisitor: boolean }
 *   400  { ok: false; error: "invalid_code" | "no_active_class" | "already_checked_in" }
 *   401  { ok: false; error: "invalid_token" }               (bad kiosk token — same generic
 *                                                              shape as academy-not-found, see below)
 *   404  { ok: false; error: "invalid_token" }               (unknown academySlug — deliberately
 *                                                              indistinguishable from a bad token)
 *   429  { ok: false; error: "rate_limited" | "locked_out"; retryAfterSeconds: number }
 */
export async function POST(request: Request) {
  let body: { academySlug?: unknown; token?: unknown; code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token, code } = body;
  if (typeof academySlug !== "string" || typeof token !== "string" || typeof code !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  // Step 1: look up the academy by slug. Not found is reported with the same
  // generic shape as a bad token below, so a caller can't tell which one failed.
  const academy = await prisma.academy.findUnique({ where: { slug: academySlug } });
  if (!academy) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 404 });
  }

  // Step 2: verify the presented kiosk token against the academy's stored hash.
  const presentedHash = digestLookupSecret(token, requireEnv("CODE_PEPPER"));
  if (presentedHash !== academy.kioskTokenHash) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 401 });
  }

  // Step 3: extract the caller's IP for rate-limiting, keyed by (academyId, ipAddress).
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : "unknown";

  // Step 4: cheap pre-flight rate-limit check. A pure fast-fail optimization —
  // NOT the authoritative decision (see recordKioskAttempt below) — so a
  // request already over the threshold never even reaches performCheckIn.
  const preflight = await checkKioskRateLimit(academy.id, ipAddress);
  if (!preflight.allowed) {
    return NextResponse.json(
      { ok: false, error: preflight.reason, retryAfterSeconds: preflight.retryAfterSeconds },
      { status: 429 },
    );
  }

  // Step 5: run the actual check-in.
  const result = await performCheckIn({ academyId: academy.id, code, source: "KIOSK" });

  // Step 6: the atomic, authoritative rate-limit decision, recorded against
  // this attempt's real outcome.
  const atomicResult = await recordKioskAttempt(academy.id, ipAddress, result.ok);

  // Step 7: reconcile the two outcomes.
  if (!atomicResult.allowed) {
    if (result.ok) {
      // A real AttendanceRecord was already committed to the DB before the
      // atomic rate-limit gate rejected this attempt (it raced past the
      // preflight check but lost the atomic one). We must never contradict a
      // real DB write in the HTTP response — hiding a genuinely successful
      // check-in behind a rate-limit error would leave the student in a
      // confusing "did I check in or not" state. Return success as normal.
      return NextResponse.json(result, { status: 200 });
    }
    // No DB side effect to preserve: a failed/abusive attempt that has now
    // crossed the abuse threshold gets the more actionable "back off" signal
    // instead of its specific failure reason.
    return NextResponse.json(
      { ok: false, error: atomicResult.reason, retryAfterSeconds: atomicResult.retryAfterSeconds },
      { status: 429 },
    );
  }

  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }

  // invalid_code / no_active_class / already_checked_in are all client-side,
  // pre-condition-not-met failures — no need for finer-grained status codes
  // on an internal API with only two consumers (Tasks 6 and 7), both of
  // which branch on the `error` field, not the HTTP status.
  return NextResponse.json(result, { status: 400 });
}
