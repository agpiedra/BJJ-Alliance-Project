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
const BUDGET = "src/lib/dues/monthly-generation-route-budget.ts";
// G2b (owner approval 2026-11-02): exactly ONE production path reaches the loop — this route file, through this module.
// Still unscheduled (no vercel.json entry until D5) and still closed by the production defaults below.
const ROUTE_MODULE = "src/lib/dues/monthly-generation-route.ts";
const ROUTE_FILE = "src/app/api/cron/monthly-generation/route.ts";
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

  it("the visit loop and the budget helper are reached only through the G2b route module, which only the route file imports", () => {
    const importers = files.filter((f) => IMPORTS_LOOP.test(stripComments(f.text))).map((f) => norm(f.file)).sort();
    expect(importers, "runMonthlyGeneration's only production caller is the G2b route module").toEqual([BUDGET, ROUTE_MODULE].sort());
    const IMPORTS_BUDGET = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/monthly-generation-route-budget["']/;
    const budgetImporters = files.filter((f) => IMPORTS_BUDGET.test(stripComments(f.text))).map((f) => norm(f.file));
    expect(budgetImporters, "planRouteBudget's only production caller is the G2b route module").toEqual([ROUTE_MODULE]);
    const IMPORTS_ROUTE_MODULE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*dues\/monthly-generation-route["']/;
    const moduleImporters = files.filter((f) => IMPORTS_ROUTE_MODULE.test(stripComments(f.text))).map((f) => norm(f.file));
    expect(moduleImporters, "only the cron route file calls the route module").toEqual([ROUTE_FILE]);
    // The helper is pure: no database client, no clock.
    const helper = stripComments(readFileSync(BUDGET, "utf8"));
    expect(helper).not.toMatch(/@\/lib\/prisma|Date\.now|performance\.now|new Date/);
  });

  it("are plain library functions: no \"use server\", no route", () => {
    for (const file of [RUNNER, LOOP]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
      expect(file).not.toMatch(/(^|[\\/])(route|page|layout|actions?)\.tsx?$/);
      expect(stripComments(text)).not.toMatch(/from\s+["'](next\/|next-intl|react)/);
    }
  });

  it("is registered in the job registry but NOT scheduled: no vercel.json entry and no stale threshold until D5", async () => {
    expect(readFileSync("vercel.json", "utf8"), "the schedule is D5's decision").not.toContain("monthly-generation");
    expect(readFileSync("src/lib/jobs/job-names.ts", "utf8")).toContain('"monthly-generation"');
    const { STALE_AFTER_HOURS, resolveJobSchedule } = await import("../../src/lib/jobs/job-health");
    expect(STALE_AFTER_HOURS["monthly-generation"]).toBeNull();
    expect(resolveJobSchedule("monthly-generation")).toBeNull();
  });

  it("keeps its closed defaults: no start month, inactive ledger, and closure policy a required input with no production value", () => {
    const loop = stripComments(readFileSync(LOOP, "utf8"));
    expect(loop).toContain("deps.generationStart ?? (async () => null)");
    expect(loop).toContain("deps.activation ?? inactiveLedgerActivation");
    expect(loop).toMatch(/closurePolicy: "reopen";/); // required (no `?`), one literal value
    const mentionsClosurePolicy = files.filter((f) => /closurePolicy\s*:/.test(stripComments(f.text))).map((f) => norm(f.file)).sort();
    expect(mentionsClosurePolicy, "besides the loop's type, only the G2b route module passes closurePolicy").toEqual([LOOP, ROUTE_MODULE].sort());
    // The route passes the one value, "reopen" (D3 = Reopen, approved; no behavior of its own). And it passes no
    // activation, no start month and no test hook, so the production defaults stay closed.
    const route = stripComments(readFileSync(ROUTE_MODULE, "utf8"));
    expect(route).toContain('closurePolicy: "reopen"');
    expect(route).not.toMatch(/\bactivation\s*:|generationStart\s*:|ForTest\s*:/);
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

  it("every database call in the loop and the runner goes through a bounded $transaction (no unbounded query outside one)", () => {
    for (const file of [RUNNER, LOOP]) {
      const text = stripComments(readFileSync(file, "utf8"));
      const direct = [...text.matchAll(/\bprisma\.(\$?\w+)/g)].map((m) => m[1]);
      expect(direct.length, file).toBeGreaterThan(0);
      expect(new Set(direct), `${file} must use only prisma.$transaction (with maxWait/timeout)`).toEqual(new Set(["$transaction"]));
    }
    expect(stripComments(readFileSync(LOOP, "utf8"))).toContain("resolveSystemJobContext(claim.organizationId, GENERATION_JOB_NAME, tx)");
  });

  it("the pending-callers registry matches: the per-student runner is still ahead of its direct caller; the loop and budget now have one", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toContain("generateMonthlyObligationForStudent");
    expect(registry).toContain(RUNNER);
    expect(registry).not.toContain('symbol: "runMonthlyGeneration"');
    expect(registry).not.toContain('symbol: "planRouteBudget"');
  });

  it("overdue-month condition C (not evaluable until stage 9) is a registered STAGE-9 BLOCKER, and readiness check 10 says it does not cover it", async () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    expect(registry).toMatch(/STAGE-9 BLOCKER: overdue-month condition C \(an ACTIVATED organization with no progress row\) is not evaluable/);
    expect(registry).toContain("Before stage 9 (activation)");
    const evaluate = readFileSync("src/lib/dues/readiness/evaluate.ts", "utf8");
    expect(evaluate.match(/condition C is not evaluable until stage 9/g)?.length).toBe(2); // pass and fail detail
    // The evaluator reports C as not evaluable on every path, never as passed.
    const alerts = readFileSync("src/lib/dues/monthly-generation-alerts.ts", "utf8");
    expect(alerts).toContain('conditionC: "notEvaluable"');
    expect(alerts).not.toMatch(/conditionC:\s*"(ok|pass|passed|clear)"/);
  });
});
