import { prisma } from "@/lib/prisma";
import { listClassSessions } from "./(staff)/admin/schedule/queries";

/**
 * Aggregate stats + a one-academy schedule preview for the PUBLIC home page.
 * Everything here is unauthenticated, public-safe data: simple `count()`s
 * (academy count, weekly class count) and one academy's class names/times —
 * no student/staff names, no financial figures, nothing per-person. Do not
 * add session/role gating here; that would defeat the point of this page.
 *
 * The previewed academy is whichever active academy has the most active
 * class sessions (ties broken alphabetically for determinism) — not a fixed
 * alphabetical/creation-order default. A public schedule preview sitting
 * directly under a "18 classes per week" stat looks broken if it happens to
 * land on the one academy with zero published classes yet (verified live:
 * an earlier alphabetical-first choice picked Escalante, which has no
 * seeded classes, directly under a stat describing Escazú's real 18). Only
 * two academies exist today, so fetching both with their active
 * class-session count and comparing in JS is simpler and cheaper than an
 * `orderBy` on a filtered relation count.
 */
export async function getPublicHomeStats() {
  const [academyCount, weeklyClassCount, academiesWithClassCounts] = await Promise.all([
    prisma.academy.count({ where: { active: true } }),
    prisma.classSession.count({ where: { active: true } }),
    prisma.academy.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        timezone: true,
        _count: { select: { classSessions: { where: { active: true } } } },
      },
    }),
  ]);

  const previewAcademy = academiesWithClassCounts.reduce<(typeof academiesWithClassCounts)[number] | null>(
    (best, candidate) =>
      !best || candidate._count.classSessions > best._count.classSessions ? candidate : best,
    null,
  );

  // Reuses the admin schedule page's existing query as-is (see its doc
  // comment) rather than re-querying `ClassSession` here. That function
  // returns both active and inactive sessions by design (for the admin
  // table) — this public preview only ever shows the active ones.
  const previewSessions = previewAcademy
    ? (await listClassSessions(previewAcademy.id)).filter((session) => session.active)
    : [];

  return { academyCount, weeklyClassCount, previewAcademy, previewSessions };
}
