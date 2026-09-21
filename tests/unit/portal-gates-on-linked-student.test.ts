import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * The portal serves anyone with a linked, active student record — a coach who also
 * trains included — so nothing under `src/app/[locale]/portal` may gate on the
 * STUDENT membership role (`["STUDENT"]`) or on `selfStudentId`, which is itself
 * gated on that role. Either would quietly re-lock every dual-role person out of
 * their own training, which is the bug this replaced. The gate is
 * `requirePortalContext()` for pages and `context.linkedStudentId` for actions.
 */
// A gate that admits ONLY the STUDENT role: `["STUDENT"]` as the whole role list.
// (A list naming every role — which is how the portal admits any active member —
// contains "STUDENT" too and is not the bug.)
const STUDENT_ROLE_GATE = /(requireTenantContext|resolveActionContext)\s*\([^)]*\[\s*["']STUDENT["']\s*\]/;
const SELF_STUDENT_ID = /\bselfStudentId\b/;

/** Code only — a comment explaining what the portal does NOT do is not a gate. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const offenders = (files: Array<{ file: string; text: string }>) =>
  files
    .filter(({ file }) => file.replace(/\\/g, "/").includes("/portal/"))
    .filter(({ text }) => {
      const code = withoutComments(text);
      return STUDENT_ROLE_GATE.test(code) || SELF_STUDENT_ID.test(code);
    })
    .map(({ file }) => file.replace(/\\/g, "/"));

describe("the portal never gates on the STUDENT role", () => {
  it("REQUIRED: no portal file gates on ['STUDENT'] or reads selfStudentId", () => {
    expect(offenders(productionSourceFiles(["src"]))).toEqual([]);
  });

  it("the scan actually sees the portal files (so it cannot pass by finding none)", () => {
    const portal = productionSourceFiles(["src"]).filter(({ file }) => file.replace(/\\/g, "/").includes("/portal/"));
    expect(portal.length).toBeGreaterThanOrEqual(3);
  });

  describe("positive controls", () => {
    it("flags a portal file that gates a page on the STUDENT role", () => {
      const planted = [{ file: "src/app/[locale]/portal/page.tsx", text: `const context = await requireTenantContext(["STUDENT"]);` }];
      expect(offenders(planted)).toEqual(["src/app/[locale]/portal/page.tsx"]);
    });

    it("flags an action gated on the STUDENT role, and a read of selfStudentId", () => {
      const planted = [
        { file: "src/app/[locale]/portal/a-action.ts", text: `const auth = await resolveActionContext(organizationId, ["STUDENT"]);` },
        { file: "src/app/[locale]/portal/b.ts", text: `const id = context.selfStudentId;` },
      ];
      expect(offenders(planted)).toEqual(["src/app/[locale]/portal/a-action.ts", "src/app/[locale]/portal/b.ts"]);
    });

    it("passes an action that admits every role (the linked-student check decides), the linked-student gate, comments, and files outside the portal", () => {
      const planted = [
        { file: "src/app/[locale]/portal/c-action.ts", text: `const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"]);` },
        { file: "src/app/[locale]/portal/page.tsx", text: `// used to be requireTenantContext(["STUDENT"])\nconst { studentId } = await requirePortalContext();` },
        { file: "src/app/[locale]/(staff)/students/[id]/page.tsx", text: `if (context.organizationRole === "STUDENT" && context.selfStudentId !== id) notFound();` },
      ];
      expect(offenders(planted)).toEqual([]);
    });
  });
});
