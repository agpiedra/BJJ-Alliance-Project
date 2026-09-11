import { prisma } from "@/lib/prisma";
import { listClassSessions } from "./(staff)/admin/schedule/queries";

/**
 * Aggregate stats + a one-academy schedule preview for the PUBLIC home page.
 * Everything here is unauthenticated, public-safe data: simple `count()`s
 * (academy count, weekly class count) and one academy's class names/times —
 * no student/staff names, no financial figures, nothing per-person. Do not
 * add session/role gating here; that would defeat the point of this page.
 *
 * The previewed academy is picked by name ascending (alphabetically first
 * among active academies) purely as a stable, deterministic default — the
 * plan doesn't specify one of the two real academies (Escazú/Escalante) over
 * the other, and this matches the existing academy-selector default on the
 * admin schedule page (`admin/schedule/page.tsx`).
 */
export async function getPublicHomeStats() {
  const [academyCount, weeklyClassCount, previewAcademy] = await Promise.all([
    prisma.academy.count({ where: { active: true } }),
    prisma.classSession.count({ where: { active: true } }),
    prisma.academy.findFirst({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, timezone: true },
    }),
  ]);

  // Reuses the admin schedule page's existing query as-is (see its doc
  // comment) rather than re-querying `ClassSession` here. That function
  // returns both active and inactive sessions by design (for the admin
  // table) — this public preview only ever shows the active ones.
  const previewSessions = previewAcademy
    ? (await listClassSessions(previewAcademy.id)).filter((session) => session.active)
    : [];

  return { academyCount, weeklyClassCount, previewAcademy, previewSessions };
}
