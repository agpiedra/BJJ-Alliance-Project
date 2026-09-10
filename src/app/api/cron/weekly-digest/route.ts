import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { sendWeeklyDigestForAcademy } from "@/lib/notifications/weekly-digest";

// This route touches Prisma (via sendWeeklyDigestForAcademy), which requires
// the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * Vercel Cron trigger for the weekly digest (`vercel.json`'s
 * `0 13 * * 1` — Monday 07:00 America/Costa_Rica). Vercel Cron issues a GET
 * request by default, authenticated by a shared secret sent as
 * `Authorization: Bearer <CRON_SECRET>` (Vercel's documented mechanism), not
 * session cookies — there is no staff session in a cron-triggered request.
 *
 * Every real `Academy` row is processed (never a hardcoded Escazú/Escalante
 * list, matching the locations panel's precedent) — one academy's digest
 * failing is caught and reported, never allowed to abort the rest, matching
 * this whole phase's best-effort ethos.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const academies = await prisma.academy.findMany({ where: { active: true }, select: { id: true } });

  const errors: Array<{ academyId: string; error: string }> = [];
  let processed = 0;
  for (const academy of academies) {
    try {
      await sendWeeklyDigestForAcademy(academy.id);
      processed++;
    } catch (err) {
      errors.push({ academyId: academy.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // `ok: false` (not always `true`) when every academy failed, so a total
  // outage is visible in Vercel's cron dashboard instead of masked as success.
  return NextResponse.json({ ok: errors.length === 0, processed, errors }, { status: 200 });
}
