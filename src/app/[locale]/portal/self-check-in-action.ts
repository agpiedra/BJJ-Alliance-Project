"use server";

import { requireStudentSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { performCheckIn } from "@/lib/kiosk/perform-check-in";
import { AttendanceSource } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import type { AtBeltSummary } from "@/lib/students/attendance-summary";

export type SelfCheckInState = ActionState & {
  student?: { firstName: string; lastName: string; currentBelt: string; currentStripes: number };
  summary?: AtBeltSummary;
  earnedStripe?: boolean;
  isVisitor?: boolean;
  homeAcademyName?: string;
};

// No form fields to validate — the only inputs are the caller's own session
// (which student) and the server clock (which class window), both resolved
// server-side. `formData` is accepted only to match useActionState's action
// signature.
export async function selfCheckIn(
  _prevState: SelfCheckInState,
  _formData: FormData,
): Promise<SelfCheckInState> {
  const session = await requireStudentSession();

  // A student acting on their own row, not a staff member acting on someone
  // else's — the session itself (re-verified against the DB inside
  // requireStudentSession) already IS the ownership proof, so none of the
  // staff "scope by id AND owner" ceremony applies to this lookup.
  const student = await prisma.student.findUnique({
    where: { id: session.studentId },
    select: { homeAcademyId: true },
  });

  // Shouldn't happen given signup's atomic User+Student transaction (see
  // requireStudentSession's own doc comment), but fail closed with the same
  // generic error the rest of this taxonomy uses rather than throwing.
  if (!student) {
    return { error: "invalid_code" };
  }

  const result = await performCheckIn({
    academyId: student.homeAcademyId,
    studentId: session.studentId,
    source: AttendanceSource.PORTAL,
  });

  if (!result.ok) {
    return { error: result.error };
  }

  return {
    ok: true,
    student: result.student,
    summary: result.summary,
    earnedStripe: result.earnedStripe,
    isVisitor: result.isVisitor,
    homeAcademyName: result.homeAcademyName,
  };
}
