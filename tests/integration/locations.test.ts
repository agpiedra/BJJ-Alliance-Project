import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayOfWeek } from "../../src/generated/prisma/client";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));
// The signup and the check-in each fire a notification after the response; not under test.
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("../../src/lib/notifications/notify-eligibility", () => ({ notifyEligibilityReached: vi.fn(async () => {}) }));

// Lets one test make the default-plan write fail, to prove the whole creation is one transaction.
const planWrite = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/payments/ensure-default-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/ensure-default-plan")>();
  return {
    ...actual,
    ensureDefaultPlan: (...args: Parameters<typeof actual.ensureDefaultPlan>) => {
      if (planWrite.fail) throw new Error("plan write failed");
      return actual.ensureDefaultPlan(...args);
    },
  };
});

const { createLocation } = await import("../../src/lib/locations/location-actions");
const { createLocationForOwner } = await import("../../src/lib/locations/location-service");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { POST: kioskCheckIn } = await import("../../src/app/api/kiosk/check-in/route");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");
const { defaultPlanNameFor } = await import("../../src/lib/payments/default-plan-name");
const { ZONE } = await import("../../src/lib/scheduling/zone");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

/**
 * Adding a location: Owner-only, add-only. Every organization in this file is
 * built the way a real one is — the public registration form, approval, the
 * invitation accepted — because a test that builds its world by hand tests a
 * world that does not exist (the seeded fixtures hid the owner lockout, and the
 * unreachable student portal, for exactly that reason). A student's check-in at
 * the new location likewise starts from the public signup form.
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const extraAcademyIds: string[] = [];
const registrationEmails: string[] = [];
let counter = 0;
let approverId: string;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function actAs(userId: string, organizationId: string, role: string) {
  currentSession = { user: { id: userId, role }, activeOrganizationId: organizationId };
}

/** An organization whose Owner is created the real way. Its first academy's kiosk token is returned for the "another academy's token" control. */
async function newOrganization(locale: "es" | "en" = "es") {
  counter += 1;
  const email = `loc-owner-${counter}-${suffix}@example.com`;
  const slug = `loc-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Loc ${counter}`,
      desiredSlug: slug,
      country: "Costa Rica",
      city: "Heredia",
      contactName: "Owner",
      contactEmail: email,
      contactPhone: "88880000",
      studentCountBand: "1-25",
      preferredLocale: locale,
      termsAccepted: "on",
    }),
  );
  expect(registration, JSON.stringify(registration)).toMatchObject({ ok: true });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  const fd = new FormData();
  fd.set("token", new URL(approval.invitationLink!).searchParams.get("token")!);
  fd.set("password", "owner-password-123");
  await acceptInvitation(locale, {}, fd).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const first = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, slug, ownerId: owner.id, first, firstToken: approval.kioskToken! };
}

async function addStaff(organizationId: string, role: "DIRECTOR" | "INSTRUCTOR", academyId: string) {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `loc-${role.toLowerCase()}-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("member-password-123"), role },
  });
  userIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId, role } });
  return user;
}

/** Adds a location as the Owner and returns the state. */
async function ownerAdds(org: { organizationId: string; ownerId: string }, fields: Record<string, string>) {
  actAs(org.ownerId, org.organizationId, "ADMIN");
  return createLocation(org.organizationId, {}, form(fields));
}

async function academiesOf(organizationId: string) {
  return prisma.academy.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
}

describe("adding a location", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `loc-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    currentSession = null;
    planWrite.fail = false;
  });

  afterAll(async () => {
    const academyIds = (await prisma.academy.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } })).map((a) => a.id);
    await prisma.attendanceRecord.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.kioskAttempt.deleteMany({ where: { academyId: { in: [...academyIds, ...extraAcademyIds] } } });
    await prisma.classSession.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.student.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: [...academyIds, ...extraAcademyIds] } } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.registrationAttempt.deleteMany({ where: { email: { in: registrationEmails } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("REQUIRED: the Owner adds a location in ONE step — academy, kiosk token hash, default plan and audit row — and is handed the token once", async () => {
    const org = await newOrganization("en");
    const result = await ownerAdds(org, { name: "  Alajuela  ", address: " 100m north of the park " });

    expect(result).toMatchObject({ ok: true, name: "Alajuela" });
    const token = result.kioskToken!;
    expect(token.length).toBeGreaterThanOrEqual(24);

    const academies = await academiesOf(org.organizationId);
    expect(academies).toHaveLength(2);
    const created = academies.find((academy) => academy.id !== org.first.id)!;
    expect(created).toMatchObject({
      name: "Alajuela",
      address: "100m north of the park",
      slug: `${org.slug}-alajuela`,
      active: true,
      timezone: org.first.timezone, // no timezone field: the same default the first location has
      kioskTokenHash: digestLookupSecret(token, pepper),
    });
    expect(result).toMatchObject({ academyId: created.id, slug: created.slug });

    // The default plan, named in the organization's language, through the same helper approval uses.
    const plans = await prisma.paymentPlan.findMany({ where: { academyId: created.id } });
    expect(plans.map((plan) => plan.name)).toEqual([defaultPlanNameFor("en")]);

    // Audited — and the audit trail holds no copy of the credential.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.organizationId, action: "academy.create", entityId: created.id } });
    expect(audit).toMatchObject({ actorId: org.ownerId, academyId: created.id, entityType: "Academy" });
    expect(audit.after).toMatchObject({ name: "Alajuela", slug: created.slug });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(created.kioskTokenHash);
  });

  it("REQUIRED: the token it returns actually authenticates THAT academy's kiosk — a student signs up at the new location, is approved, and checks in with it", async () => {
    const org = await newOrganization();
    const added = await ownerAdds(org, { name: "Cartago" });
    expect(added.ok).toBe(true);
    const token = added.kioskToken!;
    const newAcademy = await prisma.academy.findUniqueOrThrow({ where: { id: added.academyId } });

    // A class open right now at the new location (the schedule is not under test).
    const nowCr = DateTime.now().setZone(ZONE);
    const days: DayOfWeek[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
    await prisma.classSession.create({
      data: {
        academyId: newAcademy.id,
        organizationId: org.organizationId,
        dayOfWeek: days[nowCr.weekday - 1],
        startTime: nowCr.toFormat("HH:mm"),
        durationMinutes: 60,
        name: "Open Now",
        type: "GI",
        countsTowardPromotion: true,
      },
    });

    // The new location is selectable on the public signup form, and the student gets their code the real way.
    counter += 1;
    const email = `loc-student-${counter}-${suffix}@example.com`;
    const signedUp = await signup(
      org.slug,
      {},
      form({
        firstName: "New",
        lastName: "Location",
        phone: "88880000",
        email,
        homeAcademySlug: newAcademy.slug,
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "student-password-123",
      }),
    );
    expect(signedUp, JSON.stringify(signedUp)).toMatchObject({ ok: true });
    const code = (signedUp as { code?: string }).code!;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    const student = await prisma.student.findFirstOrThrow({ where: { userId: user.id } });
    expect(student.homeAcademyId).toBe(newAcademy.id);

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await approveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true });

    const checkIn = async (body: Record<string, unknown>) => {
      const response = await kioskCheckIn(
        new Request("http://localhost/api/kiosk/check-in", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };

    // Controls first: neither the first location's token nor a made-up one opens the new kiosk.
    expect((await checkIn({ academySlug: newAcademy.slug, token: org.firstToken, code })).status).toBe(401);
    expect((await checkIn({ academySlug: newAcademy.slug, token: "not-the-token", code })).status).toBe(401);
    // ...and the new token does not open the first location's kiosk either.
    expect((await checkIn({ academySlug: org.first.slug, token, code })).status).toBe(401);

    const accepted = await checkIn({ academySlug: newAcademy.slug, token, code });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ ok: true });
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id, academyId: newAcademy.id, type: "CHECKIN" } })).toBe(1);
  });

  describe("the generated slug", () => {
    it("is the organization's slug plus the slugified name (diacritics and punctuation flattened)", async () => {
      const org = await newOrganization();
      const result = await ownerAdds(org, { name: "Núñez & Hijos — Sede #2" });
      expect(result.slug).toBe(`${org.slug}-nunez-hijos-sede-2`);
    });

    it("gets a numeric suffix when the slug is already taken — even by ANOTHER organization's academy, since slugs are global", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      // Another organization already holds the slug this name would generate (`Academy.slug` is unique across ALL organizations).
      const squatter = await prisma.academy.create({
        data: { organizationId: other.organizationId, name: "Squatter", slug: `${org.slug}-puntarenas`, kioskTokenHash: digestLookupSecret(`squat-${suffix}-${counter}`, pepper) },
      });
      extraAcademyIds.push(squatter.id);

      const first = await ownerAdds(org, { name: "Puntarenas" });
      expect(first.slug).toBe(`${org.slug}-puntarenas-2`);
      const second = await ownerAdds(org, { name: "Puntarenas!" }); // a different name that flattens to the same slug
      expect(second.slug).toBe(`${org.slug}-puntarenas-3`);
    });

    it("has a fallback when the name has nothing a slug can keep", async () => {
      const org = await newOrganization();
      const result = await ownerAdds(org, { name: "日本" });
      expect(result.slug).toBe(`${org.slug}-location`);
    });
  });

  describe("validation", () => {
    it("REQUIRED: a name is required — blank, whitespace-only, missing and over-long are all refused, and nothing is created", async () => {
      const org = await newOrganization();
      for (const fields of [{ name: "" }, { name: "   " }, {}, { name: "x".repeat(101) }, { name: "Fine", address: "y".repeat(201) }]) {
        expect(await ownerAdds(org, fields as Record<string, string>)).toMatchObject({ error: "invalid" });
      }
      expect(await academiesOf(org.organizationId)).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "academy.create" } })).toBe(0);
    });

    it("the address is optional (blank is stored as none), and there is no timezone field — one smuggled into the form is ignored", async () => {
      const org = await newOrganization();
      const result = await ownerAdds(org, { name: "No Address", address: "   ", timezone: "Asia/Tokyo" });
      const created = await prisma.academy.findUniqueOrThrow({ where: { id: result.academyId } });
      expect(created.address).toBeNull();
      expect(created.timezone).toBe(org.first.timezone);
    });

    it("REQUIRED: a name already used at this organization is refused, whatever its case or spacing — but another organization may use it", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      expect(await ownerAdds(org, { name: "Escazú Norte" })).toMatchObject({ ok: true });
      for (const name of ["escazú norte", "  ESCAZÚ   NORTE ", "Escazú Norte"]) {
        expect(await ownerAdds(org, { name })).toMatchObject({ error: "duplicateName" });
      }
      expect(await academiesOf(org.organizationId)).toHaveLength(2);
      expect(await ownerAdds(other, { name: "Escazú Norte" })).toMatchObject({ ok: true });
    });

    it("REQUIRED: two Owners adding the same name at the same moment produce exactly one location", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId, "ADMIN");
      const results = await Promise.all(Array.from({ length: 4 }, () => createLocation(org.organizationId, {}, form({ name: "Racing" }))));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => result.error === "duplicateName")).toHaveLength(3);
      expect(await academiesOf(org.organizationId)).toHaveLength(2);
      expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "academy.create" } })).toBe(1);
    });
  });

  describe("who may add one", () => {
    it("REQUIRED: a location director and an instructor are refused (FORBIDDEN) and nothing is created", async () => {
      const org = await newOrganization();
      for (const role of ["DIRECTOR", "INSTRUCTOR"] as const) {
        const staff = await addStaff(org.organizationId, role, org.first.id);
        actAs(staff.id, org.organizationId, role);
        await expect(createLocation(org.organizationId, {}, form({ name: `By ${role}` }))).rejects.toThrow("FORBIDDEN");
      }
      expect(await academiesOf(org.organizationId)).toHaveLength(1);
    });

    it("REQUIRED: the service refuses a non-Owner context on its own — the action's gate is not the only layer", async () => {
      const org = await newOrganization();
      const director = await addStaff(org.organizationId, "DIRECTOR", org.first.id);
      const context = await requireOrganizationAccess(director.id, org.organizationId);

      await expect(createLocationForOwner(context, { name: "Direct", address: null })).rejects.toThrow("FORBIDDEN");
      expect(await academiesOf(org.organizationId)).toHaveLength(1);
    });

    it("REQUIRED: a non-member is told notFound, never FORBIDDEN, and nothing is created", async () => {
      const org = await newOrganization();
      const outsider = await newOrganization();
      actAs(outsider.ownerId, outsider.organizationId, "ADMIN");
      expect(await createLocation(org.organizationId, {}, form({ name: "Intruder" }))).toEqual({ error: "notFound" });
      expect(await academiesOf(org.organizationId)).toHaveLength(1);
      currentSession = null;
      expect(await createLocation(org.organizationId, {}, form({ name: "Nobody" }))).toEqual({ error: "notFound" });
    });

    it("REQUIRED: it acts on the organization it NAMES, not the session's ambient one (the two-tab case)", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      // One person who owns both; their session currently points at A.
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      actAs(a.ownerId, a.organizationId, "ADMIN");

      const result = await createLocation(b.organizationId, {}, form({ name: "Named Tab" }));

      expect(result.ok).toBe(true);
      expect((await academiesOf(b.organizationId)).map((academy) => academy.name)).toContain("Named Tab");
      expect(await academiesOf(a.organizationId)).toHaveLength(1);
    });

    it("a new location grants nobody but the Owner access to it — a director of the first location is not silently widened", async () => {
      const org = await newOrganization();
      const director = await addStaff(org.organizationId, "DIRECTOR", org.first.id);
      const added = await ownerAdds(org, { name: "Owner Only Yet" });

      expect((await requireOrganizationAccess(director.id, org.organizationId)).academyIds).toEqual([org.first.id]);
      expect((await requireOrganizationAccess(org.ownerId, org.organizationId)).academyIds).toBe("ALL");
      expect(await prisma.staffAssignment.count({ where: { academyId: added.academyId } })).toBe(0);
    });
  });

  it("REQUIRED: it is one transaction — when the default-plan write fails nothing is left behind, and a retry then succeeds", async () => {
    const org = await newOrganization();
    planWrite.fail = true;
    actAs(org.ownerId, org.organizationId, "ADMIN");
    await expect(createLocation(org.organizationId, {}, form({ name: "Half Made" }))).rejects.toThrow("plan write failed");

    expect(await academiesOf(org.organizationId)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "academy.create" } })).toBe(0);

    planWrite.fail = false;
    expect(await createLocation(org.organizationId, {}, form({ name: "Half Made" }))).toMatchObject({ ok: true });
    expect(await academiesOf(org.organizationId)).toHaveLength(2);
  });
});
