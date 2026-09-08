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

export async function getStaffSession(): Promise<StaffSession | null> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || !role || !isStaffRole(role)) {
    return null;
  }

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
