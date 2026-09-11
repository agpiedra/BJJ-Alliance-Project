import { prisma } from "@/lib/prisma";
import { resolveStaffRecipients } from "@/lib/notifications/recipients";
import { dispatchToRecipients } from "@/lib/notifications/dispatch";
import type { NotificationChannel } from "@/lib/notifications/types";

/**
 * Best-effort notification that a new student signed up and is awaiting
 * staff approval — called fire-and-forget from the signup server action.
 * Never throws, same rationale as `notifyEligibilityReached`.
 *
 * `channels` defaults to `ALL_CHANNELS`, loaded via a deferred `import()`
 * only when omitted — see `notifyEligibilityReached` for why the import
 * can't be top-level.
 */
export async function notifyNewSignup(studentId: string, channels?: NotificationChannel[]): Promise<void> {
  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { firstName: true, lastName: true, homeAcademyId: true },
    });
    if (!student) return;

    const recipients = await resolveStaffRecipients(student.homeAcademyId);
    const data = { studentName: `${student.firstName} ${student.lastName}` };

    const resolvedChannels = channels ?? (await import("@/lib/notifications/channels")).ALL_CHANNELS;
    await dispatchToRecipients(recipients, "NEW_SIGNUP", data, resolvedChannels);
  } catch (error) {
    console.error("notifyNewSignup failed (non-fatal)", error);
  }
}
