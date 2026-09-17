import { describe, expect, it } from "vitest";

// `scoped-client.ts` transitively imports `@/lib/prisma/unscoped`, which
// constructs a real `PrismaPg` adapter at module load and requires
// `DATABASE_URL` to exist — even though it's never actually connected to
// here (the guard throws before any query reaches it). A syntactically
// valid dummy value, set before the dynamic imports below, is enough.
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";

const { TENANT_SCOPED_MODELS, UnscopedTenantQueryError, tenantGuardExtension } = await import(
  "@/lib/tenant/tenant-guard"
);
const { TENANT_SCOPED_MODELS: SCOPED_CLIENT_MODELS } = await import("@/lib/tenant/scoped-client");

/**
 * Pure unit tests over the guard's hook function itself — no Prisma client,
 * no DATABASE_URL, no DB round trip. The guard's `$allOperations` hook
 * decides whether to throw BEFORE ever calling the real `query()`, so a
 * fake `query` stub is enough to prove what it does and does not let
 * through.
 *
 * Per the new Global rule (revision 23, docs/MULTI_ACADEMY_AND_KIDS_BELTS.md):
 * "A guard is not tested until something takes the unguarded path and
 * fails." The two tests below are not generic guard-behavior checks — they
 * reproduce the EXACT unscoped call shapes the layout leak and the
 * unauthenticated signup-page leak actually sent, and assert the guard
 * refuses both. A guard that only had tests for scoped/unscoped queries in
 * the abstract would not have caught either real leak, since both leaks
 * were "the guard works when called correctly" cases from every other
 * call site's perspective.
 */

function invokeGuard(model: string, operation: string, args: Record<string, unknown>) {
  const hook = tenantGuardExtension().query.$allModels.$allOperations;
  const query = async (a: Record<string, unknown>) => a;
  return hook({ model, operation, args, query });
}

describe("tenantGuardExtension", () => {
  it("keeps TENANT_SCOPED_MODELS in sync with scoped-client.ts's own list — deliberately duplicated, not imported, so the guard has no shared point of failure with the wrapper it backstops", () => {
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual([...SCOPED_CLIENT_MODELS].sort());
  });

  it("REQUIRED REGRESSION (layout door): throws on the exact unscoped Academy.findMany shape (staff)/layout.tsx sent before revision 23 — orderBy/select only, no organizationId anywhere", async () => {
    await expect(
      invokeGuard("Academy", "findMany", {
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("REQUIRED REGRESSION (unauthenticated-page door): throws on the exact unscoped Academy.findMany shape signup/page.tsx sent before revision 23 — a where with real filters but no organizationId, reachable with zero authentication", async () => {
    await expect(
      invokeGuard("Academy", "findMany", {
        where: { active: true },
        orderBy: { name: "asc" },
        select: { slug: true, name: true },
      }),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("does not throw on the same query once properly scoped by organizationId — proves the guard discriminates, not a blanket throw", async () => {
    await expect(
      invokeGuard("Academy", "findMany", {
        where: { organizationId: "org-1" },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ).resolves.toBeDefined();
  });

  it("never throws for a platform-level model outside TENANT_SCOPED_MODELS — Organization/User/etc. pass through untouched", async () => {
    await expect(invokeGuard("Organization", "findMany", {})).resolves.toBeDefined();
  });
});
