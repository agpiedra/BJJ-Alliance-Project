import type { prisma } from "@/lib/prisma";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** What approving a student did about their membership, recorded in the audit row. */
export type MembershipGrant = "granted" | "existing" | "none";
/** What archiving a student did about their membership. */
export type MembershipRevoke = "revoked" | "kept" | "none";

interface StudentRef {
  userId: string | null;
  organizationId: string;
}

/**
 * Approving a student is the moment they BELONG to the academy, so it is where
 * their `STUDENT` membership is created — not at signup. A membership is what
 * the tenant-context resolver (and so `/portal`) requires; before this existed
 * a self-registered student got a `User` and a `Student` and no membership at
 * all, so an approved student logged in to "No organization access" (only the
 * seed, which hand-writes its students' memberships, ever made the portal
 * work). Creating it at approval rather than signup avoids dangling rows for
 * applicants who are never approved, and mirrors how `approveOrganization`
 * grants the director's.
 *
 * Runs inside the caller's transaction, so the status change, the membership
 * and the audit row commit together or not at all.
 *
 * NEVER overwrites an existing membership's role: a coach who also trains has a
 * staff membership and a linked `Student` record, and approving the student
 * record must not demote them. (A deactivated STUDENT membership is switched
 * back on — that is the only existing row this touches.) A student staff
 * entered by hand has no account (`userId` null), so there is nothing to grant.
 */
export async function grantStudentMembership(tx: Tx, student: StudentRef): Promise<MembershipGrant> {
  if (!student.userId) return "none";

  const existing = await tx.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: student.userId, organizationId: student.organizationId } },
    select: { role: true, active: true },
  });
  if (!existing) {
    await tx.organizationMembership.create({
      data: { userId: student.userId, organizationId: student.organizationId, role: "STUDENT", active: true },
    });
    return "granted";
  }
  if (existing.role === "STUDENT" && !existing.active) {
    await tx.organizationMembership.update({
      where: { userId_organizationId: { userId: student.userId, organizationId: student.organizationId } },
      data: { active: true },
    });
    return "granted";
  }
  return "existing";
}

/**
 * Archiving a student switches their `STUDENT` membership off (B2's per-
 * organization `active` flag) — they lose the portal, the account is untouched.
 * Only a `STUDENT` membership: archiving the Student record of someone who also
 * holds a staff role must never take their staff access away.
 */
export async function revokeStudentMembership(tx: Tx, student: StudentRef): Promise<MembershipRevoke> {
  if (!student.userId) return "none";
  const result = await tx.organizationMembership.updateMany({
    where: { userId: student.userId, organizationId: student.organizationId, role: "STUDENT", active: true },
    data: { active: false },
  });
  return result.count > 0 ? "revoked" : "kept";
}
