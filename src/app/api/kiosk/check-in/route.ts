import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { finalizeKioskAttempt, reserveKioskAttempt } from "@/lib/kiosk/rate-limit";
import { performCheckIn } from "@/lib/kiosk/perform-check-in";
import { resolveAttendanceInstant } from "@/lib/kiosk/queued-at";

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
  let body: { academySlug?: unknown; token?: unknown; code?: unknown; queuedAt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token, code, queuedAt } = body;
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

  // Step 3: best-effort audit metadata only. `x-forwarded-for` is
  // client-supplied and is NOT part of the rate-limit key — see
  // `reserveKioskAttempt`, which keys on the verified token digest above.
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : "unknown";

  // Step 4: the atomic gate, BEFORE the submitted code is evaluated. A
  // rejected caller never reaches performCheckIn, so a flood of concurrent
  // guesses can't race past the limiter to find a working code.
  const reservation = await reserveKioskAttempt(academy.id, presentedHash, ipAddress);
  if (!reservation.allowed) {
    return NextResponse.json(
      { ok: false, error: reservation.reason, retryAfterSeconds: reservation.retryAfterSeconds },
      { status: 429 },
    );
  }

  // Step 5: run the actual check-in, against the real attendance instant.
  const result = await performCheckIn({
    academyId: academy.id,
    code,
    source: "KIOSK",
    now: resolveAttendanceInstant(queuedAt),
  });

  // Step 6: record this attempt's real outcome against the row already
  // reserved in step 4. (No reconciliation branch is needed here any more:
  // with the gate ahead of the guess there is no longer a case where a real,
  // committed check-in could be hidden behind a rate-limit rejection.)
  await finalizeKioskAttempt(reservation.attemptId, result.ok);

  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }

  // invalid_code / no_active_class / already_checked_in are all client-side,
  // pre-condition-not-met failures — no need for finer-grained status codes
  // on an internal API with only two consumers (Tasks 6 and 7), both of
  // which branch on the `error` field, not the HTTP status.
  return NextResponse.json(result, { status: 400 });
}
