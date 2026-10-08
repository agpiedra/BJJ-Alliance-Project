import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import * as duesFactsModule from "../../src/lib/dues/ledger/dues-facts";
import * as getCurrentPeriodModule from "../../src/lib/payments/get-current-period";
import * as overdueModule from "../../src/lib/payments/overdue";
import * as listOverdueModule from "../../src/lib/payments/list-overdue";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1/§2.3 (PR 3): a real render of the current dashboard page, proving the
 * two independent ledger counts (Decision 1), the extended inactive/archived population (Decision 2, scoped to the
 * caller's existing tenant/branch authorization), the contact list's own unchanged ACTIVE-only population showing
 * independent ledger facts, the §6.2 partial-read-failure policy, and the §6 "active path never calls the legacy
 * reader" requirement — via real module spies, not code reading.
 *
 * Coverage months/dueOn dates are pinned to 2020 (same technique `students-page-ledger-render.test.ts` already
 * uses): the dashboard page's own `now` is real `DateTime.now()` (not injectable), so fixtures must be unambiguously
 * past-grace/past-due under the REAL current date, not under a fixed fixture clock. The obligation WRITER's own
 * `deps.now` is a separate, fixed reference date — irrelevant to how the page itself evaluates the facts later.
 */
const prisma = getTestPrismaClient();

let mockActive = false;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
vi.mock("../../src/app/[locale]/(staff)/dashboard/weekly-attendance-chart", () => ({ WeeklyAttendanceChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/attendance-by-class-chart", () => ({ AttendanceByClassChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/confirm-promotion-button", () => ({ ConfirmPromotionButton: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/branding-reminder-card", () => ({ BrandingReminderCard: () => null }));

const { default: DashboardPage } = await import("../../src/app/[locale]/(staff)/dashboard/page");

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const WRITER_NOW = new Date("2030-12-15T12:00:00-06:00");
const writerDeps = { activation: { isActive: async () => true }, now: () => WRITER_NOW };

let a: Fixture;
let academyB: { id: string };
let director: { id: string };
let otherOrg: Fixture;
const termsByAcademy: Record<string, { id: string }> = {};
const policyByAcademy: Record<string, { id: string }> = {};

async function seedPlanAndPolicy(org: Fixture, academyId: string) {
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `DashRender plan ${suffix}-${academyId}` } });
  termsByAcademy[academyId] = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  policyByAcademy[academyId] = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "DashRender", lastName: `S${n}-${suffix}`, phone: "00000000",
      email: `dashrender-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `dashrender-${n}-${suffix}`, status,
    },
  });
}

async function newMonthlyObligation(org: Fixture, studentId: string, academyId: string) {
  const r = await createMonthlyObligation(
    { context: { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null }, studentId, coverage: { year: 2020, month: 1 }, planTermsId: termsByAcademy[academyId]!.id, policyVersionId: policyByAcademy[academyId]!.id },
    writerDeps,
  );
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function newSignupObligation(org: Fixture, studentId: string, academyId: string) {
  return prisma.duesObligation.create({
    data: {
      organizationId: org.org.id, studentId, academyId, origin: "STAFF", type: "SIGNUP",
      coverageYear: 2020, coverageMonth: 1, monthsCovered: 1, amount: "50.00", currency: "USD",
      dueOn: new Date("2020-01-05"), graceDeadline: null, lateFeeAmount: null, planTermsId: termsByAcademy[academyId]!.id, policyVersionId: null, createdById: org.admin.id,
    },
  });
}

async function newAttendance(org: Fixture, studentId: string, academyId: string, daysAbsent: number) {
  const occurredAt = new Date(Date.now() - daysAbsent * 86_400_000);
  await prisma.attendanceRecord.create({
    data: { organizationId: org.org.id, academyId, studentId, type: "CHECKIN", source: "KIOSK", occurredAt, date: occurredAt },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "dashrender-a");
  otherOrg = await makeAccountingOrg("CUMULATIVE", "dashrender-other");
  academyB = await prisma.academy.create({ data: { organizationId: a.org.id, name: "DashRender B", slug: `dashrender-b-${suffix}`, kioskTokenHash: `dashrender-b-${suffix}` } });

  const directorUser = await prisma.user.create({ data: { email: `dashrender-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;

  await seedPlanAndPolicy(a, a.academy.id);
  await seedPlanAndPolicy(a, academyB.id);
  await seedPlanAndPolicy(otherOrg, otherOrg.academy.id);
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (a) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
    // a.drop() deletes every attendance/student/academy row scoped by organizationId — covers academyB too.
    await a.drop();
  }
  if (otherOrg) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, otherOrg.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: otherOrg.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: otherOrg.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: otherOrg.org.id } });
    await otherOrg.drop();
  }
}, 120_000);

async function renderAs(userId: string, organizationId: string): Promise<string> {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
  const page = await DashboardPage();
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

/** The note text right under a given stat tile's label — scopes a names check to THAT tile, since other
 * students (e.g. contact-list rows) legitimately mention the same substrings elsewhere on the page. */
function statTileNote(html: string, label: string): string {
  const match = html.match(new RegExp(`${label}</div><div[^>]*>\\d+</div><div[^>]*>([^<]*)</div>`));
  return match?.[1] ?? "";
}

/** The contact-list row for one student, bounded to its own `<tr>...</tr>` — other rows (shared fixtures
 * accumulate across tests in this file) must never leak into a single row's assertions. */
function contactRow(html: string, fullName: string): string {
  const start = html.indexOf(fullName);
  if (start === -1) return "";
  const rowStart = html.lastIndexOf("<tr", start);
  const rowEnd = html.indexOf("</tr>", start);
  return html.slice(rowStart, rowEnd);
}

describe("dashboard: MONTHLY-only, SIGNUP-only, and overlapping students counted correctly (Decision 1)", () => {
  it("REQUIRED: two independent, never-merged counts — a student with both facts counts toward both, never deduplicated into one total", async () => {
    mockActive = true;
    const monthlyOnly = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, monthlyOnly.id, a.academy.id);
    const signupOnly = await newStudent(a, a.academy.id);
    await newSignupObligation(a, signupOnly.id, a.academy.id);
    const overlap = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, overlap.id, a.academy.id);
    await newSignupObligation(a, overlap.id, a.academy.id);
    const clean = await newStudent(a, a.academy.id);

    const html = await renderAs(a.admin.id, a.org.id);

    const monthlyNote = statTileNote(html, "Monthly past grace");
    const signupNote = statTileNote(html, "Signup past due");
    expect(monthlyNote).toContain(`${monthlyOnly.firstName} ${monthlyOnly.lastName}`);
    expect(monthlyNote).toContain(`${overlap.firstName} ${overlap.lastName}`);
    expect(monthlyNote).not.toContain(`${signupOnly.firstName} ${signupOnly.lastName}`);
    expect(monthlyNote).not.toContain(`${clean.firstName} ${clean.lastName}`);
    expect(signupNote).toContain(`${signupOnly.firstName} ${signupOnly.lastName}`);
    expect(signupNote).toContain(`${overlap.firstName} ${overlap.lastName}`);
    expect(signupNote).not.toContain(`${monthlyOnly.firstName} ${monthlyOnly.lastName}`);
    expect(signupNote).not.toContain(`${clean.firstName} ${clean.lastName}`);
  });
});

describe("dashboard: population extended to inactive/archived students with qualifying debt (Decision 2)", () => {
  it("REQUIRED: an ARCHIVED student with real old debt appears on the dashboard, clearly labeled, but never on the contact list", async () => {
    mockActive = true;
    const archived = await newStudent(a, a.academy.id, "ARCHIVED");
    await newMonthlyObligation(a, archived.id, a.academy.id);
    await newAttendance(a, archived.id, a.academy.id, 30); // would also qualify for the contact list by attendance alone, if they were ACTIVE

    const html = await renderAs(a.admin.id, a.org.id);

    // Appears on the dashboard panel, labeled with their real (non-ACTIVE) status, and never a second time
    // (a contact-list row for the same student would add a second occurrence) — the contact list never gained it.
    expect(html).toContain(`${archived.firstName} ${archived.lastName} (Archived)`);
    const occurrences = html.split(`${archived.firstName} ${archived.lastName}`).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("dashboard contact list: independent ledger facts, population unchanged (§2.3)", () => {
  it("an ACTIVE, absent-enough student with real debt shows the independent ledger facts, not a legacy status label or a collapsed boolean", async () => {
    mockActive = true;
    const student = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, student.id, a.academy.id);
    await newAttendance(a, student.id, a.academy.id, 10);

    const html = await renderAs(a.admin.id, a.org.id);
    const row = contactRow(html, `${student.firstName} ${student.lastName}`);
    expect(row).toContain("$"); // a real USD total, never collapsed into "No outstanding debt"
    expect(row).not.toContain("No outstanding debt");
  });
});

describe("dashboard: tenant/branch isolation with real foreign data and positive controls", () => {
  it("REQUIRED: a DIRECTOR scoped to academy A never sees academy B's (same-org) debt student, but DOES see their own branch's debt student", async () => {
    mockActive = true;
    const ownBranchDebtor = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, ownBranchDebtor.id, a.academy.id);
    const otherBranchDebtor = await newStudent(a, academyB.id);
    await newMonthlyObligation(a, otherBranchDebtor.id, academyB.id);

    const html = await renderAs(director.id, a.org.id);
    expect(html).toContain(`${ownBranchDebtor.firstName} ${ownBranchDebtor.lastName}`); // positive control
    expect(html).not.toContain(`${otherBranchDebtor.firstName} ${otherBranchDebtor.lastName}`); // real foreign (cross-branch) data
  });

  it("REQUIRED: an ADMIN sees both branches' debt students, within their own organization only — a genuinely different organization's debt student never appears", async () => {
    mockActive = true;
    const branchADebtor = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, branchADebtor.id, a.academy.id);
    const branchBDebtor = await newStudent(a, academyB.id);
    await newMonthlyObligation(a, branchBDebtor.id, academyB.id);
    const foreignOrgDebtor = await newStudent(otherOrg, otherOrg.academy.id);
    await newMonthlyObligation(otherOrg, foreignOrgDebtor.id, otherOrg.academy.id);

    const html = await renderAs(a.admin.id, a.org.id);
    expect(html).toContain(`${branchADebtor.firstName} ${branchADebtor.lastName}`);
    expect(html).toContain(`${branchBDebtor.firstName} ${branchBDebtor.lastName}`);
    expect(html).not.toContain(`${foreignOrgDebtor.firstName} ${foreignOrgDebtor.lastName}`);
  });
});

describe("dashboard: partial-read failure stays visible (§6.2)", () => {
  it("REQUIRED: a student missing from an otherwise-successful read shows an explicit unknown count on the dashboard panel, and 'unavailable' on the contact list — never silently zero/healthy", async () => {
    mockActive = true;
    const debtor = await newStudent(a, a.academy.id);
    await newMonthlyObligation(a, debtor.id, a.academy.id);
    await newAttendance(a, debtor.id, a.academy.id, 10);

    // `roster-payment-facts-queries.ts`'s own documented partial-failure case: "a student missing from an
    // otherwise-successful chunk" — simulated by stripping this one student's fact out of a real, successful
    // `listDuesFactsForStudents` result, rather than failing the whole batched read.
    const real = duesFactsModule.listDuesFactsForStudents;
    const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (!result.ok) return result;
      return { ...result, facts: result.facts.filter((f) => f.studentId !== debtor.id) };
    });
    let html: string;
    try {
      html = await renderAs(a.admin.id, a.org.id);
    } finally {
      spy.mockRestore();
    }
    expect(html).toContain("unknown");
    // React escapes the apostrophe in rendered text as `&#x27;` — assert on the unambiguous half of the string.
    expect(contactRow(html, `${debtor.firstName} ${debtor.lastName}`)).toContain("load payment status");
  });
});

describe("dashboard: active path skips legacy payment calculations entirely (§6)", () => {
  it("REQUIRED: getCurrentPaymentPeriod/isOverdue/listOverdueStudents are never called when the ledger is active", async () => {
    mockActive = true;
    const periodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const overdueSpy = vi.spyOn(overdueModule, "isOverdue");
    const listOverdueSpy = vi.spyOn(listOverdueModule, "listOverdueStudents");
    try {
      await renderAs(a.admin.id, a.org.id);
      expect(periodSpy).not.toHaveBeenCalled();
      expect(overdueSpy).not.toHaveBeenCalled();
      expect(listOverdueSpy).not.toHaveBeenCalled();
    } finally {
      periodSpy.mockRestore();
      overdueSpy.mockRestore();
      listOverdueSpy.mockRestore();
    }
  });

  it("the inactive path still calls them — unchanged existing behavior", async () => {
    mockActive = false;
    const periodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const overdueSpy = vi.spyOn(overdueModule, "isOverdue");
    const listOverdueSpy = vi.spyOn(listOverdueModule, "listOverdueStudents");
    try {
      await renderAs(a.admin.id, a.org.id);
      expect(listOverdueSpy).toHaveBeenCalled();
      expect(periodSpy).toHaveBeenCalled();
      expect(overdueSpy).toHaveBeenCalled();
    } finally {
      periodSpy.mockRestore();
      overdueSpy.mockRestore();
      listOverdueSpy.mockRestore();
    }
  });
});
