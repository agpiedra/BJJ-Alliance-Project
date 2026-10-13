import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAcademyBySlug } from "@/lib/tenant/platform-lookups";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { getOpenClassesNow } from "@/lib/kiosk/open-classes";

// Touches Prisma — Node runtime only, same as the other two kiosk routes.

/**
 * The kiosk Entry screen's "open for check-in now" panel (Phase 2.6 PR 5) — the first endpoint that reports open
 * classes BEFORE any student is identified. Same academy-lookup + token-verification gate, in the same order and
 * with the same deliberately indistinguishable failure shapes, as `check-in/route.ts` and `reassign/route.ts`.
 *
 *   POST { academySlug, token }
 *     -> 200 { ok: true, openClasses: OpenClassEntry[] }   an empty array is a normal, successful "nothing open
 *                                                           right now" — NOT an error.
 *     -> 401/404 { ok: false, error: "invalid_token" }     bad token / unknown academy slug, same indistinguishable
 *                                                           shape the other two routes already use.
 *     -> 403 { ok: false, error: "org_unavailable" }       organization is PENDING/SUSPENDED/CANCELLED — same gate
 *                                                           `check-in/route.ts` applies, so this panel never reveals
 *                                                           schedule data for an unavailable organization either.
 *
 * Deliberately NOT behind `reserveKioskAttempt`, for the same reason `reassign/route.ts` is not (see its own
 * comment): this endpoint accepts no PIN, only an already-verified device token — there is no PIN-guessing surface
 * for a rate limiter to defend, and the worst a valid token holder can do here is read the academy's own public
 * class schedule a little early.
 */
export async function POST(request: Request) {
  let body: { academySlug?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token } = body;
  if (typeof academySlug !== "string" || typeof token !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const academy = await resolveAcademyBySlug(academySlug);
  if (!academy) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 404 });
  }

  if (digestLookupSecret(token, requireEnv("CODE_PEPPER")) !== academy.kioskTokenHash) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 401 });
  }

  const organization = await prisma.organization.findUnique({
    where: { id: academy.organizationId },
    select: { status: true },
  });
  if (!organization || organization.status !== "ACTIVE") {
    return NextResponse.json({ ok: false, error: "org_unavailable" }, { status: 403 });
  }

  const openClasses = await getOpenClassesNow(academy.id, academy.organizationId, new Date());
  return NextResponse.json({ ok: true, openClasses }, { status: 200 });
}
