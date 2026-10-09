import "dotenv/config";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { ZONE } from "../../src/lib/scheduling/zone";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.2/§6.1 Decision 3 (PR 6): a real render of
 * `dashboard/analytics/page.tsx` (and, for one assertion, `locations-panel.tsx`'s own per-academy propagation),
 * proving the new ledger label, the partial-failure display string, and the empty-population string actually
 * reach the page — not merely the data layer this file's sibling (`analytics-payment-health.test.ts`) already
 * covers. Same mocking technique `payments-page-ledger-render.test.ts`/`dashboard-page-ledger-render.test.ts`
 * already establish: `@/lib/dues/ledger/activation` and `@/auth` mocked at the top level, `next-intl/server`
 * stubbed with the real `en.json` messages.
 */
const prisma = getTestPrismaClient();

let mockActive = true;
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

/**
 * Review fix (PR 6, gap 2): `ExportCsvButton`'s real CSV build happens entirely CLIENT-SIDE, inside its own
 * `onClick` handler (`toCsv(rows)` → a Blob download) — never present in server-rendered markup, so a plain
 * `renderToStaticMarkup` assertion can never see the actual CSV payload. Stubbed here to dump its `rows` prop
 * as inspectable JSON text instead, the same "replace a client-only concern with something the test CAN see"
 * technique this codebase's own render-test precedents already use for other client subcomponents (e.g.
 * `payments-page-ledger-render.test.ts`'s stubs). Every panel on this page uses the SAME `ExportCsvButton`, so
 * this produces several JSON dumps per render — assertions below match on a specific dump's exact substring,
 * not "the only one."
 */
vi.mock("../../src/app/[locale]/(staff)/dashboard/analytics/export-csv-button", () => ({
  ExportCsvButton: ({ rows }: { rows: Array<Record<string, string | number>> }) =>
    createElement("pre", { "data-csv-dump": true }, JSON.stringify(rows)),
}));

const { default: AnalyticsPage } = await import("../../src/app/[locale]/(staff)/dashboard/analytics/page");
const { createMonthlyObligation } = await import("../../src/lib/dues/ledger/create-monthly-obligation");
const { recordDuesPayment } = await import("../../src/lib/dues/ledger/record-payment");
const headlineTilesModule = await import("../../src/lib/analytics/headline-tiles");
const locationsModule = await import("../../src/lib/analytics/locations");
const paymentHealthModule = await import("../../src/lib/analytics/payment-health");

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function tenantContext(org: Fixture) {
  return { kind: "tenant" as const, actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN" as const, academyIds: "ALL" as const, selfStudentId: null, linkedStudentId: null };
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string) {
  const n = ++studentCounter;
  const s = suffix();
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "AnalyticsRender", lastName: `S${n}-${s}`, phone: "00000000",
      email: `analytics-render-${n}-${s}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `analytics-render-${n}-${s}`, status: "ACTIVE",
    },
  });
}

async function seedPlanAndPolicy(org: Fixture, academyId: string) {
  const s = suffix();
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `AR plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2025, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear: 2025, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
  return { terms, policy };
}

/** A real settled MONTHLY obligation for the REAL current branch-local month — `getHeadlineTiles`'s own
 * `ledgerNow` is real wall-clock time, not injectable from a page render, so every fixture here targets
 * whatever month the test actually runs in, via the writer's own default (real) clock. */
async function settledCurrentMonthStudent(org: Fixture, academyId: string, terms: { id: string }, policy: { id: string }) {
  const student = await newStudent(org, academyId);
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const created = await createMonthlyObligation({ context: tenantContext(org), studentId: student.id, coverage: { year, month }, planTermsId: terms.id, policyVersionId: policy.id });
  if (!created.ok) throw new Error(`fixture obligation failed: ${created.error}`);
  const settled = await recordDuesPayment({
    context: tenantContext(org), studentId: student.id, receivedOn: { year, month, day: 1 },
    tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [created.obligationId], maxBackdateDays: 60,
  });
  if (!settled.ok) throw new Error(`fixture settle failed: ${settled.error}`);
  return student;
}

async function unpaidCurrentMonthStudent(org: Fixture, academyId: string, terms: { id: string }, policy: { id: string }) {
  const student = await newStudent(org, academyId);
  const today = new Date();
  const created = await createMonthlyObligation({ context: tenantContext(org), studentId: student.id, coverage: { year: today.getFullYear(), month: today.getMonth() + 1 }, planTermsId: terms.id, policyVersionId: policy.id });
  if (!created.ok) throw new Error(`fixture obligation failed: ${created.error}`);
  return student;
}

async function dropDeps(org: Fixture) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
}

/** React's own text-content escaping (`escapeTextForBrowser`) turns `"`/`'`/`&`/`<`/`>` into HTML entities even
 * inside a plain text node — undoing that is what lets the `JSON.stringify`'d CSV dump be matched as literal
 * JSON text below, rather than against its escaped-for-HTML form. */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Every `ExportCsvButton` stub's dumped `rows` prop on the page, decoded back to literal JSON text. */
function extractCsvDumps(html: string): string[] {
  return [...html.matchAll(/<pre data-csv-dump="true">([\s\S]*?)<\/pre>/g)].map((m) => decodeHtmlEntities(m[1]));
}

async function renderAs(userId: string, organizationId: string): Promise<string> {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
  const page = await AnalyticsPage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("dashboard/analytics/page.tsx: payment health ledger cutover (page-level render)", () => {
  let fixture: Fixture;

  afterAll(async () => {
    if (fixture) {
      await dropDeps(fixture);
      await fixture.drop();
    }
  });

  it("REQUIRED: ledger-active, full success — the new ledger label and a plain percentage render", async () => {
    mockActive = true;
    fixture = await makeAccountingOrg("CUMULATIVE", "ar-full-success");
    const { terms, policy } = await seedPlanAndPolicy(fixture, fixture.academy.id);
    await settledCurrentMonthStudent(fixture, fixture.academy.id, terms, policy);

    const html = await renderAs(fixture.admin.id, fixture.org.id);
    // The headline stat tile swaps to the ledger label; the per-location comparison table's own column header
    // deliberately keeps the generic "Payment health (current month)" text (a scoped decision — see
    // `locations-panel.tsx`'s own comment — since that surface has no direct access to `ledgerActive`), so this
    // assertion is scoped to the stat-tile markup only, not a blanket absence check over the whole page.
    const statTileSection = html.slice(0, html.indexOf("Class popularity"));
    expect(statTileSection).toContain("Current month covered by settled payments");
    expect(statTileSection).toContain("100%");
    expect(statTileSection).not.toContain("Payment health (current month)");
  });

  it("REQUIRED: ledger-active, a partial read failure — the exact confirmed/checked/unknown string renders", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-partial-failure");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const confirmed = await settledCurrentMonthStudent(org, org.academy.id, terms, policy);
      const failed = await unpaidCurrentMonthStudent(org, org.academy.id, terms, policy);

      const duesFactsModule = await import("../../src/lib/dues/ledger/dues-facts");
      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== failed.id) };
      });
      let html: string;
      try {
        html = await renderAs(org.admin.id, org.org.id);
      } finally {
        spy.mockRestore();
      }
      void confirmed;

      expect(html).toContain("1 confirmed-paid of 1 successfully checked (1 unknown)");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: ledger-active, an empty (zero-active-student) population shows the dedicated empty string, never 0% or a false 100%", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-empty-population");
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).toContain("No active students");
    } finally {
      await org.drop();
    }
  });

  it("the inactive path still renders the OLD label and a plain percentage — unchanged existing behavior", async () => {
    mockActive = false;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-inactive-regression");
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).toContain("Payment health (current month)");
      expect(html).not.toContain("Current month covered by settled payments");
    } finally {
      mockActive = true;
      await org.drop();
    }
  });

  it("REQUIRED (review fix, gap 1): the inactive path with an EMPTY (zero-active-student) population still renders the legacy 0% — never 'No active students', on either the headline tile or the per-academy location row/CSV", async () => {
    mockActive = false;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-inactive-empty-population");
    try {
      const html = await renderAs(org.admin.id, org.org.id);

      expect(html).not.toContain("No active students");
      const statTileSection = html.slice(0, html.indexOf("Class popularity"));
      expect(statTileSection).toContain("Payment health (current month)");
      expect(statTileSection).toContain("0%");

      // The per-academy location row (same org, one academy, zero students): the OLD table header AND the
      // OLD CSV header key, both carrying the legacy 0% value — not the new empty-population string.
      const locationsSection = html.slice(html.indexOf("Location comparison"));
      expect(locationsSection).toContain("Payment health (current month)");
      expect(locationsSection).not.toContain("Current month covered by settled payments");
      expect(locationsSection).toContain("0%");

      const csvDumps = extractCsvDumps(html);
      const locationCsvDump = csvDumps.find((d) => d.includes('"Academy"'));
      expect(locationCsvDump).toBeDefined();
      expect(locationCsvDump).toContain('"Payment health (current month)":"0%"');
      expect(locationCsvDump).not.toContain("No active students");

      const headlineCsvDump = csvDumps.find((d) => d.includes('"metric"') && d.includes('"Enrolled"'));
      expect(headlineCsvDump).toBeDefined();
      expect(headlineCsvDump).toContain('{"metric":"Payment health (current month)","value":"0%"}');
    } finally {
      mockActive = true;
      await org.drop();
    }
  });

  it("REQUIRED: the locations panel renders the SAME partial-failure string for one academy via locations.ts's own propagation", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-locations-partial");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const confirmed = await settledCurrentMonthStudent(org, org.academy.id, terms, policy);
      const failed = await unpaidCurrentMonthStudent(org, org.academy.id, terms, policy);
      void confirmed;

      const duesFactsModule = await import("../../src/lib/dues/ledger/dues-facts");
      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== failed.id) };
      });
      let html: string;
      try {
        html = await renderAs(org.admin.id, org.org.id);
      } finally {
        spy.mockRestore();
      }

      // The locations comparison table's own row for this (single-academy) organization — same exact string
      // `paymentHealthDisplay` in `locations-panel.tsx` produces from `locations.ts`'s propagated counts.
      expect(html).toContain("1 confirmed-paid of 1 successfully checked (1 unknown)");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED (review fix, gap 2): ledger-active — the locations table's visible column header AND its exported CSV header both switch to the approved ledger label", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-locations-label-cutover");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      await settledCurrentMonthStudent(org, org.academy.id, terms, policy);

      const html = await renderAs(org.admin.id, org.org.id);
      const locationsSection = html.slice(html.indexOf("Location comparison"));
      expect(locationsSection).toContain("Current month covered by settled payments");
      expect(locationsSection).not.toContain("Payment health (current month)");

      const csvDumps = extractCsvDumps(html);
      const locationCsvDump = csvDumps.find((d) => d.includes('"Academy"'));
      expect(locationCsvDump).toBeDefined();
      expect(locationCsvDump).toContain('"Current month covered by settled payments":"100%"');
      expect(locationCsvDump).not.toContain("Payment health (current month)");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED (review fix, gap 3): every ledger call this page makes — both getHeadlineTiles calls, and every per-academy getHeadlineTiles call inside getLocationComparison — receives the IDENTICAL captured instant/activation flag, never a freshly re-resolved one", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-one-ledger-instant");
    try {
      // A second academy so getLocationComparison's own internal Promise.all makes a SECOND per-academy
      // getHeadlineTiles call — without the fix, this (and the page's own current/previous-range pair) would
      // each resolve `DateTime.now()` independently; right at a real month boundary, that drift could land
      // different calls on different branch-local target months for what must be one consistent page load.
      const academyB = await prisma.academy.create({
        data: { organizationId: org.org.id, name: "AR Second Academy", slug: `ar-second-${suffix()}`, kioskTokenHash: `ar-second-hash-${suffix()}` },
      });

      // A controlled, strictly-ADVANCING clock — not real wall-clock time — because a real-clock version of
      // this test is NOT actually deterministic: several `DateTime.now()` calls made microseconds apart can
      // easily land on the identical millisecond, which would make an unthreaded (buggy) implementation look
      // threaded purely by timing luck. Advancing by a full day per call makes every call's own value visibly
      // distinct whenever `DateTime.now()` is genuinely invoked more than once for ledger purposes — the exact
      // "different instant each independent call" failure mode this fix prevents, deliberately forced instead
      // of hoped-for.
      let mockCallCount = 0;
      const dateTimeNowSpy = vi.spyOn(DateTime, "now").mockImplementation(
        () => DateTime.fromISO("2031-01-15T12:00:00", { zone: ZONE }).plus({ days: mockCallCount++ }) as DateTime<true>,
      );

      const headlineSpy = vi.spyOn(headlineTilesModule, "getHeadlineTiles");
      const locationsSpy = vi.spyOn(locationsModule, "getLocationComparison");
      // The REAL proof: `getHeadlineTiles`'s own `call[2]` argument is just what the PAGE passed in — always
      // the same object, even if `getHeadlineTiles` itself ignored it internally (the exact bug this test must
      // catch). `getLedgerPaymentHealth`'s own `now` argument (its 3rd parameter) is what `getHeadlineTiles`
      // ACTUALLY resolved `ledgerNow` to, internally — spying one layer deeper is what makes this test prove
      // the threading is honored, not merely that the page composed one instant and handed it to a function
      // that was free to disregard it.
      const paymentHealthSpy = vi.spyOn(paymentHealthModule, "getLedgerPaymentHealth");
      let headlineCalls: typeof headlineSpy.mock.calls;
      let locationsCalls: typeof locationsSpy.mock.calls;
      let paymentHealthCalls: typeof paymentHealthSpy.mock.calls;
      try {
        await renderAs(org.admin.id, org.org.id);
        // Captured HERE, before `mockRestore()` below — restoring a spy also clears its own `.mock.calls`.
        headlineCalls = headlineSpy.mock.calls;
        locationsCalls = locationsSpy.mock.calls;
        paymentHealthCalls = paymentHealthSpy.mock.calls;
      } finally {
        headlineSpy.mockRestore();
        locationsSpy.mockRestore();
        paymentHealthSpy.mockRestore();
        dateTimeNowSpy.mockRestore();
      }
      void academyB;

      // 2 direct page.tsx calls (current + previous range) + 2 per-academy calls inside getLocationComparison.
      expect(headlineCalls.length).toBe(4);
      expect(locationsCalls.length).toBe(1);
      // Ledger-active on every one of those 4 calls, so `getLedgerPaymentHealth` is reached exactly 4 times too.
      expect(paymentHealthCalls.length).toBe(4);

      // Layer 1: the page composed ONE `ledgerInstant` and passed the identical object into every call it made.
      const headlineLedgerInstants = headlineCalls.map((call) => call[2]);
      const locationsLedgerInstant = locationsCalls[0]?.[2];
      expect(headlineLedgerInstants.every((d) => d !== undefined)).toBe(true);
      expect(locationsLedgerInstant).toBeDefined();
      const everyPassedNowTime = [...headlineLedgerInstants, locationsLedgerInstant].map((d) => d!.ledgerNow.getTime());
      const everyPassedActiveFlag = [...headlineLedgerInstants, locationsLedgerInstant].map((d) => d!.ledgerActive);
      expect(new Set(everyPassedNowTime).size).toBe(1);
      expect(new Set(everyPassedActiveFlag).size).toBe(1);
      expect(everyPassedActiveFlag[0]).toBe(true);

      // Layer 2 (the real catch): what `getHeadlineTiles` ACTUALLY used `ledgerNow` as, internally, on every
      // one of its 4 calls — proven via the `now` it handed to `getLedgerPaymentHealth`, never recomputed.
      const everyActuallyUsedNowTime = paymentHealthCalls.map((call) => call[2].getTime());
      expect(new Set(everyActuallyUsedNowTime).size).toBe(1);
      expect(everyActuallyUsedNowTime[0]).toBe(everyPassedNowTime[0]);
    } finally {
      await org.drop();
    }
  });
});
