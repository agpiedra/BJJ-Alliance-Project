import "dotenv/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";

// Same `auth()` mock as student-detail-actions.test.ts / create-student-action.test.ts
// — see the long note in the former. `requireStaffSession` -> `getStaffSession`
// -> next-auth's `auth()` needs a real HTTP request's cookies to resolve a JWT
// session, unavailable in a plain integration test.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { createClassSession, updateClassSession, deactivateClassSession } = await import(
  "../../src/app/[locale]/(staff)/admin/schedule/actions"
);
const { listClassSessions } = await import("../../src/app/[locale]/(staff)/admin/schedule/queries");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

/**
 * This suite creates real `ClassSession` rows, so it uses its OWN throwaway
 * academy rather than the shared seeded Escazú one.
 *
 * `seed.test.ts` and `session-scoping.test.ts` both assert Escazú's exact
 * session count (18); vitest runs test FILES in parallel by default, so
 * writing sessions into Escazú from here raced those assertions and made
 * `pnpm test` fail non-deterministically. A private fixture makes the
 * isolation structural rather than dependent on scheduling — the same
 * per-test-tagged isolation `kiosk-rate-limit.test.ts` already uses.
 */
let testAcademyId: string;

const cleanupUserIds: string[] = [];
const cleanupClassSessionIds: string[] = [];

async function cleanup() {
  if (cleanupClassSessionIds.length > 0 || cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: cleanupClassSessionIds } },
          { actorId: { in: cleanupUserIds } },
        ],
      },
    });
  }
  if (cleanupClassSessionIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { id: { in: cleanupClassSessionIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  cleanupClassSessionIds.length = 0;
  cleanupUserIds.length = 0;
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" },
    });
  }
  return user;
}

function auditRowsFor(entityId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { entityId, action },
    orderBy: { createdAt: "asc" },
  });
}

function sessionFields(overrides: Partial<Record<string, string>> = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return {
    dayOfWeek: "MONDAY",
    startTime: "07:00",
    durationMinutes: "45",
    name: `Test Session ${suffix}`,
    type: "GI",
    countsTowardPromotion: "true",
    ...overrides,
  };
}

describe("admin class-schedule CRUD actions", () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const academy = await prisma.academy.create({
      data: {
        name: `Schedule Test Academy ${suffix}`,
        slug: `schedule-test-${suffix}`,
        kioskTokenHash: `schedule-test-kiosk-hash-${suffix}`,
      },
    });
    testAcademyId = academy.id;
  });

  // Runs even when a test throws, so an aborted run can't orphan fixture rows
  // in the shared dev DB the way an afterAll-only teardown could.
  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    // Sessions/users/audit rows are gone by now, so nothing references it.
    await prisma.classSession.deleteMany({ where: { academyId: testAcademyId } });
    await prisma.academy.deleteMany({ where: { id: testAcademyId } });
  });

  beforeEach(() => {
    currentSession = null;
  });

  it("ADMIN creates a session, updates it, then deactivates it — the row survives deactivation and listClassSessions still returns it", async () => {
    const admin = await makeStaffUser("ADMIN", "schedule-crud-admin");
    currentSession = { user: { id: admin.id, role: "ADMIN" } };

    const fields = sessionFields();
    const created = await createClassSession({}, formData({ academyId: testAcademyId, ...fields }));
    expect(created.ok).toBe(true);

    const session = await prisma.classSession.findFirstOrThrow({
      where: { academyId: testAcademyId, name: fields.name },
    });
    cleanupClassSessionIds.push(session.id);
    expect(session.active).toBe(true);
    expect(session.dayOfWeek).toBe("MONDAY");
    expect(session.startTime).toBe("07:00");
    expect(session.durationMinutes).toBe(45);
    expect(session.countsTowardPromotion).toBe(true);

    const createAudits = await auditRowsFor(session.id, "classSession.create");
    expect(createAudits).toHaveLength(1);
    expect(createAudits[0].actorId).toBe(admin.id);
    expect(createAudits[0].academyId).toBe(testAcademyId);
    expect(createAudits[0].before).toBeNull();
    expect(createAudits[0].after).toMatchObject({ startTime: "07:00", durationMinutes: 45 });

    // --- update ---
    const updated = await updateClassSession(
      {},
      formData({
        classSessionId: session.id,
        dayOfWeek: "TUESDAY",
        startTime: "08:00",
        durationMinutes: "60",
        name: fields.name,
        type: "NO_GI",
        countsTowardPromotion: "false",
      }),
    );
    expect(updated.ok).toBe(true);

    const afterUpdate = await prisma.classSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(afterUpdate.dayOfWeek).toBe("TUESDAY");
    expect(afterUpdate.startTime).toBe("08:00");
    expect(afterUpdate.durationMinutes).toBe(60);
    expect(afterUpdate.type).toBe("NO_GI");
    expect(afterUpdate.countsTowardPromotion).toBe(false);
    expect(afterUpdate.active).toBe(true);

    const updateAudits = await auditRowsFor(session.id, "classSession.update");
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0].before).toMatchObject({ dayOfWeek: "MONDAY", startTime: "07:00" });
    expect(updateAudits[0].after).toMatchObject({ dayOfWeek: "TUESDAY", startTime: "08:00" });

    // --- deactivate: sets active: false, never deletes ---
    const deactivated = await deactivateClassSession({}, formData({ classSessionId: session.id }));
    expect(deactivated.ok).toBe(true);

    const afterDeactivate = await prisma.classSession.findUnique({ where: { id: session.id } });
    expect(afterDeactivate).not.toBeNull();
    expect(afterDeactivate!.active).toBe(false);

    const deactivateAudits = await auditRowsFor(session.id, "classSession.deactivate");
    expect(deactivateAudits).toHaveLength(1);
    expect(deactivateAudits[0].before).toMatchObject({ active: true });
    expect(deactivateAudits[0].after).toMatchObject({ active: false });

    // listClassSessions (an admin-only "list including inactive" read) still
    // returns the now-inactive row rather than silently dropping it.
    const listed = await listClassSessions(testAcademyId);
    const listedSession = listed.find((s) => s.id === session.id);
    expect(listedSession).toBeDefined();
    expect(listedSession!.active).toBe(false);
  });

  it("rejects a duplicate (academyId, dayOfWeek, startTime, name) slot with a friendly error, both on create and on update-into-collision", async () => {
    const admin = await makeStaffUser("ADMIN", "schedule-dup-admin");
    currentSession = { user: { id: admin.id, role: "ADMIN" } };

    const fieldsA = sessionFields({ startTime: "09:00" });
    const createdA = await createClassSession({}, formData({ academyId: testAcademyId, ...fieldsA }));
    expect(createdA.ok).toBe(true);
    const sessionA = await prisma.classSession.findFirstOrThrow({
      where: { academyId: testAcademyId, name: fieldsA.name },
    });
    cleanupClassSessionIds.push(sessionA.id);

    // Creating the exact same (academyId, dayOfWeek, startTime, name) again
    // is rejected with a friendly error, not a 500 — and nothing extra lands.
    const countBefore = await prisma.classSession.count({
      where: { academyId: testAcademyId, dayOfWeek: "MONDAY", startTime: "09:00", name: fieldsA.name },
    });
    const duplicateCreate = await createClassSession({}, formData({ academyId: testAcademyId, ...fieldsA }));
    expect(duplicateCreate.error).toBe("duplicateSlot");
    const countAfter = await prisma.classSession.count({
      where: { academyId: testAcademyId, dayOfWeek: "MONDAY", startTime: "09:00", name: fieldsA.name },
    });
    expect(countAfter).toBe(countBefore);

    // A second, distinct session — then updating it to collide with
    // sessionA's slot is rejected the same way, and sessionB is untouched.
    const fieldsB = sessionFields({ startTime: "10:00" });
    const createdB = await createClassSession({}, formData({ academyId: testAcademyId, ...fieldsB }));
    expect(createdB.ok).toBe(true);
    const sessionB = await prisma.classSession.findFirstOrThrow({
      where: { academyId: testAcademyId, name: fieldsB.name },
    });
    cleanupClassSessionIds.push(sessionB.id);

    const collidingUpdate = await updateClassSession(
      {},
      formData({
        classSessionId: sessionB.id,
        dayOfWeek: "MONDAY",
        startTime: "09:00",
        durationMinutes: fieldsB.durationMinutes,
        name: fieldsA.name,
        type: fieldsB.type,
        countsTowardPromotion: fieldsB.countsTowardPromotion,
      }),
    );
    expect(collidingUpdate.error).toBe("duplicateSlot");

    const sessionBUnchanged = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionB.id } });
    expect(sessionBUnchanged.startTime).toBe("10:00");
    expect(sessionBUnchanged.name).toBe(fieldsB.name);
  });

  describe("role-based rejection — DIRECTOR and INSTRUCTOR are refused all three writes", () => {
    it("rejects createClassSession, updateClassSession and deactivateClassSession with FORBIDDEN, mutating nothing", async () => {
      const admin = await makeStaffUser("ADMIN", "schedule-role-admin");
      currentSession = { user: { id: admin.id, role: "ADMIN" } };

      // A genuine session to attempt updateClassSession/deactivateClassSession
      // against, created by an ADMIN so we know its baseline state.
      const fields = sessionFields();
      const created = await createClassSession({}, formData({ academyId: testAcademyId, ...fields }));
      expect(created.ok).toBe(true);
      const session = await prisma.classSession.findFirstOrThrow({
        where: { academyId: testAcademyId, name: fields.name },
      });
      cleanupClassSessionIds.push(session.id);

      const director = await makeStaffUser("DIRECTOR", "schedule-role-director", testAcademyId);
      const instructor = await makeStaffUser("INSTRUCTOR", "schedule-role-instructor", testAcademyId);

      for (const nonAdmin of [director, instructor]) {
        currentSession = { user: { id: nonAdmin.id, role: nonAdmin.id === director.id ? "DIRECTOR" : "INSTRUCTOR" } };

        await expect(
          createClassSession({}, formData({ academyId: testAcademyId, ...sessionFields() })),
        ).rejects.toThrow("FORBIDDEN");

        await expect(
          updateClassSession(
            {},
            formData({
              classSessionId: session.id,
              dayOfWeek: "WEDNESDAY",
              startTime: "11:00",
              durationMinutes: "30",
              name: "Should Not Land",
              type: "KIDS",
              countsTowardPromotion: "false",
            }),
          ),
        ).rejects.toThrow("FORBIDDEN");

        await expect(
          deactivateClassSession({}, formData({ classSessionId: session.id })),
        ).rejects.toThrow("FORBIDDEN");
      }

      const untouched = await prisma.classSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(untouched.dayOfWeek).toBe(fields.dayOfWeek);
      expect(untouched.startTime).toBe(fields.startTime);
      expect(untouched.name).toBe(fields.name);
      expect(untouched.active).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityId: session.id } })).toBe(1); // only the create audit
    });
  });
});
