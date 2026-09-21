import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * `requireTenantContext` is the PAGE primitive: it resolves the tenant from the
 * ambient session, so in a server action it acts on whichever organization the
 * session points at — not the one the tab that clicked was showing (the
 * two-tab bug). Server actions use `resolveActionContext(organizationId, roles)`
 * with an explicit organization id instead.
 */
const PAGE_PRIMITIVE = /\brequireTenantContext\s*\(/;
const USE_SERVER = /^\s*["']use server["']/m;

describe("server actions never call the page primitive", () => {
  const offenders = (files: Array<{ file: string; text: string }>) =>
    files.filter(({ text }) => USE_SERVER.test(text) && PAGE_PRIMITIVE.test(text)).map(({ file }) => file);

  it("no 'use server' file calls requireTenantContext", () => {
    expect(offenders(productionSourceFiles(["src"]))).toEqual([]);
  });

  // Positive control: the scan must be able to fail, or a green result proves nothing.
  it("flags a 'use server' file that does", () => {
    const planted = [
      { file: "planted.ts", text: `"use server";\nconst c = await requireTenantContext(["ADMIN"]);` },
      { file: "page.ts", text: `const c = await requireTenantContext(["ADMIN"]);` },
      { file: "clean.ts", text: `"use server";\nconst c = await resolveActionContext(id, ["ADMIN"]);` },
    ];
    expect(offenders(planted)).toEqual(["planted.ts"]);
  });
});
