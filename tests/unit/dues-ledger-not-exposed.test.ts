import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * The first ledger writers (PR 4a) must stay unreachable from live billing until the approved activation stage. Structural checks
 * (the runtime gate is tested in tests/integration/dues-ledger-writers.test.ts):
 *
 *  1. Nothing outside `src/lib/dues/ledger/` imports them, EXCEPT the two authorized callers listed in `AUTHORIZED_CALLERS` below
 *     (monthly-generation brief §5.2, late-fee-assessment brief §7): no other page, route, server action, cron, script or library.
 *     The only other importers are tests. This test names those files explicitly rather than allowing a broad pattern — a third
 *     file starting to import from the ledger still fails it, exactly as before this PR.
 *  2. They are plain library functions: no `"use server"` (which would make an exported function an invocable endpoint), no route, no
 *     client component.
 *  3. They are registered in `scripts/pending-callers.ts`, the repo's list of code built ahead of its caller.
 */
const LEDGER_DIR = "src/lib/dues/ledger/";
const IMPORTS_LEDGER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/ledger(?:\/[^"']*)?["']/;
const AUTHORIZED_CALLERS = ["src/lib/dues/monthly-generation.ts", "src/lib/dues/late-fee-assessment.ts"];

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
