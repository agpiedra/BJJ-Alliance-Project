import type { NextResponse } from "next/server";
import { defaultUrgentMonitorDeps, handleUrgentMonitorRequest } from "@/lib/monitoring/urgent/run";

// This route touches Prisma, which requires the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * The urgent monitor (docs/dues/URGENT-ALERTING-ONE-HOUR-PROPOSAL.md revision 5.1). A literal because Next reads it statically;
 * it MUST equal MONITOR_FUNCTION_MAX_SECONDS in src/lib/monitoring/urgent/run.ts (a unit test checks).
 */
export const maxDuration = 60;

/** GET, `Authorization: Bearer <CRON_SECRET>` (constant-time check). Scheduled `7,22,37,52 * * * *` in vercel.json. */
export async function GET(request: Request): Promise<NextResponse> {
  return handleUrgentMonitorRequest(request, defaultUrgentMonitorDeps(performance.now()));
}
