import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "../helpers/source-files";

/**
 * Independent-review finding on the enrollment/resume integration plan's PR: in Next.js, EVERY exported async
 * function in a file carrying a top-level `"use server"` directive becomes a directly client-invocable server
 * action with a stable reference — regardless of whether the author intended it as "internal." This PR had
 * exported `createStudentInTx`/`createStudentCore`/`isEnrollmentBillingActive`, `approveStudentInTx`, and
 * `assignPlanInTx`/`resolvePlanId` from three "use server" files; each of those functions takes already-trusted
 * arguments (a `TenantContext`, resolved ids, a generated `codeHash`) and performs NO authentication,
 * authorization, or tenant-scoping of its own — exposed as a server action, any client could call it directly with
 * forged arguments and bypass `resolveActionContext`/`isAcademyInTenantScope`/role checks entirely.
 *
 * Fixed by moving every one of those functions into plain, non-"use server" sibling modules
 * (`src/lib/dues/assignment-core.ts`, `src/app/[locale]/(staff)/students/[id]/approve-student-core.ts`,
 * `src/app/[locale]/(staff)/students/create-student-core.ts`) and re-importing them where needed. This test is the
 * regression guard: it names the exact, intended, already-authenticated public-action allow-list for each "use
 * server" file this PR touches, so a FUTURE accidental `export` of an internal helper from one of these three files
 * fails CI immediately, not silently.
 *
 * Deliberately scoped to the files this PR and the genuine-return-to-training brief actually audited — NOT a
 * directory-wide scan. Many other pre-existing "use server" files exist under these same directory trees
 * (students/actions.ts, [id]/adjustment-actions.ts, config-actions.ts, etc.); this test makes no claim about them,
 * since they were never part of either PR's review and auditing their exports is a separate, unstarted piece of
 * work.
 *
 * Extended (genuine-return-to-training brief §7, same hard-learned lesson) for `returnToTraining`, composing the
 * new `genuineReturnChargeInTx` core directly — re-verified the identical way, not assumed safe by precedent.
 */
const ALLOWED_SERVER_ACTION_EXPORTS: Record<string, string[]> = {
  "src/lib/dues/assignment-actions.ts": ["assignPlan", "correctAssignment"],
  "src/app/[locale]/(staff)/students/create-student-action.ts": ["createStudent"],
  "src/app/[locale]/(staff)/students/[id]/actions.ts": [
    "updateStudent",
    "archiveStudent",
    "restoreStudent",
    "approveStudent",
    "pauseStudent",
    "resumeStudent",
    "returnToTraining",
    "regenerateStudentCode",
  ],
};

/** The exact top-level directive check — a `"use server"` (or `'use server'`) string appearing only in prose or a
 * comment elsewhere in the file (as this test's own doc comment above does) must NOT count; only the real directive,
 * stripped of comments, as the file's first statement, does. */
function hasUseServerDirective(text: string): boolean {
  const stripped = stripComments(text).trimStart();
  return /^["']use server["'];?/.test(stripped);
}

/** Every `export async function name(...)` — the only shape this codebase's "use server" action files use (confirmed
 * directly against all three files below) — stripped of comments first so a mention inside a doc comment never
 * counts as a real export. */
function exportedAsyncFunctionNames(text: string): string[] {
  const stripped = stripComments(text);
  return [...stripped.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]);
}

describe('"use server" files in the enrollment/resume area export only their intended, already-authenticated public actions', () => {
  it.each(Object.entries(ALLOWED_SERVER_ACTION_EXPORTS))(
    "%s carries the \"use server\" directive and exports exactly its allow-listed actions, nothing else",
    (file, allowed) => {
      const text = readFileSync(file, "utf8");
      expect(hasUseServerDirective(text), `${file} must still carry the top-level "use server" directive`).toBe(true);
      expect(exportedAsyncFunctionNames(text).sort(), `${file}'s exported async functions must be exactly its allow-list`).toEqual([...allowed].sort());
    },
  );

  it("the newly-extracted plain core modules carry NO \"use server\" directive", () => {
    for (const file of [
      "src/lib/dues/assignment-core.ts",
      "src/app/[locale]/(staff)/students/[id]/approve-student-core.ts",
      "src/app/[locale]/(staff)/students/create-student-core.ts",
      "src/app/[locale]/(staff)/students/[id]/genuine-return-core.ts",
      "src/lib/dues/ledger/genuine-return-charge.ts",
      "src/lib/dues/ledger/monthly-config-resolution.ts",
      "src/lib/students/archive-event.ts",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(hasUseServerDirective(text), `${file} must NOT be a "use server" file — its exports (assignPlanInTx/resolvePlanId, approveStudentInTx, createStudentInTx/createStudentCore/isEnrollmentBillingActive, genuineReturnChargeInTx, the shared coverage/config resolvers, isGenuineReturnBillingActive, resolveTrustworthyArchiveEvent) trust locks/validation their caller already did and must never be directly client-invocable`).toBe(false);
    }
  });
});
