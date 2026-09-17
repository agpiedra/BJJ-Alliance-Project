import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { StudentStatus } from "@/generated/prisma/client";

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

  const organizationId = session.activeOrganizationId;
  if (!organizationId) {
    return null;
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id, organizationId },
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
