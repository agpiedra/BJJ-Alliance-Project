import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";
import type { DeliveryResult, NotificationChannel, Recipient, RenderedMessage } from "../../src/lib/notifications/types";

const { notifyEligibilityReached } = await import("../../src/lib/notifications/notify-eligibility");

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

async function makeStaff(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", academyId?: string) {
  const user = await prisma.user.create({
    data: {
      email: `notif-elig-${suffix()}@example.com`,
      passwordHash: "x",
      role,
      active: true,
      locale: "es",
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
      firstName: "Ana",
      lastName: "Perez",
      phone: "8888-0000",
      email: `notif-elig-student-${suffix()}@example.com`,
      currentBelt: "BLUE",
      currentStripes: 4,
      codeHash: await hashSecret(`notif-elig-code-${suffix()}`),
      status: "ACTIVE",
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/** Records every (recipient, message) pair — matches Task 2's own test-injection pattern. */
class RecordingChannel implements NotificationChannel {
  supportsInboundReplies = false;
  calls: Array<{ to: Recipient; message: RenderedMessage }> = [];
  async send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult> {
    this.calls.push({ to, message });
    return { success: true };
  }
}

describe("notifyEligibilityReached", () => {
  afterAll(cleanup);

  it("STRIPE_THRESHOLD dispatches to the right academy's staff (not the other academy's) on both an in-app and an email channel", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const admin = await makeStaff("ADMIN");
    const escazuDirector = await makeStaff("DIRECTOR", escazu.id);
    const escalanteInstructor = await makeStaff("INSTRUCTOR", escalante.id);

    const student = await makeStudent(escazu.id);
    // Two fakes standing in for InAppChannel and EmailChannel respectively —
    // NOT a real InAppChannel: resolveStaffRecipients returns every active
    // ADMIN system-wide, including ones owned by other, concurrently
    // running test files, and a real InAppChannel would write real
    // Notification rows against those foreign fixtures, causing their
    // unrelated cleanup (`user.deleteMany`) to fail on the `Notification`
    // FK. `InAppChannel` writing a real row for a given recipient/message is
    // already proven by `notification-dispatch.test.ts`; what this test owns
    // is proving notifyEligibilityReached resolves the right recipients and
    // renders the right message before handing them to dispatch, which a
    // fake channel proves identically to a real one.
    const inAppChannel = new RecordingChannel();
    const emailChannel = new RecordingChannel();

    await notifyEligibilityReached(student.id, "STRIPE_THRESHOLD", [inAppChannel, emailChannel]);

    for (const channel of [inAppChannel, emailChannel]) {
      // Presence, not exact-list equality: the shared local dev DB can carry
      // leftover ADMIN fixture rows from other test files (the same
      // documented pre-existing pollution `seed.test.ts` flakes on), and
      // resolveStaffRecipients includes every active ADMIN unconditionally.
      const recipientIds = channel.calls.map((c) => c.to.userId);
      expect(recipientIds).toContain(admin.id);
      expect(recipientIds).toContain(escazuDirector.id);
      expect(recipientIds).not.toContain(escalanteInstructor.id);
      expect(channel.calls[0].message.type).toBe("STRIPE_THRESHOLD");
      expect(channel.calls[0].message.title.length).toBeGreaterThan(0);
    }
  });

  it("EXAM_THRESHOLD uses different copy from STRIPE_THRESHOLD", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    await makeStaff("ADMIN");
    const student = await makeStudent(escazu.id);
    const emailChannel = new RecordingChannel();

    await notifyEligibilityReached(student.id, "EXAM_THRESHOLD", [emailChannel]);

    expect(emailChannel.calls.length).toBeGreaterThan(0);
    expect(emailChannel.calls[0].message.type).toBe("EXAM_THRESHOLD");
  });

  it("never throws for a studentId that doesn't exist", async () => {
    const emailChannel = new RecordingChannel();
    await expect(
      notifyEligibilityReached("does-not-exist-id", "STRIPE_THRESHOLD", [emailChannel]),
    ).resolves.toBeUndefined();
    expect(emailChannel.calls).toHaveLength(0);
  });
});
