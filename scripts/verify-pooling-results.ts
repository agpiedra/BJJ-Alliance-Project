/**
 * Failure classification and the final verdict for scripts/verify-pooling.ts. Separate because
 * that script connects as soon as it is imported; this file is pure, so tests/unit can pin it.
 */
export type Failure = { code: string; message: string };
export type LoadResult = { failures: Failure[]; pids: Set<number> } | { unreadable: string };

// Prisma's transaction-start timeout: `maxWait` expired before pool.connect + BEGIN finished.
// Matched on code AND message: P2028 also covers expired, closed and rolled-back transactions,
// which are not this and must fail the run.
export const START_TIMEOUT = "P2028-start-timeout";
const START_TIMEOUT_MESSAGE = "Unable to start a transaction in the given time";

export function failureOf(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const prismaCode = (error as { code?: unknown } | null | undefined)?.code;
  const code =
    prismaCode === "P2028" && message.includes(START_TIMEOUT_MESSAGE)
      ? START_TIMEOUT
      : (message.match(/\b(42P05|26000|08P01|53300|57P01|08006|XX000)\b/)?.[1] ?? "other");
  return { code, message: message.replace(/\s+/g, " ").slice(0, 200) };
}

export function summarize(failures: Failure[]): string {
  const byCode = new Map<string, number>();
  for (const failure of failures) byCode.set(failure.code, (byCode.get(failure.code) ?? 0) + 1);
  const counts = [...byCode].map(([code, n]) => `${code}×${n}`).join(", ");
  return `${counts} — e.g. "${failures[0].message}"`;
}

// [3/5], the original unbounded shape. Only the transaction-start timeout is information: it
// measures this machine's local queue (runbook step 11). Every other failure — crossed results,
// prepared-statement or connection errors, any other P2028, a schema that stopped being
// readable — fails RESULT.
export function stressReport(stress: LoadResult, total: number): { ok: boolean; line: string } {
  if ("unreadable" in stress) {
    return { ok: false, line: `[3/5] STRESS   FAIL  could not run: ${stress.unreadable}` };
  }
  const gating = stress.failures.filter((failure) => failure.code !== START_TIMEOUT);
  const timeouts = stress.failures.length - gating.length;
  if (gating.length > 0) {
    const plus = timeouts > 0 ? ` (plus ${timeouts} transaction-start timeouts, information only)` : "";
    return {
      ok: false,
      line: `[3/5] STRESS   FAIL  unbounded: ${gating.length}/${total} failed with errors other than the transaction-start timeout: ${summarize(gating)}${plus}`,
    };
  }
  if (timeouts > 0) {
    return {
      ok: true,
      line: `[3/5] STRESS   INFO  unbounded: ${timeouts}/${total} failed, every one the transaction-start timeout — the original unbounded test FAILS here; a finding about this machine's queue, not gating (runbook step 11)`,
    };
  }
  return {
    ok: true,
    line: `[3/5] STRESS   PASS  unbounded: ${total}/${total} started at once succeeded (${stress.pids.size} distinct backend connections seen)`,
  };
}

// What the run established, for the final verdict. `failed`: some step printed FAIL, or the run
// stopped early (no DATABASE_URL, no connection, unreadable schema).
export type RunOutcome = {
  failed: boolean;
  local: boolean; // the target is localhost/127.0.0.1/::1 — not the deployment's database
  tls: "verified" | "fallback" | "plaintext";
  http: "pass" | "skipped" | "failed";
};

// Exit 0 is reserved for a COMPLETE deployment verification: a remote database over verified TLS,
// the database checks, and the deployed app's own requests ([5/5]). Database checks that passed
// with any of those missing are PARTIAL, exit 2 — runnable alone, never labelled complete.
export function finalVerdict(run: RunOutcome): { exitCode: 0 | 1 | 2; line: string } {
  if (run.failed || run.http === "failed") {
    return { exitCode: 1, line: "RESULT: FAIL — see the FAIL line(s) above" };
  }
  const gaps: string[] = [];
  if (run.local) gaps.push("the target is a LOCAL database, not the deployment's");
  if (run.tls === "plaintext") gaps.push("the connection is plaintext");
  if (run.tls === "fallback") {
    gaps.push("TLS is on the temporary no-verify fallback, so the server is not authenticated (runbook: SSL fallback)");
  }
  if (run.http === "skipped") gaps.push("the deployed app was not checked (no --app-url)");
  if (gaps.length > 0) {
    return {
      exitCode: 2,
      line: `RESULT: PARTIAL — the database checks passed, but this is NOT a complete deployment verification: ${gaps.join("; ")}`,
    };
  }
  return { exitCode: 0, line: "RESULT: PASS — complete deployment verification (verified TLS, database load, deployed app)" };
}
