import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * The first ledger writers (PR 4a) must stay unreachable from live billing until the approved activation stage. Structural checks
 * (the runtime gate is tested in tests/integration/dues-ledger-writers.test.ts):
 *
 *  1. Nothing outside `src/lib/dues/ledger/` imports them, EXCEPT the authorized callers listed in `AUTHORIZED_CALLERS` below
 *     (monthly-generation brief §5.2, late-fee-assessment brief §7, the resume/enrollment integration plan's own §3/§7.6, the
 *     genuine-return-to-training brief's own §7, the owner exchange-rate UI brief's own §2.1/§2.3): no other page, route,
 *     server action, cron, script or library. The only other importers are tests. This test names those files explicitly
 *     rather than allowing a broad pattern — a sixth file starting to import from the ledger still fails it. `resumeStudent`/
 *     `returnToTraining` (`[id]/actions.ts`) compose `resumeChargeInTx`/`genuineReturnChargeInTx` directly.
 *     `approveStudentInTx`/`createStudentInTx` (the gated cores `approveStudent`/`createStudent` compose) were moved out of
 *     their own "use server" action files into plain, non-"use server" sibling modules (`[id]/approve-student-core.ts`,
 *     `create-student-core.ts`) after an independent review found every exported async function in a "use server" file
 *     becomes a directly client-invocable server action — these two cores trust locks/validation their caller already did and
 *     must never be reachable that way. Those two new core files are the actual importers of `enrollmentChargeInTx` now, not
 *     the action files themselves; each action's own public, exported signature is unchanged by any of this.
 *     `[id]/genuine-return-core.ts` is the same pattern for `page.tsx`'s own read-only `isGenuineReturnBillingActive` check —
 *     `page.tsx` itself must never import the ledger directly. `src/lib/dues/exchange-rate-actions.ts` (a thin "use server"
 *     wrapper around `enterExchangeRateQuote`, owner-only, never passing a `deps` override),
 *     `src/lib/dues/exchange-rate-queries.ts` (plain reads; imports only `isRealDate` from `dues/ledger/common.ts`, never a
 *     writer, to guard a quote-date input the same way the engine's own write path already does), and
 *     `payments/plans/exchange-rate-section.tsx` (a server component's own read-only `inactiveLedgerActivation.isActive`
 *     pre-check, advisory only — `enterOrCorrectExchangeRate` itself is the unconditional enforcement) are the three new
 *     importers the owner exchange-rate UI brief adds. `src/lib/dues/awaiting-rate-receipt-actions.ts` (a thin "use
 *     server" wrapper around the already-complete `resolveAwaitingRateReceipt`/`cancelAwaitingRateReceipt`, owner-only,
 *     never passing a `deps` override), `src/lib/dues/awaiting-rate-receipt-queries.ts` (plain reads; imports only the
 *     snapshot schema/type, never a writer), and `payments/plans/awaiting-rate-receipt-section.tsx` (the same
 *     read-only `inactiveLedgerActivation.isActive` pre-check pattern) are the three new importers the owner
 *     awaiting-rate receipt queue UI brief adds. `src/lib/dues/payment-entry-actions.ts` (a thin "use server" wrapper
 *     around `recordDuesPaymentWithSubmissionIdentity`/`getSubmissionOutcome` from PR #89, never passing a `deps`
 *     override, plus `getPayableObligations` composing `listPayableObligations`), `src/lib/dues/payment-entry-queries.ts`
 *     (plain reads over `listDuesFactsForStudents`, never a writer), `src/lib/dues/payment-entry-recovery.ts`
 *     (TYPE-ONLY — imports `RecordDuesPaymentWithSubmissionIdentityResult`/`SubmissionOutcome` as types to classify a
 *     result the action layer already returned; erased at compile time, no runtime dependency on the ledger), and
 *     `src/app/[locale]/(staff)/payments/page.tsx` (the same read-only `inactiveLedgerActivation.isActive` pre-check
 *     pattern, advisory only) are the four new importers the ordinary payment-entry UI brief adds.
 *     `src/lib/dues/package-purchase-queries.ts` (plain reads; imports `firstUncoveredFrom`/`SCHEMA_MAX_MONTH` from
 *     `prepay-monthly.ts` read-only, and `inTenantScope`/`latestEffective` from `common.ts`, never a writer),
 *     `src/lib/dues/package-purchase-actions.ts` (a thin "use server" wrapper around
 *     `purchasePackageWithSubmissionIdentity`, never passing a `deps` override), and
 *     `src/app/[locale]/(staff)/payments/package-purchase-section.tsx` (imports only `decimalToMinor` from
 *     `ledger/minor-units.ts` — pure, prisma-free arithmetic, never a writer call) are the three new importers the
 *     package-purchase UI brief adds. `src/lib/dues/financial-corrections-queries.ts` (plain reads; imports
 *     `versionRevision` from `config-input.ts` and `inTenantScope` from `ledger/common.ts`, never a writer — the
 *     late-fee/payment selection and recovery reads) and `src/lib/dues/financial-corrections-actions.ts` (a thin
 *     "use server" wrapper around `correctLateFeeAndSettle`/`reversePayment`/`waiveLateFee`, never passing a `deps`
 *     override) are the two new importers the owner financial-corrections UI brief adds — its own section component
 *     imports neither the ledger nor `ledger/minor-units.ts` directly, so it needs no entry here, unlike the
 *     package/prepayment cards.
 *  2. They are plain library functions: no `"use server"` (which would make an exported function an invocable endpoint), no route, no
 *     client component.
 *  3. They are registered in `scripts/pending-callers.ts`, the repo's list of code built ahead of its caller.
 */
const LEDGER_DIR = "src/lib/dues/ledger/";
const IMPORTS_LEDGER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/ledger(?:\/[^"']*)?["']/;
const AUTHORIZED_CALLERS = [
  "src/lib/dues/monthly-generation.ts",
  "src/lib/dues/late-fee-assessment.ts",
  "src/app/[locale]/(staff)/students/[id]/actions.ts",
  "src/app/[locale]/(staff)/students/[id]/approve-student-core.ts",
  "src/app/[locale]/(staff)/students/[id]/genuine-return-core.ts",
  "src/app/[locale]/(staff)/students/create-student-core.ts",
  "src/lib/dues/exchange-rate-actions.ts",
  "src/lib/dues/exchange-rate-queries.ts",
  "src/app/[locale]/(staff)/payments/plans/exchange-rate-section.tsx",
  "src/lib/dues/awaiting-rate-receipt-actions.ts",
  "src/lib/dues/awaiting-rate-receipt-queries.ts",
  "src/app/[locale]/(staff)/payments/plans/awaiting-rate-receipt-section.tsx",
  "src/lib/dues/payment-entry-actions.ts",
  "src/lib/dues/payment-entry-queries.ts",
  "src/lib/dues/payment-entry-recovery.ts",
  "src/app/[locale]/(staff)/payments/page.tsx",
  "src/lib/dues/package-purchase-queries.ts",
  "src/lib/dues/package-purchase-actions.ts",
  "src/app/[locale]/(staff)/payments/package-purchase-section.tsx",
  "src/lib/dues/prepayment-queries.ts",
  "src/lib/dues/prepayment-actions.ts",
  "src/app/[locale]/(staff)/payments/prepayment-section.tsx",
  "src/lib/dues/financial-corrections-queries.ts",
  "src/lib/dues/financial-corrections-actions.ts",
];

describe("the ledger writers are not reachable from production code", () => {
  const files = productionSourceFiles();
  const ledgerFiles = files.filter((f) => f.file.replaceAll("\\", "/").startsWith(LEDGER_DIR));

  it("the ledger library exists (so the checks below are not vacuous)", () => {
    const names = ledgerFiles.map((f) => f.file.replaceAll("\\", "/").slice(LEDGER_DIR.length)).sort();
    expect(names).toEqual(expect.arrayContaining(["activation.ts", "create-monthly-obligation.ts", "index.ts", "minor-units.ts", "record-payment.ts"]));
  });

  it("no file outside src/lib/dues/ledger imports it, except the authorized callers", () => {
    const importers = files
      .filter((f) => !f.file.replaceAll("\\", "/").startsWith(LEDGER_DIR))
      .filter((f) => IMPORTS_LEDGER.test(stripComments(f.text)))
      .map((f) => f.file.replaceAll("\\", "/"))
      .sort();
    expect(importers, "only the authorized runners may import the ledger until the payment-write integration stage").toEqual([...AUTHORIZED_CALLERS].sort());
  });

  it("every authorized caller genuinely imports from the ledger (so the check above isn't vacuous)", () => {
    for (const path of AUTHORIZED_CALLERS) {
      const runner = files.find((f) => f.file.replaceAll("\\", "/") === path);
      expect(runner, `${path} must exist`).toBeTruthy();
      expect(IMPORTS_LEDGER.test(stripComments(runner!.text)), `${path} must genuinely import the ledger`).toBe(true);
    }
  });

  it("no ledger file is a server action, a client component or a route", () => {
    for (const { file, text } of ledgerFiles) {
      expect(text, `${file} must not start a "use server" or "use client" module`).not.toMatch(/^\s*["']use (server|client)["']/m);
      expect(file, `${file} must not be a route or page`).not.toMatch(/(^|[\\/])(route|page|layout|actions?)\.tsx?$/);
    }
  });

  it("no ledger file imports request- or UI-facing modules (next/*, react)", () => {
    for (const { file, text } of ledgerFiles) {
      expect(stripComments(text), file).not.toMatch(/from\s+["'](next\/|next-intl|react)/);
    }
  });

  it("the writers are registered as built ahead of their caller", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("createMonthlyObligation");
    expect(registry).toContain("recordDuesPayment");
    expect(registry).toContain("src/lib/dues/ledger/");
  });
});
