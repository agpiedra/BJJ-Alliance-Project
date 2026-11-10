import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Stage 9 PR 9-1, concurrency rule 9 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md revision 4): every application write to a table
 * that readiness reads must take the organization gate (src/lib/dues/activation-gate.ts) first. This guard fails when:
 *  - a file starts writing a reviewed table and is not classified below (add it as a participant WITH the gate, or explain why
 *    it is composed into a participant's transaction or not reviewed);
 *  - a participant no longer calls the gate;
 *  - an outermost ledger transaction does not take the gate as its first statement.
 * The real proof that the lock is taken and waited on is tests/integration/dues-activation-gate.test.ts (pg_blocking_pids).
 */
const REVIEWED_MODELS = [
  "paymentPeriod", "studentStatusChange", "student", "studentPlanAssignment", "paymentPlanTerms", "duesPolicyVersion", "paymentPlan",
  "academy", "organization", "duesOpeningItem", "duesReadinessConfirmation", "duesActivation", "duesObligation", "duesCoverage",
];
const REVIEWED_TABLES = [
  "PaymentPeriod", "StudentStatusChange", "Student", "StudentPlanAssignment", "PaymentPlanTerms", "DuesPolicyVersion", "PaymentPlan",
  "Academy", "Organization", "DuesOpeningItem", "DuesReadinessConfirmation", "DuesActivation", "DuesObligation", "DuesCoverage",
];
// Readiness also reads JobRun (check 10, the platform job's latest run): it has no organization column, so no organization lock
// can apply to it; it is the platform scheduler's own bookkeeping, not organization data.
const PRISMA_WRITE = new RegExp(`\\.(${REVIEWED_MODELS.join("|")})\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`);
const RAW_WRITE = new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+"(${REVIEWED_TABLES.join("|")})"`);
const GATE = /\blockOrganizationGate(WithTimeout)?\(/;

/** Writers that take the gate themselves (rule 9 a–j). */
const PARTICIPANTS = [
  "src/lib/payments/payment-actions.ts", // 9a
  "src/lib/payments/get-current-period.ts", // 9c page load
  "src/lib/payments/ensure-custom-promo-plan.ts", // 9d page load
  "src/app/[locale]/(staff)/students/[id]/actions.ts", // 9b (also profile/code edits, not reviewed)
  "src/app/[locale]/(staff)/students/[id]/approve-student-core.ts", // 9b
  "src/app/[locale]/(staff)/students/create-student-core.ts", // 9b
  "src/app/[locale]/o/[orgSlug]/signup/actions.ts", // 9b
  "src/lib/students/baseline-action.ts", // 9b
  "src/lib/dues/assignment-actions.ts", // 9e
  "src/lib/dues/config-actions.ts", // 9f (in its private lockBranch helper, the first lock of each save)
  "src/lib/payments/plan-actions.ts", // 9g, 9i
  "src/lib/locations/location-service.ts", // 9h
  "src/lib/dues/readiness/opening-core.ts", // 9j
];

/** Write only inside a transaction a participant opened, after that participant took the gate. */
const COMPOSED = [
  "src/lib/students/status-history.ts", // appendStatusChange: every caller is a 9b participant
  "src/lib/dues/assignment-core.ts", // assignPlanInTx: assignment-actions and student approval/creation
  "src/lib/payments/ensure-default-plan.ts", // inside location creation (9h) and organization approval (below)
  "src/lib/dues/ledger/resume-charge.ts", // inside the student resume transaction (9b)
  "src/lib/dues/ledger/genuine-return-charge.ts", // inside the student return transaction (9b)
];

/** Writes to a reviewed table that cannot affect any organization's readiness (with the reason). */
const NOT_REVIEWED: Record<string, string> = {
  "src/lib/organizations/approve-organization.ts": "creates the organization's first branch before any readiness can exist",
  "src/app/[locale]/register-academy/actions.ts": "creates the organization itself",
  "src/app/[locale]/platform/organizations/new/actions.ts": "creates the organization itself",
  "src/app/[locale]/platform/organizations/actions.ts": "organization status; an UPDATE of the row already waits on the gate",
  "src/app/[locale]/platform/organizations/billing-actions.ts": "platform grace days; an UPDATE of the row already waits on the gate",
  "src/app/[locale]/onboarding/actions.ts": "onboarding fields; an UPDATE of the row already waits on the gate",
  "src/app/[locale]/(staff)/dashboard/branding-reminder-actions.ts": "a reminder flag; an UPDATE of the row already waits on the gate",
  "src/app/[locale]/(staff)/admin/kiosk-tokens/actions.ts": "the branch's kiosk token field only",
  "src/lib/promotion/award.ts": "belt fields on Student, not reviewed (brief §5)",
  "src/lib/promotion/accounting-activation.ts": "promotion baseline fields on Student, not reviewed (brief §5)",
};

const LEDGER_TX_FILES = /^src\/lib\/dues\/(ledger\/[^/]+|late-fee-assessment|monthly-generation)\.ts$/;

describe("stage 9 organization gate participation (rule 9)", () => {
  const files = productionSourceFiles(["src"]).map((f) => ({ path: f.file.replaceAll("\\", "/"), code: stripComments(f.text) }));

  it("every application write to a reviewed table is classified", () => {
    const writers = files.filter((f) => PRISMA_WRITE.test(f.code) || RAW_WRITE.test(f.code)).map((f) => f.path).sort();
    const known = new Set([...PARTICIPANTS, ...COMPOSED, ...Object.keys(NOT_REVIEWED)]);
    // Ledger files are checked by the transaction rule below: their outermost transactions take the gate first, and their InTx
    // writers run inside a participant's or a ledger transaction.
    expect(writers.filter((w) => !known.has(w) && !LEDGER_TX_FILES.test(w)), "new writer of a reviewed table: take the gate (rule 9) and list it here").toEqual([]);
    expect([...known].filter((k) => !writers.includes(k)), "listed file no longer writes a reviewed table: remove it").toEqual([]);
  });

  it("every participant takes the gate", () => {
    for (const path of PARTICIPANTS) {
      const file = files.find((f) => f.path === path);
      expect(file, `${path} must exist`).toBeTruthy();
      expect(GATE.test(file!.code), `${path} must call lockOrganizationGate`).toBe(true);
    }
  });

  it("every outermost ledger transaction takes the gate as its first statement", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const f of files.filter((x) => LEDGER_TX_FILES.test(x.path))) {
      const lines = f.code.split("\n");
      lines.forEach((line, i) => {
        if (!/prisma\.\$transaction\(/.test(line)) return;
        seen++;
        // The callback's first statements: allow the transaction's own SET LOCAL bounds before the gate.
        const window = lines.slice(i, i + 12).join("\n");
        const firstLock = window.search(/lock(?!OrganizationGate)\w*\(|\$queryRaw|tx\.\w+\.(find|create|update|upsert|delete)/);
        const gateAt = window.search(GATE);
        if (gateAt < 0 || (firstLock >= 0 && firstLock < gateAt)) missing.push(`${f.path}:${i + 1}`);
      });
    }
    expect(seen, "the scan found the ledger's outermost transactions (not vacuous)").toBeGreaterThanOrEqual(14);
    expect(missing, "outermost ledger transaction without the gate first").toEqual([]);
  });
});
