import type { Tx } from "@/lib/dues/ledger/common";

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

/** Injected dependencies. All are optional: production uses the closed default activation, the real clock, and no test hooks. */
export interface LedgerDeps {
  activation?: LedgerActivation;
  /** The clock. Tests fix it; production leaves it out. */
  now?: () => Date;
  /**
   * Test-only synchronization point, called by `assessLateFeeInTx` (record-payment.ts) right before its `DuesLateFee` insert —
   * never referenced by production code, never given a value outside a test. Lets a test deliberately pause one caller there to
   * force a genuine, deterministic two-way race on the insert (proving the `ON CONFLICT DO NOTHING` design stays correct under
   * real contention), instead of hoping `Promise.all` happens to collide at the SQL level.
   */
  beforeLateFeeInsert?: (obligationId: string) => Promise<void>;
  /**
   * Test-only synchronization point, called by `correctLateFeeAndSettle` (correct-late-fee.ts) right after the fee void and its
   * own audit row are written, but before it composes `recordDuesPaymentInTx` in the same transaction — never referenced by
   * production code, never given a value outside a test. Lets a test force a failure late in the transaction to prove the void
   * (already written, not yet committed) rolls back along with everything else, rather than assuming Prisma's transaction
   * semantics "just work" without ever exercising it.
   */
  afterVoidForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `reversePayment` (reverse-payment.ts) right after the payment's and its
   * settlements' reversal markers (and their audit row) are written, but before the transaction commits — never referenced by
   * production code, never given a value outside a test. Lets a test force a failure at that point to prove the markers roll
   * back together, rather than assuming Prisma's transaction semantics "just work" without ever exercising it.
   */
  afterReversalMarkersForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `waiveLateFee` (waive-late-fee.ts) right after the fee's removal marker and its
   * own audit row are written, but before the transaction commits — never referenced by production code, never given a value
   * outside a test. Lets a test force a failure at that point to prove the marker rolls back together with the audit row,
   * rather than assuming Prisma's transaction semantics "just work" without ever exercising it.
   */
  afterWaiveMarkersForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `prepayMonthlyObligations` (prepay-monthly.ts) immediately after `purchaseInstant`
   * is captured (right after the branch/student locks succeed, before any gap/limit check or per-month write) — never referenced
   * by production code, never given a value outside a test. Lets a test pause the purchase there, either to prove a later step
   * reuses this same captured instant even if wall-clock time moves on while paused, or to hold the branch/student locks open for
   * a genuine-overlap proof against a concurrent writer.
   */
  afterPrepaymentInstantCapturedForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `prepayMonthlyObligations` (prepay-monthly.ts) after every requested month's
   * obligation has been written (with its provenance audit entry) but before it composes the final settlement — never
   * referenced by production code, never given a value outside a test. Lets a test force a failure there to prove every
   * provisional obligation, coverage and audit row rolls back together, rather than assuming Prisma's transaction semantics
   * "just work" without ever exercising it.
   */
  afterPrepaymentObligationsWrittenForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `purchasePackage` (purchase-package.ts) immediately after `purchaseInstant` is
   * captured (right after the branch/student locks succeed) — never referenced by production code, never given a value
   * outside a test. Mirrors `afterPrepaymentInstantCapturedForTest`'s role for this writer.
   */
  afterPackagePurchaseInstantCapturedForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `purchasePackage` (purchase-package.ts) after the package's own
   * `DuesObligation`, every `DuesCoverage` row and its audit entry are written, but before it resolves any current-debt
   * settlement — never referenced by production code, never given a value outside a test. Lets a test force a failure there
   * to prove the package obligation and every coverage row roll back together, or hold the branch/student locks open for a
   * genuine-overlap proof against a concurrent writer.
   */
  afterPackageObligationWrittenForTest?: () => Promise<void>;
  /**
   * Test-only synchronization point, called by `writeSettlementInTx` (record-payment.ts) right before it calls
   * `assessLateFeeInTx` for each fee-eligible item — never referenced by production code, never given a value outside a
   * test. Receives the open transaction itself so a test can mutate fee/settlement state for that exact obligation,
   * inside the SAME transaction, right before the fresh read — the only way to construct a genuine disagreement with
   * what validation already computed (`SettlementLineItem.expectedOwed`), since nothing else can run concurrently while
   * this transaction holds the student lock. Proves the restored cross-check actually fires and rolls back everything.
   */
  beforeSettlementFeeCheckForTest?: (tx: Tx, obligationId: string) => Promise<void>;
  /**
   * Test-only synchronization point, called by `enterExchangeRateQuote` (exchange-rate.ts) right after the new quote row
   * and its own audit entry are written, but before the transaction commits — never referenced by production code, never
   * given a value outside a test. Lets a test force a failure there to prove the row rolls back together with the audit
   * entry, and lets a test pause the transaction there (still holding the advisory lock) for a genuine-overlap proof
   * against a concurrent quote-write attempt.
   */
  afterExchangeRateQuoteWrittenForTest?: () => Promise<void>;
}
