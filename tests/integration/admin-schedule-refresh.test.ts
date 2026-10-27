import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy } from "../helpers/class-fixtures";

/**
 * Every schedule write refreshes the schedule page after a SUCCESS (so list, week and day views, counts and day-off
 * shading show the result without a manual reload) and never after a refusal (so a failed action cannot make the page
 * look as if something changed). The page re-renders at the URL it was posted from; the browser check covers that.
 */
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("next-intl/server", () => ({ getLocale: () => Promise.resolve("es") }));

const { createClassSession, updateClassSession, deactivateClassSession, deleteClassSession } = await import(
  "../../src/app/[locale]/(staff)/admin/schedule/actions"
);

const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const fixtureAcademyIds: string[] = [];

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("schedule writes refresh the schedule page only after a success", () => {
  let orgId: string;

  beforeEach(async () => {
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } })).id;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const admin = await prisma.user.create({
      data: { email: `schedule-refresh-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN" },
    });
    cleanupUserIds.push(admin.id);
    await prisma.organizationMembership.create({ data: { userId: admin.id, organizationId: orgId, role: "ADMIN" } });
    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: orgId };
    revalidatePath.mockReset();
  });

  afterEach(async () => {
    currentSession = null;
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: cleanupUserIds } }, { academyId: { in: fixtureAcademyIds } }] } });
    await cleanupClassFixtures();
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    cleanupUserIds.length = 0;
    fixtureAcademyIds.length = 0;
  });

  it("create, edit, deactivate and delete each refresh the page once on success, and not on a refusal", async () => {
    const { academy } = await makeClassAcademy([]);
    fixtureAcademyIds.push(academy.id);
    const fields = { dayOfWeek: "MONDAY", startTime: "07:00", durationMinutes: "60", name: `Refresh ${Date.now()}`, type: "GI", countsTowardPromotion: "true" };

    // create: success, then the same slot again (duplicateSlot)
    expect(await createClassSession(orgId, {}, formData({ academyId: academy.id, ...fields }))).toEqual({ ok: true });
    expect(revalidatePath.mock.calls).toEqual([["/es/admin/schedule"]]);
    revalidatePath.mockReset();
    expect(await createClassSession(orgId, {}, formData({ academyId: academy.id, ...fields }))).toEqual({ error: "duplicateSlot" });
    expect(revalidatePath).not.toHaveBeenCalled();

    const cls = await prisma.classSession.findFirstOrThrow({ where: { academyId: academy.id, name: fields.name } });
    const other = await prisma.classSession.create({
      data: { academyId: academy.id, organizationId: orgId, dayOfWeek: "MONDAY", startTime: "09:00", durationMinutes: 60, name: `${fields.name} B`, type: "GI" },
    });

    // edit: success, then a move into the first class's slot (duplicateSlot)
    expect(await updateClassSession(orgId, {}, formData({ classSessionId: cls.id, ...fields, startTime: "08:00" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    revalidatePath.mockReset();
    expect(await updateClassSession(orgId, {}, formData({ classSessionId: other.id, ...fields, startTime: "08:00" }))).toEqual({ error: "duplicateSlot" });
    expect(revalidatePath).not.toHaveBeenCalled();

    // delete refused while active (mustDeactivateFirst): no refresh
    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: other.id }))).toEqual({ error: "mustDeactivateFirst" });
    expect(revalidatePath).not.toHaveBeenCalled();

    // deactivate: success, then an unknown id (notFound)
    expect(await deactivateClassSession(orgId, {}, formData({ classSessionId: other.id }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    revalidatePath.mockReset();
    expect(await deactivateClassSession(orgId, {}, formData({ classSessionId: "no-such-class" }))).toEqual({ error: "notFound" });
    expect(revalidatePath).not.toHaveBeenCalled();

    // delete: success
    expect(await deleteClassSession(orgId, {}, formData({ classSessionId: other.id }))).toEqual({ ok: true });
    expect(revalidatePath.mock.calls).toEqual([["/es/admin/schedule"]]);
  });
});
