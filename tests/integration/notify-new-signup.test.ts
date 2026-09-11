import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";
import type { DeliveryResult, NotificationChannel, Recipient, RenderedMessage } from "../../src/lib/notifications/types";

const { notifyNewSignup } = await import("../../src/lib/notifications/notify-new-signup");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeStaff(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", academyId?: string, locale: string = "es") {
  const user = await prisma.user.create({
    data: {
      email: `notif-signup-${suffix()}@example.com`,
      passwordHash: "x",
      role,
      active: true,
      locale,
    },
  });
  cleanupUserIds.push(user.id);
  if (role !== "ADMIN" && academyId) {
    await prisma.staffAssignment.create({ data: { userId: user.id, academyId, role } });
  }
  return user;
}

async function makeStudent(homeAcademyId: string) {
  const student = await prisma.student.create({
    data: {
      homeAcademyId,
      firstName: "Luis",
      lastName: "Gomez",
      phone: "8888-1111",
      email: `notif-signup-student-${suffix()}@example.com`,
      currentBelt: "WHITE",
      currentStripes: 0,
      codeHash: await hashSecret(`notif-signup-code-${suffix()}`),
      status: "PENDING",
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

class RecordingChannel implements NotificationChannel {
  supportsInboundReplies = false;
  calls: Array<{ to: Recipient; message: RenderedMessage }> = [];
  async send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult> {
    this.calls.push({ to, message });
    return { success: true };
  }
}

describe("notifyNewSignup", () => {
  afterAll(cleanup);

  it("dispatches NEW_SIGNUP to the right academy's staff (not the other academy's) on both an in-app and an email channel", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const admin = await makeStaff("ADMIN");
    const escazuDirector = await makeStaff("DIRECTOR", escazu.id);
    const escalanteInstructor = await makeStaff("INSTRUCTOR", escalante.id);

    const student = await makeStudent(escazu.id);
    // Two fakes standing in for InAppChannel and EmailChannel — NOT a real
    // InAppChannel, for the same reason documented in
    // notify-eligibility.test.ts: resolveStaffRecipients returns every
    // active ADMIN system-wide, including ones owned by other, concurrently
    // running test files, and a real InAppChannel would write real
    // Notification rows against those foreign fixtures, breaking their
    // unrelated `user.deleteMany` cleanup via the `Notification` FK.
    const inAppChannel = new RecordingChannel();
    const emailChannel = new RecordingChannel();

    await notifyNewSignup(student.id, [inAppChannel, emailChannel]);

    for (const channel of [inAppChannel, emailChannel]) {
      // Presence, not exact-list equality — leftover ADMIN fixture rows can
      // exist in the shared local dev DB (same pollution `seed.test.ts`
      // flakes on).
      const recipientIds = channel.calls.map((c) => c.to.userId);
      expect(recipientIds).toContain(admin.id);
      expect(recipientIds).toContain(escazuDirector.id);
      expect(recipientIds).not.toContain(escalanteInstructor.id);
      expect(channel.calls[0].message.type).toBe("NEW_SIGNUP");
    }
  });

  it("sends each recipient content in THEIR OWN locale, not a single shared locale for everyone", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const enAdmin = await makeStaff("ADMIN", undefined, "en");
    const esDirector = await makeStaff("DIRECTOR", escazu.id, "es");
    const student = await makeStudent(escazu.id);
    const channel = new RecordingChannel();

    await notifyNewSignup(student.id, [channel]);

    const toEnAdmin = channel.calls.find((c) => c.to.userId === enAdmin.id);
    const toEsDirector = channel.calls.find((c) => c.to.userId === esDirector.id);
    expect(toEnAdmin).toBeDefined();
    expect(toEsDirector).toBeDefined();

    // Same event (one signup), different recipients, different locale
    // content — the I-2 bug: everyone used to get one shared-locale message.
    expect(toEnAdmin!.message.body).toContain("signed up");
    expect(toEsDirector!.message.body).toContain("registró");
    expect(toEnAdmin!.message.body).not.toBe(toEsDirector!.message.body);
  });

  it("never throws for a missing/invalid studentId", async () => {
    const recording = new RecordingChannel();
    await expect(notifyNewSignup("does-not-exist-id", [recording])).resolves.toBeUndefined();
    expect(recording.calls).toHaveLength(0);
  });
});
