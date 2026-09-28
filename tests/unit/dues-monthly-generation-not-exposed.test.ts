import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Monthly-generation brief §7/§8: `generateMonthlyObligationForStudent` has no production caller — not a route, not a server
 * action, no scheduler entry (`vercel.json`'s `crons` array is untouched). Same isolation discipline as
 * `dues-ledger-not-exposed.test.ts` and `dues-eligibility-not-exposed.test.ts`.
 */
const FILE = "src/lib/dues/monthly-generation.ts";
const IMPORTS_RUNNER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/monthly-generation["']/;

describe("the monthly-generation runner is not reachable from production code", () => {
  it("no file other than itself imports it", () => {
    const files = productionSourceFiles();
    const importers = files
      .filter((f) => f.file.replaceAll("\\", "/") !== FILE)
      .filter((f) => IMPORTS_RUNNER.test(stripComments(f.text)))
      .map((f) => f.file);
    expect(importers, "generateMonthlyObligationForStudent must have no production caller until the activation/scheduler rollout stage").toEqual([]);
  });

  it("is a plain library function: no \"use server\", no route", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
    expect(FILE).not.toMatch(/(^|[\\/])(route|page|layout|actions?)\.tsx?$/);
  });

  it("imports no request- or UI-facing modules (next/*, react)", () => {
    const text = readFileSync(FILE, "utf8");
    expect(stripComments(text)).not.toMatch(/from\s+["'](next\/|next-intl|react)/);
  });

  it("is not registered in vercel.json's scheduler", () => {
    const vercelConfig = readFileSync("vercel.json", "utf8");
    expect(vercelConfig).not.toContain("monthly-generation");
  });

  it("is registered as built ahead of its caller", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("generateMonthlyObligationForStudent");
    expect(registry).toContain("src/lib/dues/monthly-generation.ts");
  });
});
