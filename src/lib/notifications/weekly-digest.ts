import { DateTime } from "luxon";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { unscopedPrisma } from "@/lib/prisma/unscoped";
import { requireEnv } from "@/lib/env";
import { ZONE, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { resolveSystemJobContext } from "@/lib/tenant/context";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { dispatchToRecipients } from "@/lib/notifications/dispatch";
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
 * cookie-bound staff request) — both are called with a real `SystemJobContext`
 * (MULTI_ACADEMY_AND_KIDS_BELTS.md Appendix C: a job is never represented as
 * a synthetic membership/session), which auto-passes both functions' own
 * role gates. `SystemJobContext` itself is org-wide, not academy-scoped, so
 * this narrows to exactly this one academy via each function's own
 * `academyId` parameter — the same `filters.academyId` narrowing pattern
 * the analytics module already established, applied here to the digest's
 * per-academy dispatch.
 */
export async function sendWeeklyDigestForAcademy(
  academyId: string,
  resendClient: ResendClient = new Resend(requireEnv("RESEND_API_KEY")),
): Promise<void> {
  // Explicit escape hatch (revision 23): this is the org-identity resolution
  // itself — no organizationId is known yet at this line, so it can't scope
  // the lookup that discovers it.
  const academy = await unscopedPrisma.academy.findUniqueOrThrow({ where: { id: academyId } });
  const jobContext = await resolveSystemJobContext(academy.organizationId, "weekly-digest");
  // The organization was suspended/cancelled between the cron route's own
  // dispatch loop and this call — skip, per spec: "Skip non-active
  // organizations." The route's own loop is expected to filter by active
  // organizations too; this is the same fail-closed check repeated at the
  // point where it actually matters, not trusted away.
  if (!jobContext) return;

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
      where: {
        organizationId: jobContext.organizationId,
        academyId,
        type: "CHECKIN",
        date: { gte: windowStart, lte: windowEnd },
      },
    }),
    // The full returned list already IS "students inactive 30+ days" (every
    // bucket `getRetentionList` returns is 30+ days quiet) — no further
    // filtering needed, just its length.
    // `from` is a required field of `AnalyticsFilters` but `getRetentionList`
    // never reads it (its inactivity classification only looks at `to`) — the
    // value here is inert, so it's just `DateTime.now()` rather than a
    // `.minus({ days: 7 })` that reads as if it bounded something it doesn't.
    getRetentionList(jobContext, { from: DateTime.now(), to: DateTime.now(), academyId }),
    listOverdueStudents(jobContext, undefined, academyId),
    resolveStaffRecipients(academyId),
  ]);

  const channel = new EmailChannel(resendClient);

  // Routed through dispatchToRecipients/dispatchNotification (same as the
  // other 3 triggers) rather than calling channel.send directly in a bare
  // Promise.all: that used to discard every DeliveryResult, so a failed
  // digest email (bad API key, bounced address, Resend outage) was silently
  // swallowed. dispatchNotification's existing failure logging/isolation now
  // applies here for free, with no separate error-handling logic needed.
  // `channels: [channel]` (never ALL_CHANNELS) is what keeps this EMAIL-ONLY
  // per the plan's ruling — it must never write an in-app Notification row.
  await dispatchToRecipients(
    recipients,
    "WEEKLY_DIGEST",
    {
      academyName: academy.name,
      attendanceCount,
      inactiveCount: inactiveStudents.length,
      overduePayments: overdueStudents.length,
    },
    [channel],
  );
}
