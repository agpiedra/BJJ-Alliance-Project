/**
 * `/api/health` is public and unauthenticated by design — an uptime monitor has to be able
 * to hit it with no credentials, which also means anyone who finds the URL can. A 5-second
 * cache caps that at one real database round trip per window, no matter how many
 * concurrent callers ask inside it, while a genuine outage (or a genuine recovery) is still
 * visible within 5 seconds — short enough that a monitor polling every "few minutes" (the
 * cadence this endpoint is built for) never sees a stale result, long enough that a leaked
 * URL hit thousands of times a second cannot turn into a free way to hammer Postgres.
 */
export const CACHE_WINDOW_MS = 5_000;

interface CachedHealth {
  ok: boolean;
  checkedAt: number;
}

let cached: CachedHealth | null = null;

// Dynamically imported — never at module load — so tests/unit/database-check.test.ts (which
// always injects `check` and never calls this) can import this module without constructing
// a real Prisma client, which requires DATABASE_URL and belongs to the integration side of
// this codebase's unit/integration test split, not the unit side.
async function pingDatabase(): Promise<void> {
  const { unscopedPrisma } = await import("@/lib/prisma/unscoped");
  await unscopedPrisma.$queryRaw`SELECT 1`;
}

/**
 * Whether the database is reachable right now, cached for `CACHE_WINDOW_MS` (see above) —
 * a failed check is cached too, so a real outage doesn't turn into repeated real queries
 * either. Never throws.
 *
 * `check` is injectable purely so the caching behavior can be tested in isolation from a
 * real database; production callers always take the default, which really queries
 * Postgres via `unscopedPrisma` (a liveness ping has no tenant to scope it to).
 */
export async function checkDatabaseHealth(check: () => Promise<void> = pingDatabase): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.checkedAt < CACHE_WINDOW_MS) {
    return cached.ok;
  }

  let ok: boolean;
  try {
    await check();
    ok = true;
  } catch (error) {
    console.error("[health] database check failed", error);
    ok = false;
  }
  cached = { ok, checkedAt: now };
  return ok;
}

/** Test-only: clears the module-level cache so each test case starts fresh. */
export function resetDatabaseHealthCacheForTests(): void {
  cached = null;
}
