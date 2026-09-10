import { prisma } from "@/lib/prisma";
import type { Recipient } from "@/lib/notifications/types";

/**
 * Resolves who should be notified about something that happened at
 * `academyId`: every active ADMIN (unconditionally — spec's own
 * ADMIN/DIRECTOR-gated-feature precedent, see the plan's ruling), plus every
 * active DIRECTOR/INSTRUCTOR with a `StaffAssignment` to that academy.
 *
 * Deliberately NOT routed through `academyScopeWhere`/`isAcademyInScope`
 * (`@/lib/auth/session`) — those answer "what can THIS CALLER see," a
 * question about an existing session's scope. This function answers a
 * different question — "who should be notified about academy X" — for a
 * concrete academy id with no caller session in play at all, so it queries
 * `StaffAssignment` directly instead.
 *
 * Deduplicated by `userId` via a `Map`: an ADMIN is never also a DIRECTOR in
 * practice, but a `Map` keyed by `userId` is simpler than reasoning about
 * whether an overlap (e.g. an ADMIN who also happens to hold a
 * `StaffAssignment` row) could ever produce a duplicate.
 */
export async function resolveStaffRecipients(academyId: string): Promise<Recipient[]> {
  const [admins, assignments] = await Promise.all([
    prisma.user.findMany({
      where: { role: "ADMIN", active: true },
      select: { id: true, email: true, locale: true },
    }),
    prisma.staffAssignment.findMany({
      where: { academyId, user: { active: true } },
      select: { user: { select: { id: true, email: true, locale: true } } },
    }),
  ]);

  const recipients = new Map<string, Recipient>();
  for (const admin of admins) {
    recipients.set(admin.id, { userId: admin.id, email: admin.email, locale: admin.locale });
  }
  for (const { user } of assignments) {
    recipients.set(user.id, { userId: user.id, email: user.email, locale: user.locale });
  }

  return [...recipients.values()];
}
