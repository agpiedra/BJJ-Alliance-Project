import { describe, expect, it } from "vitest";
import { type RunOutcome, START_TIMEOUT, failureOf, finalVerdict, stressReport } from "../../scripts/verify-pooling-results";

// Shapes as Prisma 7 raises them: TransactionManagerError prefixes "Transaction API error: " and
// carries code P2028 for every transaction-manager failure, not only the start timeout.
const prismaError = (message: string, code = "P2028") =>
  Object.assign(new Error(`Transaction API error: ${message}`), { code });
const startTimeout = () => failureOf(prismaError("Unable to start a transaction in the given time."));
const TOTAL = 360;
const run = (...errors: unknown[]) => ({ failures: errors.map(failureOf), pids: new Set([1, 2]) });

describe("failureOf identifies only the transaction-start timeout", () => {
  it("P2028 with the start-timeout message", () => {
    expect(startTimeout().code).toBe(START_TIMEOUT);
  });

  it("other P2028 messages are not the start timeout", () => {
    for (const message of [
      "Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction.",
      "Transaction already closed: A commit cannot be executed on a transaction that was rolled back.",
    ]) {
      expect(failureOf(prismaError(message)).code).toBe("other");
    }
  });

  it("the message without code P2028 is not the start timeout", () => {
    expect(failureOf(new Error("Unable to start a transaction in the given time.")).code).toBe("other");
    expect(failureOf(prismaError("Unable to start a transaction in the given time.", "P1001")).code).toBe("other");
  });

  it("keeps the Postgres codes it already recognised", () => {
    expect(failureOf(new Error('prepared statement "s1" already exists (42P05)')).code).toBe("42P05");
    expect(failureOf(new Error("53300: too many connections")).code).toBe("53300");
  });
});

describe("stressReport: only start timeouts stay information", () => {
  it("no failures: PASS, does not fail RESULT", () => {
    const report = stressReport(run(), TOTAL);
    expect(report.ok).toBe(true);
    expect(report.line).toMatch(/^\[3\/5\] STRESS   PASS  unbounded: 360\/360/);
  });

  it("only start timeouts: INFO, does not fail RESULT", () => {
    const report = stressReport({ failures: Array.from({ length: 60 }, startTimeout), pids: new Set() }, TOTAL);
    expect(report.ok).toBe(true);
    expect(report.line).toMatch(/^\[3\/5\] STRESS   INFO  unbounded: 60\/360 failed, every one the transaction-start timeout/);
  });

  it.each([
    ["a crossed result", new Error("crossed result: asked for 7, got 8")],
    ["a prepared-statement error", new Error('prepared statement "s1" does not exist (26000)')],
    ["too many connections", new Error("53300: sorry, too many clients already")],
    ["an expired transaction (P2028, not the start timeout)", prismaError("Transaction already closed: A query cannot be executed on an expired transaction.")],
    ["an unknown error", new Error("socket hang up")],
  ])("%s: FAIL, fails RESULT", (_, error) => {
    const report = stressReport(run(error), TOTAL);
    expect(report.ok).toBe(false);
    expect(report.line).toMatch(/^\[3\/5\] STRESS   FAIL  unbounded: 1\/360 failed with errors other than the transaction-start timeout/);
  });

  it("start timeouts mixed with another failure: FAIL, counts only the gating ones", () => {
    const report = stressReport(
      { failures: [startTimeout(), startTimeout(), failureOf(new Error("crossed result: asked for 1, got 2"))], pids: new Set() },
      TOTAL,
    );
    expect(report.ok).toBe(false);
    expect(report.line).toContain("1/360 failed with errors other than the transaction-start timeout: other×1");
    expect(report.line).toContain("(plus 2 transaction-start timeouts, information only)");
    expect(report.line).not.toContain(START_TIMEOUT);
  });

  it("a schema that stopped being readable: FAIL, fails RESULT", () => {
    const report = stressReport({ unreadable: "relation does not exist" }, TOTAL);
    expect(report.ok).toBe(false);
    expect(report.line).toBe("[3/5] STRESS   FAIL  could not run: relation does not exist");
  });
});

describe("finalVerdict: exit 0 only when every check ran and passed", () => {
  const complete: RunOutcome = { failed: false, local: false, tls: "verified", http: "pass" };
  const verdict = (overrides: Partial<RunOutcome>) => finalVerdict({ ...complete, ...overrides });

  it("full success: remote, verified TLS, database checks, HTTP check → PASS, exit 0", () => {
    expect(verdict({})).toEqual({
      exitCode: 0,
      line: "RESULT: PASS — every check ran and passed: verified TLS to a remote database, database load, 90/90 HTTP 200 from the supplied --app-url",
    });
  });

  it("HTTP omitted (database checks alone) → PARTIAL, exit 2", () => {
    const result = verdict({ http: "skipped" });
    expect(result.exitCode).toBe(2);
    expect(result.line).toBe(
      "RESULT: PARTIAL — the database checks passed, but not every check ran or was verified: the HTTP check did not run (no --app-url)",
    );
  });

  it("HTTP failed → FAIL, exit 1, even with every database check passing", () => {
    expect(verdict({ http: "failed" })).toEqual({ exitCode: 1, line: "RESULT: FAIL — see the FAIL line(s) above" });
  });

  it("any failed step → FAIL, exit 1, whatever else passed or was skipped", () => {
    for (const http of ["pass", "skipped", "failed"] as const) {
      expect(verdict({ failed: true, http }).exitCode).toBe(1);
    }
    expect(verdict({ failed: true, tls: "fallback", local: true }).exitCode).toBe(1);
  });

  it("TLS fallback with everything else passing → PARTIAL, exit 2, names the fallback", () => {
    const result = verdict({ tls: "fallback" });
    expect(result.exitCode).toBe(2);
    expect(result.line).toContain("TLS is on the temporary no-verify fallback, so the server is not authenticated");
  });

  it("local plaintext database → PARTIAL, exit 2, names both", () => {
    const result = verdict({ local: true, tls: "plaintext" });
    expect(result.exitCode).toBe(2);
    expect(result.line).toContain("the target is a LOCAL database, not the deployment's; the connection is plaintext");
  });

  it("a local database over verified TLS with the app checked is still PARTIAL", () => {
    expect(verdict({ local: true }).exitCode).toBe(2);
  });

  it("lists every gap at once", () => {
    expect(verdict({ local: true, tls: "plaintext", http: "skipped" }).line).toMatch(
      /LOCAL database.*plaintext.*HTTP check did not run \(no --app-url\)$/,
    );
  });

  it("no outcome other than complete success exits 0", () => {
    for (const failed of [false, true])
      for (const local of [false, true])
        for (const tls of ["verified", "fallback", "plaintext"] as const)
          for (const http of ["pass", "skipped", "failed"] as const) {
            const isComplete = !failed && !local && tls === "verified" && http === "pass";
            expect(finalVerdict({ failed, local, tls, http }).exitCode === 0).toBe(isComplete);
          }
  });
});

describe("finalVerdict wording claims only what was checked", () => {
  it("no verdict line claims a complete deployment, capacity, or authentication", () => {
    for (const failed of [false, true])
      for (const local of [false, true])
        for (const tls of ["verified", "fallback", "plaintext"] as const)
          for (const http of ["pass", "skipped", "failed"] as const) {
            expect(finalVerdict({ failed, local, tls, http }).line).not.toMatch(/complete deployment|capacity|authentication/i);
          }
  });

  it("the PASS line scopes the HTTP check to the supplied URL", () => {
    expect(finalVerdict({ failed: false, local: false, tls: "verified", http: "pass" }).line).toContain(
      "90/90 HTTP 200 from the supplied --app-url",
    );
  });
});
