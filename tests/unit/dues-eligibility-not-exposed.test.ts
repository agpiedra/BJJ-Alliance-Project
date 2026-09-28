import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Eligibility-prerequisites brief, section 6.2: the eligibility-and-assignment read function must stay unreachable until the
 * monthly job PR calls it — same isolation discipline as PR 4a's ledger writers
 * (tests/unit/dues-ledger-not-exposed.test.ts), scoped to this one file instead of a whole directory.
 */
const FILE = "src/lib/dues/eligibility.ts";
const IMPORTS_ELIGIBILITY = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/eligibility["']/;

describe("the eligibility reader is not reachable from production code", () => {
  it("no file other than itself imports it", () => {
    const files = productionSourceFiles();
    const importers = files.filter((f) => f.file.replaceAll("\\", "/") !== FILE).filter((f) => IMPORTS_ELIGIBILITY.test(stripComments(f.text))).map((f) => f.file);
    expect(importers, "eligibleAndAssigned must have no production caller until the monthly job PR").toEqual([]);
  });

  it("is a plain library function: no \"use server\", no route", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
  });

  it("is registered as built ahead of its caller", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("eligibleAndAssigned");
    expect(registry).toContain("src/lib/dues/eligibility.ts");
  });
});
