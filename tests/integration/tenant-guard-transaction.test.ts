import "dotenv/config";
import { describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { unscopedPrisma } from "../../src/lib/prisma/unscoped";
import { UnscopedTenantQueryError } from "../../src/lib/tenant/tenant-guard";

/**
 * Verifies, against the REAL guarded `@/lib/prisma` singleton (not a mock,
 * not the isolated unit-test hook invocation in tenant-guard.test.ts), that
 * the guard's query hook fires for a query issued INSIDE a `$transaction`
 * interactive callback — not just for a query issued directly on the base
 * client.
 *
 * Why this needed a real check rather than reasoning about it: several
 * commits in this PR (writeAward, students/[id]/actions.ts's mutations,
 * admin/schedule/actions.ts, kiosk-tokens/actions.ts) keep their write on
 * the raw client specifically because it shares an interactive transaction
 * with an `AuditLog` row, which `getScopedDb`'s wrapper excludes. If Prisma
 * extensions did not propagate into an interactive transaction's `tx`
 * client, every one of those writes — payment recording and promotion
 * awards among them — would be silently unprotected, and the 413-test green
 * run would have proven nothing about that entire category.
 */
describe("tenant guard inside $transaction", () => {
  it("REQUIRED VERIFICATION: throws for an unscoped READ issued via tx inside an interactive $transaction callback", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        return tx.academy.findMany({ orderBy: { name: "asc" } });
      }),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("REQUIRED VERIFICATION: throws for an unscoped WRITE issued via tx inside an interactive $transaction callback — the exact shape writeAward/students actions/schedule actions/kiosk-token actions all use", async () => {
    // Fixture setup only — reads the row's own real id/name via the explicit
    // hatch, same as any other test file's `escazu.organizationId` lookups.
    // The query under test is the `tx.academy.update` below, not this line.
    const escazu = await unscopedPrisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    await expect(
      prisma.$transaction(async (tx) => {
        return tx.academy.update({
          where: { id: escazu.id },
          data: { name: escazu.name },
        });
      }),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("does NOT throw for a properly-scoped write via tx inside $transaction — proves the guard discriminates inside a transaction too, not merely refuses to run at all in there", async () => {
    const escazu = await unscopedPrisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    await expect(
      prisma.$transaction(async (tx) => {
        return tx.academy.update({
          where: { id: escazu.id, organizationId: escazu.organizationId },
          data: { name: escazu.name },
        });
      }),
    ).resolves.toBeDefined();
  });
});
