import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import * as duesFactsModule from "../../src/lib/dues/ledger/dues-facts";
import * as rosterPaymentFactsModule from "../../src/lib/dues/roster-payment-facts-queries";
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
async function newStudent(org: Fixture, academyId: string, status: "ACTIVE" | "INACTIVE" | "ARCHIVED" = "ACTIVE") {
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

/** The exact rendered number for a given stat tile's label — the numeric contract itself, not just the note. */
function statTileCount(html: string, label: string): number {
  const match = html.match(new RegExp(`${label}</div><div[^>]*>(\\d+)</div>`));
  if (!match) throw new Error(`Stat tile "${label}" not found in rendered HTML`);
  return Number(match[1]);
}

/** The "N unknown" suffix inside a tile's own note (§6.2) — 0 when the note carries no such suffix at all. */
function statTileUnknownCount(html: string, label: string): number {
  const match = statTileNote(html, label).match(/(\d+) unknown/);
  return match ? Number(match[1]) : 0;
}

/** MATROOM Phase 3 (approved prototype, review finding): a stat tile's colour flag is now conditional on its
 * own value, not a static prop — this checks for the flag's own indicator span (`bg-bad`/`bg-brand-gold` on
 * the `aria-hidden` rail StatTile renders only when `flag` is set) inside that specific tile's own fragment,
 * bounded the same way `statTileNote`/`statTileCount` already bound themselves to one tile by its label. */
function statTileHasFlag(html: string, label: string): boolean {
  const labelIndex = html.indexOf(`>${label}</div>`);
  if (labelIndex === -1) throw new Error(`Stat tile "${label}" not found in rendered HTML`);
  // Anchor to the tile's own outer <div>, not the label's own nested one — StatTile's outer class list always
  // contains "bg-card p-4" (with or without "pl-5"), a fragment unique to a tile's own opening tag, never to its
  // label/value/note children or the flag span itself.
  const tileStart = html.lastIndexOf("bg-card p-4", labelIndex);
  if (tileStart === -1) throw new Error(`Stat tile "${label}" has no enclosing tile markup in rendered HTML`);
  const segment = html.slice(tileStart, labelIndex);
  return segment.includes("bg-bad") || segment.includes("bg-brand-gold");
}

/** The contact-list row for one student, bounded to its own `<tr>...</tr>` — other rows (shared fixtures
 * accumulate across tests in this file) must never leak into a single row's assertions.
 *
 * A qualifying debtor's full name can ALSO appear earlier on the page, inside a "Monthly past grace"/"Signup
 * past due" stat-tile note (`joinNames` only truncates past its 3-name cap — below that, every name it lists is
 * literally rendered). The first occurrence found by `indexOf` is that note mention, which sits before the
 * page's very first `<tr>`: `lastIndexOf("<tr", start)` then returns -1, and `String.prototype.slice` treats a
 * negative start as counting from the END of the string rather than "not found", silently returning a bogus (or
 * empty) slice instead of throwing. Demonstrated directly below. Scans forward through EVERY occurrence of the
 * name and returns the first one actually enclosed by a `<tr>...</tr>` pair, so a note mention is skipped in
 * favor of the real row — and a name that is never inside any row still correctly returns "". */
function contactRow(html: string, fullName: string): string {
  let start = html.indexOf(fullName);
  while (start !== -1) {
    const rowStart = html.lastIndexOf("<tr", start);
    const rowEnd = html.indexOf("</tr>", start);
    if (rowStart !== -1 && rowEnd !== -1 && rowEnd > rowStart) {
      return html.slice(rowStart, rowEnd);
    }
    start = html.indexOf(fullName, start + 1);
  }
  return "";
}

describe("contactRow: a name mentioned earlier on the page never shadows its real <tr> row (regression)", () => {
  it("REQUIRED: a stat-tile note mention before the table does not make the real row unreachable", () => {
    const html =
      '<div>Monthly past grace: DashRender NoteShadow-1</div>' +
      '<table><tbody><tr><td>DashRender NoteShadow-1</td><td>$ 50.00</td></tr></tbody></table>';
    const row = contactRow(html, "DashRender NoteShadow-1");
    expect(row).not.toBe("");
    expect(row).toContain("$");
  });

  it("REQUIRED: a name that never appears inside any row still returns empty, not a neighboring row's content", () => {
    const html =
      '<div>Monthly past grace: DashRender NoteShadow-2</div>' +
      '<table><tbody><tr><td>Someone Else</td></tr></tbody></table>';
    expect(contactRow(html, "DashRender NoteShadow-2")).toBe("");
  });
});

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

    // Numeric contract (review fix): this is the FIRST test to render in this file, against a fresh org with no
    // other qualifying debtors yet — monthlyOnly + overlap = 2, signupOnly + overlap = 2, never summed/deduped
    // into one total (would be 3 unique students, or 4 if double-counted — neither 2 nor 2).
    expect(statTileCount(html, "Monthly past grace")).toBe(2);
    expect(statTileCount(html, "Signup past due")).toBe(2);
    // MATROOM Phase 3 (review finding): colour flag reflects the real non-zero count here — the zero case is
    // covered separately below, against a genuinely empty org, not asserted by omission in this shared-fixture one.
    expect(statTileHasFlag(html, "Monthly past grace")).toBe(true);
    expect(statTileHasFlag(html, "Signup past due")).toBe(true);

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
  it("REQUIRED: both an ARCHIVED and an INACTIVE student with real old debt appear on the dashboard, clearly labeled, but never on the contact list", async () => {
    mockActive = true;
    // Split across the two tiles on purpose: `joinNames` caps a tile's note at 3 names, and this shared org
    // already carries 2 qualifying names per tile from the earlier "two independent counts" test — putting BOTH
    // new debtors on the SAME tile would push one past the cap, truncating it to "+1" and silently removing its
    // name from the literal-containment check below (a test-fixture ordering artifact, not a real product bug).
    const archived = await newStudent(a, a.academy.id, "ARCHIVED");
    await newSignupObligation(a, archived.id, a.academy.id);
    await newAttendance(a, archived.id, a.academy.id, 30); // would also qualify for the contact list by attendance alone, if they were ACTIVE
    const inactive = await newStudent(a, a.academy.id, "INACTIVE");
    await newMonthlyObligation(a, inactive.id, a.academy.id);
    await newAttendance(a, inactive.id, a.academy.id, 30);

    const html = await renderAs(a.admin.id, a.org.id);

    // Appears on the dashboard panel, labeled with their real (non-ACTIVE) status, and never a second time
    // (a contact-list row for the same student would add a second occurrence) — the contact list never gained it.
    expect(statTileNote(html, "Signup past due")).toContain(`${archived.firstName} ${archived.lastName} (Archived)`);
    expect(html.split(`${archived.firstName} ${archived.lastName}`).length - 1).toBe(1);
    expect(statTileNote(html, "Monthly past grace")).toContain(`${inactive.firstName} ${inactive.lastName} (Inactive)`);
    expect(html.split(`${inactive.firstName} ${inactive.lastName}`).length - 1).toBe(1);
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
  it("REQUIRED: a student missing from an otherwise-successful read shows an explicit unknown count on the dashboard panel, excluded from the confirmed counts, and 'unavailable' on the contact list — never silently zero/healthy", async () => {
    mockActive = true;
    // Baseline BEFORE this test's own debtor exists — other tests in this file share org `a`, so the confirmed
    // count already includes earlier fixtures' debtors. The numeric contract this test proves is a DELTA: this
    // debtor's real debt must contribute zero to the confirmed count and exactly one to `unknownCount`.
    const baselineHtml = await renderAs(a.admin.id, a.org.id);
    const baselineMonthlyCount = statTileCount(baselineHtml, "Monthly past grace");

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

    // Numeric contract (review fix): the failed student is NEVER folded into the confirmed count (it would have
    // qualified for "Monthly past grace" had the read succeeded) — the count stays exactly at its baseline — and
    // `unknownCount` is exactly 1, not merged into, or confused with, the confirmed count itself.
    expect(statTileCount(html, "Monthly past grace")).toBe(baselineMonthlyCount);
    expect(statTileUnknownCount(html, "Monthly past grace")).toBe(1);
    expect(statTileUnknownCount(html, "Signup past due")).toBe(1);
    expect(statTileNote(html, "Monthly past grace")).not.toContain(`${debtor.firstName} ${debtor.lastName}`);

    expect(html).toContain("unknown");
    // React escapes the apostrophe in rendered text as `&#x27;` — assert on the unambiguous half of the string.
    expect(contactRow(html, `${debtor.firstName} ${debtor.lastName}`)).toContain("load payment status");
  });
});

describe("dashboard + contact list share one captured ledger instant (review fix)", () => {
  it("REQUIRED: the panel's own ledger read and the contact list's internal ledger read receive the SAME instant, never an independently re-captured later one, across a branch-local midnight boundary", async () => {
    mockActive = true;
    const student = await newStudent(a, a.academy.id);
    await newAttendance(a, student.id, a.academy.id, 10);

    // A dedicated policy/terms (graceDay 14), used ONLY by this test — the shared academy policy (graceDay 5)
    // stays untouched for every other test in this file. Coverage {2030, 5} + graceDay 14 ⇒ graceDeadlineFor
    // (next month's graceDay) = 2030-06-14, exactly the branch-local calendar date of INSTANT_A below.
    const boundaryPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `DashRender boundary plan ${suffix}` } });
    const boundaryTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: boundaryPlan.id, effectiveYear: 2020, effectiveMonth: 2, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const boundaryPolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 2, dueDay: 20, graceDay: 14, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
    const r = await createMonthlyObligation(
      { context: { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null }, studentId: student.id, coverage: { year: 2030, month: 5 }, planTermsId: boundaryTerms.id, policyVersionId: boundaryPolicy.id },
      writerDeps,
    );
    if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);

    // America/Costa_Rica (UTC-6, no DST, the academy's own default timezone): INSTANT_A is 30 seconds before
    // branch-local midnight on 2030-06-14; INSTANT_B is 30 seconds after it rolls over to 2030-06-15 — a real
    // branch-local midnight boundary. `DateTime.now()` returns INSTANT_A on its FIRST call (the dashboard page's
    // own capture) and INSTANT_B on every call after — simulating exactly what a re-introduced bug (the contact
    // list independently calling `DateTime.now()` again, later in the same render) would receive.
    const INSTANT_A = DateTime.fromISO("2030-06-14T23:59:30", { zone: "America/Costa_Rica" }) as ReturnType<typeof DateTime.now>;
    const INSTANT_B = DateTime.fromISO("2030-06-15T00:00:30", { zone: "America/Costa_Rica" }) as ReturnType<typeof DateTime.now>;
    const nowSpy = vi.spyOn(DateTime, "now").mockReturnValueOnce(INSTANT_A).mockReturnValue(INSTANT_B);

    const capturedInstants: Date[] = [];
    const realListRosterPaymentFacts = rosterPaymentFactsModule.listRosterPaymentFacts;
    const factsSpy = vi
      .spyOn(rosterPaymentFactsModule, "listRosterPaymentFacts")
      .mockImplementation(async (...args: Parameters<typeof realListRosterPaymentFacts>) => {
        capturedInstants.push(args[2]);
        return realListRosterPaymentFacts(...args);
      });

    let html: string;
    try {
      html = await renderAs(a.admin.id, a.org.id);
    } finally {
      nowSpy.mockRestore();
      factsSpy.mockRestore();
    }

    // Core proof: EVERY ledger read during this render (the panel's own population call, and the one inside
    // `listStudentsToContact`) received the identical instant — the dashboard's first-captured INSTANT_A, never
    // the later INSTANT_B that an independent `DateTime.now()` call would have produced.
    expect(capturedInstants.length).toBeGreaterThanOrEqual(2);
    for (const instant of capturedInstants) {
      expect(instant.getTime()).toBe(INSTANT_A.toJSDate().getTime());
    }

    // Content-level consistency at the boundary: at INSTANT_A's branch-local date (2030-06-14), this obligation's
    // grace deadline (also 2030-06-14) has NOT yet passed (`compareDates` is strict `>` — "on the deadline" is
    // still on time), so it must NOT appear in the dashboard's "Monthly past grace" tile, and the contact list's
    // row for the same student must show the principal with NO late fee. Had the contact list instead used
    // INSTANT_B (one branch-local day later), the SAME obligation would already be past grace and carry a late
    // fee — a real, user-visible divergence this fixture is built to expose, not just a spy-argument artifact.
    const monthlyNote = statTileNote(html, "Monthly past grace");
    expect(monthlyNote).not.toContain(`${student.firstName} ${student.lastName}`);
    const row = contactRow(html, `${student.firstName} ${student.lastName}`);
    expect(row).toContain("$");
    expect(row).not.toContain("late fee");
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

describe("dashboard: StatTile colour flag is absent for a genuinely zero count (MATROOM Phase 3 review finding)", () => {
  // Its own dedicated, genuinely empty org — zero students — rather than asserting "zero" against the shared
  // `a`/`otherOrg` fixtures above, which accumulate debtors across this file's other tests. Zero students means
  // zero of every count this page computes (promotion queue, legacy overdue, both ledger tiles); no plan/policy/
  // obligation fixture is needed to prove that.
  let empty: Fixture;

  beforeAll(async () => {
    empty = await makeAccountingOrg("CUMULATIVE", "dashrender-empty");
  }, 30_000);

  afterAll(async () => {
    if (empty) await empty.drop();
  }, 30_000);

  it("REQUIRED: zero ready-to-grade and zero legacy overdue render with no colour flag", async () => {
    mockActive = false;
    const html = await renderAs(empty.admin.id, empty.org.id);
    expect(statTileCount(html, "Ready to grade")).toBe(0);
    expect(statTileHasFlag(html, "Ready to grade")).toBe(false);
    expect(statTileCount(html, "Overdue monthly dues")).toBe(0);
    expect(statTileHasFlag(html, "Overdue monthly dues")).toBe(false);
  });

  it("REQUIRED: zero on both ledger-active tiles renders with no colour flag", async () => {
    mockActive = true;
    const html = await renderAs(empty.admin.id, empty.org.id);
    expect(statTileCount(html, "Monthly past grace")).toBe(0);
    expect(statTileHasFlag(html, "Monthly past grace")).toBe(false);
    expect(statTileCount(html, "Signup past due")).toBe(0);
    expect(statTileHasFlag(html, "Signup past due")).toBe(false);
  });
});
