"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";
import { performCheckIn, type ProgressOutcome } from "@/lib/kiosk/perform-check-in";
import { AttendanceSource } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import type { AtBeltSummary } from "@/lib/students/attendance-summary";

export type SelfCheckInState = ActionState & {
  student?: { firstName: string; lastName: string; currentBelt: string; currentStripes: number };
  summary?: AtBeltSummary;
  /** This check-in reached the threshold: eligible for instructor review (a check-in never awards anything). */
  thresholdReached?: boolean;
  progressOutcome?: ProgressOutcome;
  isVisitor?: boolean;
  homeAcademyName?: string;
  /** The class this check-in was recorded on (echoes the student's own selection; the page re-renders that row). */
  classSessionId?: string;
};

// The student checks in to an EXPLICIT class from today's list (PR 3). The only client input is that class id
// (`classSessionId`); WHO is checking in comes from the caller's own session and WHEN from the server clock, both
// resolved server-side. The id is never trusted: the shared core validates it against the student's own academy,
// its active state and its check-in window (start -30 minutes to end +30 minutes, that class's own duration) under the portal's OPEN_ONLY policy, so the
// list on screen is a convenience, not the eligibility boundary. Unlike the attended kiosk, the portal has no
// "no class matched, save it unattributed" fallback: no selection is refused.
export async function selfCheckIn(
  organizationId: string,
  _prevState: SelfCheckInState,
  formData: FormData,
): Promise<SelfCheckInState> {
  // Any ACTIVE member — a coach who also trains checks in for THEIR OWN training
  // like anyone else. What matters is not the membership role but whether this
  // account has a linked, ACTIVE student record in the organization the caller
  // NAMES (`resolveActionContext` re-verifies membership in it).
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);
  if (!auth.ok) return { error: "invalid_code" };
  const context = auth.context;

  // `linkedStudentId` is the caller's own record, re-derived from the database —
  // there is no student id in the input to substitute. When there is none, say
  // honestly why: a record that EXISTS but is not active (pending, archived) is
  // `notActive` — the portal is not anonymous, so the honest message beats the
  // kiosk's generic one — and no record at all is the generic error.
  const studentId = context.linkedStudentId;
  if (!studentId) {
    const own = await prisma.student.findUnique({
      where: { userId: context.actorUserId, organizationId: context.organizationId },
      select: { id: true },
    });
    return { error: own ? "notActive" : "invalid_code" };
  }

  // A student acting on their own row, not a staff member acting on someone
  // else's — the tenant context itself (re-verified against the DB inside
  // requireTenantContext) already IS the ownership proof, so none of the
  // staff "scope by id AND owner" ceremony applies to this lookup.
  const student = await prisma.student.findUnique({
    where: { id: studentId, organizationId: context.organizationId },
    select: { homeAcademyId: true, status: true },
  });

  // Shouldn't happen given signup's atomic User+Student transaction, but
  // fail closed with the same generic error the rest of this taxonomy uses
  // rather than throwing.
  if (!student) {
    return { error: "invalid_code" };
  }

  // performCheckIn's own resolution branch necessarily (and correctly)
  // returns the generic `invalid_code` for a non-ACTIVE student — it's the
  // shared kiosk/portal core, and an anonymous kiosk shouldn't be able to
  // learn an account's status from a check-in attempt. But the portal page
  // ISN'T anonymous: it already shows this student their own PENDING/
  // ARCHIVED/INACTIVE status in a banner above this button, so silently
  // reusing that generic error here would be a strictly worse message than
  // an honest one — especially since PENDING is every self-signed-up
  // student's default state, not a rare edge case. This check happens
  // BEFORE performCheckIn/any DB write is ever attempted.
  if (student.status !== "ACTIVE") {
    return { error: "notActive" };
  }

  const selected = formData.get("classSessionId");
  if (typeof selected !== "string" || selected === "") {
    return { error: "invalid_class" };
  }

  const result = await performCheckIn({
    academyId: student.homeAcademyId,
    context,
    studentId,
    source: AttendanceSource.PORTAL,
    pickedClassSessionId: selected,
    pickPolicy: "OPEN_ONLY",
  });

  if (!result.ok) {
    return { error: result.error };
  }

  // Without this, the page's OTHER card (getAtBeltSummary, fetched at
  // page-load time via the Server Component render) would keep showing the
  // pre-check-in numbers while this button's own success state shows the
  // fresh ones — two different attendance counts on the same screen.
  // revalidatePath is the load-bearing half of fixing that: calling it here
  // sets Next's internal `pathWasRevalidated` flag, which is what makes THIS
  // action's own response carry a freshly-rendered Server Component payload
  // for the current view — not merely a cache invalidation that only pays
  // off on some future navigation. todays-classes-card.tsx's
  // router.refresh() call is a defensive fallback for if this ever fails
  // silently, not the mechanism this comment used to (incorrectly) credit
  // with "unlocking" fresh data — the fresh data is already carried by this
  // action's response once revalidatePath has run.
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
    thresholdReached: result.thresholdReached,
    progressOutcome: result.progressOutcome,
    isVisitor: result.isVisitor,
    homeAcademyName: result.homeAcademyName,
    classSessionId: result.matchedClass?.id,
  };
}
