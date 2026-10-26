import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import type { Prisma } from "../../src/generated/prisma/client";

// Same `auth()` mock as admin-schedule-actions.test.ts: the actions resolve their session through next-auth.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { createClassSession, updateClassSession, deactivateClassSession, deleteClassSession } = await import(
  "../../src/app/[locale]/(staff)/admin/schedule/actions"
);
const { listDeletableClassSessionIds } = await import("../../src/app/[locale]/(staff)/admin/schedule/queries");
const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");
const { listContributingDays } = await import("../../src/lib/promotion/progress-days");

const prisma = getTestPrismaClient();

const cleanupUserIds: string[] = [];
const cleanupOrgIds: string[] = [];
const fixtureAcademyIds: string[] = [];

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function makeUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", organizationId: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: { email: `schedule-delete-${role.toLowerCase()}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role },
  });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId, role } });
  }
  return user;
}

function signIn(user: { id: string; role: string }, organizationId: string) {
  currentSession = { user: { id: user.id, role: user.role }, activeOrganizationId: organizationId };
}

/** A private academy holding ONE class; inactive unless said otherwise. */
async function makeClass(active = false) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", name: `Delete Fixture ${suffix}`, active },
  ]);
  fixtureAcademyIds.push(academy.id);
  return { academy, cls: sessions[0] };
}

function attendanceData(
  cls: { id: string; academyId: string; organizationId: string },
  studentId: string,
  day: string,
  extra: Partial<Prisma.AttendanceRecordUncheckedCreateInput> = {},
): Prisma.AttendanceRecordUncheckedCreateInput {
  return {
    studentId, academyId: cls.academyId, organizationId: cls.organizationId, classSessionId: cls.id,
    occurredAt: new Date(`${day}T00:30:00Z`), date: new Date(`${day}T00:00:00Z`), type: "CHECKIN", source: "KIOSK",
    ...extra,
  };
}

function claim(cls: { id: string; academyId: string; organizationId: string }, studentId: string, status: "PENDING" | "DISMISSED" = "PENDING") {
  return prisma.queuedCheckIn.create({
    data: {
      organizationId: cls.organizationId, academyId: cls.academyId, studentId, eventKey: `id:${Math.random()}`,
      claimedAtVerified: true, claimedClassSessionId: cls.id, reason: "SELECTION_NOT_OPEN", status,
    },
  });
}

/** Every transaction `holdOpen` started, released in `afterEach` even when a test fails, so no lock outlives its test. */
const holds: Array<{ release: () => void; done: Promise<unknown> }> = [];

/** Opens a transaction on the TEST client, runs `work`, then holds it open (and its locks) until `release()`. */
function holdOpen(work: (tx: Prisma.TransactionClient) => Promise<void>, afterRelease?: (tx: Prisma.TransactionClient) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await work(tx);
      markReady();
      await released;
      await afterRelease?.(tx);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  holds.push({ release, done });
  return { ready, release, done };
}

/**
 * Proof that a statement is WAITING on a row lock, not merely slow: some backend whose current query contains `fragment`
 * reports `wait_event_type = 'Lock'`.
 */
async function waitUntilBlocked(fragment: string) {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no backend blocked on: ${fragment}`);
}

// The lock statements of deleteClassSession and of performCheckIn's queued-claim write.
const DELETE_LOCK = `SELECT "active" FROM "ClassSession"`;
const CLAIM_LOCK = `SELECT 1 FROM "ClassSession"`;

describe("deleteClassSession — permanent removal of an unused, inactive class only", () => {
  let orgId: string;
  let admin: { id: string; role: string };

  beforeEach(async () => {
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } })).id;
    admin = await makeUser("ADMIN", orgId);
    signIn(admin, orgId);
  });

  afterEach(async () => {
    for (const hold of holds.splice(0)) {
      hold.release();
      await hold.done.catch(() => undefined);
    }
    currentSession = null;
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: cleanupUserIds } }, { academyId: { in: fixtureAcademyIds } }, { organizationId: { in: cleanupOrgIds } }] },
    });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await cleanupClassFixtures();
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
    cleanupUserIds.length = 0;
    cleanupOrgIds.length = 0;
    fixtureAcademyIds.length = 0;
  });

  it("deletes an unused inactive class, audits the full row, keeps its earlier audit history and frees the slot", async () => {
    const { academy, cls } = await makeClass(true);
    expect((await deactivateClassSession(orgId, {}, formData({ classSessionId: cls.id }))).ok).toBe(true);

    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ ok: true });
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).toBeNull();

    const deleteAudits = await prisma.auditLog.findMany({ where: { entityId: cls.id, action: "classSession.delete" } });
    expect(deleteAudits).toHaveLength(1);
    expect(deleteAudits[0].actorId).toBe(admin.id);
    expect(deleteAudits[0].academyId).toBe(academy.id);
    expect(deleteAudits[0].after).toBeNull();
    expect(deleteAudits[0].before).toEqual({
      dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: cls.name, type: "GI",
      countsTowardPromotion: true, active: false, createdAt: cls.createdAt.toISOString(),
    });
    // The deactivation audited earlier is still there.
    expect(await prisma.auditLog.count({ where: { entityId: cls.id, action: "classSession.deactivate" } })).toBe(1);

    // The same day/time/name slot can be created again.
    const recreated = await createClassSession(
      orgId, {},
      formData({ academyId: academy.id, dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: "60", name: cls.name, type: "GI", countsTowardPromotion: "true" }),
    );
    expect(recreated.ok).toBe(true);
  });

  it("a successful delete leaves every attendance row and the promotion days of the academy's other classes unchanged", async () => {
    const { academy, sessions } = await makeClassAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: `Kept ${Date.now()}` },
      { dayOfWeek: "TUESDAY", startTime: "18:00", name: `Unused ${Date.now()}`, active: false },
    ]);
    fixtureAcademyIds.push(academy.id);
    const [kept, unused] = sessions;
    const { student } = await makeClassStudent(academy.id, orgId);
    await prisma.attendanceRecord.create({ data: attendanceData(kept, student.id, "2026-03-09") });
    await prisma.attendanceRecord.create({ data: attendanceData(kept, student.id, "2026-03-16", { voidedAt: new Date(), voidedById: admin.id, voidReason: "t" }) });
    const from = new Date("2020-01-01");
    const rowsBefore = await prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { id: "asc" } });
    const daysBefore = await listContributingDays(prisma, { studentId: student.id, organizationId: orgId, from });
    expect(daysBefore).toHaveLength(1);

    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: unused.id }))).toEqual({ ok: true });

    expect(await prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { id: "asc" } })).toEqual(rowsBefore);
    expect(await listContributingDays(prisma, { studentId: student.id, organizationId: orgId, from })).toEqual(daysBefore);
    expect(await prisma.classSession.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it("refuses an ACTIVE class (mustDeactivateFirst) and keeps it", async () => {
    const { cls } = await makeClass(true);
    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "mustDeactivateFirst" });
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: cls.id, action: "classSession.delete" } })).toBe(0);
  });

  it("refuses an inactive class with valid attendance (inUse); the row, its link and the promotion days are unchanged", async () => {
    const { academy, cls } = await makeClass(false);
    const { student } = await makeClassStudent(academy.id, orgId);
    const record = await prisma.attendanceRecord.create({ data: attendanceData(cls, student.id, "2026-03-03") });
    const from = new Date("2020-01-01");
    const daysBefore = await listContributingDays(prisma, { studentId: student.id, organizationId: orgId, from });
    expect(daysBefore.map((d) => d.recordId)).toEqual([record.id]);

    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "inUse" });

    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
    expect((await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } })).classSessionId).toBe(cls.id);
    expect(await listContributingDays(prisma, { studentId: student.id, organizationId: orgId, from })).toEqual(daysBefore);
  });

  it("refuses an inactive class whose ONLY attendance is voided (inUse): voided rows are still history", async () => {
    const { academy, cls } = await makeClass(false);
    const { student } = await makeClassStudent(academy.id, orgId);
    await prisma.attendanceRecord.create({
      data: attendanceData(cls, student.id, "2026-03-04", { voidedAt: new Date(), voidedById: admin.id, voidReason: "test" }),
    });
    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "inUse" });
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
  });

  it("refuses an inactive class claimed by a PENDING queued check-in (inUse); once the claim is dismissed it can go", async () => {
    const { academy, cls } = await makeClass(false);
    const { student } = await makeClassStudent(academy.id, orgId);
    const pending = await claim(cls, student.id);

    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "inUse" });
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();

    await prisma.queuedCheckIn.update({ where: { id: pending.id }, data: { status: "DISMISSED", dismissReason: "test" } });
    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ ok: true });
    // The dismissed evidence itself is kept, with the claim exactly as sent.
    expect(await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ claimedClassSessionId: cls.id });
  });

  it("refuses a class claimed by a REAL queued replay written by performCheckIn", async () => {
    const { academy, cls } = await makeClass(false);
    const { student } = await makeClassStudent(academy.id, orgId);
    const now = new Date("2026-03-02T00:30:00Z");
    const queued = await performCheckIn({
      studentId: student.id, academyId: academy.id, source: "KIOSK", now, pickedClassSessionId: cls.id,
      context: { kind: "kiosk", organizationId: orgId, academyId: academy.id },
      replay: { timestampVerified: true, event: { key: "id:delete-real-replay", claimedAtRaw: String(now.getTime()), claimedAt: now } },
    });
    expect(queued).toMatchObject({ ok: false, error: "queued_for_review", duplicate: false });

    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "inUse" });
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
  });

  it("DIRECTOR and INSTRUCTOR are refused (FORBIDDEN) and nothing is deleted", async () => {
    const { academy, cls } = await makeClass(false);
    for (const role of ["DIRECTOR", "INSTRUCTOR"] as const) {
      signIn(await makeUser(role, orgId, academy.id), orgId);
      await expect(deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }))).rejects.toThrow("FORBIDDEN");
    }
    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
  });

  it("an ADMIN of ANOTHER organization cannot delete this organization's class (notFound), nor can this admin through a foreign organizationId", async () => {
    const { cls } = await makeClass(false);
    const otherOrg = await prisma.organization.create({
      data: { slug: `schedule-delete-other-${Date.now()}`, name: "Schedule Delete Other Org", status: "ACTIVE" },
    });
    cleanupOrgIds.push(otherOrg.id);

    // A real ADMIN of the other organization, naming this organization's class id.
    signIn(await makeUser("ADMIN", otherOrg.id), otherOrg.id);
    expect(await deleteClassSession(otherOrg.id, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "notFound" });

    // This organization's ADMIN, with a tab claiming the other organization.
    signIn(admin, orgId);
    expect(await deleteClassSession(otherOrg.id, {}, formData({ classSessionId: cls.id }))).toEqual({ error: "notFound" });

    expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: cls.id, action: "classSession.delete" } })).toBe(0);
  });

  it("listDeletableClassSessionIds offers only unused inactive classes: any attendance (voided too) or a pending claim excludes", async () => {
    const { academy, cls: unused } = await makeClass(false);
    const { cls: attended } = await makeClass(false);
    const { cls: voidedOnly } = await makeClass(false);
    const { cls: pending } = await makeClass(false);
    const { cls: dismissed } = await makeClass(false);
    const { student } = await makeClassStudent(academy.id, orgId);
    await prisma.attendanceRecord.create({ data: attendanceData(attended, student.id, "2026-03-05") });
    await prisma.attendanceRecord.create({
      data: attendanceData(voidedOnly, student.id, "2026-03-06", { voidedAt: new Date(), voidedById: admin.id, voidReason: "t" }),
    });
    await claim(pending, student.id);
    await claim(dismissed, student.id, "DISMISSED");

    const ids = [unused, attended, voidedOnly, pending, dismissed].map((c) => c.id);
    expect([...(await listDeletableClassSessionIds(orgId, ids))].sort()).toEqual([unused.id, dismissed.id].sort());
    expect((await listDeletableClassSessionIds(orgId, [])).size).toBe(0);
  });

  describe("concurrency: row locks, each wait proven through pg_stat_activity", () => {
    it("an attendance insert in flight is waited for, then counted: the delete returns inUse and the row survives", async () => {
      const { academy, cls } = await makeClass(false);
      const { student } = await makeClassStudent(academy.id, orgId);

      // The insert's foreign-key check holds a key-share lock on the class row until this transaction commits.
      const inflight = holdOpen(async (tx) => {
        await tx.attendanceRecord.create({ data: attendanceData(cls, student.id, "2026-03-07") });
      });
      await inflight.ready;

      const deleting = deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }));
      await waitUntilBlocked(DELETE_LOCK);
      inflight.release();
      await inflight.done;

      expect(await deleting).toEqual({ error: "inUse" });
      expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
      expect(await prisma.attendanceRecord.count({ where: { classSessionId: cls.id } })).toBe(1);
    });

    it("a queued claim in flight (class row FOR SHARE, then the insert, as performCheckIn writes it) is waited for, then counted: inUse", async () => {
      const { academy, cls } = await makeClass(false);
      const { student } = await makeClassStudent(academy.id, orgId);

      const inflight = holdOpen(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ClassSession" WHERE "id" = ${cls.id} AND "organizationId" = ${orgId} FOR SHARE`;
        await tx.queuedCheckIn.create({
          data: {
            organizationId: orgId, academyId: academy.id, studentId: student.id, eventKey: "id:inflight-claim",
            claimedAtVerified: true, claimedClassSessionId: cls.id, reason: "SELECTION_NOT_OPEN",
          },
        });
      });
      await inflight.ready;

      const deleting = deleteClassSession(orgId, {}, formData({ classSessionId: cls.id }));
      await waitUntilBlocked(DELETE_LOCK);
      inflight.release();
      await inflight.done;

      expect(await deleting).toEqual({ error: "inUse" });
      expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).not.toBeNull();
    });

    it("two concurrent deletes of one class: the second waits, then finds no row (notFound); exactly one delete audit", async () => {
      const { cls } = await makeClass(false);
      const [a, b] = await Promise.all([
        deleteClassSession(orgId, {}, formData({ classSessionId: cls.id })),
        deleteClassSession(orgId, {}, formData({ classSessionId: cls.id })),
      ]);
      expect([a, b]).toEqual(expect.arrayContaining([{ ok: true }, { error: "notFound" }]));
      expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).toBeNull();
      expect(await prisma.auditLog.count({ where: { entityId: cls.id, action: "classSession.delete" } })).toBe(1);
    });

    it("an edit or a deactivation that loses the race to a delete returns notFound (no 500) and writes no audit", async () => {
      for (const attempt of ["update", "deactivate"] as const) {
        const { cls } = await makeClass(false);
        // A delete in progress holds the row FOR UPDATE and then removes it.
        const deleting = holdOpen(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "ClassSession" WHERE "id" = ${cls.id} FOR UPDATE`;
          },
          async (tx) => {
            await tx.classSession.delete({ where: { id: cls.id } });
          },
        );
        await deleting.ready;
        const writing =
          attempt === "update"
            ? updateClassSession(orgId, {}, formData({
                classSessionId: cls.id, dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: "60", name: cls.name, type: "GI", countsTowardPromotion: "true",
              }))
            : deactivateClassSession(orgId, {}, formData({ classSessionId: cls.id }));
        await waitUntilBlocked(`UPDATE "public"."ClassSession"`);
        deleting.release();
        await deleting.done;
        expect(await writing).toEqual({ error: "notFound" });
        expect(await prisma.auditLog.count({ where: { entityId: cls.id, action: { in: ["classSession.update", "classSession.deactivate"] } } })).toBe(0);
      }
    });

    it("the REAL performCheckIn enqueue waits on a delete holding the class row, then keeps its claim verbatim once the class is gone", async () => {
      const { academy, cls } = await makeClass(false);
      const { student } = await makeClassStudent(academy.id, orgId);

      // A delete in progress: the class row locked FOR UPDATE (deleteClassSession's first statement), then removed.
      const deleting = holdOpen(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ClassSession" WHERE "id" = ${cls.id} FOR UPDATE`;
        },
        async (tx) => {
          await tx.classSession.delete({ where: { id: cls.id } });
        },
      );
      await deleting.ready;

      const now = new Date("2026-03-02T00:30:00Z");
      const replaying = performCheckIn({
        studentId: student.id, academyId: academy.id, source: "KIOSK", now, pickedClassSessionId: cls.id,
        context: { kind: "kiosk", organizationId: orgId, academyId: academy.id },
        replay: { timestampVerified: true, event: { key: "id:delete-race-replay", claimedAtRaw: String(now.getTime()), claimedAt: now } },
      });
      await waitUntilBlocked(CLAIM_LOCK);
      deleting.release();
      await deleting.done;

      expect(await replaying).toMatchObject({ ok: false, error: "queued_for_review", duplicate: false });
      expect(await prisma.classSession.findUnique({ where: { id: cls.id } })).toBeNull();
      const kept = await prisma.queuedCheckIn.findMany({ where: { studentId: student.id } });
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ claimedClassSessionId: cls.id, status: "PENDING" });
    });
  });
});
