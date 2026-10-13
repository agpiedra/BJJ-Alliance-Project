import { prisma } from "@/lib/prisma";
import { nextBoundaryAfter, openOccurrences } from "@/lib/scheduling/check-in-window";
import { toOpenClassEntry, type OpenClassEntry } from "@/lib/kiosk/perform-check-in";

/**
 * Classes open right now at this academy — the first caller of `openOccurrences` that runs BEFORE any student is
 * identified (the kiosk Entry screen's "open for check-in now" panel, Phase 2.6 PR 5). Same academy/organization
 * scoping every other kiosk read already uses (`reassign/route.ts`'s picklist query), and the SAME `openOccurrences`
 * the real check-in itself evaluates against — so what this panel shows is exactly what the server will accept,
 * never a second, divergent notion of "open."
 *
 * `refreshAt` is `nextBoundaryAfter` over the SAME `sessions` and the SAME `now` already read above — no second
 * query, no second clock read — so the client can refetch exactly when this result is known to go stale, instead
 * of polling blind. `serverNow` is that SAME `now`, round-tripped so the client can measure its own clock's skew
 * against it before trusting `refreshAt` — the same convention `listTodaysClasses`/`useRefreshAtBoundary` already
 * use for the portal's own boundary refresh.
 */
export async function getOpenClassesNow(
  academyId: string,
  organizationId: string,
  now: Date,
): Promise<{ classes: OpenClassEntry[]; refreshAt: Date; serverNow: Date }> {
  const sessions = await prisma.classSession.findMany({ where: { academyId, organizationId, active: true } });
  return {
    classes: openOccurrences(sessions, now).map(toOpenClassEntry),
    refreshAt: nextBoundaryAfter(sessions, now),
    serverNow: now,
  };
}
