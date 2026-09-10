import { prisma } from "@/lib/prisma";
import type { DeliveryResult, NotificationChannel, Recipient, RenderedMessage } from "@/lib/notifications/types";

/** Writes a `Notification` row for the bell — always unread (`readAt: null`) on creation. */
export class InAppChannel implements NotificationChannel {
  supportsInboundReplies = false;

  async send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult> {
    await prisma.notification.create({
      data: {
        userId: to.userId,
        type: message.type,
        title: message.title,
        body: message.body,
        readAt: null,
      },
    });
    return { success: true };
  }
}
