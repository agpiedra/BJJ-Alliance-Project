import type { NextResponse } from "next/server";
import { handleMonthlyGenerationRequest } from "@/lib/dues/monthly-generation-route";

// This route touches Prisma, which requires the Node runtime — do not add `export const runtime = "edge"` here.

/**
 * F = 300 s (owner-approved, G2b). A literal because Next reads it statically; it MUST equal
 * MONTHLY_GENERATION_FUNCTION_MAX_SECONDS in src/lib/dues/monthly-generation-route.ts (a unit test checks).
 */
export const maxDuration = 300;

/**
 * G2b: the monthly-generation trigger. GET, `Authorization: Bearer <CRON_SECRET>` (checked in constant time by
 * `runScheduledJob`), no request inputs. NOT SCHEDULED: there is no `vercel.json` entry until the schedule (D5) is approved.
 * A 200 means the invocation ran — never that any month's billing is complete. See monthly-generation-route.ts.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const startedAtMs = performance.now();
  return handleMonthlyGenerationRequest(request, startedAtMs);
}
