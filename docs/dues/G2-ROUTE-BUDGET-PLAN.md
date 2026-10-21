# G2: whole-route budget for the monthly-generation cron route (design plan)

**Status:** revision 2, written against main `50ff5084d1ce04c6b0d036f58741db6b95df7b26`.

**G2a is implemented** on branch `feat/dues-g2a-route-bookkeeping`, with the §4 correction recorded before coding. Evidence:
`design/matroom/verification/dues-g2a-route-bookkeeping/README.md`.

**One deviation found while implementing:** for an infeasible budget, the wrapper returns **200 with `ok: false`**, not 500.
The wrapper returns 500 only when the job throws, so whether the G2b route throws in that case is G2b's choice.

**Not started:** G2b (route, registry, cron), provider work, scheduling and activation.

**Fixed inputs** (`MONTHLY-GENERATION-DECISION-BRIEF.md` §0):
- **D3 = Reopen** (approved).
- **Missing historical charges** keep their original due and grace dates; existing charges remain unchanged.
- **D5 and O4 are pending.** `ready` is false, and activation is off.
- **The 07:00 UTC daily schedule** is provisional and is **not** approved here.

**Revision 2 corrects revision 1:**
- completion claims, and a field that does not exist (`remainingSegments`);
- ambiguous heartbeat-status persistence;
- the logging and response-body scope of the wrapper;
- budget versus throughput wording;
- the idle-timeout semantics;
- the API position of the new options (a fourth argument).

---

## 1. Current behavior (traced at 50ff508)

### 1.1 The shared wrapper: `runScheduledJob(jobName, request, fn)`, `src/lib/jobs/run-scheduled-job.ts`

| Step | Lines | Behavior | Bounded? |
|---|---|---|---|
| Authentication | 65–68 | Compares the bearer with `CRON_SECRET`. On a mismatch: 401, no row, no ping | In memory |
| `JobRun` create | 70 | `prisma.jobRun.create`: a plain query, status `RUNNING` by default (`JobRun.status @default(RUNNING)`) | **No.** G1's review measured that a plain query waits for a pool connection indefinitely, and it has no statement timeout |
| The job | 75–81 | `await fn()`. On a throw: `errors: [threw.message]` (79), which becomes the stored `errorSummary` (84, 96), and `body = { ok: false, error: threw.message }` (80) | Whatever the job bounds |
| Status | 35–39, 83 | `FAILED` if it threw; `SUCCEEDED` if `failed === 0`; otherwise `PARTIAL` or `FAILED` | — |
| Finalize | 86–98 | `prisma.jobRun.update` (status, finishedAt, counts, breakdown, `errorSummary`). **Deliberately before the ping** (48–58) | **No** |
| Heartbeat | 100–101 → `heartbeat.ts` 30–47 | GET to the per-job URL, or `/fail`. Aborted after 5 s (20, 36–37). Returns `ok`, `failed` or `not_configured`. On error, logs the **raw error object** (42) | HTTP: 5 s, client-side |
| Heartbeat status | 102–108 | `prisma.jobRun.update({ heartbeatStatus })`. Its failure is caught, and the **raw error** logged (107) | **No** |
| Thrown-path response | 110–112 | Logs the **raw error object** (`console.error(\`[cron:${jobName}] threw\`, threw)`, 111), then returns **500 with the raw message** in `body.error` | — |
| Normal response | 114 | 200 with the job's own `body` | — |

### 1.2 Health and detection

- **Stuck:** `job-health.ts` 17 and 23–25: `RUNNING` and older than 30 minutes.
- **Stale:** `job-health.ts` 11–13 and 19–21: a per-job threshold.
- **`/api/health/jobs`** (`src/app/api/health/jobs/route.ts` 26–38) reads only the **latest** `JobRun` per registered job
  (34), so an older run left `RUNNING` stops being reported once a newer run exists.
- `HEALTHCHECK_ENV` (`heartbeat.ts` 11–13) and `STALE_AFTER_HOURS` are `Record<JobName, …>`, and the health route iterates
  `JOB_NAMES` (33).

### 1.3 The only current caller: the weekly digest

`src/app/api/cron/weekly-digest/route.ts` 23–62 calls `runScheduledJob("weekly-digest", request, fn)`.

**Caller-owned raw error text** (not the wrapper's):
- the digest's own `body.errors` carries `err.message` per failed academy (52, 60), returned on a 200;
- its notification path has its own logging (for example `src/lib/notifications/dispatch.ts` 36).

**These are flagged, not audited, and this plan does not change them.**

### 1.4 The generation runner (G1): `src/lib/dues/monthly-generation-progress.ts`

- **`runMonthlyGeneration`** (210):
  - checks the limits (213);
  - admits units against `elapsed() + unit < deadlineMs` (217–218), with `elapsedMs` and `limits.deadlineMs` injectable
    (116, 91).
- **`budgetOf`** (188): `short` = 4 s, `student` = 8 s, `visitEntry` = 36 s. Discovery is admitted only if
  `elapsed + short + visitEntry` (40 s) `< deadlineMs`.
- **Every database operation** is a bounded transaction: `bounded` (265), and the runner's own transaction
  (`monthly-generation.ts` 193–198).
- **Its report** has exactly these fields: `visits` (per segment: `ended`, `error`, `classes`, `reasons`, `errorCodes`,
  `rollover`, `passFinished`), `claimErrors`, `discoveryError`, `stoppedBy`. **There is no `remainingSegments` and no
  completeness field,** and G2 adds neither.

**What G1 actually guarantees about work done:**
- **Recorded progress:** the cursor, and the pass counts for the students before it, committed atomically per student.
- **The last finished pass's observations** (`lastPass…`, `lastPassClean`): what each student looked like **at its own
  visit**, during a pass that spans many transactions and possibly many runs.
- **These may already be outdated** when read: a change behind the cursor is seen only by a later pass.
- **Nothing in G1 or G2 reports billing completeness.**

---

## 2. One route budget

**Definitions:**
- **F:** the host's maximum duration for this route. Unknown (D5). It would be set through the route's `maxDuration` export,
  which does not exist today.
- **C:** cold start before the handler runs. Unknown; only the host can measure it.
- **M:** response and runtime margin. Unknown; to be measured.
- **short:** G1's short-transaction worst case, 4 s by default.

**Sequential costs** (outside the runner's deadline, each counted once):

| Step | Worst case | Notes |
|---|---|---|
| S0 cold start | C | Before the handler; a reserve only |
| S1 authentication | ≈ 0 | — |
| S2 `JobRun` create | short | Bounded (§3) |
| S3 the runner | T_run | — |
| S4 finalize | short | Bounded |
| S5 heartbeat | 5 s | Existing abort |
| S6 heartbeat status | short | Bounded |

**Overlapping reserves** (inside T_run, never added again): discovery, each visit's entry, each further student, the pass end,
and the lease release. The runner reserves these itself before admitting a unit.

**Wiring (existing mechanism; G1 unchanged):** the route passes `elapsedMs` measured from the handler's start, and
`limits.deadlineMs = F − C − M − post`, with `post = S4 + S5 + S6 = 2·short + 5 s`. S2's real duration is thereby charged to
the runner's own admission check.

### 2.1 Early exits: each reserves its own failure path

| Branch | Must still fit after it | Must not happen |
|---|---|---|
| S2 fails, or is uncertain | One `/fail` ping (5 s) + M | A success ping; starting the runner |
| Budget infeasible (below) | A finalize as `FAILED` (short) + `/fail` (5 s) + S6 (short) + M | A success ping; starting the runner |
| Finalize uncertain (§4) | `/fail` (5 s) + M. S6 is skipped: there is no confirmed row to annotate | A success ping |
| The normal path | S4 + S5 + S6 + M (the `post` reserve) | — |

Each early branch's reserve is no larger than `post`, so reserving `post` covers every exit.

### 2.2 Admission feasibility (a conditional reserve, not a runtime or capacity claim)

**For the runner to admit even one visit:**
`F − C − M − post > elapsed_at_runner_start + short + visitEntry`.

With the defaults and S2 at its worst, that is `F > C + M + 4 s + 13 s + 40 s = 57 s + C + M`.

**What this is and is not:**
- It is a **worst-case admission condition**. If F is below it, the route records `FAILED` with reason `budgetInfeasible`
  and does not start the runner.
- It **is not** a predicted run time, and **not** a throughput or capacity guarantee.
- How much work a run does depends on real per-operation times. Only a hosted measurement can establish that (decision
  brief §2.4), and no formula here substitutes for it.

**Further conditions:**
- **L > F,** so a live run's lease cannot lapse mid-run.
- **If F is too small,** G1's limits shrink together, keeping `lock ≤ statement ≤ each transaction timeout`. That is an
  engineering change to re-measure, not an owner decision.

---

## 3. Bounded operations

| Operation | Bound | Mechanism |
|---|---|---|
| A pool connection for S2, S4 and S6 | `shortMaxWait` | `maxWait` (measured in G1: bounds pg pool acquisition) |
| A **running** statement in any bounded transaction | `statement_timeout` (lock waits count inside it), with `lock_timeout ≤ statement_timeout` | `SET LOCAL` (the G1 pattern) |
| A transaction's total time | `timeout` + at most one in-flight statement | Prisma's `timeout` does not interrupt a running statement (measured in G1) |
| A transaction left **idle** (no statement running) while open — for example, the process paused between statements while holding locks | **New:** `idle_in_transaction_session_timeout` | `SET LOCAL` as the first statement, with `statement_timeout` and `lock_timeout` |
| Heartbeat HTTP | 5 s | The existing `AbortController` |

### 3.1 The idle timeout

**Value and ordering:**
- **Engineering default = `statement_timeout`** (1 s), and it must be ≤ the transaction's Prisma `timeout`.
- **The full order:** `lock_timeout ≤ statement_timeout ≤ timeout`, and `idle_in_transaction_session_timeout ≤ timeout`.
- The legitimate idle gap inside these transactions is the JavaScript time between two statements, which is milliseconds.
- **Tests that deliberately pause inside a transaction** must raise the value for that test, as they already do for the
  other timeouts.

**Coverage:**
- G1's `bounded` helper (all short transactions of the loop);
- the runner's transaction when `bounds` are passed (the loop always passes them);
- the wrapper's new bounded bookkeeping (option mode only).

**Not covered:**
- discovery's `unscopedPrisma` transaction in `platform-lookups.ts` (add it there too: same helper pattern, same G2a scope);
- the digest's plain queries;
- any other code.

**What it does and does not do:**
- **It does not govern a running statement;** `statement_timeout` does.
- **When it fires,** Postgres **terminates the session**, not only the transaction. The open transaction rolls back and its
  locks are released.

**What happens to the pooled connection** when the session ends:
- The pg client sees its connection closed.
- `pg.Pool` discards a client whose connection has errored, rather than returning it for reuse.
- A later transaction therefore gets a fresh or healthy connection.

**Whether the pooler** (Supavisor, transaction mode) **passes this setting through and discards cleanly is a D5 fact.**

**Test required:** terminate a transaction's backend through the idle timeout (and, separately, `pg_terminate_backend`),
then prove a **later** bounded transaction on the same application pool succeeds, with no error from the dead client.

### 3.2 What a bound does not prove

- **`maxWait` expired:** the transaction never started, so nothing was written.
- **`timeout` or `statement_timeout` around the commit, or a lost connection after COMMIT was sent:** the outcome is
  **unknown**. The write may have committed. Every such case is reported as *unknown* (§4), never as "not written".
- **The heartbeat abort or a network error:** "not confirmed". Healthchecks may still have received and recorded it.
- **A network stall:** server-side timeouts do not bound a client stuck on its socket. The pg client has no socket or query
  timeout, and a pool-level `query_timeout` would change every query in the app (out of scope; it needs its own review). Only
  F, enforced by the host, ends such a run (§5).

---

## 4. Failure reporting

**Three things are kept distinct:**

| Fact | Values | Meaning |
|---|---|---|
| **Finalization** | `confirmed` / `unknown` | Whether the final `JobRun` update is known to have committed |
| **Heartbeat request** | `accepted` (a 2xx was received) / `notConfirmed` (abort, network error, non-2xx) / `notConfigured` | Only what the client observed |
| **Heartbeat result persisted** | `confirmed` / `unknown` / `notAttempted` | Whether `heartbeatStatus` is known to be stored. `unknown` means the stored value may be the new one or the earlier null |

**What these facts never mean:**
- Neither heartbeat fact, nor HTTP 200, proves billing completeness.
- None of them proves anything about the progress rows beyond what G1's report says.

**The monthly route's response body, in option mode only:**
- `{ ok, finalized, heartbeat: { request, resultPersisted }, report }`, where `report` is G1's report unchanged;
- on a bookkeeping failure, a safe diagnostic `{ stage: "create" | "finalize" | "heartbeatStatus", code: SafeErrorCode }`;
- **`ok` is true only when** finalization is confirmed and the run's own status is `SUCCEEDED`.

| Failure | Persisted | `JobRun` | Heartbeat | Response | Committed financial work and progress |
|---|---|---|---|---|---|
| Authentication | Nothing | None | None | 401 (unchanged) | None attempted |
| `JobRun` create fails, `maxWait` expired | Nothing | None | `/fail`, best effort | 500, `finalized: "unknown"` (no row), stage `create` + code | None attempted |
| `JobRun` create uncertain (a timeout around commit) | **Unknown:** possibly a `RUNNING` row | Unknown | `/fail`, best effort | 500, stage `create` + code | None attempted |
| Budget infeasible | Finalize attempted as `FAILED`, reason `budgetInfeasible` | Per finalize | `/fail` | 500 | None attempted |
| Failures during generation | Committed students only | `PARTIAL` or `FAILED` per plan §8 | `/fail` | 200, `ok: false` | **Kept:** per-student transactions are independent of the route |
| The runner stops at its deadline | Committed students only | `SUCCEEDED` if nothing failed | Success | 200, `ok: true`. **Not "complete":** progress is the recorded cursor and last-pass observations (§1.4) | Kept |
| An unexpected throw | As committed | `FAILED`, `errorSummary` = a safe code | `/fail` | 500, `error` = a safe code | Kept |
| Finalize uncertain or failed | **Unknown** | `RUNNING`, or the final values | `/fail`, best effort; **no success ping** | 500, `finalized: "unknown"`, stage `finalize` + code | Kept |
| Heartbeat not confirmed | Row final | — | Possibly received | `heartbeat.request: "notConfirmed"` | Kept |
| Heartbeat-status update uncertain | **Unknown:** null, or the new value | Final otherwise | The one request already sent stands. Its observed outcome is **preserved** in `heartbeat.request`. **No second, compensating ping** is sent | `heartbeat.resultPersisted: "unknown"`, stage `heartbeatStatus` + code; `ok` unaffected | Kept |

**Correction recorded before G2a coding (owner review):**
- **The heartbeat-result write comes after the heartbeat request.** Its failure, or an uncertain commit:
  - preserves the request's observed outcome;
  - reports persistence as `unknown`;
  - emits only a safe stage-and-code diagnostic;
  - sends **no** second ping;
  - **does not claim that no success ping was sent** (one may have been).
- **The "no success ping" rule applies only to the earlier failures:**
  - `JobRun` creation failure;
  - budget infeasibility;
  - unconfirmed finalization.
- **Every branch is tested for the exact number and order of heartbeat requests.**

---

## 5. Host termination and recovery

`finally` blocks, failure pings and lease releases **are not guaranteed** to run after the host kills the process. Recovery
relies on what had committed, and on expiry.

| Killed… | Persists | The lease | `JobRun` | The next invocation |
|---|---|---|---|---|
| Before S2 | Nothing | — | None | Normal; a missed ping alerts |
| After S2, before the runner | `RUNNING` row | — | Stuck after 30 minutes, **while it is the latest run** (1.2) | Normal |
| Inside a student transaction | Earlier students only. The open transaction rolls back when the server sees the connection close. If the connection lingers idle, the idle timeout (§3.1) ends it. A statement still running ends at `statement_timeout` | Held until L | `RUNNING` → stuck | Skips the segment until L; resumes at the committed cursor. The marker counts the visit |
| Between students, or after the runner | All committed | Held until L | `RUNNING` → stuck | Resumes at the cursor after L |
| After finalize, before the ping | The final row | Released, if the runner finished | Final | Normal; a missed-ping false alarm (the existing design, 48–58) |
| After the ping, before S6 | The final row; `heartbeatStatus` null | — | Final | Normal |

**L > F** is required (§2.2).

**Known limit:** a stuck row stops being visible once a newer run exists. A reaper is **not proposed here.**

---

## 6. The shared wrapper: API and the compatibility change

**The new options are an optional fourth argument:** `runScheduledJob(jobName, request, fn, options?)`. The third argument is
already `fn`.

**`options?: { bookkeeping?: { maxWaitMs; timeoutMs; statementTimeoutMs; lockTimeoutMs; idleInTransactionTimeoutMs } }`:**
- **Absent** (the weekly digest, which passes three arguments): S2, S4 and S6 stay plain queries, and the digest's success,
  partial and failure response bodies are unchanged.
- **Present** (the monthly route only):
  - bounded bookkeeping;
  - the §4 response fields, and the best-effort `/fail` pings on uncertain create or finalize.

### 6.1 Explicit compatibility change: wrapper-generated diagnostics become safe, for every caller, the digest included

Wrapper-generated diagnostics — exceptions the wrapper catches or produces itself — use `safeErrorCode`:

| Location | Today | After |
|---|---|---|
| `run-scheduled-job.ts` 79 → stored `errorSummary` | `threw.message` | `safeErrorCode(threw)` |
| 80 → 500 response `body.error` | `threw.message` | `safeErrorCode(threw)` |
| 111 → `console.error` | The raw error object | `{ jobName, error: safeErrorCode(threw) }` |
| 107 → `console.error` on heartbeat-status failure | The raw error object | `{ jobName, runId, error: safeErrorCode(error) }` |
| `heartbeat.ts` 42 → `console.error` on ping failure | The raw error object | `{ jobName, success, error: safeErrorCode(error) }` |

**This is a compatibility change for the weekly digest:** its thrown-path 500 body, its stored `errorSummary` and its logs
carry a safe code instead of the message. It is listed here so it is not silent.

**Caller-supplied content is not changed by this:**
- the job's own success, partial and failure `body`;
- the `errors` strings a job puts in its `outcome` (stored in `errorSummary` as given);
- anything the job logs itself.

The digest's caller-owned raw messages (§1.3) remain. **No complete digest logging audit is claimed.** They are flagged for
separate work.

### 6.2 Tests

**New, using fabricated secrets in an error's `name`, `code`, `message`, `stack`, `meta` and `cause`:**
- Through a throwing `fn`, assert none of them appears in:
  - the 500 response body;
  - the stored `errorSummary`;
  - **any argument** of any `console.log/info/warn/error/debug` call (all arguments serialized, properties included).
- Through a throwing `fetch`: the same for the heartbeat log.
- Through a failing heartbeat-status update: the same for its log.

**Run twice:** without options (the digest path) and with options.

**Digest behavior preserved** (existing `tests/integration/run-scheduled-job.test.ts` 48–140 and `tests/unit/heartbeat.test.ts`):
- 401 with no row;
- `SUCCEEDED`, `PARTIAL` and `FAILED` mapping;
- a thrown error gives `FAILED`, a 500 and `/fail`;
- the breakdown cap;
- **finalize before ping.**

**The one changed expectation:** the thrown-path `errorSummary` and body `error` now equal the safe code. That is the
explicit change in §6.1.

**New, no-options path:** a spy proves the wrapper opens no `$transaction` and issues no `SET LOCAL` there.

**New, option mode,** one test per early-exit branch of §2.1, each with a real wait or a real failure on the isolated test
database:
- **create blocked** (pool exhausted): `/fail` sent, **no success ping**, the runner not started, 500 with stage `create`;
- **budget infeasible:** `FAILED` finalize, `/fail`, no runner;
- **finalize uncertain** (a lock on the `JobRun` row held past the timeout): `/fail`, **no success ping**,
  `finalized: "unknown"`;
- **heartbeat-status uncertain:** `resultPersisted: "unknown"`, with `ok` and finalization unaffected;
- **each branch's total wall time** stays within its §2.1 reserve.

**New, idle timeout (§3.1):**
- a transaction paused idle past the timeout is terminated, and its locks are released;
- a later transaction on the same pool succeeds.

---

## 7. Implementation boundary

**G2a: repository work before D5** (no route, no registry entry, no cron, no provider configuration, no activation):

| File | Change |
|---|---|
| `src/lib/jobs/run-scheduled-job.ts` | The optional fourth argument (bounded bookkeeping, §4 response fields, best-effort `/fail` on uncertain create or finalize); the §6.1 safe diagnostics for all callers |
| `src/lib/jobs/heartbeat.ts` | Line 42 safe diagnostic only |
| `src/lib/dues/monthly-generation-route-budget.ts` (new) | A pure helper: from F, C, M and G1's limits, it returns `deadlineMs` and the `elapsedMs` origin, or `budgetInfeasible`. No I/O |
| `src/lib/dues/monthly-generation-progress.ts` | `idle_in_transaction_session_timeout` in `bounded`; the limit added to `GenerationLimits`, and the ordering check extended (§3.1) |
| `src/lib/dues/monthly-generation.ts` | The same `SET LOCAL` in the runner's bounded transaction |
| `src/lib/tenant/platform-lookups.ts` | The same `SET LOCAL` in discovery's transaction |
| Tests | `tests/integration/run-scheduled-job.test.ts` (extended); `tests/unit/heartbeat.test.ts` (extended); a new route-budget unit test; extensions to `tests/integration/monthly-generation-progress.test.ts` for the idle timeout and pool recovery |
| Docs | This plan's status, and the G1 evidence README's limits |

**G2b: after D5 approval** (repository):
- the route `src/app/api/cron/monthly-generation/route.ts` with `maxDuration` from the confirmed F;
- the `JOB_NAMES`, `STALE_AFTER_HOURS` and `HEALTHCHECK_ENV` entries;
- the `vercel.json` entry;
- check 10;
- `closurePolicy` set to its Reopen value;
- the runbook.

**Provider and hosted work** (a person, after D5):
- the production `CRON_SECRET`, and a Healthchecks check with an alert-delivery test (E7);
- confirming F, C, cron behavior, connection limits and the pooler's handling of `SET LOCAL` and session termination;
- one measured hosted run;
- E3 and E5.

**Stage 9:** activation, `generationStart`, the first progress row, checks 11–12, O4.

**Genuine unresolved owner decisions:**
- **D5:** the schedule, and the host limits once known.
- **O4,** and stage 9's approvals.

The §6.1 compatibility change is presented for **review approval** as part of G2a. If it is rejected, safe diagnostics apply
in option mode only, and the digest stays as is.
