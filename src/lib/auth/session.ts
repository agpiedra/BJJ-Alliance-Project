import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { StudentStatus } from "@/generated/prisma/client";

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

export interface StudentSession {
  userId: string;
  studentId: string;
  status: StudentStatus;
}

/**
 * Resolves the caller's student session, re-validating the JWT's claims
 * against the database on EVERY call — same discipline as
 * `getStaffSession()` and for the same reason: the JWT is valid for up to
 * 30 days, so a `STUDENT` claim is a snapshot of whenever the user last
 * logged in, not the truth. An account deactivated (`active: false`) or
 * whose role changed since (e.g. promoted to staff) must lose access
 * immediately, not at the end of the token's life.
 *
 * Login itself is deliberately NOT gated on the linked `Student.status` —
 * a `PENDING` or `ARCHIVED` student can still resolve a session and see
 * their portal (mirroring how a staff session's gate checks `User.active`,
 * not some downstream business-status field). Callers that need to gate an
 * actual mutation on `ACTIVE` (self check-in, confirming a promotion) check
 * `status` themselves.
 */
export async function getStudentSession(): Promise<StudentSession | null> {
  const session = await auth();
  const claimedRole = session?.user?.role;
  if (!session?.user || claimedRole !== "STUDENT") {
    return null;
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, active: true },
  });

  // Fail closed on all three counts: user row gone, `active: false`, or a
  // current `role` that no longer matches the JWT's `STUDENT` claim (e.g.
  // promoted to staff since the token was issued).
  if (!currentUser || !currentUser.active || currentUser.role !== "STUDENT") {
    return null;
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true, status: true },
  });

  // Shouldn't happen given signup's atomic User+Student transaction, but
  // fail closed rather than throw if the linked row is somehow missing.
  if (!student) {
    return null;
  }

  return { userId: session.user.id, studentId: student.id, status: student.status };
}

export async function requireStudentSession(): Promise<StudentSession> {
  const session = await getStudentSession();
  if (!session) {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }
  return session;
}
