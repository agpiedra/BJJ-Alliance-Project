import type { NextResponse } from "next/server";
import { listActiveAcademyIdsForDigest } from "@/lib/tenant/platform-lookups";
import { sendWeeklyDigestForAcademy } from "@/lib/notifications/weekly-digest";
import { runScheduledJob, type JobOrgBreakdown } from "@/lib/jobs/run-scheduled-job";

// This route touches Prisma (via sendWeeklyDigestForAcademy), which requires
// the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * Vercel Cron trigger for the weekly digest (`vercel.json`'s
 * `0 13 * * 1` — Monday 07:00 America/Costa_Rica). Vercel Cron issues a GET
 * request by default, authenticated by a shared secret sent as
 * `Authorization: Bearer <CRON_SECRET>` (Vercel's documented mechanism), not
 * session cookies — there is no staff session in a cron-triggered request.
 * That check, plus the JobRun row and Healthchecks.io heartbeat (C1), live
 * once in `runScheduledJob` — shared with the promotion-auto-award route.
 *
 * Every real `Academy` row is processed (never a hardcoded Escazú/Escalante
 * list, matching the locations panel's precedent) — one academy's digest
 * failing is caught and reported, never allowed to abort the rest, matching
 * this whole phase's best-effort ethos.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return runScheduledJob("weekly-digest", request, async () => {
    // This job iterates every organization on the platform by design — see
    // platform-lookups.ts's listActiveAcademyIdsForDigest.
    const academyIds = await listActiveAcademyIdsForDigest();

    const errors: Array<{ academyId: string; error: string }> = [];
    const breakdown: JobOrgBreakdown[] = [];
    const organizationsSeen = new Set<string>();
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const academyId of academyIds) {
      try {
        const result = await sendWeeklyDigestForAcademy(academyId);
        processed++;
        sent += result.sent;
        failed += result.failed;
        skipped += result.skipped;
        organizationsSeen.add(result.organizationId);
        breakdown.push({ organizationId: result.organizationId, sent: result.sent, failed: result.failed, skipped: result.skipped });
      } catch (err) {
        // A whole academy erroring counts as one failed unit toward the JobRun/heartbeat
        // signal, even though `sent`/`failed` above count individual email attempts — this
        // is deliberately a coarser, mixed-unit tally: the dead-man's switch only needs "did
        // anything fail", not a precise cross-unit metric.
        failed += 1;
        errors.push({ academyId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      outcome: { sent, failed, skipped, organizationsProcessed: organizationsSeen.size, organizationBreakdown: breakdown },
      // `ok: false` (not always `true`) whenever anything failed, so a total outage is
      // visible in Vercel's cron dashboard instead of masked as success.
      body: { ok: failed === 0, processed, sent, failed, skipped, errors },
    };
  });
}
