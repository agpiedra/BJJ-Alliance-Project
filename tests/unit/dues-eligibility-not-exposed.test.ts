import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Eligibility-prerequisites brief, section 6.2: the eligibility-and-assignment read function had no caller until the
 * monthly-generation PR — same isolation discipline as PR 4a's ledger writers (tests/unit/dues-ledger-not-exposed.test.ts),
 * scoped to this one file instead of a whole directory, naming every authorized caller explicitly rather than allowing a
 * broad pattern — an unnamed file importing it still fails this test.
 *
 * Extended (PAYMENT-UI-CONSUMER-INTEGRATION-BRIEF.md §6) for `dues-facts.ts`'s own `listDuesFactsForStudents`/
 * `getOwnDuesFacts`, which reuses `eligibleAndAssigned` for exactly the question it already answers (does a NEW
 * obligation resolve for the current period) — never for `SIGNUP`/event-triggered obligations, which this function
 * says nothing about.
 */
const FILE = "src/lib/dues/eligibility.ts";
const IMPORTS_ELIGIBILITY = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/eligibility["']/;
const AUTHORIZED_CALLERS = ["src/lib/dues/monthly-generation.ts", "src/lib/dues/ledger/dues-facts.ts"];

describe("the eligibility reader is not reachable from production code", () => {
  it("no file other than itself and the authorized callers imports it", () => {
    const files = productionSourceFiles();
    const importers = files
      .filter((f) => f.file.replaceAll("\\", "/") !== FILE)
      .filter((f) => IMPORTS_ELIGIBILITY.test(stripComments(f.text)))
      .map((f) => f.file.replaceAll("\\", "/"))
      .sort();
    expect(importers, "eligibleAndAssigned must have no production caller other than the authorized ones").toEqual([...AUTHORIZED_CALLERS].sort());
  });

  it("every authorized caller genuinely imports it (so the check above isn't vacuous)", () => {
    const files = productionSourceFiles();
    for (const path of AUTHORIZED_CALLERS) {
      const runner = files.find((f) => f.file.replaceAll("\\", "/") === path);
      expect(runner, `${path} must exist`).toBeTruthy();
      expect(IMPORTS_ELIGIBILITY.test(stripComments(runner!.text)), `${path} must genuinely import eligibility.ts`).toBe(true);
    }
  });

  it("is a plain library function: no \"use server\", no route", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
  });
});
