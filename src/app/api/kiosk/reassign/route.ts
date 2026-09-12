import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { reassignAttendance } from "@/lib/kiosk/reassign-attendance";
import { attendanceDateDayOfWeek } from "@/lib/scheduling/zone";
import { AttendanceMatchSource } from "@/generated/prisma/client";

// Touches Prisma — Node runtime only, same as the check-in route.

/**
 * The kiosk confirmation screen's "¿No es esta clase?" link (REDESIGN_BRIEF.md
 * Phase 9), in two modes against the same device-token gate:
 *
 *   POST { academySlug, token, attendanceRecordId }
 *     -> 200 { ok: true, picklist: [...] }      the classes to choose from
 *   POST { academySlug, token, attendanceRecordId, classSessionId }
 *     -> 200 { ok: true, matchedClass: {...} }  reassignment done
 *     -> 400 { ok: false, error: "notFound" | "invalidClass" | "alreadyRecorded" }
 *
 * Deliberately NOT behind `reserveKioskAttempt`: the rate limiter exists to
 * stop PIN guessing, and this endpoint accepts no PIN. Reaching it at all
 * requires a valid device token AND the cuid of an attendance row at that same
 * academy, and the worst it can do is move that one row between two of that
 * academy's own classes on its own day.
 *
 * The picklist is derived from the RECORD's ledger day, not from the server's
 * current weekday — a check-in made just before CR midnight must still offer
 * that class's day, not the one that started a minute ago.
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
  // same deliberately indistinguishable failure shape, as the check-in route.
  const academy = await prisma.academy.findUnique({ where: { slug: academySlug } });
  if (!academy) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 404 });
  }

  if (digestLookupSecret(token, requireEnv("CODE_PEPPER")) !== academy.kioskTokenHash) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 401 });
  }

  const record = await prisma.attendanceRecord.findUnique({
    where: { id: attendanceRecordId },
    select: { id: true, academyId: true, date: true, student: { select: { userId: true } } },
  });

  if (!record || record.academyId !== academy.id) {
    return NextResponse.json({ ok: false, error: "notFound" }, { status: 400 });
  }

  if (classSessionId === undefined) {
    const sessions = await prisma.classSession.findMany({
      where: {
        academyId: academy.id,
        active: true,
        dayOfWeek: attendanceDateDayOfWeek(record.date),
      },
      orderBy: { startTime: "asc" },
      select: { id: true, name: true, startTime: true, type: true },
    });
    return NextResponse.json({ ok: true, picklist: sessions }, { status: 200 });
  }

  const result = await reassignAttendance(record.id, classSessionId, {
    // The student's own linked account when they have one; otherwise no
    // AuditLog actor exists to write (see reassign-attendance.ts).
    actorUserId: record.student.userId,
    // A student fixing their own just-created check-in is still "the student
    // picked it" — STAFF_CORRECTED is reserved for the Kiosco page's action.
    matchSource: AttendanceMatchSource.STUDENT_PICKED,
    expectedAcademyId: academy.id,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
