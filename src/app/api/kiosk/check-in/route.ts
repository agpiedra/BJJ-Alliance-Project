import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAcademyBySlug } from "@/lib/tenant/platform-lookups";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { finalizeKioskAttempt, reserveKioskAttempt } from "@/lib/kiosk/rate-limit";
import { performCheckIn } from "@/lib/kiosk/perform-check-in";
import { resolveAttendanceInstant } from "@/lib/kiosk/queued-at";
import type { KioskContext } from "@/lib/tenant/types";

// This route touches Prisma (via performCheckIn / rate-limit.ts), which
// requires the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * Response contract for Tasks 6 (kiosk page) and 7 (offline-replay queue):
 *
 *   200  { ok: true; student: {...}; summary: AtBeltSummary; thresholdReached: boolean; progressOutcome: "counted" | "already_counted_today" | "not_promotion_class"; isVisitor: boolean }
 *   400  { ok: false; error: "invalid_code" | "no_active_class" | "already_checked_in" }
 *   401  { ok: false; error: "invalid_token" }               (bad kiosk token — same generic
 *                                                              shape as academy-not-found, see below)
 *   403  { ok: false; error: "org_unavailable" }              (organization is PENDING, SUSPENDED,
 *                                                              or CANCELLED — same generic shape for
 *                                                              all three; never discloses which)
 *   404  { ok: false; error: "invalid_token" }               (unknown academySlug — deliberately
 *                                                              indistinguishable from a bad token)
 *   429  { ok: false; error: "rate_limited" | "locked_out"; retryAfterSeconds: number }
 */
export async function POST(request: Request) {
  let body: {
    academySlug?: unknown;
    token?: unknown;
    code?: unknown;
    queuedAt?: unknown;
    pickedClassSessionId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token, code, queuedAt, pickedClassSessionId } = body;
  if (typeof academySlug !== "string" || typeof token !== "string" || typeof code !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  // Optional; only its TYPE is checked here. Whether the id is actually one of
  // this academy's active classes for this weekday is re-validated inside
  // performCheckIn against a fresh query — never trusted from the client.
  if (pickedClassSessionId !== undefined && typeof pickedClassSessionId !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  // Step 1: look up the academy by slug — see platform-lookups.ts for why
  // this can never be scoped by the organization it exists to discover.
  // Not found is reported with the same generic shape as a bad token below,
  // so a caller can't tell which one failed.
  const academy = await resolveAcademyBySlug(academySlug);
  if (!academy) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 404 });
  }

  // Step 2: verify the presented kiosk token against the academy's stored hash.
  const presentedHash = digestLookupSecret(token, requireEnv("CODE_PEPPER"));
  if (presentedHash !== academy.kioskTokenHash) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 401 });
  }

  // Step 2.5: reject before any student-code resolution when the academy's
  // organization isn't ACTIVE (PENDING/SUSPENDED/CANCELLED) — spec's
  // "Suspended organization policy": the same generic error for all three,
  // disclosing nothing about billing state or code validity, enforced here
  // on the server rather than relying on a client-side check.
  const organization = await prisma.organization.findUnique({
    where: { id: academy.organizationId },
    select: { status: true },
  });
  if (!organization || organization.status !== "ACTIVE") {
    return NextResponse.json({ ok: false, error: "org_unavailable" }, { status: 403 });
  }

  // Step 3: best-effort audit metadata only. `x-forwarded-for` is
  // client-supplied and is NOT part of the rate-limit key — see
  // `reserveKioskAttempt`, which keys on the verified token digest above.
  //
  // Read off the `Request` rather than `next/headers`' `headers()`: they are
  // the same headers here (this route is excluded from the middleware matcher,
  // so nothing rewrites them upstream), but `headers()` throws outside a real
  // request scope, which made this handler impossible to call directly from an
  // integration test — and this is the exact seam the S2 brute-force-ordering
  // bug lived in twice.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : "unknown";

  // Step 4: the atomic gate, BEFORE the submitted code is evaluated. A
  // rejected caller never reaches performCheckIn, so a flood of concurrent
  // guesses can't race past the limiter to find a working code.
  const reservation = await reserveKioskAttempt(academy.id, academy.organizationId, presentedHash, ipAddress);
  if (!reservation.allowed) {
    return NextResponse.json(
      { ok: false, error: reservation.reason, retryAfterSeconds: reservation.retryAfterSeconds },
      { status: 429 },
    );
  }

  // Step 5: run the actual check-in, against the real attendance instant.
  // KioskContext is derived entirely from the verified device token above —
  // never from a session/cookie (MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C
  // proposal point 3: "the kiosk path resolves its organization only from
  // the verified branch token").
  const selection: { pickedClassSessionId: string; pickPolicy: "TODAY_ANY" } | { pickedClassSessionId?: undefined; pickPolicy?: undefined } =
    pickedClassSessionId !== undefined ? { pickedClassSessionId, pickPolicy: "TODAY_ANY" } : {};
  const kioskContext: KioskContext = { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
  const result = await performCheckIn({
    academyId: academy.id,
    context: kioskContext,
    code,
    source: "KIOSK",
    now: resolveAttendanceInstant(queuedAt),
    // The attended kiosk keeps its outside-window fallback (any of TODAY's classes): a selection is validated with
    // the TODAY_ANY policy and, when valid, is honored even if a different class also matches automatically.
    ...selection,
    // A `queuedAt` in the body means this is an offline replay from
    // `flushOfflineQueue`, not a live tap — nobody is at the tablet to answer
    // a picker, so an unmatched replay is saved as UNMATCHED rather than
    // returned as a picklist the queue would have to discard. See the
    // `unattended` doc comment in perform-check-in.ts for the full ruling.
    unattended: queuedAt !== undefined,
  });

  // Step 6: record this attempt's real outcome against the row already
  // reserved in step 4. The specific reason matters, not just ok/not-ok: only
  // `invalid_code` is a wrong-guess signal that may extend the lockout, while
  // `already_checked_in` and `no_active_class` mean the code was valid.
  // (No reconciliation branch is needed here any more: with the gate ahead of
  // the guess there is no longer a case where a real, committed check-in could
  // be hidden behind a rate-limit rejection.)
  await finalizeKioskAttempt(reservation.attemptId, academy.organizationId, result.ok ? "success" : result.error);

  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }

  // invalid_code / no_active_class / already_checked_in are all client-side,
  // pre-condition-not-met failures — no need for finer-grained status codes
  // on an internal API with only two consumers (Tasks 6 and 7), both of
  // which branch on the `error` field, not the HTTP status.
  return NextResponse.json(result, { status: 400 });
}
