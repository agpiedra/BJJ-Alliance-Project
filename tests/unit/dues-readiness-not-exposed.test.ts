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
  // Stage 8d-1: the screen's read model and the pure start-month rules. Read-only, like the report.
  "src/lib/dues/readiness/screen.ts",
  "src/lib/dues/readiness/candidate.ts",
  "src/lib/db/read-only-snapshot.ts",
];
const IMPORTS_READINESS = /(?:from\s+|import\s*\(\s*)["'][^"']*dues\/readiness(?:\/[a-z-]+)?["']/;

/**
 * Stage 8d-1 (docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md): the owner's READ-ONLY readiness screen is the first caller outside the
 * folder, named here deliberately. It is two server components that may import only the read model (`screen`), the start-month
 * rules (`candidate`) and report types (`evaluate`) — never the 8c actions, which are the interactive PR's (8d-2).
 */
const SCREEN_FILES = ["src/app/[locale]/(staff)/payments/readiness/page.tsx", "src/app/[locale]/(staff)/payments/readiness/readiness-view.tsx"];
/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §6): the only client files that reach the readiness folder. They import
 * the five 8c server actions and nothing else from it — never the cores, the loader, the fingerprints or the read model.
 */
const CLIENT_FORM_FILES = ["src/app/[locale]/(staff)/payments/readiness/confirmation-forms.tsx", "src/app/[locale]/(staff)/payments/readiness/draft-forms.tsx"];

describe("the readiness report is not reachable from a browser", () => {
  it.each(FILES)("%s is a plain server module: no \"use server\" / \"use client\"", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/^\s*["']use (server|client)["']/m);
  });

  it("outside the readiness folder, only the 8d screen and its two client form files import it", () => {
    const importers = productionSourceFiles()
      .filter((f) => !f.file.replaceAll("\\", "/").startsWith("src/lib/dues/readiness/"))
      .filter((f) => IMPORTS_READINESS.test(stripComments(f.text)))
      .map((f) => f.file.replaceAll("\\", "/"))
      .sort();
    expect(importers).toEqual([...SCREEN_FILES, ...CLIENT_FORM_FILES].sort());
  });

  it.each(CLIENT_FORM_FILES)("%s is a client file that imports only the 8c server actions from the readiness folder", (file) => {
    const text = stripComments(readFileSync(file, "utf8"));
    expect(text).toMatch(/^"use client";/);
    const modules = [...text.matchAll(/from\s+["'][^"']*dues\/readiness(?:\/([a-z-]+))?["']/g)].map((m) => m[1] ?? "index");
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.every((m) => m === "opening-actions"), modules.join(",")).toBe(true);
  });

  // 8d-2: the writes live in the client form files (which the view mounts); these two server files still import no action.
  it.each(SCREEN_FILES)("%s is a server component that imports only the read model, the month rules and report types, and no action", (file) => {
    const text = stripComments(readFileSync(file, "utf8"));
    expect(text).not.toMatch(/^\s*["']use (server|client)["']/m);
    const modules = [...text.matchAll(/from\s+["'][^"']*dues\/readiness(?:\/([a-z-]+))?["']/g)].map((m) => m[1] ?? "index");
    expect(modules.every((m) => ["screen", "candidate", "evaluate"].includes(m)), modules.join(",")).toBe(true);
    expect(text).not.toMatch(/opening-actions|method=["']post["']|formAction|action=\{/i);
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

/**
 * Stage 8 PR 8c: the owner's writers for opening drafts and confirmations. `opening-actions.ts` is the ONLY "use server" file,
 * and every export of it is a callable action, so it exports exactly the five actions. `opening-core.ts` trusts its caller's
 * authorization and must never be "use server". Neither calls a ledger writer; the only ledger import is the lock primitive.
 */
describe("the 8c owner actions expose exactly five server actions and nothing else", () => {
  const ACTIONS = "src/lib/dues/readiness/opening-actions.ts";
  const CORE = "src/lib/dues/readiness/opening-core.ts";

  it("opening-actions.ts is \"use server\" and exports exactly the five actions", () => {
    const text = readFileSync(ACTIONS, "utf8");
    expect(text).toMatch(/^"use server";/);
    const exported = [...stripComments(text).matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+(\w+)/gm)].map((m) => m[1]).sort();
    expect(exported).toEqual(["acknowledgePricing", "createOpeningDraft", "recordOpeningReview", "replaceOpeningDraft", "withdrawOpeningDraft"]);
    expect(stripComments(text)).not.toMatch(/^export\s*\{|^export\s+\*|^export\s+default/m);
  });

  it("opening-core.ts is a plain module, and neither file imports a ledger writer", () => {
    expect(readFileSync(CORE, "utf8")).not.toMatch(/^\s*["']use (server|client)["']/m);
    for (const file of [ACTIONS, CORE]) {
      const ledgerImports = [...stripComments(readFileSync(file, "utf8")).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/dues\/ledger\/([^"']+)["']/g)];
      expect(ledgerImports.map((m) => `${m[2]}:${m[1].trim()}`), file).toEqual(file === CORE ? ["common:lockBranchShared"] : []);
    }
  });

  // Plan rev 2 §4.4: a confirmation reads its content with ONE statement on its own transaction (loadReviewContentInTx), never the
  // multi-statement report loader (inconsistent under READ COMMITTED) and never a nested snapshot (a second pooled connection while
  // holding the first). The single-statement property cannot be interleaved by a test hook, so this structural rule guards it.
  it("opening-core.ts never uses the multi-statement loader or a nested snapshot", () => {
    const text = stripComments(readFileSync(CORE, "utf8"));
    expect(text).not.toMatch(/loadReadinessSnapshot|runReadOnlySnapshot|\$transaction\([^)]*\$transaction/);
    expect(text).toMatch(/loadReviewContentInTx\(tx,/);
  });

  // 8d-2: the screen is now their caller, so they leave the built-ahead registry, and each has a real call site in a form file.
  it("the five actions have a caller in the 8d-2 form files and are no longer registered as built ahead", () => {
    const registry = readFileSync("scripts/pending-callers.ts", "utf8");
    const callers = CLIENT_FORM_FILES.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
    for (const name of ["createOpeningDraft", "replaceOpeningDraft", "withdrawOpeningDraft", "recordOpeningReview", "acknowledgePricing"]) {
      expect(registry, name).not.toContain(`"${name}"`);
      expect(callers, name).toMatch(new RegExp(`${name}\\(organizationId, \\{\\}, `));
    }
  });
});
