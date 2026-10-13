import { prisma } from "@/lib/prisma";
import { openOccurrences } from "@/lib/scheduling/check-in-window";
import { toOpenClassEntry, type OpenClassEntry } from "@/lib/kiosk/perform-check-in";

/**
 * Classes open right now at this academy — the first caller of `openOccurrences` that runs BEFORE any student is
 * identified (the kiosk Entry screen's "open for check-in now" panel, Phase 2.6 PR 5). Same academy/organization
 * scoping every other kiosk read already uses (`reassign/route.ts`'s picklist query), and the SAME `openOccurrences`
 * the real check-in itself evaluates against — so what this panel shows is exactly what the server will accept,
 * never a second, divergent notion of "open."
 */
export async function getOpenClassesNow(academyId: string, organizationId: string, now: Date): Promise<OpenClassEntry[]> {
  const sessions = await prisma.classSession.findMany({ where: { academyId, organizationId, active: true } });
  return openOccurrences(sessions, now).map(toOpenClassEntry);
}
