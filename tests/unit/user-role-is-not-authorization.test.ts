import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * `User.role` — the global role on the account — is NOT an authorization source.
 * Access is MEMBERSHIP: `OrganizationMembership.role` for the organization the
 * person is acting in, plus a linked student record for the portal (see
 * `src/lib/auth/route-access.ts`). The column stays (it is written when an account
 * is created), but it used to gate whole route trees, and an unused column that used
 * to be the authorization source is exactly how someone re-authorizes on it by
 * accident in four months. So this is a rule with an allowlist, not a convention —
 * the same shape as the `unscopedPrisma` rule:
 *
 * - new code may not READ the global role — `user.role`, `existingUser?.role`,
 *   `token.role`, `session.user.role`, or a `select: { role: true }` on a `user` query;
 * - the only files that may are listed below, each with why. Add one only with a
 *   reason that is not "it was convenient to gate on".
 *
 * (Reading `membership.role`, `invitation.role` and the like is not this: those are
 * per-organization facts and are how access is decided.)
 */
const ALLOWED_USER_ROLE_READERS: Array<{ file: string; why: string }> = [
  { file: "scripts/db-inventory.ts", why: "an inventory report that lists the column verbatim — it decides nothing" },
];

/** Code only: comments and string contents are not reads. Template-literal `${...}` expressions are kept, since those ARE code. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`([^`]*)`/g, (_match, inner: string) => (inner.match(/\$\{[^}]*\}/g) ?? []).join(" "))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** A property read of `.role` on something named like a user, or a `role: true` select inside a `user` query. */
function readsUserRole(text: string): boolean {
  const stripped = code(text);
  if (/\b\w*[uU]ser\w*\??\.role\b/.test(stripped)) return true;
  const userQuery = /\.user\.(findUnique|findFirst|findMany|findUniqueOrThrow|findFirstOrThrow)\s*\(/g;
  for (let match = userQuery.exec(stripped); match; match = userQuery.exec(stripped)) {
    // Only THIS call's own arguments: from its opening parenthesis to the matching one — a
    // neighbouring query (say a membership select in the same Promise.all) is not a read of User.role.
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < stripped.length && depth > 0) {
      if (stripped[end] === "(") depth += 1;
      else if (stripped[end] === ")") depth -= 1;
      end += 1;
    }
    if (/\brole\s*:\s*true\b/.test(stripped.slice(match.index, end))) return true;
  }
  return false;
}

const norm = (file: string) => file.replace(/\\/g, "/");
const offenders = (files: Array<{ file: string; text: string }>) =>
  files.filter(({ file, text }) => !ALLOWED_USER_ROLE_READERS.some((allowed) => allowed.file === norm(file)) && readsUserRole(text)).map(({ file }) => norm(file));

describe("nothing authorizes on the global User.role", () => {
  it("REQUIRED: no source file reads it, except the allowlisted ones", () => {
    expect(offenders(productionSourceFiles(["src", "scripts", "prisma"]))).toEqual([]);
  });

  it("every allowlisted reader still exists and still reads it (a stale entry would silently widen the rule)", () => {
    for (const { file } of ALLOWED_USER_ROLE_READERS) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(readsUserRole(text), file).toBe(true);
    }
  });

  it("the scan sees the source it guards (so it cannot pass by matching nothing)", () => {
    expect(productionSourceFiles(["src", "scripts", "prisma"]).length).toBeGreaterThan(200);
  });

  describe("positive controls", () => {
    it("flags each way of reading the global role", () => {
      const planted = [
        { file: "a.ts", text: `if (user.role === "STUDENT") return;` },
        { file: "b.ts", text: `if (existingUser?.role === "STUDENT") return;` },
        { file: "c.ts", text: `const r = session.user.role;` },
        { file: "d.ts", text: `const r = token.userRole; const s = actor.user?.role;` },
        { file: "e.ts", text: `const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });` },
        { file: "f.ts", text: `const u = await tx.user.findFirst({\n  where: { email },\n  select: { role: true },\n});` },
        { file: "g.ts", text: "const label = `${user.role}`;" },
      ];
      expect(offenders(planted)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]);
    });

    it("does not flag per-organization roles, comments, strings, or non-user queries", () => {
      const planted = [
        { file: "ok1.ts", text: `if (membership.role === "ADMIN" || invitation.role === "STUDENT" || context.organizationRole === "ADMIN") return;` },
        { file: "ok2.ts", text: `// the global user.role is not an authorization source\n/* existingUser?.role */` },
        { file: "ok3.ts", text: `const t = useTranslations("staffShell.userMenu.role"); const k = \`userMenu.role.\${role}\`;` },
        { file: "ok4.ts", text: `const m = await prisma.organizationMembership.findUnique({ where: { id }, select: { role: true, active: true } });` },
        { file: "ok5.ts", text: `await prisma.user.create({ data: { email, passwordHash, role: invitation.role } });` },
        { file: "ok6.ts", text: `const u = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });` },
      ];
      expect(offenders(planted)).toEqual([]);
    });

    it("lets an allowlisted file read it", () => {
      expect(offenders([{ file: "scripts/db-inventory.ts", text: `const users = await tx.user.findMany({ select: { role: true } });` }])).toEqual([]);
      expect(offenders([{ file: "scripts\\db-inventory.ts", text: `user.role` }])).toEqual([]);
    });
  });
});

describe("the column says so", () => {
  it("REQUIRED: the schema's User.role carries a warning that it is not an authorization source and names what is", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model User {"));
    const before = model.slice(0, model.search(/^\s*role\s+Role\b/m));
    const docLines = before.split(/\r?\n/).filter((line) => line.trim().startsWith("///")).join(" ");

    expect(docLines).toMatch(/NOT an authorization source/i);
    expect(docLines).toMatch(/OrganizationMembership\.role/);
    expect(docLines).toMatch(/route-access/);
  });
});
