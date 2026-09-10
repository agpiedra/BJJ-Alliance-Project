"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
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

  // performCheckIn's own resolution branch necessarily (and correctly)
  // returns the generic `invalid_code` for a non-ACTIVE student — it's the
  // shared kiosk/portal core, and an anonymous kiosk shouldn't be able to
  // learn an account's status from a check-in attempt. But the portal page
  // ISN'T anonymous: it already shows this student their own PENDING/
  // ARCHIVED/INACTIVE status in a banner above this button, so silently
  // reusing that generic error here would be a strictly worse message than
  // an honest one — especially since PENDING is every self-signed-up
  // student's default state, not a rare edge case. `session.status` is
  // already resolved (and re-verified) by requireStudentSession, so this
  // check happens BEFORE performCheckIn/any DB write is ever attempted.
  if (session.status !== "ACTIVE") {
    return { error: "notActive" };
  }

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

  // Without this, the page's OTHER card (getAtBeltSummary, fetched at
  // page-load time via the Server Component render) would keep showing the
  // pre-check-in numbers while this button's own success state shows the
  // fresh ones — two different attendance counts on the same screen.
  // revalidatePath is what actually tells the CLIENT's Router Cache for this
  // path to drop its cached RSC payload — this is what makes the
  // self-check-in-button.tsx's router.refresh() call (which merely asks for
  // a refetch) actually return fresh data instead of a cached copy.
  //
  // Best-effort, not fatal: `revalidatePath` requires a real Next.js
  // request-scoped store (populated by the framework around every genuine
  // Server Action invocation), which isn't present when this action is
  // called directly, outside that machinery — e.g. by
  // tests/integration/self-check-in-action.test.ts, following this
  // codebase's established pattern of invoking exported action functions
  // directly rather than through cookies/a real request. The check-in
  // itself already succeeded and is committed; losing the cache-invalidation
  // signal in that one calling context must not fail the whole action.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/portal`);
  } catch (error) {
    console.error("[self-check-in] failed to revalidate /portal", { error });
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
