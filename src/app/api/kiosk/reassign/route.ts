import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAcademyBySlug } from "@/lib/tenant/platform-lookups";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { reassignAttendance } from "@/lib/kiosk/reassign-attendance";
import { openOccurrences } from "@/lib/scheduling/check-in-window";
import { toOpenClassEntry } from "@/lib/kiosk/perform-check-in";
import { AttendanceMatchSource } from "@/generated/prisma/client";
import type { KioskContext } from "@/lib/tenant/types";

// Touches Prisma — Node runtime only, same as the check-in route.

/**
 * The kiosk confirmation screen "not this class" link (REDESIGN_BRIEF.md Phase 9), in two modes against the same
 * device-token gate:
 *
 *   POST { academySlug, token, attendanceRecordId }
 *     -> 200 { ok: true, picklist: [...] }      the OTHER classes that were open when the attendance was recorded
 *   POST { academySlug, token, attendanceRecordId, classSessionId }
 *     -> 200 { ok: true, matchedClass: {...} }  reassignment done
 *     -> 400 { ok: false, error: "notFound" | "invalidClass" | "classNotOpen" | "alreadyRecorded" }
 *
 * This is the STUDENT-facing correction, so it obeys the same check-in window as the check-in itself: the target must
 * be open at the instant the attendance was recorded (start -30 minutes to end +30 minutes, that class's own duration),
 * both when the choices are listed and again when one is submitted. A correction can never produce an attendance the
 * check-in would have refused. (A coach correcting from the Kiosco page is a different action with no window.)
 *
 * Deliberately NOT behind `reserveKioskAttempt`: the rate limiter exists to
 * stop PIN guessing, and this endpoint accepts no PIN. Reaching it at all
 * requires a valid device token AND the cuid of an attendance row at that same
 * academy, and the worst it can do is move that one row between two of that
 * academy's own classes that were open at its own instant.
 */
export async function POST(request: Request) {
  let body: {
    academySlug?: unknown;
    token?: unknown;
    attendanceRecordId?: unknown;
    classSessionId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const { academySlug, token, attendanceRecordId, classSessionId } = body;
  if (
    typeof academySlug !== "string" ||
    typeof token !== "string" ||
    typeof attendanceRecordId !== "string" ||
    (classSessionId !== undefined && typeof classSessionId !== "string")
  ) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  // Same academy lookup + token verification, in the same order and with the
  // same deliberately indistinguishable failure shape, as the check-in route
  // — see platform-lookups.ts for why this can't be organization-scoped.
  const academy = await resolveAcademyBySlug(academySlug);
  if (!academy) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 404 });
  }

  if (digestLookupSecret(token, requireEnv("CODE_PEPPER")) !== academy.kioskTokenHash) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 401 });
  }

  const record = await prisma.attendanceRecord.findUnique({
    where: { id: attendanceRecordId, organizationId: academy.organizationId },
    select: { id: true, academyId: true, occurredAt: true, classSessionId: true, student: { select: { userId: true } } },
  });

  if (!record || record.academyId !== academy.id) {
    return NextResponse.json({ ok: false, error: "notFound" }, { status: 400 });
  }

  if (classSessionId === undefined) {
    // The classes that were open at the instant of the original tap (the same rule as the check-in), minus the one it
    // is already on. Derived from the RECORD, not from the current time: a correction a moment later must still offer
    // the classes the student could have attended when they tapped.
    const sessions = await prisma.classSession.findMany({
      where: { organizationId: academy.organizationId, academyId: academy.id, active: true },
    });
    const picklist = openOccurrences(sessions, record.occurredAt)
      .filter((occurrence) => occurrence.session.id !== record.classSessionId)
      .map(toOpenClassEntry);
    return NextResponse.json({ ok: true, picklist }, { status: 200 });
  }

  const kioskContext: KioskContext = { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
  const result = await reassignAttendance(record.id, classSessionId, {
    // The student's own linked account when they have one; otherwise no
    // AuditLog actor exists to write (see reassign-attendance.ts).
    actorUserId: record.student.userId,
    // A student fixing their own just-created check-in is still "the student
    // picked it" — STAFF_CORRECTED is reserved for the Kiosco page's action. The target must have been open when the
    // attendance was recorded: the window rule applies to the student's correction exactly as to the check-in.
    matchSource: AttendanceMatchSource.STUDENT_PICKED,
    requireOpenAt: record.occurredAt,
    expectedAcademyId: academy.id,
    context: kioskContext,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
