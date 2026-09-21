import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

// resolveActionContext reads the session through next-auth's `auth()`, which
// needs a real request; signIn() ends acceptInvitation in a NEXT_REDIRECT.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));

const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { recordPayment } = await import("../../src/lib/payments/payment-actions");
const { createPlan, updatePlan, deactivatePlan, reactivatePlan, changeOrganizationCurrency } = await import(
  "../../src/lib/payments/plan-actions"
);
const { listSelectablePlans, listPlansForManagement } = await import("../../src/lib/payments/list-plans");
const { getPaymentHistory } = await import("../../src/app/[locale]/(staff)/students/[id]/get-payment-history");
const { getCurrentPaymentPeriod, currentCrDateParts } = await import("../../src/lib/payments/get-current-period");
const { listCurrentPaymentStatus } = await import("../../src/lib/payments/list-current-status");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { ensureCustomPromoPlan } = await import("../../src/lib/payments/ensure-custom-promo-plan");
const { customPromoPlanNameFor } = await import("../../src/lib/payments/custom-promo-plan-name");
// The organizations `newOrganization()` builds default to Spanish.
const CUSTOM_PROMO_PLAN_NAME = customPromoPlanNameFor("es");
const { digestLookupSecret, hashSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let approverId: string;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/**
 * An organization built the way a real customer's is — the public registration
 * form's action, a platform approval, the invitation link, the owner's password
 * — so the default plan, the currency, the language and the owner's scope all
 * come from the product itself rather than a hand-built fixture. (That
 * distinction is the whole reason the owner-lockout bug survived five phases.)
 */
async function newOrganization(opts: { currency?: "CRC" | "USD"; locale?: "es" | "en" } = {}) {
  const suffix = uniqueSuffix();
  const slug = `plans-${suffix}`;
  const email = `owner-plans-${suffix}@example.com`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Plans Test ${suffix}`,
      desiredSlug: slug,
      country: "Costa Rica",
      city: "Heredia",
      contactName: "Owner",
      contactEmail: email,
      contactPhone: "88880000",
      studentCountBand: "1-25",
      preferredLocale: opts.locale ?? "es",
      termsAccepted: "on",
      ...(opts.currency ? { currency: opts.currency } : {}),
    }),
  );
  expect(registration, JSON.stringify(registration)).toMatchObject({ ok: true });

  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  orgIds.push(organization.id);

  const approval = await approveOrganization(slug, approverId);
  const token = new URL(approval.invitationLink!).searchParams.get("token")!;
  await acceptInvitation("es", {}, form({ token, password: "owner-password-123" })).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
  });

  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, academyId: academy.id, ownerId: owner.id, slug };
}

function actAs(userId: string, organizationId: string, role = "ADMIN") {
  currentSession = { user: { id: userId, role }, activeOrganizationId: organizationId };
}

async function makeStudent(organizationId: string, academyId: string, label: string) {
  const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId, track: "ADULT" } });
  const suffix = uniqueSuffix();
  return prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "Plan",
      lastName: `${label}-${suffix}`,
      phone: "88880000",
      email: `plan-${label}-${suffix}@example.com`,
      currentRankId: rank.id,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`plans-${suffix}`, pepper),
    },
  });
}

function pay(orgId: string, fields: Record<string, string>) {
  return recordPayment(orgId, {}, form({ status: "PAID", ...fields }));
}

async function staffMember(orgId: string, academyId: string, role: "DIRECTOR" | "INSTRUCTOR") {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${suffix}@example.com`, passwordHash: await hashSecret("x-password-123"), role },
  });
  userIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: orgId, role } });
  await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId: orgId, role } });
  return user;
}

describe("payment plans, default amounts and organization currency", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: {
        email: `plans-approver-${uniqueSuffix()}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "ADMIN",
        isSuperAdmin: true,
      },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    currentSession = null;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.student.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.registrationAttempt.deleteMany({ where: { email: { in: registrationEmails } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe("a new organization can record a payment on day one", () => {
    it("REQUIRED: approval gives the default academy a monthly plan named in the organization's language", async () => {
      const spanish = await newOrganization({ locale: "es" });
      const english = await newOrganization({ locale: "en" });

      const spanishPlans = await prisma.paymentPlan.findMany({ where: { academyId: spanish.academyId } });
      const englishPlans = await prisma.paymentPlan.findMany({ where: { academyId: english.academyId } });

      expect(spanishPlans.map((p) => p.name)).toEqual(["Mensualidad"]);
      expect(englishPlans.map((p) => p.name)).toEqual(["Monthly"]);
      // No price: the app cannot know what an academy charges.
      expect(spanishPlans[0].defaultAmount).toBeNull();
      expect(spanishPlans[0].active).toBe(true);
    });

    it("re-approving never resurrects a plan the director deactivated, nor duplicates it", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      // Give the academy a second plan so the default one may be deactivated.
      await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Trimestral" }));
      const monthly = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Mensualidad" } });
      expect(await deactivatePlan(org.organizationId, monthly.id)).toEqual({ ok: true });

      await approveOrganization(org.slug, approverId); // a resend re-runs approval

      const plans = await prisma.paymentPlan.findMany({ where: { academyId: org.academyId, name: "Mensualidad" } });
      expect(plans).toHaveLength(1);
      expect(plans[0].active).toBe(false);
    });

    it("registration stores the chosen currency, defaulting to colones when absent", async () => {
      const usd = await newOrganization({ currency: "USD" });
      const unspecified = await newOrganization();
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: usd.organizationId } })).currency).toBe("USD");
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: unspecified.organizationId } })).currency).toBe("CRC");
    });
  });

  describe("plan management", () => {
    it("creates a plan with a default amount, audited in the same transaction", async () => {
      const org = await newOrganization({ currency: "USD" });
      actAs(org.ownerId, org.organizationId);

      const result = await createPlan(
        org.organizationId,
        {},
        form({ academyId: org.academyId, name: "Promoción Diciembre", description: "Holiday special", defaultAmount: "45" }),
      );

      expect(result).toEqual({ ok: true });
      const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Promoción Diciembre" } });
      expect(plan.defaultAmount?.toNumber()).toBe(45);
      expect(plan.description).toBe("Holiday special");
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: plan.id, action: "paymentPlan.create" } });
      expect(audit.actorId).toBe(org.ownerId);
      expect(audit.organizationId).toBe(org.organizationId);
      expect(audit.after).toMatchObject({ name: "Promoción Diciembre", defaultAmount: 45, active: true });
    });

    it("refuses a duplicate name, points at reactivating a DEACTIVATED one, and protects the system promo plan", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Becado" }));

      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Becado" }))).toMatchObject({ error: "nameTaken" });

      const becado = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Becado" } });
      await deactivatePlan(org.organizationId, becado.id);
      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Becado" }))).toMatchObject({
        error: "nameTakenInactive",
      });

      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: CUSTOM_PROMO_PLAN_NAME }))).toMatchObject({
        error: "systemPlan",
      });
    });

    it("rejects an invalid amount and never trusts a foreign academy id", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      actAs(org.ownerId, org.organizationId);

      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "X", defaultAmount: "-5" }))).toMatchObject({
        error: "invalid",
      });
      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "X", defaultAmount: "abc" }))).toMatchObject({
        error: "invalid",
      });
      // Another organization's academy id, submitted by this org's owner.
      expect(await createPlan(org.organizationId, {}, form({ academyId: other.academyId, name: "Sneaky" }))).toEqual({ error: "notFound" });
      expect(await prisma.paymentPlan.count({ where: { academyId: other.academyId, name: "Sneaky" } })).toBe(0);
    });

    it("edits a plan (audited with before/after); the system promo plan can be neither edited nor targeted", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Familiar", defaultAmount: "30000" }));
      const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Familiar" } });

      expect(
        await updatePlan(org.organizationId, {}, form({ planId: plan.id, name: "Familiar 2", description: "", defaultAmount: "32000" })),
      ).toEqual({ ok: true });

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: plan.id, action: "paymentPlan.update" } });
      expect(audit.before).toMatchObject({ name: "Familiar", defaultAmount: 30000 });
      expect(audit.after).toMatchObject({ name: "Familiar 2", defaultAmount: 32000 });

      expect(await updatePlan(org.organizationId, {}, form({ planId: plan.id, name: CUSTOM_PROMO_PLAN_NAME }))).toMatchObject({ error: "systemPlan" });
      const promo = await ensureCustomPromoPlan(org.organizationId, org.academyId);
      expect(await updatePlan(org.organizationId, {}, form({ planId: promo.id, name: "Renamed" }))).toMatchObject({ error: "systemPlan" });
      expect(await deactivatePlan(org.organizationId, promo.id)).toMatchObject({ error: "systemPlan" });
    });

    it("REQUIRED: refuses to deactivate an academy's last active plan — nobody could record a payment", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const only = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Mensualidad" } });
      // The system promo plan exists too, and must NOT count as "another active plan".
      await ensureCustomPromoPlan(org.organizationId, org.academyId);

      expect(await deactivatePlan(org.organizationId, only.id)).toMatchObject({ error: "lastActivePlan" });
      expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: only.id } })).active).toBe(true);
    });

    it("a plan in another organization is not found, whoever asks", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const theirs = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: other.academyId } });
      actAs(org.ownerId, org.organizationId);

      expect(await deactivatePlan(org.organizationId, theirs.id)).toEqual({ error: "notFound" });
      expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: theirs.id } })).active).toBe(true);
    });

    it("an INSTRUCTOR cannot manage plans at all", async () => {
      const org = await newOrganization();
      const instructor = await staffMember(org.organizationId, org.academyId, "INSTRUCTOR");
      actAs(instructor.id, org.organizationId, "INSTRUCTOR");

      await expect(createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Nope" }))).rejects.toThrow("FORBIDDEN");
      expect(await prisma.paymentPlan.count({ where: { academyId: org.academyId, name: "Nope" } })).toBe(0);
    });

    it("lists every plan for management (active and deactivated) with how much history each carries", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const student = await makeStudent(org.organizationId, org.academyId, "mgmt");
      const monthly = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Mensualidad" } });
      await pay(org.organizationId, { studentId: student.id, year: "2026", month: "1", planId: monthly.id, amount: "20000" });
      await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Extra" }));

      const managed = await listPlansForManagement(org.organizationId, [org.academyId]);
      expect(managed.find((p) => p.name === "Mensualidad")?.paymentCount).toBe(1);
      expect(managed.find((p) => p.name === "Extra")?.paymentCount).toBe(0);
    });
  });

  describe("REQUIRED: deactivating a plan that has payment history", () => {
    it("removes it from the picker and from NEW payments, and leaves every past record fully readable", async () => {
      const org = await newOrganization({ currency: "USD" });
      actAs(org.ownerId, org.organizationId);
      const alice = await makeStudent(org.organizationId, org.academyId, "alice");
      const bob = await makeStudent(org.organizationId, org.academyId, "bob");

      await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Promoción Diciembre", defaultAmount: "45" }));
      const promoPlan = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Promoción Diciembre" } });
      const today = currentCrDateParts();
      const period = { year: String(today.year), month: String(today.month) };

      // Alice paid on that plan THIS month, so it also shows in the live status table.
      expect(
        await pay(org.organizationId, { studentId: alice.id, ...period, planId: promoPlan.id, amount: "45", notes: "paid in cash" }),
      ).toEqual({ ok: true });

      // Sanity before: it IS in the picker.
      expect((await listSelectablePlans(org.organizationId, [org.academyId])).map((p) => p.name)).toContain("Promoción Diciembre");

      // Deactivate it (the academy still has its default monthly plan, so this is allowed).
      expect(await deactivatePlan(org.organizationId, promoPlan.id)).toEqual({ ok: true });

      // 1. Gone from the picker for new payments.
      const selectable = await listSelectablePlans(org.organizationId, [org.academyId]);
      expect(selectable.map((p) => p.name)).not.toContain("Promoción Diciembre");
      expect(selectable.map((p) => p.name)).toContain("Mensualidad");

      // 2. The student's payment history STILL renders it: plan name, amount, currency, notes.
      const history = await getPaymentHistory(alice.id, org.organizationId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ planName: "Promoción Diciembre", amount: 45, currency: "USD", notes: "paid in cash" });

      // 3. The Pagos "Estado del mes" table STILL shows the plan on that student's row.
      const context = await requireOrganizationAccess(org.ownerId, org.organizationId);
      const rows = await listCurrentPaymentStatus(context, today);
      const aliceRow = rows.find((r) => r.studentId === alice.id)!;
      expect(aliceRow.period).toMatchObject({ planName: "Promoción Diciembre", amount: 45, currency: "USD" });

      // 4. A NEW payment on the deactivated plan is refused server-side (the
      //    picker hides it, but a stale form or hand-built request must not
      //    work), and nothing is written.
      expect(await pay(org.organizationId, { studentId: bob.id, ...period, planId: promoPlan.id, amount: "45" })).toEqual({
        error: "planInactive",
      });
      expect(await prisma.paymentPeriod.count({ where: { studentId: bob.id } })).toBe(0);

      // 5. But CORRECTING the payment that already sits on it still works: the
      //    plan isn't changing, and history must never become uneditable.
      expect(
        await pay(org.organizationId, { studentId: alice.id, ...period, planId: promoPlan.id, amount: "45", notes: "corrected note" }),
      ).toEqual({ ok: true });
      expect((await getPaymentHistory(alice.id, org.organizationId))[0].notes).toBe("corrected note");

      // 6. Moving an existing payment ONTO a deactivated plan (not its own) is not allowed.
      const monthly = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Mensualidad" } });
      await pay(org.organizationId, { studentId: bob.id, ...period, planId: monthly.id, amount: "20" });
      expect(await pay(org.organizationId, { studentId: bob.id, ...period, planId: promoPlan.id, amount: "20" })).toEqual({
        error: "planInactive",
      });

      // 7. The database itself refuses to delete a plan that has history — the
      //    backstop under "plans are deactivated, never deleted".
      await expect(prisma.paymentPlan.delete({ where: { id: promoPlan.id } })).rejects.toThrow();
      expect(await prisma.paymentPlan.findUnique({ where: { id: promoPlan.id } })).not.toBeNull();

      // 8. Reactivating brings it straight back into the picker, history untouched.
      expect(await reactivatePlan(org.organizationId, promoPlan.id)).toEqual({ ok: true });
      expect((await listSelectablePlans(org.organizationId, [org.academyId])).map((p) => p.name)).toContain("Promoción Diciembre");
      expect(await getPaymentHistory(alice.id, org.organizationId)).toHaveLength(1);
    });
  });

  describe("the system promo plan follows the organization's language", () => {
    it("REQUIRED: an English organization's is 'Custom promotion', a Spanish one's 'Promoción personalizada' — and asking twice never makes a second", async () => {
      const spanish = await newOrganization({ locale: "es" });
      const english = await newOrganization({ locale: "en" });

      const es = await ensureCustomPromoPlan(spanish.organizationId, spanish.academyId);
      const en = await ensureCustomPromoPlan(english.organizationId, english.academyId);
      expect(es.name).toBe("Promoción personalizada");
      expect(en.name).toBe("Custom promotion");

      expect((await ensureCustomPromoPlan(english.organizationId, english.academyId)).id).toBe(en.id);
      expect(await prisma.paymentPlan.count({ where: { academyId: english.academyId, name: { in: ["Custom promotion", "Promoción personalizada"] } } })).toBe(1);
    });

    it("an organization that already has the plan under the OTHER language's name keeps it — no second promo plan appears", async () => {
      const english = await newOrganization({ locale: "en" });
      // What every English organization created before this change has: the Spanish name.
      const legacy = await prisma.paymentPlan.create({
        data: { academyId: english.academyId, organizationId: english.organizationId, name: "Promoción personalizada" },
      });

      const ensured = await ensureCustomPromoPlan(english.organizationId, english.academyId);

      expect(ensured.id).toBe(legacy.id);
      expect(await prisma.paymentPlan.count({ where: { academyId: english.academyId, name: { in: ["Custom promotion", "Promoción personalizada"] } } })).toBe(1);
    });

    it("the English-named plan is still THE system plan: it needs a promo name, and cannot be created, edited or deactivated", async () => {
      const org = await newOrganization({ locale: "en" });
      actAs(org.ownerId, org.organizationId);
      const student = await makeStudent(org.organizationId, org.academyId, "enpromo");
      const promo = await ensureCustomPromoPlan(org.organizationId, org.academyId);
      expect(promo.name).toBe("Custom promotion");

      // Recording on it without a promo name is refused, exactly as for the Spanish name.
      expect(
        await pay(org.organizationId, { studentId: student.id, year: "2026", month: "1", planId: promo.id, status: "PROMO", amount: "10" }),
      ).toMatchObject({ error: "promoNameRequired" });

      expect(await createPlan(org.organizationId, {}, form({ academyId: org.academyId, name: "Custom promotion" }))).toMatchObject({ error: "systemPlan" });
      expect(await updatePlan(org.organizationId, {}, form({ planId: promo.id, name: "Renamed" }))).toMatchObject({ error: "systemPlan" });
      expect(await deactivatePlan(org.organizationId, promo.id)).toMatchObject({ error: "systemPlan" });
      // ...and it does not count as "another active plan" for the last-plan guard.
      const monthly = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Monthly" } });
      expect(await deactivatePlan(org.organizationId, monthly.id)).toMatchObject({ error: "lastActivePlan" });
    });

    it("a recurring promo on the English-named plan still carries forward into the next month", async () => {
      const org = await newOrganization({ locale: "en", currency: "USD" });
      actAs(org.ownerId, org.organizationId);
      const student = await makeStudent(org.organizationId, org.academyId, "encarry");
      const promo = await ensureCustomPromoPlan(org.organizationId, org.academyId);

      expect(
        await pay(org.organizationId, {
          studentId: student.id,
          year: "2026",
          month: "1",
          planId: promo.id,
          status: "PROMO",
          amount: "0",
          promoName: "Competitor scholarship",
          promoRecurring: "on",
        }),
      ).toEqual({ ok: true });

      const february = await getCurrentPaymentPeriod(student.id, org.organizationId, { year: 2026, month: 2 });
      expect(february).toMatchObject({ planName: "Custom promotion", promoName: "Competitor scholarship", promoRecurring: true });
    });
  });

  describe("the currency is snapshotted on every payment", () => {
    it("REQUIRED: a payment records the currency of the moment; changing the organization's currency never relabels it", async () => {
      const org = await newOrganization({ currency: "USD" });
      actAs(org.ownerId, org.organizationId);
      const student = await makeStudent(org.organizationId, org.academyId, "snap");
      const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { academyId: org.academyId, name: "Mensualidad" } });
      const key = (month: number) => ({ studentId_year_month: { studentId: student.id, year: 2026, month } });

      await pay(org.organizationId, { studentId: student.id, year: "2026", month: "1", planId: plan.id, amount: "45" });
      expect((await prisma.paymentPeriod.findUniqueOrThrow({ where: key(1) })).currency).toBe("USD");

      // The owner moves the academy from dollars to colones.
      expect(await changeOrganizationCurrency(org.organizationId, {}, form({ currency: "CRC" }))).toEqual({ ok: true });
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).currency).toBe("CRC");

      // A NEW payment is in colones...
      await pay(org.organizationId, { studentId: student.id, year: "2026", month: "2", planId: plan.id, amount: "22500" });
      const history = await getPaymentHistory(student.id, org.organizationId);
      const byMonth = new Map(history.map((h) => [h.month, h]));
      expect(byMonth.get(2)).toMatchObject({ amount: 22500, currency: "CRC" });
      // ...but the January payment is STILL dollars — money that changed hands is never relabelled.
      expect(byMonth.get(1)).toMatchObject({ amount: 45, currency: "USD" });

      // Correcting the OLD payment keeps the currency it was recorded in.
      await pay(org.organizationId, { studentId: student.id, year: "2026", month: "1", planId: plan.id, amount: "50", notes: "fixed" });
      expect(await prisma.paymentPeriod.findUniqueOrThrow({ where: key(1) })).toMatchObject({ currency: "USD" });

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: org.organizationId, action: "organization.currencyChange" } });
      expect(audit.before).toEqual({ currency: "USD" });
      expect(audit.after).toEqual({ currency: "CRC" });
    });

    it("REQUIRED: a carried-forward promo keeps its SOURCE row's currency, not the organization's current one", async () => {
      const org = await newOrganization({ currency: "USD" });
      actAs(org.ownerId, org.organizationId);
      const student = await makeStudent(org.organizationId, org.academyId, "carry");
      const promo = await ensureCustomPromoPlan(org.organizationId, org.academyId);

      // A recurring promo recorded in dollars...
      expect(
        await pay(org.organizationId, {
          studentId: student.id,
          year: "2026",
          month: "1",
          planId: promo.id,
          status: "PROMO",
          amount: "30",
          promoName: "Beca competidor",
          promoRecurring: "on",
        }),
      ).toEqual({ ok: true });

      // ...then the academy switches to colones...
      await changeOrganizationCurrency(org.organizationId, {}, form({ currency: "CRC" }));

      // ...and the promo materialises for the next month. The copied 30 is still DOLLARS.
      const february = await getCurrentPaymentPeriod(student.id, org.organizationId, { year: 2026, month: 2 });
      expect(february).toMatchObject({ amount: 30, currency: "USD" });
    });

    it("only the OWNER can change the currency — a location director cannot", async () => {
      const org = await newOrganization();
      const director = await staffMember(org.organizationId, org.academyId, "DIRECTOR");
      actAs(director.id, org.organizationId, "DIRECTOR");

      await expect(changeOrganizationCurrency(org.organizationId, {}, form({ currency: "USD" }))).rejects.toThrow("FORBIDDEN");
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).currency).toBe("CRC");
    });

    it("rejects a currency that isn't in the list", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      expect(await changeOrganizationCurrency(org.organizationId, {}, form({ currency: "EUR" }))).toMatchObject({ error: "invalid" });
    });
  });
});
