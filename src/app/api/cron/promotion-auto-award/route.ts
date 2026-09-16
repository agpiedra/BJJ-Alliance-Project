import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { runAutomaticStripeAwardsForOrganization } from "@/lib/promotion/automation";

// This route touches Prisma, which requires the Node runtime — do not add
// `export const runtime = "edge"` here.

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-iii. Vercel Cron trigger for the
 * promotion auto-award job, authenticated the same way
 * `weekly-digest/route.ts` already is — a shared secret sent as
 * `Authorization: Bearer <CRON_SECRET>` (Vercel's documented mechanism),
 * checked before anything else runs. This is an `/api` route, so the
 * staff-session middleware never covers it (Phase 1) — an unauthenticated
 * endpoint that can award promotions would be a real hole.
 *
 * Every ACTIVE organization is processed — one organization's failure is
 * caught and reported, never allowed to abort the rest, matching
 * `weekly-digest/route.ts`'s established best-effort ethos.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const organizations = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true } });

  const results = [];
  const errors: Array<{ organizationId: string; error: string }> = [];
  for (const organization of organizations) {
    try {
      results.push(await runAutomaticStripeAwardsForOrganization(organization.id));
    } catch (err) {
      errors.push({ organizationId: organization.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ ok: errors.length === 0, results, errors }, { status: 200 });
}
