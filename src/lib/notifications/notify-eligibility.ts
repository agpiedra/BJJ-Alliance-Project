import { prisma } from "@/lib/prisma";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { dispatchToRecipients } from "@/lib/notifications/dispatch";
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
    // `student.currentStripes` is still the OLD count here — performCheckIn
    // never mutates it; a promotion is always staff-confirmed later via
    // confirmPromotion (which sets `toStripes: currentStripes + 1`). So the
    // stripe this student just became ELIGIBLE for is currentStripes + 1,
    // not currentStripes itself — see templates.ts's STRIPE_THRESHOLD case
    // and its "eligible for" (not "earned") copy.
    const data = {
      studentName: `${student.firstName} ${student.lastName}`,
      belt: student.currentBelt,
      stripes: student.currentStripes + 1,
    };

    const resolvedChannels = channels ?? (await import("@/lib/notifications/channels")).ALL_CHANNELS;
    await dispatchToRecipients(recipients, type, data, resolvedChannels);
  } catch (error) {
    console.error("notifyEligibilityReached failed (non-fatal)", error);
  }
}
