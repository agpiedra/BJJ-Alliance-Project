import type { getTestPrismaClient } from "./test-db";

/**
 * TEST CLEANUP ONLY. Progress rows and activation records are never deleted by anything in the application: the database refuses
 * (`DuesGenerationProgress_no_delete`, `DuesActivation_no_delete`, stage 9). Tests that created such rows in the isolated test
 * database remove them here, with triggers disabled for this one transaction (`session_replication_role = replica`, which needs
 * the test database's superuser role). Never used outside tests/.
 */
export async function forceDeleteForTest(prisma: ReturnType<typeof getTestPrismaClient>, ...statements: { sql: string; params?: unknown[] }[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    for (const s of statements) await tx.$executeRawUnsafe(s.sql, ...(s.params ?? []));
  });
}
