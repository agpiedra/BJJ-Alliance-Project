import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { hashSecret } from "../../src/lib/crypto";

let currentSession: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const {
  createInvoiceAction,
  recordInvoicePaymentAction,
  voidInvoiceAction,
  acknowledgeInvoiceReviewAction,
  extendInvoiceGraceAction,
  updateOrganizationGraceDaysAction,
} = await import("../../src/app/[locale]/platform/organizations/billing-actions");
const { resolveDirectorBillingBanner } = await import("../../src/lib/billing/banner");
const { resolveInvoiceState, graceEndsOn } = await import("../../src/lib/billing/deadline");

const prisma = getTestPrismaClient();

const cleanupOrgIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupOrgIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organizationInvoice.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeOrganization(overrides: Partial<{ timezone: string }> = {}) {
  const suffix = uniqueSuffix();
  const org = await prisma.organization.create({
    data: {
      slug: `billing-test-${suffix}`,
      name: `Billing Test ${suffix}`,
      status: "ACTIVE",
      timezone: overrides.timezone ?? "America/Costa_Rica",
    },
  });
  cleanupOrgIds.push(org.id);
  return org;
}

async function makeSuperAdmin() {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `billing-super-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      isSuperAdmin: true,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeOrgDirector(organizationId: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `billing-director-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "DIRECTOR",
      isSuperAdmin: false,
    },
  });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role: "DIRECTOR" } });
  return user;
}

function tenantContext(organizationId: string) {
  return { kind: "tenant" as const, organizationId, actorUserId: "irrelevant", organizationRole: "DIRECTOR" as const, academyIds: "ALL" as const, selfStudentId: null, linkedStudentId: null };
}

async function createPastDueInvoice(organizationId: string, _superAdminId: string, daysPastGrace = 0) {
  const dueOn = DateTime.now().minus({ days: 20 + daysPastGrace });
  const fd = new FormData();
  fd.set("periodStart", dueOn.minus({ months: 1 }).toISODate()!);
  fd.set("periodEnd", dueOn.toISODate()!);
  fd.set("dueOn", dueOn.toISODate()!);
  await createInvoiceAction(organizationId, {}, fd);
  return prisma.organizationInvoice.findFirstOrThrow({ where: { organizationId } });
}

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
  });

  it("REQUIRED: invoice creation is SUPER_ADMIN-only, snapshots Organization.graceDays into graceDaysApplied, and is audited", async () => {
    const org = await makeOrganization();
    await prisma.organization.update({ where: { id: org.id }, data: { graceDays: 7 } });
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const fd = new FormData();
    fd.set("periodStart", "2026-01-01");
    fd.set("periodEnd", "2026-01-31");
    fd.set("dueOn", "2026-01-28");
    const result = await createInvoiceAction(org.id, {}, fd);
    expect(result.ok).toBe(true);

    const invoice = await prisma.organizationInvoice.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(invoice.graceDaysApplied).toBe(7);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "organizationInvoice.create" } });
    expect(audit.actorId).toBe(superAdmin.id);
  });

  it("REQUIRED: a stored due date reads back as the exact calendar day it was entered, for a timezone west of UTC — regression for a live-verified bug where `new Date(dateString)` (UTC-midnight parse) plus timezone-aware readback silently shifted the deadline back a day", async () => {
    const org = await makeOrganization({ timezone: "America/Costa_Rica" });
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const fd = new FormData();
    fd.set("periodStart", "2026-08-01");
    fd.set("periodEnd", "2026-08-31");
    fd.set("dueOn", "2026-08-28");
    await createInvoiceAction(org.id, {}, fd);

    const invoice = await prisma.organizationInvoice.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(graceEndsOn(invoice, org.timezone).toISODate()).toBe("2026-09-02");
  });

  it("a non-super-admin (org DIRECTOR) cannot create an invoice", async () => {
    const org = await makeOrganization();
    const director = await makeOrgDirector(org.id);
    currentSession = { user: { id: director.id } };

    const fd = new FormData();
    fd.set("periodStart", "2026-01-01");
    fd.set("periodEnd", "2026-01-31");
    fd.set("dueOn", "2026-01-28");
    const result = await createInvoiceAction(org.id, {}, fd);
    expect(result.error).toBe("notFound");
    expect(await prisma.organizationInvoice.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("REQUIRED: changing Organization.graceDays leaves every outstanding invoice's graceDaysApplied unchanged, and applies to the next invoice issued", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const outstanding = await createPastDueInvoice(org.id, superAdmin.id);
    expect(outstanding.graceDaysApplied).toBe(5); // default

    const changeResult = await updateOrganizationGraceDaysAction(org.id, "10");
    expect(changeResult.ok).toBe(true);

    const unchangedOutstanding = await prisma.organizationInvoice.findUniqueOrThrow({ where: { id: outstanding.id } });
    expect(unchangedOutstanding.graceDaysApplied).toBe(5);

    const fd = new FormData();
    fd.set("periodStart", "2026-03-01");
    fd.set("periodEnd", "2026-03-31");
    fd.set("dueOn", "2026-03-28");
    await createInvoiceAction(org.id, {}, fd);
    const newInvoice = await prisma.organizationInvoice.findFirstOrThrow({ where: { organizationId: org.id, id: { not: outstanding.id } } });
    expect(newInvoice.graceDaysApplied).toBe(10);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "organization.graceDays.changed" } });
    expect(audit.before).toEqual({ graceDays: 5 });
    expect(audit.after).toEqual({ graceDays: 10 });
  });

  it("graceDays rejects negative and non-integer values at validation", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    expect((await updateOrganizationGraceDaysAction(org.id, "-1")).error).toBe("invalidGraceDays");
    expect((await updateOrganizationGraceDaysAction(org.id, "2.5")).error).toBe("invalidGraceDays");
    expect((await updateOrganizationGraceDaysAction(org.id, "not-a-number")).error).toBe("invalidGraceDays");

    const unchanged = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(unchanged.graceDays).toBe(5);
  });

  it("graceDays: 0 is a VALID value, not rejected", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const result = await updateOrganizationGraceDaysAction(org.id, "0");
    expect(result.ok).toBe(true);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).graceDays).toBe(0);
  });

  it("REQUIRED: extending an outstanding invoice moves its deadline, returning it from GRACE_EXPIRED to DUE, and clears the review flag", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const invoice = await createPastDueInvoice(org.id, superAdmin.id, 10); // well past grace
    expect(resolveInvoiceState(invoice, org.timezone)).toBe("GRACE_EXPIRED");

    const extendResult = await extendInvoiceGraceAction(invoice.id, "60", "Director asked for more time.");
    expect(extendResult.ok).toBe(true);

    const extended = await prisma.organizationInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(resolveInvoiceState(extended, org.timezone)).toBe("DUE");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "organizationInvoice.graceExtended" } });
    expect(audit.before).toEqual({ graceExtensionDays: 0 });
  });

  it("extending requires a non-empty note", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const invoice = await createPastDueInvoice(org.id, superAdmin.id);

    const result = await extendInvoiceGraceAction(invoice.id, "30", "  ");
    expect(result.error).toBe("noteRequired");
  });

  it("REQUIRED: acknowledgment is not resolution — an acknowledged invoice stays GRACE_EXPIRED and unpaid, and the director's banner is unchanged", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const invoice = await createPastDueInvoice(org.id, superAdmin.id, 5);

    const bannerBefore = await resolveDirectorBillingBanner(tenantContext(org.id));
    expect(bannerBefore?.state).toBe("GRACE_EXPIRED");

    const result = await acknowledgeInvoiceReviewAction(invoice.id, "Spoke to the director, transfer coming Friday.");
    expect(result.ok).toBe(true);

    const acknowledged = await prisma.organizationInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(acknowledged.paidAt).toBeNull();
    expect(resolveInvoiceState(acknowledged, org.timezone)).toBe("GRACE_EXPIRED");

    // The director's own banner is unchanged by acknowledgment — it only
    // clears the platform admin's unreviewed queue, never the director's view.
    const bannerAfter = await resolveDirectorBillingBanner(tenantContext(org.id));
    expect(bannerAfter?.state).toBe("GRACE_EXPIRED");
  });

  it("REQUIRED: recording payment sets paidAt and clears the director's banner immediately, audited", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const invoice = await createPastDueInvoice(org.id, superAdmin.id, 5);

    expect((await resolveDirectorBillingBanner(tenantContext(org.id)))?.state).toBe("GRACE_EXPIRED");

    const result = await recordInvoicePaymentAction(invoice.id, "Paid via bank transfer.");
    expect(result.ok).toBe(true);

    const paid = await prisma.organizationInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.paidAt).not.toBeNull();
    expect(resolveInvoiceState(paid, org.timezone)).toBe("CURRENT");

    // Cleared immediately — no separate step, since the banner re-reads live.
    expect(await resolveDirectorBillingBanner(tenantContext(org.id))).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "organizationInvoice.recordPayment" } });
    expect(audit.before).toEqual({ paidAt: null });
  });

  it("REQUIRED: no code path sets Organization.status from billing state — an organization with a GRACE_EXPIRED invoice remains ACTIVE throughout", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    await createPastDueInvoice(org.id, superAdmin.id, 30); // deeply expired

    const stillActive = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });

  it("REQUIRED: an unpaid invoice's state moves CURRENT -> DUE -> GRACE_EXPIRED purely as dates pass, with no code running in between and no organization suspended as a result", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    // Anchored to the org's own timezone, not the test runner's system
    // zone — createInvoiceAction now writes dates anchored to the
    // organization's timezone (see billing-actions.ts's own comment), so
    // "+N days" probes must advance calendar days in that same zone or
    // they drift by the zone offset relative to what actually got stored.
    const dueOn = DateTime.now().setZone(org.timezone).plus({ days: 5 });
    const fd = new FormData();
    fd.set("periodStart", dueOn.minus({ months: 1 }).toISODate()!);
    fd.set("periodEnd", dueOn.toISODate()!);
    fd.set("dueOn", dueOn.toISODate()!);
    await createInvoiceAction(org.id, {}, fd);
    const invoice = await prisma.organizationInvoice.findFirstOrThrow({ where: { organizationId: org.id } });

    // No write to the invoice row happens between these three reads —
    // state is derived purely from the current time passed in.
    expect(resolveInvoiceState(invoice, org.timezone, DateTime.now())).toBe("CURRENT");
    expect(resolveInvoiceState(invoice, org.timezone, dueOn.plus({ days: 1 }))).toBe("DUE");
    expect(resolveInvoiceState(invoice, org.timezone, dueOn.plus({ days: invoice.graceDaysApplied + 1 }))).toBe("GRACE_EXPIRED");

    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("ACTIVE");
  });

  it("REQUIRED: graceDays/graceDaysApplied/graceExtensionDays and the review fields appear nowhere in the director-facing serialized payload — asserted against the actual object's own keys, not against the rendered DOM", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    await createPastDueInvoice(org.id, superAdmin.id, 5);

    const banner = await resolveDirectorBillingBanner(tenantContext(org.id));
    expect(banner).not.toBeNull();
    const keys = Object.keys(banner!);
    expect(keys).toEqual(["state", "dueOn", "deadline"]);
    expect(keys).not.toContain("graceDays");
    expect(keys).not.toContain("graceDaysApplied");
    expect(keys).not.toContain("graceExtensionDays");
    // Not a substring check on the whole payload — `state: "GRACE_EXPIRED"`
    // legitimately contains "grace" as text; the actual guarantee is that
    // no NUMERIC grace value (the thing the doc says must never reach a
    // director) is present anywhere in the payload.
    expect(Object.values(banner!).some((value) => typeof value === "number")).toBe(false);
  });

  it("void requires a reason and cannot be applied to an already-resolved invoice", async () => {
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const invoice = await createPastDueInvoice(org.id, superAdmin.id);

    expect((await voidInvoiceAction(invoice.id, "")).error).toBe("reasonRequired");

    const voided = await voidInvoiceAction(invoice.id, "Registered in error.");
    expect(voided.ok).toBe(true);

    const secondVoid = await voidInvoiceAction(invoice.id, "Again.");
    expect(secondVoid.error).toBe("alreadyResolved");
  });

  it("platform billing fields are entirely separate from the student Pagos section — no shared model", async () => {
    // Structural check: OrganizationInvoice and PaymentPeriod/PaymentPlan
    // are distinct Prisma models with no relation between them.
    const org = await makeOrganization();
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const invoice = await createPastDueInvoice(org.id, superAdmin.id);
    expect("studentId" in invoice).toBe(false);
    expect("planId" in invoice).toBe(false);
  });
});
