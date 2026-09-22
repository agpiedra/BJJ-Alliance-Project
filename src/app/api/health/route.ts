import { NextResponse } from "next/server";
import { checkDatabaseHealth } from "@/lib/health/database-check";

// This route touches Prisma (via checkDatabaseHealth), which requires the
// Node runtime — do not add `export const runtime = "edge"` here.

/**
 * C1: public, unauthenticated health check for an uptime monitor. Deliberately checks
 * ONLY the database (per the C1 proposal's decision #3) — no version string, no secrets,
 * nothing about the scheduled jobs (that's `/api/health/jobs`, behind CRON_SECRET, since
 * job freshness is an operational detail, not something an anonymous caller needs).
 * `checkDatabaseHealth` caches briefly — see that module's own comment for the window and
 * why — so this endpoint being public and unauthenticated can never become a free way to
 * hammer Postgres.
 */
export async function GET(): Promise<NextResponse> {
  const ok = await checkDatabaseHealth();
  return NextResponse.json({ ok }, { status: ok ? 200 : 503 });
}
