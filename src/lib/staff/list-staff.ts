import { prisma } from "@/lib/prisma";
import { STAFF_ROLES, type StaffMembershipRole } from "@/lib/staff/staff-service";

export interface StaffMemberRow {
  membershipId: string;
  userId: string;
  email: string;
  role: StaffMembershipRole;
  /** The MEMBERSHIP's switch — false means deactivated in THIS organization only. */
  active: boolean;
  /** Empty for an Owner: their scope is every academy. */
  academies: { id: string; name: string }[];
}

export interface PendingInvitationRow {
  id: string;
  email: string;
  role: StaffMembershipRole;
  academies: { id: string; name: string }[];
  expiresAt: Date;
  /** Past its expiry: still listed (so it can be resent or revoked) but dead. */
  expired: boolean;
  createdAt: Date;
}

const ROLE_ORDER: Record<StaffMembershipRole, number> = { ADMIN: 0, DIRECTOR: 1, INSTRUCTOR: 2 };

/**
 * The staff page's data: this organization's staff (never students, never
 * another organization's) and its pending invitations — not yet accepted, not
 * revoked, not superseded. Plain function, not a server action: it trusts its
 * argument and is called only from the Owner-gated page.
 */
export async function listStaff(organizationId: string): Promise<{ members: StaffMemberRow[]; invitations: PendingInvitationRow[] }> {
  const [memberships, assignments, academies, pending] = await Promise.all([
    prisma.organizationMembership.findMany({
      where: { organizationId, role: { in: [...STAFF_ROLES] } },
      select: { id: true, userId: true, role: true, active: true, user: { select: { email: true } } },
    }),
    prisma.staffAssignment.findMany({ where: { organizationId }, select: { userId: true, academyId: true } }),
    prisma.academy.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.invitation.findMany({
      where: { organizationId, usedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const academyById = new Map(academies.map((academy) => [academy.id, academy]));
  const named = (ids: string[]) =>
    ids.flatMap((id) => {
      const academy = academyById.get(id);
      return academy ? [academy] : [];
    });

  const academyIdsByUser = new Map<string, string[]>();
  for (const assignment of assignments) {
    academyIdsByUser.set(assignment.userId, [...(academyIdsByUser.get(assignment.userId) ?? []), assignment.academyId]);
  }

  const members = memberships
    .map((membership): StaffMemberRow => {
      const role = membership.role as StaffMembershipRole;
      return {
        membershipId: membership.id,
        userId: membership.userId,
        email: membership.user.email,
        role,
        active: membership.active,
        academies: role === "ADMIN" ? [] : named(academyIdsByUser.get(membership.userId) ?? []),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.email.localeCompare(b.email));

  const now = Date.now();
  const invitations = pending
    .filter((invitation) => (STAFF_ROLES as readonly string[]).includes(invitation.role))
    .map(
      (invitation): PendingInvitationRow => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role as StaffMembershipRole,
        academies: named(invitation.academyIds),
        expiresAt: invitation.expiresAt,
        expired: invitation.expiresAt.getTime() <= now,
        createdAt: invitation.createdAt,
      }),
    );

  return { members, invitations };
}
