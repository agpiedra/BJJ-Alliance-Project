import { prisma } from "@/lib/prisma";
import { routing } from "@/i18n/routing";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { renderNotificationMessage } from "@/lib/notifications/templates";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import type { NotificationChannel } from "@/lib/notifications/types";

/**
 * Best-effort notification that a student crossed the next-stripe or
 * exam-eligibility threshold — called fire-and-forget from
 * `performCheckIn`'s hook. Never throws: a missing student, a DB error
 * resolving recipients, or a channel dispatch failure are all swallowed
 * here, since the caller cannot tolerate an unhandled rejection.
 *
 * `channels` defaults to `ALL_CHANNELS`, loaded via a dynamic `import()`
 * only when the caller omits it — `channels.ts` eagerly constructs a real
 * Resend client and calls `requireEnv("RESEND_API_KEY")` at module-load
 * time, so a top-level import here would force every test of this function
 * to have that env var set even when it injects its own fake channels.
 * Deferring the import also means a missing/invalid `RESEND_API_KEY` in
 * production surfaces as a caught rejection here, not an unhandled one.
 */
export async function notifyEligibilityReached(
  studentId: string,
  type: "STRIPE_THRESHOLD" | "EXAM_THRESHOLD",
  channels?: NotificationChannel[],
): Promise<void> {
  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { firstName: true, lastName: true, currentBelt: true, currentStripes: true, homeAcademyId: true },
    });
    if (!student) return;

    const recipients = await resolveStaffRecipients(student.homeAcademyId);
    const message = renderNotificationMessage(
      type,
      {
        studentName: `${student.firstName} ${student.lastName}`,
        belt: student.currentBelt,
        stripes: student.currentStripes,
      },
      routing.defaultLocale,
    );

    const resolvedChannels = channels ?? (await import("@/lib/notifications/channels")).ALL_CHANNELS;
    await dispatchNotification(recipients, message, resolvedChannels);
  } catch (error) {
    console.error("notifyEligibilityReached failed (non-fatal)", error);
  }
}
