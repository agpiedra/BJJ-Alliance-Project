import { randomUUID } from "node:crypto";
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
 * Response contract for the kiosk page and the offline-replay queue:
 *
 *   200  { ok: true; student: {...}; summary: AtBeltSummary; thresholdReached: boolean; progressOutcome; isVisitor: boolean;
 *          attendanceRecordId; matchedClass: {...} | null; canCorrect: boolean }
 *   400  { ok: false; error: "invalid_code" | "already_checked_in" }
 *   400  { ok: false; error: "no_open_class" }                  no class is open: check-in is unavailable and a coach can
 *                                                                record the attendance. NOTHING is written.
 *   400  { ok: false; error: "class_selection_required"; openClasses: [...] }
 *                                                                SEVERAL classes are open: the student must choose (name,
 *                                                                time range, class type). NOTHING is written until they do.
 *   400  { ok: false; error: "class_not_open"; openClasses: [...] }   the chosen class is not open (it may have closed
 *                                                                while the picker was up); fresh choices, NOTHING written.
 *   400  { ok: false; error: "invalid_class" }                  the chosen id is not an active class of this academy.
 *   401  { ok: false; error: "invalid_token" }               (bad kiosk token — same generic
 *                                                              shape as academy-not-found, see below)
 *   403  { ok: false; error: "org_unavailable" }              (organization is PENDING, SUSPENDED,
 *                                                              or CANCELLED — same generic shape for
 *                                                              all three; never discloses which)
 *   404  { ok: false; error: "invalid_token" }               (unknown academySlug — deliberately
 *                                                              indistinguishable from a bad token)
 *   429  { ok: false; error: "rate_limited" | "locked_out"; retryAfterSeconds: number }
 *
 * A body with `queuedAt` is an OFFLINE REPLAY (recovery of an attendance that already happened) and NEVER returns
 * no_open_class / class_selection_required / class_not_open / invalid_class: it is recorded, or retained UNMATCHED
 * for staff review, so a queued attendance is never discarded. See `replay` in perform-check-in.ts.
 */
/**
 * Identifies one queued EVENT so that retrying the SAME event is idempotent and two DISTINCT events never merge:
 * the id the device generated when it queued the tap; for entries queued before device ids existed, the claimed
 * timestamp (two taps of one student never share a millisecond); a random key when even that is unusable (a retry of
 * such a request may then be kept twice - evidence a coach can dismiss - which is better than merging two events).
 */
function queuedEventKey(eventId: unknown, queuedAt: unknown): string {
  if (typeof eventId === "string") return `id:${eventId}`;
  if (typeof queuedAt === "number" && Number.isFinite(queuedAt)) return `legacy:${queuedAt}`;
  return `random:${randomUUID()}`;
}

/** What the device CLAIMED, exactly as received: the raw value (truncated) and, only for a valid number, its instant. */
function describeClaimedInstant(queuedAt: unknown): { claimedAtRaw: string | null; claimedAt: Date | null } {
  if (typeof queuedAt === "number") {
    const at = new Date(queuedAt);
    return { claimedAtRaw: String(queuedAt), claimedAt: Number.isNaN(at.getTime()) ? null : at };
  }
  if (typeof queuedAt === "string") return { claimedAtRaw: queuedAt.slice(0, 200), claimedAt: null };
  return { claimedAtRaw: (JSON.stringify(queuedAt) ?? null)?.slice(0, 200) ?? null, claimedAt: null };
}

export async function POST(request: Request) {
  let body: {
    academySlug?: unknown;
    token?: unknown;
    code?: unknown;
    queuedAt?: unknown;
    pickedClassSessionId?: unknown;
    eventId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token, code, queuedAt, pickedClassSessionId, eventId } = body;
  if (typeof academySlug !== "string" || typeof token !== "string" || typeof code !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  // Optional; only its TYPE is checked here. Whether the id is actually one of
  // this academy's active classes AND open at the check-in instant is re-validated
  // inside performCheckIn against a fresh query — never trusted from the client.
  if (pickedClassSessionId !== undefined && typeof pickedClassSessionId !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  // Optional identity of a queued EVENT (generated by the device when it was queued). It makes a retry of the same event
  // recognizable and two distinct events distinguishable; see `queuedEventKey`.
  if (eventId !== undefined && (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 100)) {
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
  //
  // A `queuedAt` in the body means this is an offline replay from `flushOfflineQueue`, not a live tap: nobody is at the
  // tablet to answer a picker, and the attendance already happened, so it is evaluated at its ORIGINAL instant and is
  // recorded or retained for staff review, never refused. A `queuedAt` that cannot be verified (malformed, in the future,
  // older than the bound) is still a replay - it is kept - but its instant is not trusted to pick a class.
  const replayInstant = resolveAttendanceInstant(queuedAt);
  const kioskContext: KioskContext = { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
  const result = await performCheckIn({
    academyId: academy.id,
    context: kioskContext,
    code,
    source: "KIOSK",
    now: replayInstant,
    // The same window rule as the portal: a selection must be one of this academy's classes that is open at the
    // instant, and a valid selection always wins. There is no outside-window fallback.
    ...(pickedClassSessionId !== undefined ? { pickedClassSessionId } : {}),
    ...(queuedAt !== undefined
      ? {
          replay: {
            timestampVerified: replayInstant !== undefined,
            event: { key: queuedEventKey(eventId, queuedAt), ...describeClaimedInstant(queuedAt) },
          },
        }
      : {}),
  });

  // Step 6: record this attempt's real outcome against the row already
  // reserved in step 4. The specific reason matters, not just ok/not-ok: only
  // `invalid_code` is a wrong-guess signal that may extend the lockout, while
  // every other failure (`already_checked_in`, `no_open_class`, `class_selection_required`, ...) means the code was valid.
  // (No reconciliation branch is needed here any more: with the gate ahead of
  // the guess there is no longer a case where a real, committed check-in could
  // be hidden behind a rate-limit rejection.)
  // A queued event kept as evidence (or recognized as a retry of one) is a DEFINITIVE 200 for the device queue - the
  // event is safely held for staff, so the device may delete it - and never an `already_checked_in`.
  if (!result.ok && result.error === "queued_for_review") {
    await finalizeKioskAttempt(reservation.attemptId, academy.organizationId, "success");
    return NextResponse.json({ ok: true, retained: true, reviewId: result.reviewId, duplicate: result.duplicate === true }, { status: 200 });
  }
  await finalizeKioskAttempt(
    reservation.attemptId,
    academy.organizationId,
    result.ok ? "success" : (result.error as Exclude<typeof result.error, "queued_for_review">),
  );

  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }

  // invalid_code / no_open_class / class_selection_required / already_checked_in are all client-side,
  // pre-condition-not-met failures — no need for finer-grained status codes
  // on an internal API with only two consumers (Tasks 6 and 7), both of
  // which branch on the `error` field, not the HTTP status.
  return NextResponse.json(result, { status: 400 });
}
