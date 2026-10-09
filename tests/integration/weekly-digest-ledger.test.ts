import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import * as duesFactsModule from "../../src/lib/dues/ledger/dues-facts";
import * as listOverdueModule from "../../src/lib/payments/list-overdue";
import type { ResendClient } from "../../src/lib/notifications/email-channel";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.1/§4/§6.2 (PR 4): the weekly digest's ledger cutover, reusing PR 3's
 * own `summarizeLedgerOverdue`/`listRosterPaymentFacts` wiring (`src/lib/dues/ledger-overdue-summary.ts`) through
 * a real `SystemJobContext` (never a fabricated ADMIN context). `tests/integration/weekly-digest.test.ts` already
 * covers the legacy (`!ledgerActive`) path end-to-end and is left untouched by this PR — this file covers only the
 * new ledger-active branch and its own wiring-level protections.
 *
 * Coverage months are pinned to 2020 (same technique `dashboard-page-ledger-render.test.ts` already uses) — the
 * digest's own `now`/`ledgerNow` is real, unmocked wall-clock time (not injectable here), so fixtures must be
 * unambiguously past-grace/past-due under the REAL current date. The obligation WRITER's own `deps.now` below is a
 * separate, fixed reference date — irrelevant to how the digest itself evaluates the facts later.
 */
const prisma = getTestPrismaClient();

let mockActive = false;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

const { sendWeeklyDigestForAcademy } = await import("../../src/lib/notifications/weekly-digest");

const WRITER_NOW = new Date("2030-12-15T12:00:00-06:00");
const writerDeps = { activation: { isActive: async () => true }, now: () => WRITER_NOW };

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** `makeAccountingOrg`'s admin takes the schema default locale ("es") — forced to "en" here so this file's
 * body-text assertions (English digest copy) are deterministic regardless of that default. */
async function makeOrg(label: string): Promise<Fixture> {
  const org = await makeAccountingOrg("CUMULATIVE", label);
  await prisma.user.update({ where: { id: org.admin.id }, data: { locale: "en" } });
  return org;
}

async function seedPlanAndPolicy(org: Fixture, academyId: string) {
  const s = suffix();
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `WD plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
  return { terms, policy };
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string, status: "ACTIVE" | "INACTIVE" | "ARCHIVED" = "ACTIVE") {
  const n = ++studentCounter;
  const s = suffix();
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "WDLedger", lastName: `S${n}-${s}`, phone: "00000000",
      email: `wdledger-${n}-${s}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `wdledger-${n}-${s}`, status,
    },
  });
}

async function newMonthlyObligation(org: Fixture, studentId: string, academyId: string, terms: { id: string }, policy: { id: string }) {
  const r = await createMonthlyObligation(
    { context: { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null }, studentId, coverage: { year: 2020, month: 1 }, planTermsId: terms.id, policyVersionId: policy.id },
    writerDeps,
  );
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function newSignupObligation(org: Fixture, studentId: string, academyId: string, terms: { id: string }) {
  return prisma.duesObligation.create({
    data: {
      organizationId: org.org.id, studentId, academyId, origin: "STAFF", type: "SIGNUP",
      coverageYear: 2020, coverageMonth: 1, monthsCovered: 1, amount: "50.00", currency: "USD",
      dueOn: new Date("2020-01-05"), graceDeadline: null, lateFeeAmount: null, planTermsId: terms.id, policyVersionId: null, createdById: org.admin.id,
    },
  });
}

/** Records every (to, subject, html) triple, standing in for a real Resend client — same shape
 * `weekly-digest.test.ts`'s own `RecordingResendClient` already establishes. */
class RecordingResendClient implements ResendClient {
  calls: Array<{ from: string; to: string; subject: string; html: string }> = [];
  emails = {
    send: async (params: { from: string; to: string; subject: string; html: string }) => {
      this.calls.push(params);
      return { data: { id: "fake-id" }, error: null };
    },
  };
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

describe("sendWeeklyDigestForAcademy: ledger-active counts (Decision 1)", () => {
  afterEach(() => {
    mockActive = false;
  });

  it("REQUIRED: two independent, never-merged counts — monthly-only, signup-only, overlap, and clean students", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-counts");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);

      // Deliberately asymmetric (3 monthly vs. 2 signup), not 2-and-2 — a swapped
      // monthlyPastGraceCount/signupPastDueCount field mapping would otherwise be invisible here.
      const monthlyOnly = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, monthlyOnly.id, org.academy.id, terms, policy);
      const monthlyOnly2 = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, monthlyOnly2.id, org.academy.id, terms, policy);
      const signupOnly = await newStudent(org, org.academy.id);
      await newSignupObligation(org, signupOnly.id, org.academy.id, terms);
      const overlap = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, overlap.id, org.academy.id, terms, policy);
      await newSignupObligation(org, overlap.id, org.academy.id, terms);
      await newStudent(org, org.academy.id); // clean — contributes to neither count

      const client = new RecordingResendClient();
      const result = await sendWeeklyDigestForAcademy(org.academy.id, client);
      expect(result).toMatchObject({ organizationId: org.org.id, failed: 0, skipped: 0 });
      expect(result.sent).toBeGreaterThanOrEqual(1);

      // monthlyOnly + monthlyOnly2 + overlap = 3 past monthly grace; signupOnly + overlap = 2 past signup due —
      // never summed into one number (would be 4 unique or 5 double-counted, neither of which is 3 and 2).
      const body = client.calls[0]!.html;
      expect(body).toContain("3 students past monthly grace");
      expect(body).toContain("2 students past signup due");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: an INACTIVE and an ARCHIVED student with real old debt count toward the digest (Decision 2)", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-inactive");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);

      const inactive = await newStudent(org, org.academy.id, "INACTIVE");
      await newMonthlyObligation(org, inactive.id, org.academy.id, terms, policy);
      const archived = await newStudent(org, org.academy.id, "ARCHIVED");
      await newSignupObligation(org, archived.id, org.academy.id, terms);

      const client = new RecordingResendClient();
      await sendWeeklyDigestForAcademy(org.academy.id, client);

      const body = client.calls[0]!.html;
      expect(body).toContain("1 students past monthly grace");
      expect(body).toContain("1 students past signup due");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });
});

describe("sendWeeklyDigestForAcademy: real tenant/academy isolation with positive controls", () => {
  afterEach(() => {
    mockActive = false;
  });

  it("REQUIRED: one academy's digest never counts a debtor from another academy in the same organization", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-isolation-branch");
    const academyB = await prisma.academy.create({ data: { organizationId: org.org.id, name: "WD Ledger B", slug: `wd-ledger-b-${suffix()}`, kioskTokenHash: `wd-ledger-b-${suffix()}` } });
    try {
      const { terms: termsA, policy: policyA } = await seedPlanAndPolicy(org, org.academy.id);
      const { terms: termsB, policy: policyB } = await seedPlanAndPolicy(org, academyB.id);

      const ownDebtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, ownDebtor.id, org.academy.id, termsA, policyA);
      const otherBranchDebtor = await newStudent(org, academyB.id);
      await newMonthlyObligation(org, otherBranchDebtor.id, academyB.id, termsB, policyB);

      const client = new RecordingResendClient();
      await sendWeeklyDigestForAcademy(org.academy.id, client);

      const body = client.calls[0]!.html;
      expect(body).toContain("1 students past monthly grace"); // positive control: own branch's debtor counted
    } finally {
      await dropDeps(org);
      await org.drop();
      await prisma.academy.deleteMany({ where: { id: academyB.id } });
    }
  });

  it("REQUIRED: one organization's digest never counts a debtor from a genuinely different organization", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-isolation-org");
    const otherOrg = await makeOrg("wd-ledger-isolation-other");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const { terms: otherTerms, policy: otherPolicy } = await seedPlanAndPolicy(otherOrg, otherOrg.academy.id);

      const ownDebtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, ownDebtor.id, org.academy.id, terms, policy);
      const foreignOrgDebtor = await newStudent(otherOrg, otherOrg.academy.id);
      await newMonthlyObligation(otherOrg, foreignOrgDebtor.id, otherOrg.academy.id, otherTerms, otherPolicy);

      const client = new RecordingResendClient();
      await sendWeeklyDigestForAcademy(org.academy.id, client);

      const body = client.calls[0]!.html;
      expect(body).toContain("1 students past monthly grace"); // positive control: own org's debtor counted
    } finally {
      await dropDeps(org);
      await org.drop();
      await dropDeps(otherOrg);
      await otherOrg.drop();
    }
  });
});

describe("sendWeeklyDigestForAcademy: partial-read failure stays visible (§6.2)", () => {
  afterEach(() => {
    mockActive = false;
  });

  it("REQUIRED: a student missing from an otherwise-successful read shows an explicit unknown count, excluded from the confirmed count — never silently zero/healthy", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-partial-failure");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const debtor = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, debtor.id, org.academy.id, terms, policy);

      // Same documented partial-failure case `roster-payment-facts-queries.ts` itself describes: "a student
      // missing from an otherwise-successful chunk" — simulated by stripping this one student's fact out of a
      // real, successful `listDuesFactsForStudents` result, rather than failing the whole batched read.
      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== debtor.id) };
      });
      const client = new RecordingResendClient();
      try {
        await sendWeeklyDigestForAcademy(org.academy.id, client);
      } finally {
        spy.mockRestore();
      }

      // Numeric contract: the failed student is never folded into the confirmed count (it would have qualified
      // for "past monthly grace" had the read succeeded) — the count stays at 0 — and the unknown-count is
      // visible in the email body itself, not merely logged.
      const body = client.calls[0]!.html;
      expect(body).toContain("0 students past monthly grace");
      expect(body).toMatch(/student('|&#x27;|&#39;)?s? ledger data unknown/);
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });
});

describe("sendWeeklyDigestForAcademy: active-path legacy-reader exclusion (§6)", () => {
  afterEach(() => {
    mockActive = false;
  });

  it("REQUIRED: listOverdueStudents is never called when the ledger is active for this organization", async () => {
    mockActive = true;
    const org = await makeOrg("wd-ledger-exclusion-active");
    const spy = vi.spyOn(listOverdueModule, "listOverdueStudents");
    try {
      const client = new RecordingResendClient();
      await sendWeeklyDigestForAcademy(org.academy.id, client);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await org.drop();
    }
  });

  it("the inactive path still calls listOverdueStudents and renders the legacy body — unchanged existing behavior", async () => {
    mockActive = false;
    const org = await makeOrg("wd-ledger-exclusion-inactive");
    const spy = vi.spyOn(listOverdueModule, "listOverdueStudents");
    try {
      const client = new RecordingResendClient();
      await sendWeeklyDigestForAcademy(org.academy.id, client);
      expect(spy).toHaveBeenCalled();
      const body = client.calls[0]!.html;
      expect(body).toContain("overdue payments");
      expect(body).not.toContain("past monthly grace");
    } finally {
      spy.mockRestore();
      await org.drop();
    }
  });
});
