# G2a: bounded route bookkeeping, safe wrapper diagnostics, route-budget helper — evidence

**What this implements:** G2a of `docs/dues/G2-ROUTE-BUDGET-PLAN.md` (revision 2, with the owner's correction recorded before
coding in its §4).

**What it does not include:**
- the monthly-generation route;
- a job-registry entry or a `vercel.json` cron;
- provider configuration, deployment or activation.

**Decision status:**
- D3 = Reopen (approved);
- D5 and O4 pending;
- `ready` false; activation off.

**Where it was tested:** the isolated test database only (postgres_test, port 5433).

## What changed

| File | Change |
|---|---|
| `src/lib/jobs/run-scheduled-job.ts` | **Optional fourth argument:** `options.bookkeeping`. It makes the `JobRun` create, finalize and heartbeat-status writes bounded transactions: `maxWait`, `timeout`, `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`. It also adds the body fields `ok`, `finalized`, `heartbeat.{request,resultPersisted}` and `bookkeepingError`, and the early-exit behavior. **Every caller's** wrapper-generated exception diagnostics are now `safeErrorCode` values |
| `src/lib/jobs/heartbeat.ts` | The ping-failure log uses `safeErrorCode`; `HEARTBEAT_TIMEOUT_MS` is exported (still 5 s) |
| `src/lib/dues/monthly-generation-route-budget.ts` (new) | `planRouteBudget`: a pure calculation, with no I/O and no clock. It returns the runner's deadline, or `budgetInfeasible` / `leaseTooShort` / `invalidInput`. **No production caller** (registered in `scripts/pending-callers.ts`) |
| `src/lib/dues/monthly-generation-progress.ts` | `idleInTransactionTimeoutMs` (default 1 s), and the ordering check `0 < idle ≤ each transaction timeout`. `SET LOCAL idle_in_transaction_session_timeout` in `bounded`, the student bounds and the discovery bounds. `admissionBudgetMs` is exported for the helper |
| `src/lib/dues/monthly-generation.ts` | The same `SET LOCAL` in the runner's transaction when the bounds include it |
| `src/lib/tenant/platform-lookups.ts` | The same `SET LOCAL` in discovery's transaction when the bounds include it |

### Compatibility change for the weekly digest (explicit)

Wrapper-generated diagnostics now carry `safeErrorCode` (a Prisma code, an allow-listed class name, or `unrecognized_error`).
For **every** caller, the digest included:

| Location | Before | After |
|---|---|---|
| A thrown job's stored `errorSummary` | `error.message` | Safe code |
| The 500 body's `error` | `error.message` | Safe code |
| The final `console.error` on a throw | The raw error object | `{ error: <safe code> }` |
| The heartbeat-status failure log | The raw error | Safe code |
| The ping-failure log (`heartbeat.ts`) | The raw error | Safe code |

**Unchanged for the digest:**
- authentication;
- status mapping;
- finalize-before-ping;
- its success, partial and failure bodies;
- its bookkeeping is still plain queries: a spy proves no transaction is opened.

**Caller-owned content is not sanitized and not audited:** what a job puts in its own body, in `outcome.errors`, or logs
itself. The digest's known caller-owned raw messages remain, and are tracked separately:
- `route.ts` 52 and 60: per-academy `err.message` in its 200 body;
- `src/lib/notifications/dispatch.ts` 36.

**No full digest logging audit is claimed.**

## Review correction (PR #153, round 1): validated as executed, and one heartbeat constant

**Timeouts are validated exactly as they are executed:**
- **The problem:** `SET LOCAL statement_timeout = 0` disables that timeout in PostgreSQL. Before this correction:
  - the helper accepted a zero statement timeout;
  - fractional values could truncate to 0 under `Math.trunc`.

  Either way, the claimed bound would not hold.
- **The fix:** one small shared check, `src/lib/db/transaction-timeouts.ts` (`transactionTimeoutsProblem` /
  `assertTransactionTimeouts`). Every timeout must be a **finite positive integer number of milliseconds**, in the order
  lock ≤ statement ≤ transaction timeout, with idle ≤ transaction timeout.
- **Generation limits:** `generationLimitsProblem` applies that check to both transaction kinds, and requires the deadline,
  the lease and every count to be finite positive integers.

**The same checks guard every entry point, before any I/O:**

| Entry point | Behavior on an invalid value |
|---|---|
| `planRouteBudget` | `invalidInput`; **never certified feasible** |
| `runMonthlyGeneration` | `RangeError` |
| The runner, when given bounds | `RangeError` |
| Discovery (`listClaimableGenerationSegments`) | `RangeError` |
| `runScheduledJob` with `options.bookkeeping` | `RangeError` before any `JobRun` write or ping |

**Regression tests** (`tests/unit/monthly-generation-route-budget.test.ts`):
- zero statement timeouts;
- sub-millisecond values that would truncate to 0, including the idle timeout;
- non-finite and NaN generation timeouts;
- generation statement above the short-transaction timeout, and lock above statement;
- a fractional lease; a non-finite deadline;
- each bounded entry point rejecting zero and truncating values;
- **the valid defaults unchanged** (same values, still certified with the same numbers).

**One heartbeat constant:**
- The helper's `heartbeatTimeoutMs` override is removed. Both the budget's reserve and `pingHeartbeat`'s abort use
  `HEARTBEAT_TIMEOUT_MS`.
- **Regressions:**
  - the reserve equals that constant in `postMs`, `createFailedMs` and `finalizeUnconfirmedMs`;
  - an attempted override is a type error, and has no effect at runtime;
  - with fake timers, the ping is still pending 1 ms before `HEARTBEAT_TIMEOUT_MS` and aborted exactly at it.

**Unchanged:**
- heartbeat ordering, uncertain-write handling, financial behavior, G1 fencing and the digest's behavior;
- the G2a convention for an infeasible budget, **HTTP 200 with `ok: false`**.

**The monthly route's own HTTP contract,** including whether an infeasible budget becomes a 500, is recorded as a **G2b
requirement** in the plan.

## Behavior in option mode (as tested)

| Branch | Heartbeat requests, exactly and in order | Response | Runner/job |
|---|---|---|---|
| Success | 1: success, sent after the row is final (`SUCCEEDED` + `finishedAt` observed at ping time) | 200, `ok: true`, `finalized: "confirmed"`, `heartbeat: { accepted, confirmed }` | Ran |
| `JobRun` create fails: the pool really exhausted, `maxWait` 500 ms | 1: `/fail`. **No success ping** | 500, `finalized: "unknown"`, `bookkeepingError.stage = "create"` with a safe code | **Not called** |
| Budget infeasible (`planRouteBudget` inside the job) | 1: `/fail`, after the row is final as `FAILED` | **200** with `ok: false`. The wrapper returns 500 only for a throw; the G2b route chooses whether to throw here | Runner **not started** |
| Finalize not confirmed: `JobRun` really locked `SHARE` past the timeouts | 1: `/fail`. **No success ping**, although the job succeeded | 500, `finalized: "unknown"`, `resultPersisted: "notAttempted"`, `stage = "finalize"`. The row really stayed `RUNNING` | Ran |
| Heartbeat-result write not confirmed: locked during the ping | 1: success (the one already sent). **No second ping** | 200, `ok: true`, `heartbeat: { request: "accepted", resultPersisted: "unknown" }`, `stage = "heartbeatStatus"`. Logs contain no SQL or driver text | Ran |

A thrown job (both modes) sends exactly one request, `/fail`.

**Ambiguous commits.** A timeout around COMMIT is reported exactly like a failure: `finalized: "unknown"` or
`resultPersisted: "unknown"`. Neither claims the write did not land.
- **What the tests cover:** real lock-timeout failures, where the write did not commit.
- **What they do not cover:** a commit that landed while the client saw an error. Nothing in this stack can create that
  deterministically. The reporting path is the same, and that state is described in the plan, not tested.

## Tested guarantees

**Run on the test database:**
- `tests/integration/run-scheduled-job.test.ts`: 17 tests, 10 of them new;
- `tests/integration/monthly-generation-progress.test.ts`: 43 tests, 2 new; 3 existing tests had limits adjusted for the
  idle-timeout ordering;
- `tests/unit/heartbeat.test.ts`: 8, 1 new;
- `tests/unit/monthly-generation-route-budget.test.ts`: 6, new;
- `tests/unit/dues-monthly-generation-not-exposed.test.ts`: updated.

| Requirement | Evidence |
|---|---|
| Real connection waits | The pool really exhausted (10 connections held): `JobRun` create fails after ≥ 450 ms and < `maxWait` + 1.5 s, and the job is never called |
| Real database failures | `LOCK TABLE "JobRun" IN SHARE MODE` held by another connection makes the finalize, and separately the heartbeat-status write, fail by lock or statement timeout |
| Uncertain finalization | One `/fail`, no success ping, `finalized: "unknown"`, 500; the wall time is within two bounded transactions plus the ping |
| Uncertain heartbeat-result persistence | The request outcome is kept (`accepted`), `resultPersisted: "unknown"`, exactly one request, `ok` unaffected |
| Early-exit reserves | Create failure with an endpoint that never answers: ends within `maxWait` + the 5 s abort + 1.5 s. Helper unit tests: each exit's reserve ≤ `post + M` |
| Idle timeout releases locks and the pool recovers | A transaction holding a row `FOR UPDATE` and idle past 300 ms is ended. Another connection then takes the same lock with `NOWAIT`, and 12 sequential transactions on the application pool (more than its 10 connections) succeed. **In the loop:** a student transaction paused idle is ended and recorded PENDING, its obligation rolled back, and the next student on the same pool commits |
| G1 atomicity, fencing and financial behavior | The whole G1 file (43 tests, including contiguity, fence rollback, crash boundaries, overlap, D1 attribution and failure isolation) passes three times in a row |
| Digest authentication, status mapping, finalize-before-ping | Existing tests unchanged and passing, and the new no-transaction spy |
| Fabricated secrets | Errors carry a secret in their name, code, message, stack, meta and cause. In both modes, the secret is absent from the 500 body, the stored `errorSummary` and every console argument; the same for a throwing heartbeat fetch |
| Budget arithmetic | Post = 2 × 4 s + 5 s. Admission = 4 s + 40 s. Feasible only when F > 57 s + C + M (strict). `leaseTooShort` when L ≤ F. `invalidInput` on inconsistent bounds. `failurePathFits` false when even the refusal cannot be recorded |

## Limits and assumptions (not proved here)

- **The budget is conditional admission feasibility,** not a measured run time, throughput or capacity. F, C and M are
  parameters; no production value is assumed (D5).
- **A network stall is not bounded** by anything in the application: server-side timeouts do not end a client stuck on its
  socket. Only the host's limit ends that run.
- **The heartbeat abort** cancels the request on the client only. It does not prove that Healthchecks did not receive or
  record the ping.
- **Whether the production pooler** (Supavisor, transaction mode, as planned) honors `SET LOCAL
  idle_in_transaction_session_timeout` and discards a terminated session cleanly is **unverified** (D5). Here it was proven
  against direct Postgres with `pg.Pool`.
- **Healthchecks** was not contacted: every request went to a stubbed `fetch`.
- **G1's budget** does not include the idle timeout. An idle gap is still bounded by Prisma's transaction `timeout`; the
  idle timeout bounds lock holding when the client is paused.

## Commands run (isolated test database only)

- `pnpm typecheck`: clean;
- `pnpm lint`: 0 errors (23 pre-existing warnings, none in changed files);
- `pnpm check:guard-usage`: clean;
- `pnpm check:pending-callers`: 22 registered;
- `pnpm test:unit`: 1976/1976;
- `pnpm test:integration`: the results are in the PR description;
- no migration.
