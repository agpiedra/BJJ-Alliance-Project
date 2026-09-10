import { DateTime } from "luxon";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { ZONE, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import type { StaffSession } from "@/lib/auth/session";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { renderNotificationMessage } from "@/lib/notifications/templates";
import { EmailChannel, type ResendClient } from "@/lib/notifications/email-channel";
import { listOverdueStudents } from "@/lib/payments/list-overdue";
import { getRetentionList } from "@/lib/analytics/retention";

/**
 * Sends one academy's weekly digest email to every resolved staff recipient
 * (ADMIN + that academy's assigned DIRECTOR/INSTRUCTOR staff, per
 * `resolveStaffRecipients`) — EMAIL-ONLY per this plan's own ruling, so
 * `EmailChannel` is constructed directly here rather than going through
 * `ALL_CHANNELS` (which also includes `InAppChannel`).
 *
 * `resendClient` is optional purely for testability — same DI seam
 * `EmailChannel` itself already establishes (a fake `emails.send` stub avoids
 * a real network call and a real `RESEND_API_KEY`), threaded one level up so
 * a test can call this function directly instead of reaching around it.
 * Production callers (the cron route) omit it and get the real `Resend`
 * client, matching `channels.ts`'s own construction.
 *
 * Neither `listOverdueStudents` nor `getRetentionList` have a caller session
 * available here (this runs from a cron-triggered background job, not a
 * cookie-bound staff request) — both are called with a SYNTHETIC
 * `StaffSession` (`role: "DIRECTOR"`, `academyIds: [academyId]`), which
 * passes both functions' own role gates and scopes both to exactly this one
 * academy via `academyScopeWhere`.
 */
export async function sendWeeklyDigestForAcademy(
  academyId: string,
  resendClient: ResendClient = new Resend(requireEnv("RESEND_API_KEY")),
): Promise<void> {
  const academy = await prisma.academy.findUniqueOrThrow({ where: { id: academyId } });
  const session: StaffSession = { userId: "system:weekly-digest", role: "DIRECTOR", academyIds: [academyId] };

  // Trailing 7 real days, inclusive of today: [today - 6 days, today] against
  // `AttendanceRecord.date` (the pre-computed CR-calendar-day column, not a
  // naive UTC slice of `occurredAt` — see that column's own schema comment).
  // Only `CHECKIN` counts as a real attendance fact, matching
  // `getHeadlineTiles`'s `totalAttendances` precedent (an `ADJUSTMENT` is a
  // correction, not a physical check-in).
  const todayCr = DateTime.now().setZone(ZONE);
  const windowStart = attendanceDateFromZoned(todayCr.minus({ days: 6 }));
  const windowEnd = attendanceDateFromZoned(todayCr);

  const [attendanceCount, inactiveStudents, overdueStudents, recipients] = await Promise.all([
    prisma.attendanceRecord.count({
      where: { academyId, type: "CHECKIN", date: { gte: windowStart, lte: windowEnd } },
    }),
    // The full returned list already IS "students inactive 30+ days" (every
    // bucket `getRetentionList` returns is 30+ days quiet) — no further
    // filtering needed, just its length.
    getRetentionList(session, { from: DateTime.now().minus({ days: 7 }), to: DateTime.now(), academyId: null }),
    listOverdueStudents(session),
    resolveStaffRecipients(academyId),
  ]);

  const channel = new EmailChannel(resendClient);

  await Promise.all(
    recipients.map((recipient) => {
      const message = renderNotificationMessage(
        "WEEKLY_DIGEST",
        {
          academyName: academy.name,
          attendanceCount,
          inactiveCount: inactiveStudents.length,
          overduePayments: overdueStudents.length,
        },
        recipient.locale,
      );
      return channel.send(recipient, message);
    }),
  );
}
