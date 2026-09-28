import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Eligibility-prerequisites brief, section 6.2: the eligibility-and-assignment read function had no caller until the
 * monthly-generation PR — same isolation discipline as PR 4a's ledger writers (tests/unit/dues-ledger-not-exposed.test.ts),
 * scoped to this one file instead of a whole directory, now updated to name that one authorized caller explicitly rather
 * than allowing a broad pattern — a second file starting to import it still fails this test, exactly as before this PR.
 */
const FILE = "src/lib/dues/eligibility.ts";
const IMPORTS_ELIGIBILITY = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/eligibility["']/;
const AUTHORIZED_CALLER = "src/lib/dues/monthly-generation.ts";

describe("the eligibility reader is not reachable from production code", () => {
  it("no file other than itself and the one authorized monthly-generation caller imports it", () => {
    const files = productionSourceFiles();
    const importers = files
      .filter((f) => f.file.replaceAll("\\", "/") !== FILE)
      .filter((f) => IMPORTS_ELIGIBILITY.test(stripComments(f.text)))
      .map((f) => f.file.replaceAll("\\", "/"));
    expect(importers, "eligibleAndAssigned must have no production caller other than the monthly-generation runner").toEqual([AUTHORIZED_CALLER]);
  });

  it("the authorized caller genuinely imports it (so the check above isn't vacuous)", () => {
    const files = productionSourceFiles();
    const runner = files.find((f) => f.file.replaceAll("\\", "/") === AUTHORIZED_CALLER);
    expect(runner, `${AUTHORIZED_CALLER} must exist`).toBeTruthy();
    expect(IMPORTS_ELIGIBILITY.test(stripComments(runner!.text))).toBe(true);
  });

  it("is a plain library function: no \"use server\", no route", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
  });
});
