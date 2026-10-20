import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Stage 8 PR 8a: the readiness report is server-only code with no browser-reachable caller yet. Any export of a
 * `"use server"` file is a callable action, so the module must not be one, and no route, action or client file may import
 * it until the owner screen (PR 8d) deliberately updates this test.
 */
const FILES = [
  "src/lib/dues/readiness/index.ts",
  "src/lib/dues/readiness/evaluate.ts",
  "src/lib/dues/readiness/fingerprint.ts",
  "src/lib/dues/readiness/snapshot.ts",
  "src/lib/db/read-only-snapshot.ts",
];
const IMPORTS_READINESS = /(?:from\s+|import\s*\(\s*)["'][^"']*dues\/readiness(?:\/[a-z-]+)?["']/;

describe("the readiness report is not reachable from a browser", () => {
  it.each(FILES)("%s is a plain server module: no \"use server\" / \"use client\"", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/^\s*["']use (server|client)["']/m);
  });

  it("nothing outside the readiness folder imports it", () => {
    const importers = productionSourceFiles()
      .filter((f) => !f.file.replaceAll("\\", "/").startsWith("src/lib/dues/readiness/"))
      .filter((f) => IMPORTS_READINESS.test(stripComments(f.text)))
      .map((f) => f.file);
    expect(importers).toEqual([]);
  });

  it("calls no ledger writer and takes no row lock", () => {
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, "utf8"));
      expect(text, file).not.toMatch(/InTx\(|FOR (UPDATE|SHARE)|lock[A-Z]\w*\(|generateMonthlyObligationForStudent|\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    }
  });

  it("is registered as built ahead of its caller", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("getDuesReadinessForOwner");
    expect(registry).toContain("src/lib/dues/readiness/index.ts");
  });
});
