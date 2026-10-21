/**
 * The one check every bounded-transaction entry point and the route-budget helper share (G2a). The values validated are the
 * values execution uses: `SET LOCAL statement_timeout = N` with N = 0 DISABLES the timeout in PostgreSQL, so a zero, a
 * fraction that truncates to zero, a negative or a non-finite value would silently remove the bound the budget relies on.
 * Every timeout here must therefore be a finite, positive INTEGER number of milliseconds, in the documented order:
 * lock_timeout <= statement_timeout <= the transaction timeout, and idle_in_transaction_session_timeout <= the transaction
 * timeout. Returns a description of the first problem, or null.
 */
export interface TransactionTimeouts {
  maxWaitMs: number;
  timeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs?: number;
}

export function isPositiveIntegerMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function transactionTimeoutsProblem(t: TransactionTimeouts, label: string, options: { requireIdle?: boolean } = {}): string | null {
  const fields: Array<[string, unknown]> = [
    ["maxWaitMs", t.maxWaitMs],
    ["timeoutMs", t.timeoutMs],
    ["statementTimeoutMs", t.statementTimeoutMs],
    ["lockTimeoutMs", t.lockTimeoutMs],
  ];
  if (options.requireIdle || t.idleInTransactionTimeoutMs !== undefined) fields.push(["idleInTransactionTimeoutMs", t.idleInTransactionTimeoutMs]);
  for (const [name, value] of fields) {
    if (!isPositiveIntegerMs(value)) return `${label}.${name} must be a finite positive integer number of milliseconds`;
  }
  if (t.lockTimeoutMs > t.statementTimeoutMs || t.statementTimeoutMs > t.timeoutMs) return `${label}: lock_timeout <= statement_timeout <= transaction timeout is required`;
  if (t.idleInTransactionTimeoutMs !== undefined && t.idleInTransactionTimeoutMs > t.timeoutMs) return `${label}: idle_in_transaction_session_timeout <= transaction timeout is required`;
  return null;
}

/** Throws a RangeError for an invalid configuration: a programming error, refused before any transaction starts. */
export function assertTransactionTimeouts(t: TransactionTimeouts, label: string, options: { requireIdle?: boolean } = {}): void {
  const problem = transactionTimeoutsProblem(t, label, options);
  if (problem) throw new RangeError(problem);
}
