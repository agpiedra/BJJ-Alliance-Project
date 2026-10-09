import { DateTime } from "luxon";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { resolveAcademyByIdOrThrow } from "@/lib/tenant/platform-lookups";
import { requireEnv } from "@/lib/env";
import { ZONE, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { resolveSystemJobContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { SystemJobContext } from "@/lib/tenant/types";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { dispatchToRecipients } from "@/lib/notifications/dispatch";
import { EmailChannel, type ResendClient } from "@/lib/notifications/email-channel";
import { listOverdueStudents, type OverdueStudent } from "@/lib/payments/list-overdue";
import { getRetentionList } from "@/lib/analytics/retention";
import { isLedgerActiveForOrg, listRosterPaymentFacts } from "@/lib/dues/roster-payment-facts-queries";
import { summarizeLedgerOverdue, type LedgerOverdueSummary } from "@/lib/dues/ledger-overdue-summary";

const EMPTY_LEDGER_OVERDUE: LedgerOverdueSummary = {
  monthlyPastGraceCount: 0,
  monthlyPastGraceNote: "",
  signupPastDueCount: 0,
  signupPastDueNote: "",
  unknownCount: 0,
};

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1/§4 (PR 4): the ledger-backed replacement for this academy's
 * `listOverdueStudents` count, reusing PR 3's own population/aggregation wiring verbatim
 * (`summarizeLedgerOverdue`, `src/lib/dues/ledger-overdue-summary.ts`) — Decision 2's population (every
 * student status, no `status` filter) narrowed to this one academy via `homeAcademyId`, the same narrowing
 * `listOverdueStudents` itself already applies for this caller (`list-overdue.ts`'s own `academyId` param).
 * `jobContext` is a real `SystemJobContext`, never a fabricated `ADMIN` context or an unsafe cast — both
 * `getScopedDb` and `listRosterPaymentFacts` already define correct, narrower behavior for it (§4 item 4).
 * The digest has no per-recipient locale yet at this point (rendered later, once per recipient, by
 * `renderNotificationMessage`) — the identity function is passed for `tStatus`, and only the two counts and
 * `unknownCount` are read from the result; the `*Note` name strings are discarded.
 */
async function summarizeLedgerOverdueForAcademy(
  jobContext: SystemJobContext,
  academyId: string,
  ledgerNow: Date,
): Promise<LedgerOverdueSummary> {
  const students = await getScopedDb(jobContext).student.findMany({
    where: { homeAcademyId: academyId },
    select: { id: true, firstName: true, lastName: true, status: true },
  });
  if (students.length === 0) return EMPTY_LEDGER_OVERDUE;
  const { byStudentId } = await listRosterPaymentFacts(jobContext, students.map((s) => s.id), ledgerNow);
  return summarizeLedgerOverdue(students, byStudentId, (status) => status);
}

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
/** C1: what one academy's digest actually did — the counts `run-scheduled-job.ts` (via the
 * cron route) needs for the JobRun row and the Healthchecks.io heartbeat. `skipped: 1`
 * means nothing was owed to anyone here (no staff on file, or the organization is no
 * longer active) — that must never register as a failure on the dead-man's switch. */
export interface DigestResult {
  organizationId: string;
  sent: number;
  failed: number;
  skipped: number;
}

export async function sendWeeklyDigestForAcademy(
  academyId: string,
  resendClient: ResendClient = new Resend(requireEnv("RESEND_API_KEY")),
): Promise<DigestResult> {
  // See platform-lookups.ts's resolveAcademyByIdOrThrow for why this
  // org-identity resolution can't itself be organization-scoped.
  const academy = await resolveAcademyByIdOrThrow(academyId);
  const jobContext = await resolveSystemJobContext(academy.organizationId, "weekly-digest");
  // The organization was suspended/cancelled between the cron route's own
  // dispatch loop and this call — skip, per spec: "Skip non-active
  // organizations." The route's own loop is expected to filter by active
  // organizations too; this is the same fail-closed check repeated at the
  // point where it actually matters, not trusted away. A SKIP (C1 decision
  // #2), never a failure: nothing was owed to anyone here.
  if (!jobContext) return { organizationId: academy.organizationId, sent: 0, failed: 0, skipped: 1 };

  // Trailing 7 real days, inclusive of today: [today - 6 days, today] against
  // `AttendanceRecord.date` (the pre-computed CR-calendar-day column, not a
  // naive UTC slice of `occurredAt` — see that column's own schema comment).
  // Only `CHECKIN` counts as a real attendance fact, matching
  // `getHeadlineTiles`'s `totalAttendances` precedent (an `ADJUSTMENT` is a
  // correction, not a physical check-in).
  const todayCr = DateTime.now().setZone(ZONE);
  const windowStart = attendanceDateFromZoned(todayCr.minus({ days: 6 }));
  const windowEnd = attendanceDateFromZoned(todayCr);

  // §2.1/§4: ONE captured flag, read once, before the legacy-vs-ledger decision below — same convention
  // every other cutover page already established (dashboard/portal/roster/student-detail/payments).
  const ledgerActive = await isLedgerActiveForOrg(jobContext.organizationId);
  // §4: the one captured instant shared by every ledger read this digest makes (today, exactly one —
  // `summarizeLedgerOverdueForAcademy`'s own `listRosterPaymentFacts` call) — kept separate from, and never
  // substituted for, `todayCr`'s unrelated existing role driving the attendance window above.
  const ledgerNow = todayCr.toJSDate();

  const [attendanceCount, inactiveStudents, recipients, overdueStudents, ledgerOverdue] = await Promise.all([
    prisma.attendanceRecord.count({
      where: {
        organizationId: jobContext.organizationId,
        academyId,
        type: "CHECKIN",
        voidedAt: null,
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
    resolveStaffRecipients(academyId),
    // §6: the legacy reader is never invoked at all once `ledgerActive` — not merely computed and discarded
    // (dashboard's own precedent, `dashboard/page.tsx`'s `listOverdueStudents` ternary).
    !ledgerActive ? listOverdueStudents(jobContext, undefined, academyId) : Promise.resolve<OverdueStudent[]>([]),
    // §2.1/Decision 1/Decision 2: the ledger-backed replacement — two independent counts, over a population
    // that includes inactive/archived students with qualifying old debt, scoped to this one academy.
    // Computed only when it would actually be used.
    ledgerActive ? summarizeLedgerOverdueForAcademy(jobContext, academyId, ledgerNow) : Promise.resolve(EMPTY_LEDGER_OVERDUE),
  ]);

  // C1 decision #2: no staff email on file is a SKIP, not a failure — distinct from an
  // email that was attempted and bounced (dispatchNotification's own failure path below).
  if (recipients.length === 0) {
    return { organizationId: academy.organizationId, sent: 0, failed: 0, skipped: 1 };
  }

  const channel = new EmailChannel(resendClient);

  // Routed through dispatchToRecipients/dispatchNotification (same as the
  // other 3 triggers) rather than calling channel.send directly in a bare
  // Promise.all: that used to discard every DeliveryResult, so a failed
  // digest email (bad API key, bounced address, Resend outage) was silently
  // swallowed. dispatchNotification's existing failure logging/isolation now
  // applies here for free, with no separate error-handling logic needed.
  // `channels: [channel]` (never ALL_CHANNELS) is what keeps this EMAIL-ONLY
  // per the plan's ruling — it must never write an in-app Notification row.
  const delivery = await dispatchToRecipients(
    recipients,
    "WEEKLY_DIGEST",
    {
      academyName: academy.name,
      attendanceCount,
      inactiveCount: inactiveStudents.length,
      ledgerActive,
      overduePayments: overdueStudents.length,
      monthlyPastGraceCount: ledgerOverdue.monthlyPastGraceCount,
      signupPastDueCount: ledgerOverdue.signupPastDueCount,
      unknownCount: ledgerOverdue.unknownCount,
    },
    [channel],
  );
  return { organizationId: academy.organizationId, sent: delivery.sent, failed: delivery.failed, skipped: 0 };
}
