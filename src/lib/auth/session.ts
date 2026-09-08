import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export type StaffRoleName = "ADMIN" | "DIRECTOR" | "INSTRUCTOR";

export interface StaffSession {
  userId: string;
  role: StaffRoleName;
  academyIds: string[] | "ALL";
}

const STAFF_ROLES: StaffRoleName[] = ["ADMIN", "DIRECTOR", "INSTRUCTOR"];

function isStaffRole(role: string): role is StaffRoleName {
  return (STAFF_ROLES as string[]).includes(role);
}

/**
 * Resolves the caller's staff session, re-validating the JWT's claims
 * against the database on EVERY call.
 *
 * The JWT is valid for up to 30 days, so its `role` / implied active status
 * are a snapshot of whenever the user last logged in — not the truth. An
 * account deactivated (`active: false`) or demoted (ADMIN -> INSTRUCTOR,
 * staff -> STUDENT) an hour ago would otherwise keep full access for the
 * remainder of the token's life, with no way to revoke it short of rotating
 * the signing secret for everyone. This previously bit ADMIN hardest: the
 * ADMIN branch returned before touching the DB at all, so a revoked admin
 * was never checked against anything.
 *
 * Fails closed on all three counts — user row gone, `active: false`, or a
 * current `role` that no longer matches the JWT's claim — and only then
 * reads `StaffAssignment` rows for the non-admin academy scope.
 */
export async function getStaffSession(): Promise<StaffSession | null> {
  const session = await auth();
  const claimedRole = session?.user?.role;
  if (!session?.user || !claimedRole || !isStaffRole(claimedRole)) {
    return null;
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, active: true },
  });

  // A demotion is a role MISMATCH, not merely "the current role isn't
  // staff" — a DIRECTOR carrying a stale ADMIN claim must be turned back
  // too, not silently downgraded to the role they actually hold now, since
  // this request was authorized under the claim they no longer have.
  if (!currentUser || !currentUser.active || currentUser.role !== claimedRole) {
    return null;
  }

  // Narrowed by the equality check above; `currentUser.role` is the same
  // StaffRoleName the JWT claimed, now confirmed against the DB.
  const role: StaffRoleName = claimedRole;

  if (role === "ADMIN") {
    return { userId: session.user.id, role, academyIds: "ALL" };
  }

  const assignments = await prisma.staffAssignment.findMany({
    where: { userId: session.user.id },
    select: { academyId: true },
  });

  return { userId: session.user.id, role, academyIds: assignments.map((a) => a.academyId) };
}

export async function requireStaffSession(allowedRoles?: StaffRoleName[]): Promise<StaffSession> {
  const session = await getStaffSession();
  if (!session) {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    throw new Error("FORBIDDEN");
  }
  return session;
}

/** Do not spread this with another literal academyId key — the literal silently wins over the { in: [...] } fragment. Compose with an AND array instead. */
export function academyScopeWhere(session: StaffSession): { academyId?: { in: string[] } } {
  if (session.academyIds === "ALL") return {};
  return { academyId: { in: session.academyIds } };
}

export function isAcademyInScope(session: StaffSession, academyId: string): boolean {
  return session.academyIds === "ALL" || session.academyIds.includes(academyId);
}
