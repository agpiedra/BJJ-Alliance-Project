import { prisma } from "@/lib/prisma";
import { resolveAcademyByIdOrThrow } from "@/lib/tenant/platform-lookups";
import type { Recipient } from "@/lib/notifications/types";

/**
 * Resolves who should be notified about something that happened at
 * `academyId`: every active ADMIN (unconditionally — spec's own
 * ADMIN/DIRECTOR-gated-feature precedent, see the plan's ruling), plus every
 * active DIRECTOR/INSTRUCTOR with a `StaffAssignment` to that academy.
 *
 * Deliberately NOT routed through `getScopedDb`/`isAcademyInTenantScope`
 * (`@/lib/tenant/context`) — those answer "what can THIS CALLER see," a
 * question about an existing session's scope. This function answers a
 * different question — "who should be notified about academy X" — for a
 * concrete academy id with no caller session in play at all, so it queries
 * `OrganizationMembership`/`StaffAssignment` directly instead.
 *
 * Deduplicated by `userId` via a `Map`: an ADMIN is never also a DIRECTOR in
 * practice, but a `Map` keyed by `userId` is simpler than reasoning about
 * whether an overlap (e.g. an ADMIN who also happens to hold a
 * `StaffAssignment` row) could ever produce a duplicate.
 */
export async function resolveStaffRecipients(academyId: string): Promise<Recipient[]> {
  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1: Notification.organizationId is
  // required — the org this notification is about (this academy's), not
  // necessarily every recipient's only membership. See platform-lookups.ts's
  // resolveAcademyByIdOrThrow for why this org-identity resolution can't
  // itself be organization-scoped.
  const academy = await resolveAcademyByIdOrThrow(academyId);

  // ADMINs are resolved through OrganizationMembership, scoped to this
  // academy's own organization — never `User.role` globally, which would
  // notify every ADMIN across every tenant about one organization's event
  // (the exact 1d gap flagged when Notification.organizationId was added:
  // "unscoped by organization... notifies every ADMIN everywhere").
  const [adminMemberships, assignments] = await Promise.all([
    prisma.organizationMembership.findMany({
      where: { organizationId: academy.organizationId, role: "ADMIN", user: { active: true } },
      select: { user: { select: { id: true, email: true, locale: true } } },
    }),
    prisma.staffAssignment.findMany({
      where: { organizationId: academy.organizationId, academyId, user: { active: true } },
      select: { user: { select: { id: true, email: true, locale: true } } },
    }),
  ]);

  const recipients = new Map<string, Recipient>();
  for (const { user: admin } of adminMemberships) {
    recipients.set(admin.id, {
      userId: admin.id,
      email: admin.email,
      locale: admin.locale,
      organizationId: academy.organizationId,
    });
  }
  for (const { user } of assignments) {
    recipients.set(user.id, {
      userId: user.id,
      email: user.email,
      locale: user.locale,
      organizationId: academy.organizationId,
    });
  }

  return [...recipients.values()];
}
