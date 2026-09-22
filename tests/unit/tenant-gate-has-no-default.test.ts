import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { callArguments, productionSourceFiles, splitArguments, stripComments } from "../helpers/source-files";

/**
 * The two tenant gates — `requireTenantContext(allowedRoles)` for pages and
 * `resolveActionContext(organizationId, allowedRoles)` for server actions — are the
 * database check that stands behind the session claim: the middleware can only refuse on
 * a claim, so a stale or forged one reaches the page or the action, and this is what stops
 * it. Their NO-ROLE-LIST forms used to admit any membership — students included. The pages
 * that called `requireTenantContext()` that way were invisible for as long as the middleware
 * happened to be catching the same people; `regenerateStudentCode` called
 * `resolveActionContext(organizationId)` under a comment that said "any STAFF role" while
 * the code admitted any role at all. The hole existed because two layers overlapped, and only
 * became reachable when one was removed. The default was pointed the safe way, but a footgun
 * that happens to point safely is still a footgun: a permissive gate cannot be had BY
 * OMISSION at all. Same principle as making `unscopedPrisma` the loud import.
 *
 * - the role-list parameter is REQUIRED in both signatures (no `?`, no default) — a forgotten
 *   list is a compile error;
 * - every production call passes an explicit array LITERAL of role names — not a constant
 *   that could be reassigned, not `undefined`, not a spread, not an empty list (which admits
 *   nobody, and is a bug wearing a guard's clothes);
 * - naming STUDENT in a gate is how a page or action admits students, so only the portal
 *   gate (`requirePortalContext`, in context.ts) and the self check-in action may;
 * - `requireOrganizationAccess` (the optional-roles primitive under `resolveActionContext`)
 *   is called by nothing in production but context.ts, so it can never be a gate by omission.
 */
const ROLE_LIST = /^\[\s*"(?:ADMIN|DIRECTOR|INSTRUCTOR|STUDENT)"(?:\s*,\s*"(?:ADMIN|DIRECTOR|INSTRUCTOR|STUDENT)")*\s*,?\s*\]$/;

interface Gate {
  callee: string;
  /** Which argument carries the role list. */
  roleArgument: number;
  /** The only files that may name STUDENT in it. */
  mayNameStudent: string[];
  /** The declaration, with its role-list parameter required. */
  signature: RegExp;
}

const GATES: Gate[] = [
  {
    callee: "requireTenantContext",
    roleArgument: 0,
    mayNameStudent: ["src/lib/tenant/context.ts"],
    signature: /function requireTenantContext\(\s*allowedRoles:\s*MembershipRole\[\]\s*\)/,
  },
  {
    callee: "resolveActionContext",
    roleArgument: 1,
    mayNameStudent: ["src/lib/tenant/context.ts", "src/app/[locale]/portal/self-check-in-action.ts"],
    signature: /function resolveActionContext\(\s*organizationId:\s*string,\s*allowedRoles:\s*MembershipRole\[\],?\s*\)/,
  },
];

const norm = (file: string) => file.replace(/\\/g, "/");
type Files = Array<{ file: string; text: string }>;

const roleArgumentsOf = (text: string, gate: Gate): Array<string | undefined> =>
  callArguments(stripComments(text), gate.callee).map((argumentText) => splitArguments(argumentText)[gate.roleArgument]);

const withoutExplicitRoleList = (files: Files, gate: Gate) =>
  files.filter(({ text }) => roleArgumentsOf(text, gate).some((role) => role === undefined || !ROLE_LIST.test(role))).map(({ file }) => norm(file));

const namingStudentWithoutPermission = (files: Files, gate: Gate) =>
  files
    .filter(({ file }) => !gate.mayNameStudent.includes(norm(file)))
    .filter(({ text }) => roleArgumentsOf(text, gate).some((role) => role?.includes('"STUDENT"')))
    .map(({ file }) => norm(file));

const callsRequireOrganizationAccess = (files: Files) =>
  files
    .filter(({ file }) => norm(file) !== "src/lib/tenant/context.ts")
    .filter(({ text }) => callArguments(stripComments(text), "requireOrganizationAccess").length > 0)
    .map(({ file }) => norm(file));

const [pageGate, actionGate] = GATES;

describe("the tenant gates have no permissive default", () => {
  const source = productionSourceFiles(["src", "scripts"]);

  describe.each(GATES)("$callee", (gate) => {
    it("REQUIRED: the role-list parameter is required — no `?`, no default value", () => {
      const context = readFileSync(path.join(process.cwd(), "src/lib/tenant/context.ts"), "utf8");
      expect(stripComments(context)).toMatch(gate.signature);
    });

    it("REQUIRED: every production call passes an explicit array literal of role names", () => {
      expect(withoutExplicitRoleList(source, gate)).toEqual([]);
    });

    it("REQUIRED: only the allowlisted files may name STUDENT in it", () => {
      expect(namingStudentWithoutPermission(source, gate)).toEqual([]);
    });

    it("the scan sees the calls it guards (so it cannot pass by matching nothing)", () => {
      const calls = source.flatMap(({ text }) => roleArgumentsOf(text, gate));
      expect(calls.length).toBeGreaterThan(8);
      expect(calls.some((role) => role?.includes('"ADMIN", "DIRECTOR"'))).toBe(true);
    });
  });

  it("REQUIRED: nothing in production but context.ts calls requireOrganizationAccess (its role list is optional, so it must never be a gate)", () => {
    expect(callsRequireOrganizationAccess(source)).toEqual([]);
  });

  describe("positive controls", () => {
    it("flags a page gate with no argument, undefined, an empty list, a variable, a spread or an unknown role", () => {
      const planted = [
        { file: "a.tsx", text: `const c = await requireTenantContext();` },
        { file: "b.tsx", text: `const c = await requireTenantContext(undefined);` },
        { file: "c.tsx", text: `const c = await requireTenantContext([]);` },
        { file: "d.tsx", text: `const c = await requireTenantContext(ROLES);` },
        { file: "e.tsx", text: `const c = await requireTenantContext([...ROLES]);` },
        { file: "f.tsx", text: `const c = await requireTenantContext(["ADMIN", "OWNER"]);` },
        { file: "g.tsx", text: `const ok = await requireTenantContext(["ADMIN"]);\nconst bad = await requireTenantContext();` },
      ];
      expect(withoutExplicitRoleList(planted, pageGate)).toEqual(["a.tsx", "b.tsx", "c.tsx", "d.tsx", "e.tsx", "f.tsx", "g.tsx"]);
    });

    it("flags an action gate with NO role list — the form that admitted any role — and the other bad forms", () => {
      const planted = [
        { file: "a.ts", text: `const auth = await resolveActionContext(organizationId);` },
        { file: "b.ts", text: `const auth = await resolveActionContext(organizationId, undefined);` },
        { file: "c.ts", text: `const auth = await resolveActionContext(organizationId, []);` },
        { file: "d.ts", text: `const auth = await resolveActionContext(organizationId, [...STAFF_ROLES]);` },
        { file: "e.ts", text: `const auth = await resolveActionContext(organizationId, STAFF);` },
      ];
      expect(withoutExplicitRoleList(planted, actionGate)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    });

    it("accepts explicit literal lists, and ignores comments and the definitions", () => {
      const planted = [
        { file: "ok1.tsx", text: `const c = await requireTenantContext(["ADMIN", "DIRECTOR"]);` },
        { file: "ok2.tsx", text: `const c = await requireTenantContext(\n  ["ADMIN", "DIRECTOR", "INSTRUCTOR"],\n);` },
        { file: "ok3.tsx", text: `// called as requireTenantContext() in the old days\n/* requireTenantContext(); */\nconst c = await requireTenantContext(["ADMIN"]);` },
        { file: "ok4.ts", text: `export async function requireTenantContext(allowedRoles: MembershipRole[]): Promise<TenantContext> {}` },
      ];
      expect(withoutExplicitRoleList(planted, pageGate)).toEqual([]);
      const actions = [
        { file: "ok5.ts", text: `const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);` },
        { file: "ok6.ts", text: `const auth = await resolveActionContext(\n  context.organizationId,\n  ["ADMIN"],\n);` },
        { file: "ok7.ts", text: `export async function resolveActionContext(organizationId: string, allowedRoles: MembershipRole[]): Promise<ActionAuthResult> {}` },
      ];
      expect(withoutExplicitRoleList(actions, actionGate)).toEqual([]);
    });

    it("flags a gate that names STUDENT outside the allowlist, and lets the allowlisted files do it", () => {
      const page = [{ file: "src/app/[locale]/(staff)/students/page.tsx", text: `await requireTenantContext(["ADMIN", "STUDENT"]);` }];
      expect(namingStudentWithoutPermission(page, pageGate)).toEqual(["src/app/[locale]/(staff)/students/page.tsx"]);
      const action = [{ file: "src/lib/staff/staff-actions.ts", text: `await resolveActionContext(organizationId, ["ADMIN", "STUDENT"]);` }];
      expect(namingStudentWithoutPermission(action, actionGate)).toEqual(["src/lib/staff/staff-actions.ts"]);
      expect(
        namingStudentWithoutPermission(
          [{ file: "src\\app\\[locale]\\portal\\self-check-in-action.ts", text: `await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);` }],
          actionGate,
        ),
      ).toEqual([]);
    });

    it("flags a production call to requireOrganizationAccess outside context.ts", () => {
      expect(callsRequireOrganizationAccess([{ file: "src/lib/x.ts", text: `const c = await requireOrganizationAccess(userId, organizationId);` }])).toEqual(["src/lib/x.ts"]);
      expect(callsRequireOrganizationAccess([{ file: "src/lib/tenant/context.ts", text: `const c = await requireOrganizationAccess(userId, organizationId, allowedRoles);` }])).toEqual([]);
    });
  });
});
