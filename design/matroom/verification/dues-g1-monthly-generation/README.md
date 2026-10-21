# Monthly generation G1 — evidence

Implements G1 of `docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md` (revision 4) with owner decisions **D1** (job attribution:
`SCHEDULED_JOB`, null actor), **D2** (the `DuesGenerationProgress` table) and **D4** (eligible students of an inactive branch
are unresolved configuration work) approved **for G1 only**. **D3** (month closure) and **D5** (scheduling) remain undecided.

Nothing here has a production caller: no route, no job-registry entry, no `vercel.json` cron, no provider setup, no closure.
O4 stays undecided and readiness `ready` stays false. Every test ran against the isolated test database (postgres_test,
port 5433); no development or production database was written.

## What changed

| File | Change |
|---|---|
| `prisma/schema.prisma`, migration `20261021120000_dues_generation_progress` | The `DuesGenerationProgress` table, its (organization, year, month) unique key, the `(lastVisitedAt, id)` discovery index, the organization foreign key, and six hand-written CHECK constraints. **No `closedAt` column**: closure is D3, still pending |
| `src/lib/dues/ledger/create-monthly-obligation.ts` | D1 only. `createMonthlyObligationInTx` / `writeMonthlyObligationInTx` accept the job's `SystemJobContext`; that context writes `origin: SCHEDULED_JOB` with a null `createdById` and audit `actorId`. A staff `TenantContext` is unchanged (`STAFF`, its actor). The pairing is enforced: `SCHEDULED_JOB` if and only if the context is a system job, else `invalid`. No other writer behaviour changed |
| `src/lib/dues/monthly-generation.ts` (the per-student runner) | Optional in-transaction `fence` / `record` callbacks; `FenceLostError` reported as `fenced` (never `unexpected`); optional statement/lock/transaction timeouts; capped history and candidate reads (`historyTooLarge`, `configurationTooLarge`); the future-month check under the branch lock, before eligibility; D4 `inactiveBranch`; the writer's `futureMonth` refusal mapped to `failure` (it was a configuration gap); error detail reduced to class name and code |
| `src/lib/dues/monthly-generation-progress.ts` (new) | The visit loop: discovery, claim, gate, rollover, per-student protocol, failure record, crash marker, pass end, release. `closurePolicy` is a required input whose only value is `"none"` |
| `src/lib/tenant/platform-lookups.ts` | `listClaimableGenerationSegments`: the one cross-organization read (discovery), next to the other platform-level lookups |
| `src/lib/tenant/scoped-client.ts`, `tenant-guard.ts` | The new model in both tenant-scoped lists |
| `scripts/pending-callers.ts`, structural tests | Registered as built ahead of its caller; no importer; closed defaults pinned |

### A correction to plan revision 4 found while implementing

Revision 4's §1 said the writer the runner calls has no future-month check. That is wrong: the runner calls
`createMonthlyObligationInTx`, which does refuse `futureMonth` (`create-monthly-obligation.ts`, under its own branch lock).
Only the lower core `writeMonthlyObligationInTx` has none. The real defect was different: the runner filed that refusal
under configuration gaps. G1 adds the check in the runner itself, under the branch lock and before eligibility, and maps
the writer's refusal to `failure`. The plan's §1 is corrected in this PR.

### A defect found by the tests

The first version of the `last_pass_complete` CHECK constraint accepted a half-recorded last pass. `NULL >= 0` is NULL,
and a CHECK that evaluates to NULL passes. `monthly-generation-progress-schema.test.ts` caught it, and the constraint now
tests every column `IS NOT NULL` explicitly. The migration was never applied outside the isolated test database.

## Tested guarantees

All in `tests/integration/monthly-generation-progress.test.ts` (30 tests) and `monthly-generation-progress-schema.test.ts`
(10 tests), against the real test database.

| Requirement | Test(s) | What is asserted |
|---|---|---|
| Contiguous, atomically committed cursor and counts for every outcome | "each student's class and the cursor commit together…" | After **every** student commit, the four counts equal the number of students at or before the cursor, for INELIGIBLE, UNPRICED, COVERED (created) and COVERED (already existing); no obligation exists past the cursor |
| Obligation, coverage, audit and progress roll back together on fence loss | "a fenced cursor update that affects zero rows…" | Inside B's transaction, after the obligation, coverage and audit rows are written (asserted), the lease token changes; the cursor update matches 0 rows; **all three ledger rows and the token change are gone**; the outcome is `fenced` |
| Future-month refusal under the branch lock | two tests | A month the branch has not reached → PENDING `futureMonth`, no obligation. With a configuration save holding the branch `FOR UPDATE`, the runner is **proven waiting** on `Academy … FOR SHARE` (pg_stat_activity); the save moves the branch to a timezone where the month has begun; the runner then creates the obligation — the decision used the timezone read under the lock |
| Bounded reads | three tests + structural | History overflow → `historyTooLarge`; configuration overflow → `configurationTooLarge`; a 2 s `pg_sleep` under a 300 ms `statement_timeout` → PENDING; **each advances the cursor**. Structural: every `findMany` in the runner and loop has `take`, except one keyed by ids from a capped read |
| Bounded rollover | two tests | A 6-month gap is filled at most 3 rows per visit (3 + 3), only from the newest row, only up to the **earliest** branch's current month (a UTC+14 branch already in January does not create January). A branch list over the cap skips rollover (reported) and still processes the row |
| Deadline | "the invocation deadline…" | With the budget exhausted, nothing is claimed or written |
| Fair selection across more segments than one invocation can visit | "least recently visited first…" | 5 segments, one student per invocation, discovery limit 2: the first 5 runs visit all 5 in initial least-recently-visited order; **every window of 5 consecutive runs visits all 5**; all 15 students are reached in 15 runs |
| Crash recovery at each documented commit boundary | 10 scenarios + repeated-crash test | After the claim; after the marker; after A commits; inside B's transaction before and after the cursor update; **B's connection killed for real** (`pg_terminate_backend`); after B commits; after B's failure record; before and after the pass end. Each: the committed state satisfies the invariant, B's obligation exists exactly when B's count does, and recovery ends with one obligation for B, none for A and the expected pass counts. Three consecutive crashes at X → the fourth visit records X PENDING `repeatedFailure`, passes it, and the pass is not clean |
| Overlapping runs and lease takeover | two tests | A claim on a row held by another run's student transaction is **proven waiting** (pg_stat_activity), times out and is skipped; the holder commits contiguously and then stops at its lapsed lease without writing. A stale run whose lease was taken over between two students fails its next fence before writing; the claimant continues from the committed cursor; no duplicates |
| Configuration failures stay visible and cannot produce a clean pass | two tests | Missing pricing and an eligible student of an inactive branch (D4) → UNPRICED (`noEffectiveVersion`, `inactiveBranch`), pass not clean, nothing billed for them; after both are fixed, the next pass is clean and bills both |
| "Clean" is an observation, not completeness | "a student inserted behind the cursor…" | A student inserted behind the cursor mid-pass is not seen; the pass still reads clean; the next pass bills the student |
| Production defaults produce no financial writes | three tests + structural | No progress row → nothing claimed, nothing written. A progress row with production defaults → refused `ledgerNotActive`; active ledger but no start month → `beforeStart`; month before S → `beforeStart`; a non-ACTIVE organization → `organizationNotActive`; financial counts unchanged, cursor unchanged, no rollover. Structural: no production importer of the loop; the runner's only importer is the loop; not in `vercel.json` or the job registry; closed defaults present in the source |
| D1 attribution, staff path preserved | two tests + existing suites | The job row is `SCHEDULED_JOB`, `createdById` null, audit `actorId` null; the staff row is `STAFF` with its actor; amount, currency, late fee, due date, grace deadline, versions, type and coverage identical. The write core refuses mismatched origin and context. The existing runner, writer and prepayment suites (92 tests) pass unchanged |
| Schema constraints | 10 tests | Each CHECK constraint, the unique key, the foreign key and the discovery index |

## Assumptions and limits (not proved by these tests)

- **Process death is simulated, apart from one case.** In the other scenarios, a test hook throws where the process would
  die, and the database state left is what had committed. One scenario terminates the student transaction's database
  connection for real. That a dropped connection rolls back its open transaction is a Postgres guarantee, observed here
  once rather than tested exhaustively. No test kills the Node process itself.
- **Progress needs plan revision 4's assumptions A1–A5:** runs keep happening; a run fits at least one unit; the database
  accepts the failure record; the open segments are finite; the organization gate passes. The fairness test proves the
  selection order under a fixed one-student budget. It does not prove the general worst-case bound (§7).
- **Timeouts are real Postgres `statement_timeout`/`lock_timeout` and Prisma transaction timeouts.** Their values are
  engineering defaults. `T` and the lease `L` must be set against the host's real function limit, which a person must
  confirm under D5.
- **A statement timeout or thrown error is reported as reason `unexpected`.** There is no separate `timeout` code. The class
  name and database code travel in the runner's sanitized `detail`, not in the visit report.
- **Writer core reads (`staleVersion` history) are not capped.** They are bounded only by the timeouts. The writer's reads
  were deliberately left unchanged.
- **A pass is not a snapshot.** Data changed behind the cursor is seen only by a later pass. Because nothing closes a month
  in G1, every open month keeps being re-walked, which is Reopen-like *mechanics*. That is not a D3 decision: G2, the only
  production caller, cannot merge until D3 is decided.
- **Discovery orders by `lastVisitedAt` from the database clock.** Leases use the database clock (UTC). The budget uses the
  process clock.
- **The table is empty in production until stage 9** inserts an organization's first row in its activation transaction.
  Nothing in this PR inserts that row.

## Commands run (all against the isolated test database)

- `pnpm typecheck`, `pnpm lint` (0 errors; the 23 warnings are all pre-existing and none is in a changed file),
  `pnpm check:guard-usage`, `pnpm check:pending-callers`;
- `pnpm test:unit`;
- `pnpm test:integration`;
- `pnpm db:check-drift`, with `DATABASE_URL` and `SHADOW_DATABASE_URL` pointed at the test server, never the development
  database: both comparisons clean;
- the migration applied with `pnpm db:test:migrate`.

The results and CI run ids are in the PR description.
