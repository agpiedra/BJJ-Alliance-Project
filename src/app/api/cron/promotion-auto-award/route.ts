import type { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAutomaticStripeAwardsForOrganization, type AutomationRunResult } from "@/lib/promotion/automation";
import { runScheduledJob, type JobOrgBreakdown } from "@/lib/jobs/run-scheduled-job";

// This route touches Prisma, which requires the Node runtime — do not add
// `export const runtime = "edge"` here.

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-iii. Vercel Cron trigger for the
 * promotion auto-award job, authenticated the same way
 * `weekly-digest/route.ts` already is — a shared secret sent as
 * `Authorization: Bearer <CRON_SECRET>` (Vercel's documented mechanism),
 * checked before anything else runs. This is an `/api` route, so the
 * staff-session middleware never covers it (Phase 1) — an unauthenticated
 * endpoint that can award promotions would be a real hole. That check, plus
 * the JobRun row and Healthchecks.io heartbeat (C1), live once in
 * `runScheduledJob` — shared with the weekly-digest route.
 *
 * Every ACTIVE organization is processed — one organization's failure is
 * caught and reported, never allowed to abort the rest, matching
 * `weekly-digest/route.ts`'s established best-effort ethos.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return runScheduledJob("promotion-auto-award", request, async () => {
    const organizations = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true } });

    const results: AutomationRunResult[] = [];
    const errors: Array<{ organizationId: string; error: string }> = [];
    const breakdown: JobOrgBreakdown[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const organization of organizations) {
      try {
        const result = await runAutomaticStripeAwardsForOrganization(organization.id);
        results.push(result);
        sent += result.awardedStudentIds.length;
        failed += result.errors.length;
        skipped += result.skippedConflict;
        breakdown.push({
          organizationId: organization.id,
          sent: result.awardedStudentIds.length,
          failed: result.errors.length,
          skipped: result.skippedConflict,
        });
      } catch (err) {
        // A whole organization erroring counts as one failed unit toward the JobRun/heartbeat
        // signal, even though `sent`/`failed` above count individual students — deliberately a
        // coarser, mixed-unit tally, matching weekly-digest/route.ts's own reasoning.
        failed += 1;
        errors.push({ organizationId: organization.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      outcome: { sent, failed, skipped, organizationsProcessed: organizations.length, organizationBreakdown: breakdown },
      body: { ok: failed === 0, results, errors, sent, failed, skipped },
    };
  });
}
