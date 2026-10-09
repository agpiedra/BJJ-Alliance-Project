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
import * as listCurrentStatusModule from "../../src/lib/payments/list-current-status";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.4 (PR 5): the Pagos status table's ledger cutover — reuses PR 3's own
 * `summarizeLedgerOverdue`/`listRosterPaymentFacts`/`toRosterLedgerDisplay` wiring
 * (`src/lib/payments/list-ledger-payment-status.ts`) through the real `TenantContext` `payments/page.tsx`
 * already resolves. Two describe blocks: a reader-level one (fee totals, pending-conversion) that calls
 * `listLedgerPaymentStatus` directly — neither fact is visible through the rendered status pill alone, which
 * only shows currency totals — and a page-level one (overlapping stat-tile counts, visible read failures,
 * tenant/branch isolation, active legacy-reader exclusion) that renders the real page.
 *
 * Coverage months are pinned to 2020 (same technique `dashboard-page-ledger-render.test.ts` already uses) — this
 * page's own ledger `now` is real, unmocked wall-clock time (not injectable here), so fixtures must be
 * unambiguously past-grace/past-due under the REAL current date.
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
// Irrelevant to this PR's own change (the status table), same stubbing technique `payments-page-card-gating.test.ts`
// already established — `useRouter()`/form-state hooks have no app-router context outside a real Next.js request.
vi.mock("../../src/app/[locale]/(staff)/payments/payment-entry-section", () => ({ PaymentEntrySection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/package-purchase-section", () => ({ PackagePurchaseSection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/prepayment-section", () => ({ PrepaymentSection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/financial-corrections-section", () => ({ FinancialCorrectionsSection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/payments-table", () => ({ PaymentsTable: () => null }));
vi.mock("@/components/payments/record-payment-form", () => ({ RecordPaymentForm: () => null }));
vi.mock("@/components/ui/toast", () => ({ Toaster: () => null }));

const { default: PaymentsPage } = await import("../../src/app/[locale]/(staff)/payments/page");
const { listLedgerPaymentStatus } = await import("../../src/lib/payments/list-ledger-payment-status");

const WRITER_NOW = new Date("2030-12-15T12:00:00-06:00");
const writerDeps = { activation: { isActive: async () => true }, now: () => WRITER_NOW };

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

// The page-level describe block below reuses the SAME academy across several `it`s (a shared `fixture`), each
// calling this helper again — `DuesPolicyVersion`'s own `(academyId, effectiveYear, effectiveMonth)` unique
// constraint would collide on a second call for the same academy at a fixed year/month. A distinct, strictly
// increasing `effectiveYear` per call (always <= 2020, the coverage year every obligation in this file uses)
// avoids the collision AND keeps each call's own policy the latest-effective one for that coverage at the
// moment it creates its own obligations (`createMonthlyObligation`'s own "staleVersion" check requires the id
// passed in to be the latest effective among ALL versions ever created for that academy) — tests run
// sequentially within a file, so this ordering holds.
let policyYearCounter = 2000;

async function seedPlanAndPolicy(org: Fixture, academyId: string, currency: "USD" | "CRC" = "USD") {
  const s = suffix();
  const effectiveYear = ++policyYearCounter;
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `Pagos plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear, effectiveMonth: 1, priceAmount: "100.00", currency, monthsCovered: 1, createdById: org.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: currency, createdById: org.admin.id },
  });
  return { terms, policy };
}

/** Terms only, no policy — a SIGNUP obligation has no `policyVersionId` by shape, so a caller that only needs a
 * second currency's terms (never a second `DuesPolicyVersion` for the same academy, which would become the new
 * "latest effective" one and invalidate an already-created MONTHLY obligation's own policy reference) uses this
 * instead of `seedPlanAndPolicy`. */
async function seedTermsOnly(org: Fixture, academyId: string, currency: "USD" | "CRC") {
  const s = suffix();
  const effectiveYear = ++policyYearCounter;
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `Pagos signup plan ${s}` } });
  return prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear, effectiveMonth: 1, priceAmount: "50.00", currency, monthsCovered: 1, createdById: org.admin.id },
  });
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string) {
  const n = ++studentCounter;
  const s = suffix();
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "PagosLedger", lastName: `S${n}-${s}`, phone: "00000000",
      email: `pagosledger-${n}-${s}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `pagosledger-${n}-${s}`, status: "ACTIVE",
    },
  });
}

async function newMonthlyObligation(org: Fixture, studentId: string, terms: { id: string }, policy: { id: string }) {
  const r = await createMonthlyObligation(
    { context: { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null }, studentId, coverage: { year: 2020, month: 1 }, planTermsId: terms.id, policyVersionId: policy.id },
    writerDeps,
  );
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function newSignupObligation(org: Fixture, studentId: string, academyId: string, terms: { id: string }, currency: "USD" | "CRC" = "USD") {
  return prisma.duesObligation.create({
    data: {
      organizationId: org.org.id, studentId, academyId, origin: "STAFF", type: "SIGNUP",
      coverageYear: 2020, coverageMonth: 1, monthsCovered: 1, amount: "50.00", currency,
      dueOn: new Date("2020-01-05"), graceDeadline: null, lateFeeAmount: null, planTermsId: terms.id, policyVersionId: null, createdById: org.admin.id,
    },
  });
}

async function newPendingReceipt(org: Fixture, studentId: string, academyId: string) {
  return prisma.awaitingRateReceipt.create({
    data: {
      organizationId: org.org.id, studentId, academyId, kind: "ORDINARY", status: "PENDING",
      receivedOn: new Date("2030-01-01"), tenderCurrency: "CRC", tenderAmount: "100.00", method: "EFECTIVO",
      capturedAt: new Date(), capturedById: org.admin.id, snapshot: { kind: "ORDINARY", obligationIds: [] },
    },
  });
}

async function dropDeps(org: Fixture) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["AwaitingRateReceipt", "DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
}

function tenantContext(org: Fixture) {
  return { kind: "tenant" as const, actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN" as const, academyIds: "ALL" as const, selfStudentId: null, linkedStudentId: null };
}

describe("listLedgerPaymentStatus: fee totals and pending-conversion (reader-level)", () => {
  it("REQUIRED: currency-separated totals, with the late fee included exactly once", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "pagos-fee-totals");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD");
      const debtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, debtor.id, terms, policy);

      const { rows } = await listLedgerPaymentStatus(tenantContext(org), new Date());
      const row = rows.find((r) => r.studentId === debtor.id);
      expect(row?.entry.kind).toBe("ledger");
      if (row?.entry.kind !== "ledger") throw new Error("expected a ledger entry");

      // principal 100.00 + late fee 20.00 = 120.00, in minor units (12000) — the fee folded in exactly once,
      // never added twice and never omitted. `feeMinor` carries the SAME fee separately for the "(includes X
      // late fee)" display — not a second, independent fee.
      expect(row.entry.display.totals).toHaveLength(1);
      expect(row.entry.display.totals[0]).toMatchObject({ currency: "USD", amountMinor: 12000, feeMinor: 2000 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: two different currencies on the same student never get summed into one total", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "pagos-fee-currency-split");
    try {
      const { terms: usdTerms, policy: usdPolicy } = await seedPlanAndPolicy(org, org.academy.id, "USD");
      // A plain SIGNUP has no policy — terms only, via a SEPARATE fresh plan (never a second DuesPolicyVersion
      // for this academy, which would become the new "latest effective" one and invalidate `usdPolicy` above
      // against `createMonthlyObligation`'s own staleVersion check).
      const crcTerms = await seedTermsOnly(org, org.academy.id, "CRC");
      const debtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, debtor.id, usdTerms, usdPolicy);
      await newSignupObligation(org, debtor.id, org.academy.id, crcTerms, "CRC");

      const { rows } = await listLedgerPaymentStatus(tenantContext(org), new Date());
      const row = rows.find((r) => r.studentId === debtor.id);
      if (row?.entry.kind !== "ledger") throw new Error("expected a ledger entry");

      expect(row.entry.display.totals).toHaveLength(2);
      const usdTotal = row.entry.display.totals.find((t) => t.currency === "USD");
      const crcTotal = row.entry.display.totals.find((t) => t.currency === "CRC");
      expect(usdTotal?.amountMinor).toBe(12000); // 100 principal + 20 fee, USD only
      expect(crcTotal?.amountMinor).toBe(5000); // 50 signup, CRC only — never combined with the USD total
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a pending-conversion receipt is distinct from settlement — real unrelated debt is never suppressed", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "pagos-pending-conversion");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD");
      const debtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, debtor.id, terms, policy);
      await newPendingReceipt(org, debtor.id, org.academy.id);

      const { rows } = await listLedgerPaymentStatus(tenantContext(org), new Date());
      const row = rows.find((r) => r.studentId === debtor.id);
      if (row?.entry.kind !== "ledger") throw new Error("expected a ledger entry");

      // The pending receipt is real (flags.pendingConversion), but it never offsets or hides the real,
      // unrelated monthly debt — the full principal+fee total is still exactly 12000, not reduced or zeroed.
      expect(row.entry.display.flags.pendingConversion).toBe(true);
      expect(row.entry.display.flags.debt).toBe(true);
      expect(row.entry.display.totals[0]?.amountMinor).toBe(12000);
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });
});

describe("payments/page.tsx: ledger status table (page-level)", () => {
  let fixture: Awaited<ReturnType<typeof makeAccountingOrg>>;
  let academyB: { id: string };
  let director: { id: string };
  let otherOrg: Awaited<ReturnType<typeof makeAccountingOrg>>;

  beforeAll(async () => {
    fixture = await makeAccountingOrg("CUMULATIVE", "pagos-page-ledger");
    otherOrg = await makeAccountingOrg("CUMULATIVE", "pagos-page-ledger-other");
    academyB = await prisma.academy.create({ data: { organizationId: fixture.org.id, name: "Pagos Ledger B", slug: `pagos-ledger-b-${suffix()}`, kioskTokenHash: `pagos-ledger-b-${suffix()}` } });
    const directorUser = await prisma.user.create({ data: { email: `pagos-ledger-director-${suffix()}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
    await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, role: "DIRECTOR" } });
    await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, academyId: fixture.academy.id, role: "DIRECTOR" } });
    director = directorUser;
  }, 60_000);

  afterAll(async () => {
    currentSession = null;
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
    await dropDeps(fixture);
    // academyB was created with `organizationId: fixture.org.id` — `fixture.drop()` already deletes every
    // academy scoped to that org (AFTER it deletes the students that reference them), so academyB needs no
    // separate deletion here; doing one before `drop()` would hit the student/academy FK ordering fixture.drop()
    // itself exists to get right.
    await fixture.drop();
    await dropDeps(otherOrg);
    await otherOrg.drop();
  }, 120_000);

  async function renderAs(userId: string, organizationId: string): Promise<string> {
    currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
    const page = await PaymentsPage();
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
    currentSession = null;
    return html;
  }

  function statTileCount(html: string, label: string): number {
    const match = html.match(new RegExp(`${label}</div><div[^>]*>(\\d+)</div>`));
    if (!match) throw new Error(`Stat tile "${label}" not found in rendered HTML`);
    return Number(match[1]);
  }

  function statTileNote(html: string, label: string): string {
    const match = html.match(new RegExp(`${label}</div><div[^>]*>\\d+</div><div[^>]*>([^<]*)</div>`));
    return match?.[1] ?? "";
  }

  it("REQUIRED: overlapping facts — a student with both debts counts toward both stat tiles, deliberately asymmetric", async () => {
    mockActive = true;
    const { terms, policy } = await seedPlanAndPolicy(fixture, fixture.academy.id);
    const monthlyOnly1 = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, monthlyOnly1.id, terms, policy);
    const monthlyOnly2 = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, monthlyOnly2.id, terms, policy);
    const overlap = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, overlap.id, terms, policy);
    await newSignupObligation(fixture, overlap.id, fixture.academy.id, terms);

    const html = await renderAs(fixture.admin.id, fixture.org.id);
    // monthlyOnly1 + monthlyOnly2 + overlap = 3; overlap alone = 1 signup — deliberately asymmetric so a
    // swapped monthlyPastGrace/signupPastDue tile mapping is visible here, not hidden by equal counts.
    expect(statTileCount(html, "Monthly past grace")).toBe(3);
    expect(statTileCount(html, "Signup past due")).toBe(1);
  });

  it("REQUIRED: a student missing from an otherwise-successful read shows 'unavailable', excluded from the confirmed stat tile count, with an exact unknown count", async () => {
    mockActive = true;
    const { terms, policy } = await seedPlanAndPolicy(fixture, fixture.academy.id, "CRC");
    const failedDebtor = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, failedDebtor.id, terms, policy);

    const real = duesFactsModule.listDuesFactsForStudents;
    const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (!result.ok) return result;
      return { ...result, facts: result.facts.filter((f) => f.studentId !== failedDebtor.id) };
    });
    let html: string;
    try {
      html = await renderAs(fixture.admin.id, fixture.org.id);
    } finally {
      spy.mockRestore();
    }

    // React escapes the apostrophe in rendered text as `&#x27;` — assert on the unambiguous half of the string
    // (same gotcha `dashboard-page-ledger-render.test.ts` already documents).
    expect(html).toContain("load payment status");
    expect(statTileNote(html, "Monthly past grace")).toContain("1 unknown");
  });

  it("REQUIRED: a DIRECTOR scoped to academy A never sees academy B's (same-org) debt student, but DOES see their own branch's debt student", async () => {
    mockActive = true;
    const { terms: termsA, policy: policyA } = await seedPlanAndPolicy(fixture, fixture.academy.id);
    const { terms: termsB, policy: policyB } = await seedPlanAndPolicy(fixture, academyB.id);
    const ownBranchDebtor = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, ownBranchDebtor.id, termsA, policyA);
    const otherBranchDebtor = await newStudent(fixture, academyB.id);
    await newMonthlyObligation(fixture, otherBranchDebtor.id, termsB, policyB);

    const html = await renderAs(director.id, fixture.org.id);
    expect(html).toContain(`${ownBranchDebtor.firstName} ${ownBranchDebtor.lastName}`);
    expect(html).not.toContain(`${otherBranchDebtor.firstName} ${otherBranchDebtor.lastName}`);
  });

  it("REQUIRED: an ADMIN sees both branches' debt students within their own organization only — a genuinely different organization's debt student never appears", async () => {
    mockActive = true;
    const { terms: termsA, policy: policyA } = await seedPlanAndPolicy(fixture, fixture.academy.id);
    const { terms: termsB, policy: policyB } = await seedPlanAndPolicy(fixture, academyB.id);
    const branchADebtor = await newStudent(fixture, fixture.academy.id);
    await newMonthlyObligation(fixture, branchADebtor.id, termsA, policyA);
    const branchBDebtor = await newStudent(fixture, academyB.id);
    await newMonthlyObligation(fixture, branchBDebtor.id, termsB, policyB);
    const { terms: otherTerms, policy: otherPolicy } = await seedPlanAndPolicy(otherOrg, otherOrg.academy.id);
    const foreignOrgDebtor = await newStudent(otherOrg, otherOrg.academy.id);
    await newMonthlyObligation(otherOrg, foreignOrgDebtor.id, otherTerms, otherPolicy);

    const html = await renderAs(fixture.admin.id, fixture.org.id);
    expect(html).toContain(`${branchADebtor.firstName} ${branchADebtor.lastName}`);
    expect(html).toContain(`${branchBDebtor.firstName} ${branchBDebtor.lastName}`);
    expect(html).not.toContain(`${foreignOrgDebtor.firstName} ${foreignOrgDebtor.lastName}`);
  });

  it("REQUIRED: listCurrentPaymentStatus is never called when the ledger is active for this organization", async () => {
    mockActive = true;
    const spy = vi.spyOn(listCurrentStatusModule, "listCurrentPaymentStatus");
    try {
      await renderAs(fixture.admin.id, fixture.org.id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the inactive path still calls listCurrentPaymentStatus — unchanged existing behavior", async () => {
    mockActive = false;
    const spy = vi.spyOn(listCurrentStatusModule, "listCurrentPaymentStatus");
    try {
      await renderAs(fixture.admin.id, fixture.org.id);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
