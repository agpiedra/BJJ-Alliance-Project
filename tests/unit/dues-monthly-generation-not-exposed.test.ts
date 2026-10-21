import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, stripComments } from "../helpers/source-files";

/**
 * Monthly-generation brief §7/§8: `generateMonthlyObligationForStudent` has no production caller — not a route, not a server
 * action, no scheduler entry (`vercel.json`'s `crons` array is untouched). Same isolation discipline as
 * `dues-ledger-not-exposed.test.ts` and `dues-eligibility-not-exposed.test.ts`.
 *
 * Monthly-generation G1 (docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md revision 4): the visit loop
 * (`monthly-generation-progress.ts`) is the runner's one library importer, and has no importer itself. Its closed defaults are
 * pinned here too: no start month, inactive ledger, no production closure policy, and no code outside tests inserting progress
 * rows except the loop's own rollover (which runs only on a claimed row, i.e. after stage 9 inserted the first one).
 */
const RUNNER = "src/lib/dues/monthly-generation.ts";
const LOOP = "src/lib/dues/monthly-generation-progress.ts";
const IMPORTS_RUNNER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/monthly-generation["']/;
const IMPORTS_LOOP = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/monthly-generation-progress["']/;
const norm = (file: string) => file.replaceAll("\\", "/");

/** Every `.findMany(...)` call's full argument text, by balanced parentheses (arguments nest objects and ternaries). */
function findManyCalls(text: string): string[] {
  const calls: string[] = [];
  for (let at = text.indexOf(".findMany("); at !== -1; at = text.indexOf(".findMany(", at + 1)) {
    let depth = 0;
    for (let i = at + ".findMany".length; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        calls.push(text.slice(at, i + 1));
        break;
      }
    }
  }
  return calls;
}

describe("the monthly-generation runner and visit loop are not reachable from production code", () => {
  const files = productionSourceFiles();

  it("only the visit loop imports the runner", () => {
    const importers = files
      .filter((f) => norm(f.file) !== RUNNER)
      .filter((f) => IMPORTS_RUNNER.test(stripComments(f.text)))
      .map((f) => norm(f.file));
    expect(importers, "generateMonthlyObligationForStudent must have no production caller until the activation/scheduler rollout stage").toEqual([LOOP]);
  });

  it("nothing imports the visit loop", () => {
    const importers = files.filter((f) => IMPORTS_LOOP.test(stripComments(f.text))).map((f) => norm(f.file));
    expect(importers, "runMonthlyGeneration must have no production caller until G2 (D3 and D5 pending)").toEqual([]);
  });

  it("are plain library functions: no \"use server\", no route", () => {
    for (const file of [RUNNER, LOOP]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
      expect(file).not.toMatch(/(^|[\\/])(route|page|layout|actions?)\.tsx?$/);
      expect(stripComments(text)).not.toMatch(/from\s+["'](next\/|next-intl|react)/);
    }
  });

  it("is not registered in vercel.json's scheduler or the job registry", () => {
    expect(readFileSync("vercel.json", "utf8")).not.toContain("monthly-generation");
    expect(readFileSync("src/lib/jobs/job-names.ts", "utf8")).not.toContain("monthly-generation");
  });

  it("keeps its closed defaults: no start month, inactive ledger, and closure policy a required input with no production value", () => {
    const loop = stripComments(readFileSync(LOOP, "utf8"));
    expect(loop).toContain("deps.generationStart ?? (async () => null)");
    expect(loop).toContain("deps.activation ?? inactiveLedgerActivation");
    expect(loop).toMatch(/closurePolicy: "none";/); // required (no `?`), one literal value
    const mentionsClosurePolicy = files.filter((f) => /closurePolicy\s*:/.test(stripComments(f.text))).map((f) => norm(f.file));
    expect(mentionsClosurePolicy, "only the loop's own type may mention closurePolicy until D3 is decided").toEqual([LOOP]);
  });

  it("no production file other than the loop's rollover writes DuesGenerationProgress rows through the model API", () => {
    const writers = files
      .filter((f) => /duesGenerationProgress\s*\.\s*(create|createMany|upsert|update|updateMany|delete|deleteMany)\b/.test(stripComments(f.text)))
      .map((f) => norm(f.file));
    expect(writers).toEqual([LOOP]);
    const rawWriters = files.filter((f) => /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"DuesGenerationProgress"/.test(stripComments(f.text))).map((f) => norm(f.file));
    expect(rawWriters).toEqual([LOOP]);
  });

  it("every model read in the loop and runner is bounded (take) or keyed by ids from a bounded read", () => {
    for (const file of [RUNNER, LOOP]) {
      const text = stripComments(readFileSync(file, "utf8"));
      const calls = findManyCalls(text);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const keyedByCappedIds = call.includes("id: { in: planIds }"); // planIds come from the capped assignment read
        expect(keyedByCappedIds || /take:/.test(call), `${file}: ${call.slice(0, 90)}`).toBe(true);
      }
    }
  });

  it("is registered as built ahead of its caller", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("generateMonthlyObligationForStudent");
    expect(registry).toContain(RUNNER);
    expect(registry).toContain("runMonthlyGeneration");
    expect(registry).toContain(LOOP);
  });
});
