import { prisma } from "@/lib/prisma";

/**
 * Extracted from `src/lib/dues/ledger/common.ts` (PR 4a) so non-ledger callers — the status-history writers in this PR — can take the
 * same student-row lock without importing anything under `src/lib/dues/ledger/`, which `tests/unit/dues-ledger-not-exposed.test.ts`
 * asserts has ZERO callers outside that directory. `common.ts` re-exports both from here, so the ledger's own writers are unaffected.
 */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The student row, `FOR UPDATE`. Returns its home branch, or null when it is not in the organization. */
export async function lockStudent(tx: Tx, organizationId: string, studentId: string): Promise<{ homeAcademyId: string } | null> {
  const rows = await tx.$queryRaw<{ homeAcademyId: string }[]>`
    SELECT "homeAcademyId" FROM "Student" WHERE "id" = ${studentId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return rows[0] ?? null;
}
