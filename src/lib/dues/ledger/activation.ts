/**
 * The seam that keeps the first ledger writers (PR 4a) closed to live billing until the approved activation stage.
 *
 * IMPORTANT: THIS IS NOT AUTHORIZATION. It is a test seam and a closed default, nothing more.
 *  - Production passes nothing, so every writer uses `inactiveLedgerActivation` and refuses (`notActive`) for every organization.
 *  - Tests inject an active stub to exercise the writers.
 *  - Before ANY caller is exposed (an action, a route, a job), activation must come from TRUSTED ORGANIZATION STATE read by the server
 *    (the activation stage's own stored, owner-approved settings and readiness result), never from request data and never from a boolean
 *    a caller supplies. Passing `{ isActive: async () => true }` from a caller is exactly the bug this note exists to prevent.
 *  - No activation infrastructure is built here: there is no table, setting or flag to read yet, and none is invented.
 *
 * A structural test (tests/unit/dues-ledger-not-exposed.test.ts) fails if anything outside this folder imports the writers, so the
 * first real caller has to update it deliberately, in the same review that decides where activation comes from.
 */
export interface LedgerActivation {
  /** Whether the ledger is authoritative for this organization. Must be answered from trusted, server-side organization state. */
  isActive(organizationId: string): Promise<boolean>;
}

/** The only production implementation until the activation stage exists: no organization is active. */
export const inactiveLedgerActivation: LedgerActivation = { isActive: async () => false };

/** Injected dependencies. Both are optional: production uses the closed default activation and the real clock. */
export interface LedgerDeps {
  activation?: LedgerActivation;
  /** The clock. Tests fix it; production leaves it out. */
  now?: () => Date;
}
