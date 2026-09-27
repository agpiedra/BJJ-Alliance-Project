import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * The first ledger writers (PR 4a) must stay unreachable from live billing until the approved activation stage. Three structural checks
 * (the runtime gate is tested in tests/integration/dues-ledger-writers.test.ts):
 *
 *  1. NOTHING outside `src/lib/dues/ledger/` imports them: no page, route, server action, cron, script or other library. The only other
 *     importers are tests. When the payment-write integration PR adds the first caller, it updates this test on purpose.
 *  2. They are plain library functions: no `"use server"` (which would make an exported function an invocable endpoint), no route, no
 *     client component.
 *  3. They are registered in `scripts/pending-callers.ts`, the repo's list of code built ahead of its caller.
 */
const LEDGER_DIR = "src/lib/dues/ledger/";
const IMPORTS_LEDGER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/ledger(?:\/[^"']*)?["']/;

describe("the ledger writers are not reachable from production code", () => {
  const files = productionSourceFiles();
  const ledgerFiles = files.filter((f) => f.file.replaceAll("\\", "/").startsWith(LEDGER_DIR));

  it("the ledger library exists (so the checks below are not vacuous)", () => {
    const names = ledgerFiles.map((f) => f.file.replaceAll("\\", "/").slice(LEDGER_DIR.length)).sort();
    expect(names).toEqual(expect.arrayContaining(["activation.ts", "create-monthly-obligation.ts", "index.ts", "minor-units.ts", "record-payment.ts"]));
  });

  it("no file outside src/lib/dues/ledger imports it", () => {
    const importers = files
      .filter((f) => !f.file.replaceAll("\\", "/").startsWith(LEDGER_DIR))
      .filter((f) => IMPORTS_LEDGER.test(stripComments(f.text)))
      .map((f) => f.file);
    expect(importers, "the writers must have no production caller until the payment-write integration stage").toEqual([]);
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
