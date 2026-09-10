import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import type { DeliveryResult, NotificationChannel, Recipient, RenderedMessage } from "../../src/lib/notifications/types";

const { InAppChannel } = await import("../../src/lib/notifications/in-app-channel");
const { dispatchNotification } = await import("../../src/lib/notifications/dispatch");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupUserIds.length > 0) {
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeUser() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `notif-dispatch-${suffix}@example.com`,
      passwordHash: "x",
      role: "INSTRUCTOR",
      active: true,
      locale: "es",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

/** A fake channel that always throws, to prove one channel's failure never blocks others. */
class ThrowingChannel implements NotificationChannel {
  supportsInboundReplies = false;
  async send(_to: Recipient, _message: RenderedMessage): Promise<DeliveryResult> {
    throw new Error("boom: this channel always fails");
  }
}

/** A fake channel that records every (recipient, message) pair it was called with. */
class RecordingChannel implements NotificationChannel {
  supportsInboundReplies = false;
  calls: Array<{ to: Recipient; message: RenderedMessage }> = [];
  async send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult> {
    this.calls.push({ to, message });
    return { success: true };
  }
}

describe("InAppChannel", () => {
  afterAll(cleanup);

  it("send creates a real Notification row with readAt null and the right userId/type/title/body", async () => {
    const user = await makeUser();
    const channel = new InAppChannel();
    const recipient: Recipient = { userId: user.id, email: user.email, locale: user.locale };
    const message: RenderedMessage = { type: "NEW_SIGNUP", title: "Nueva inscripción", body: "Alguien se registró." };

    const result = await channel.send(recipient, message);
    expect(result.success).toBe(true);
    expect(channel.supportsInboundReplies).toBe(false);

    const row = await prisma.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.readAt).toBeNull();
    expect(row.type).toBe("NEW_SIGNUP");
    expect(row.title).toBe("Nueva inscripción");
    expect(row.body).toBe("Alguien se registró.");
  });
});

describe("dispatchNotification", () => {
  afterAll(cleanup);

  it("calls every channel for every recipient", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const recipients: Recipient[] = [
      { userId: userA.id, email: userA.email, locale: userA.locale },
      { userId: userB.id, email: userB.email, locale: userB.locale },
    ];
    const message: RenderedMessage = { type: "NEW_SIGNUP", title: "t", body: "b" };
    const channel1 = new RecordingChannel();
    const channel2 = new RecordingChannel();

    await dispatchNotification(recipients, message, [channel1, channel2]);

    expect(channel1.calls).toHaveLength(2);
    expect(channel2.calls).toHaveLength(2);
    expect(channel1.calls.map((c) => c.to.userId).sort()).toEqual([userA.id, userB.id].sort());
    expect(channel2.calls.map((c) => c.to.userId).sort()).toEqual([userA.id, userB.id].sort());
  });

  it("one channel throwing for one recipient doesn't prevent other recipients/channels from being attempted (settles via Promise.allSettled)", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const recipients: Recipient[] = [
      { userId: userA.id, email: userA.email, locale: userA.locale },
      { userId: userB.id, email: userB.email, locale: userB.locale },
    ];
    const message: RenderedMessage = { type: "NEW_SIGNUP", title: "t", body: "b" };
    const throwing = new ThrowingChannel();
    const recording = new RecordingChannel();

    // Must resolve (not reject) even though `throwing` always throws for
    // every recipient.
    await expect(dispatchNotification(recipients, message, [throwing, recording])).resolves.toBeUndefined();

    // The healthy channel was still attempted for both recipients despite
    // the other channel's failures.
    expect(recording.calls).toHaveLength(2);
  });

  it("a real InAppChannel writes a Notification row for each recipient even when dispatched alongside a throwing channel", async () => {
    const userA = await makeUser();
    const message: RenderedMessage = { type: "NEW_SIGNUP", title: "t2", body: "b2" };
    const inApp = new InAppChannel();
    const throwing = new ThrowingChannel();

    await dispatchNotification([{ userId: userA.id, email: userA.email, locale: userA.locale }], message, [
      throwing,
      inApp,
    ]);

    const row = await prisma.notification.findFirstOrThrow({ where: { userId: userA.id, title: "t2" } });
    expect(row.body).toBe("b2");
  });
});
