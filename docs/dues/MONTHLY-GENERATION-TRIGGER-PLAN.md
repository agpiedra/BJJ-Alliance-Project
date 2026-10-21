# Monthly obligation generation — the trigger (implementation plan)

**Status:** revision 4. Written against main `ca66d3e104050691a6b49198b1c357a28f7d7cfc`. **G1 is implemented** (branch
`feat/dues-g1-monthly-generation-progress`) with **D1, D2 and D4 approved for G1 only**; evidence in
`design/matroom/verification/dues-g1-monthly-generation/README.md`. D3 and D5 remain undecided; nothing is scheduled,
routed, registered or activated, O4 stays undecided and `ready` stays false. §1 below is corrected (see its writer rows).

**What revision 4 changes (corrections to revision 3's progress protocol):**
- **Contiguous committed progress (§6.2).** Every student, writing or not, is processed in its own transaction. That
  transaction commits the student's class count and the cursor move together. Every cursor move is a compare-and-set from the
  previous committed cursor. Revision 3's page-end bookkeeping is removed, along with the defect that let the cursor pass a
  student whose count had not committed.
- **Fencing (§6.3).** The progress row is locked first, with lease verification, inside the student's transaction. A fenced
  update that affects zero rows explicitly rolls back the whole transaction, including its obligation, coverage and audit
  writes. Duplicate prevention is no longer cited as evidence of atomicity.
- **Completion vs closure (§3, §9).** "The last pass observed no outstanding work" is kept distinct from current completeness.
  A multi-run pass is not a snapshot. Irreversible closure needs serialization against concurrent changes, which needs
  additional state and writer changes if D3 = Close.
- **Bound claims (§6.1, §7).** The runs-per-pass formula is corrected: progress is guaranteed per student, not per page. The
  overflow paths now advance the cursor. Month-row creation at rollover is bounded.
- **A correction to §1 (itself corrected during G1):** revision 4 said the writer the runner calls has no future-month check.
  That was wrong: the runner calls `createMonthlyObligationInTx`, which refuses `futureMonth`; only the lower core
  `writeMonthlyObligationInTx` has none. The runner filed that refusal as a configuration gap; G1 checks the month in the
  runner under the branch lock and reports the writer's refusal as a failure.

**Not authorized by this plan or its review:**
- the attribution change (D1), which is a financial-writer signature change;
- any schema change (D2);
- scheduling (D5);
- any financial-policy choice (D3, D4);
- any provider choice.

**Owner decisions are D1–D5 (§12), all pending; everything else is an engineering default, open to review.**

**Unchanged:**
- no organization becomes active, and `inactiveLedgerActivation` stays the only production activation;
- O4 stays undecided and `ready` stays false;
- pricing, eligibility, due dates, coverage and duplicate rules are preserved exactly.

---

## 1. What exists today (traced)

| Piece | Where | Facts that matter here |
|---|---|---|
| Per-student runner | `src/lib/dues/monthly-generation.ts:42-123` | One Prisma interactive transaction per student (default `timeout`/`maxWait`). Lock order: branch `FOR SHARE` (returns the timezone), then student `FOR UPDATE`. Reads status, assignment and candidate history **without limits** under the lock, calls `eligibleAndAssigned`, picks terms and policy with `latestEffective`, then calls `createMonthlyObligationInTx`. Non-writing outcomes are returned from inside the transaction (it commits with no writes). Any thrown error is caught **outside** the transaction and mapped to `failure: unexpected` (`:120-122`). **No caller** |
| Eligibility | `src/lib/dues/eligibility.ts` | Pure. Status: the latest row effective strictly before the 1st. Assignment: the latest effective at or before the month, in the student's branch |
| Write core (`writeMonthlyObligationInTx`) | `src/lib/dues/ledger/create-monthly-obligation.ts:48-164` | Checks activation first (`notActive`, `:74`). An existing `MONTHLY` row is returned unchanged (`:94`); then `coverageTaken`; then terms and policy, `FOR SHARE` (`:103`), re-validated (`staleVersion`, `inapplicable`, `currencyMismatch`). **Every refusal precedes the first write** (`:125`). Writes the obligation, the coverage row and the audit row (`:125-162`). Hardcodes `origin` from its argument, and takes `createdById` and the audit `actorId` from `context.actorUserId`. Its own history reads (`:110-111`) are unbounded. **It has no future-month check** (`:45`: "that decision belongs entirely to the caller") |
| `createMonthlyObligationInTx` | same file, `:181-203` | Takes the branch and student locks itself (re-entrant inside the runner's transaction), refuses `futureMonth` against the branch's current month (`:200`), then calls the write core with `origin: STAFF`. **This is what the runner calls** (`monthly-generation.ts:103`), so the runner does get a future-month refusal; it filed it under `configurationGap` (`:118`). (Corrected during G1: revision 4 said the runner had no future-month check.) |
| Uniqueness | migrations | Partial unique `MONTHLY` per (student, year, month); unique `DuesCoverage` per (student, year, month) |
| Ledger lock order | `src/lib/dues/ledger/common.ts:13-16` | Branch `FOR SHARE`, student `FOR UPDATE`, then terms and policy `FOR SHARE`. Configuration saves hold the branch `FOR UPDATE` |
| Activation seam | `src/lib/dues/ledger/activation.ts:17-23` | `isActive(orgId)`; production `inactiveLedgerActivation` → false. Not authorization. **No start month** |
| System-job context | `src/lib/tenant/context.ts:162-177` | `resolveSystemJobContext`: null unless `Organization.status === "ACTIVE"`; never a nulled `TenantContext` |
| Schema already present | `prisma/schema.prisma` | `DuesObligationOrigin.SCHEDULED_JOB` (unused); nullable `createdById` / `actorId`. `Student.id` is a `cuid()`, so ids are **not** strictly increasing (a new student can sort before an existing one). `JobStatus` = RUNNING/SUCCEEDED/PARTIAL/FAILED. `JobRun` has no field for remaining work, a cursor or the invoker |
| Read-only snapshot | `src/lib/db/read-only-snapshot.ts:14` | REPEATABLE READ, READ ONLY |
| Job wrapper, registry, health | `src/lib/jobs/run-scheduled-job.ts`, `/api/health/jobs` | Bearer `CRON_SECRET`, then the `JobRun` lifecycle, then a Healthchecks ping (`failed === 0` → success). A registered name without runs reads stale. The run id is not passed to the job body |
| Schedule | `vercel.json` | Only the weekly digest. No `maxDuration` anywhere |
| Check 10 | `src/lib/dues/readiness/evaluate.ts:290` | `notImplemented` |
| Stage 9 design | `STAGE-8-READINESS-BRIEF.md` §8 | `ledgerStartsOn = G(S)`. "Exactly S by the first monthly run; never before S." The upper limit on activation time is an **unapproved proposal** |

---

## 2. Evidence levels (each proves only what it says)

| Level | What | Established by | Does not prove |
|---|---|---|---|
| **E1 code exists** | The runner and route merged with tests | Repository | That anything runs |
| **E2 code configuration** | The `vercel.json` entry | Repository | That the host registered or fires it |
| **E3 deployment configuration** | The host shows the cron registered on production; the secret and heartbeat URL are set | A person, from the host | Timely firing |
| **E4 observed execution** | A finalized `JobRun` row from an authenticated request | Application database | **Who** invoked it: the scheduler, or anyone holding `CRON_SECRET`. Nothing records the invoker |
| **E5 scheduler evidence** | The host's invocation log shows scheduled invocations | A person, from host logs | The handler's result |
| **E6 heartbeat acceptance** | `heartbeatStatus = "ok"` (the monitor returned 2xx) | Application database | That an alert would be delivered |
| **E7 alert delivery** | A missed or `/fail` ping produces an alert a person receives | A deliberate test, observed by a person | — |

- "Job verified operating" = E4 + E6 from data, plus E3, E5 and E7 confirmed by a person.
- **Dark-run side effects:**
  - writes its `JobRun` row (create, final update, heartbeat-status update);
  - sends one heartbeat request if a URL is configured;
  - reads the progress table, which is empty in production (§5).
- **A dark run creates no financial rows and no ledger audit rows:** no `DuesObligation`, `DuesCoverage`, `DuesLateFee`,
  `DuesPayment`, `DuesSettlement` or ledger `AuditLog` row.
- **It writes no progress rows:** there are none to claim, and rollover runs only on a claimed row (§5).

---

## 3. Work classes, passes, and what a pass does and does not show

Each (student, month) is classified **once per visit, under the student lock**, by the per-student transaction (§6.2):

| Class | Meaning | Work left? |
|---|---|---|
| **INELIGIBLE** | `UNDECIDABLE`, `NOT_ELIGIBLE` or `NO_ASSIGNMENT` (existing rule) | No |
| **COVERED** | A `MONTHLY` obligation or a `DuesCoverage` row exists for the month (including one created by this visit) | No |
| **ELIGIBLE_UNPRICED** | Eligible, but **configuration prevents creation**: no effective terms or policy, or the writer refused for a configuration reason (`inapplicable`, `currencyMismatch`, `staleVersion`, `notFound`). Also, if D4 = skip, an eligible student of an inactive branch (reason `inactiveBranch`) | **Yes**: an owner must fix configuration |
| **ELIGIBLE_PENDING** | Not shown to be ineligible or covered, and creation did not happen: `conflict`, `timeout`, `unexpected`, `historyTooLarge`, `configurationTooLarge`, `branchNotInMonth` (§6.2), or `repeatedFailure` (§6.4) | **Yes**: the job owes work |

A student whose read overflowed or timed out is counted PENDING, not INELIGIBLE: eligibility was never established, so it
cannot be counted as "no work".

**A pass** is one walk of the cursor over the organization's students in `id` order, from the start to an empty page
(§6.2). A pass may span many runs.

**What a pass records:** for every student, the class observed **at that student's own visit**. When the pass ends, its
counts are kept as `lastPass…`. **`lastPassClean`** is true when that pass recorded `ELIGIBLE_UNPRICED = 0` and
`ELIGIBLE_PENDING = 0`.

**What `lastPassClean` means, and what it does not:**
- **It means:** the last finished pass observed no outstanding work at each student's own visit time.
- **It does not mean the month is complete now.** A multi-run pass is **not** one consistent snapshot. Students are read at
  different times, under different transactions, possibly days apart.
- **Changes during a pass:**

  | Change during a pass | Effect |
  |---|---|
  | A student's status, assignment or pricing changes **after** its visit (behind the cursor) | Not seen by this pass. Seen by the next pass if the month is still processed (§9) |
  | The same change **before** its visit (ahead of the cursor) | Seen by this pass |
  | **A new student** whose `cuid` sorts **after** the cursor | Visited by this pass |
  | **A new student** whose `cuid` sorts **before** the cursor | Not visited by this pass; visited by the next |
  | **A branch move** (`homeAcademyId` changes) | The order is by student `id` alone, across branches, so a move never changes the student's position and never causes a skip or a second visit within a pass. The visit uses the student's branch **at visit time** (its locks, its timezone, its assignments). A move after the visit is seen by the next pass. An obligation already created for the old branch stays (existing rule: generation never voids) |
  | A configuration save on a branch while one of its students is being visited | Serialized by the existing branch lock (the save holds it `FOR UPDATE`) |

- So `lastPassClean` can be true while outstanding work exists that was created behind the cursor. Only a later pass can
  observe it, and only while the month is still processed. Closing a month on `lastPassClean` alone could therefore drop work;
  §9 states what closure needs instead.

**Relation to check 10 and the window:**
- **Check 10** measures trigger health (§11). It **never** reads pass results.
- Pass results live on the progress record (§5). They exist only after activation (there are no rows before stage 9). The job
  reports them (§8).
- **Which months are processed** depends on D3 (§9).

---

## 4. Start month and activation (unchanged seams, no invented state)

- **The writer's gate:** `LedgerActivation.isActive(orgId)`, unchanged. Production stays false.
- **The start month:** `generationStart(orgId): Promise<YearMonth | null>`. Production default: `async () => null`. Checked at
  every visit; a month before S is never processed.
- **Stage 9 must:**
  - implement both from **one** stored activation record;
  - **insert the organization's first progress row for S** inside the effective-activation transaction (§5, discovery).

  Until then the progress table is empty in production, so every run selects nothing.
- **A progress row grants nothing.** A visit still refuses unless all three hold:
  - `Organization.status === "ACTIVE"`;
  - `isActive` is true;
  - the month is ≥ `generationStart`.

  The writer re-checks `isActive` itself.

---

## 5. The recommended design: a persisted progress record (requires D2)

**One new tenant-scoped table, `DuesGenerationProgress`, one row per (organization, month).** It is operational bookkeeping
only, with no amounts and no ledger meaning. Proposed columns:

| Column | Purpose |
|---|---|
| `organizationId`, `year`, `month` | Identity (unique). A foreign key to the organization. Tenant-scoped (added to both scoped-model lists) |
| `cursorStudentId` (nullable) | The last student whose visit **and** count are committed in the current pass. Null = no student committed yet in this pass |
| `passStartedAt` (nullable) | When the current pass's first student committed |
| `leaseToken`, `leaseUntil` (nullable) | The current claimant and its expiry: a fencing token for overlapping runs |
| `lastVisitedAt` (nullable) | Selection order (least recently visited first); set at claim |
| `inFlightStudentId`, `inFlightAttempts` | Crash detection (§6.4) |
| `passIneligible`, `passCovered`, `passUnpriced`, `passPending` | Counts for the current pass's committed prefix |
| `lastPassCompletedAt`, the four `lastPass…` counts, `lastPassClean` | The result of the last **finished** pass (§3) |
| `closedAt` (nullable) | Used only if D3 = Close (§9). **Not added in G1**: D3 is undecided, and G1 implements no closure |

**Indexes:** a partial index on open rows (`closedAt IS NULL`) by (`lastVisitedAt`, `id`).

**Invariant (enforced by the protocol, §6.2):** the four `pass…` counts always equal the classes of exactly the students
with `id ≤ cursorStudentId` visited in this pass. No commit ever moves the cursor without the counts of every student it
moves past.

**Discovery (bounded, one query, no organization scan):**
- The run selects open rows that can be claimed (`leaseUntil` null or past), ordered by `lastVisitedAt NULLS FIRST`, then
  `id`, with `LIMIT k`.
- Rows exist only for organizations stage 9 activated, so discovery never scans every organization.

**Month rollover (bounded):**
- **When it runs:** after a successful claim and the organization gate (§4), when the claimed row is the organization's
  newest.
- **What it inserts:**
  - the missing month rows up to `current_min`: the **earliest** branch-local current month across the organization's
    branches. A month is created only once **every** branch has reached it.
  - at most `R` rows (engineering default 3);
  - in one statement, `INSERT … SELECT … LIMIT R ON CONFLICT DO NOTHING`.
- **Branch read:** the timezones are read with `LIMIT cap + 1`. On overflow, rollover is skipped and reported
  (`configurationTooLarge`); the claimed row is still processed.
- **Catch-up after a long outage:** a gap of `G` months takes `ceil(G / R)` visits to the newest row. New rows have
  `lastVisitedAt = NULL`, so they are selected first.
- **Lag:** a branch that reaches a month earlier than the organization's last branch waits for that branch. The wait is less
  than the largest timezone difference between them (under 27 hours).
- **Discoverability:** the newest row is never closed (§9), so every organization stays discoverable.

**Order within a pass:** students of the organization by `id` (all branches together). Keyset pages: `id > cursor ORDER BY id
LIMIT P`. The page is only a **source of candidate ids**: progress is committed per student (§6.2), never per page.

---

## 6. Bounding the whole invocation

### 6.1 One budget for everything

- The invocation has a deadline `T` (engineering default 45 seconds, below the host's function limit once a person confirms
  it under D5).
- A unit starts only if `now + U_max(unit) < T`.
- The `JobRun` writes and the heartbeat (5-second timeout, existing) sit outside `T`, inside the host limit.

Every database statement runs with `statement_timeout` = `s` and `lock_timeout` ≤ `s` (engineering default `s` = 1 second).
Postgres counts lock waiting inside `statement_timeout`. Each interactive transaction also has Prisma's `maxWait` (`w`) and
`timeout` (`x`) (engineering defaults 2 and 5 seconds), which abort it as a whole.

| Unit | Statements | `U_max` |
|---|---|---|
| Discovery | One indexed query, `LIMIT k` (k = 20) | `s` |
| Claim | One conditional `UPDATE … RETURNING` (§6.3) | `s` |
| Organization gate | Organization status, `isActive`, `generationStart` | `3s` |
| Rollover | One branch read (`LIMIT cap + 1`), one insert (`LIMIT R`) | `2s` |
| Page read | `Student` ids, keyset, `LIMIT P` (P = 100) | `s` |
| Marker | One fenced compare-and-set (§6.4) | `s` |
| Student | The student transaction (§6.2), then, only if it failed, one fenced failure-record statement | `w + x + s` |
| Pass end | One fenced compare-and-set (and, under D3 = Close, the closure check, §9) | `2s` |

- Every read is bounded **before** rows are read, by `LIMIT` and the timeouts; never by a cap applied after reading.
- The runner's own reads inside the student transaction gain `take: cap + 1` (status rows, assignments, plans, terms and
  policy candidates). A runner change, not a writer change:
  - **history overflow** → the student is recorded PENDING with reason `historyTooLarge`, and the cursor advances;
  - **configuration overflow** → PENDING, reason `configurationTooLarge`, and the cursor advances.

  Revision 3's visit-ending `configurationTooLarge` is removed: no overflow can make a visit advance nothing.
- The writer core's own history reads (`:110-111`) are left unchanged (no writer change). They are bounded in time by `s` and
  `x`. A timeout there is recorded PENDING with reason `timeout`.
- **Per-visit slice:** a claimed visit processes at most `V` students (engineering default 50), then the run claims the next
  segment. A segment is claimed only if a claim, the gate, a page read, a marker and one student unit all fit before `T`.

### 6.2 The per-student protocol (contiguous committed progress)

Let `C` be the visit's committed cursor (from the claim's `RETURNING`), and `X` the next student id from the page.

**The student transaction (one Prisma interactive transaction, `SET LOCAL statement_timeout` and `lock_timeout` first):**

1. **Fence and lock the progress row first:**
   `SELECT … FROM "DuesGenerationProgress" WHERE id = :seg AND "leaseToken" = :mine AND "leaseUntil" > now() AND
   "cursorStudentId" IS NOT DISTINCT FROM :C FOR UPDATE`.
   Zero rows → throw `FenceLost`, and the transaction rolls back (nothing was written yet).
2. **The existing runner's work, in the existing order:**
   1. branch `FOR SHARE`. This returns the timezone;
   2. **new:** if the month is later than the branch's current month → class PENDING, reason `branchNotInMonth`, and skip to
      step 4. This replaces the check the writer core does not have (§1). With rollover's `current_min` rule (§5) it
      normally never fires; it guards a branch timezone change;
   3. student `FOR UPDATE`;
   4. the capped reads, then eligibility, then the candidates;
   5. `createMonthlyObligationInTx`: terms and policy `FOR SHARE`, then the obligation, coverage and audit writes.
3. **Map the outcome to its class (§3).** This covers every outcome, including the non-writing ones the runner already returns
   from inside the transaction: INELIGIBLE, COVERED, UNPRICED, and PENDING `conflict`.
4. **Advance the cursor:**
   `UPDATE … SET "cursorStudentId" = :X, "pass<Class>" = "pass<Class>" + 1, "passStartedAt" = COALESCE("passStartedAt",
   now()) WHERE id = :seg AND "leaseToken" = :mine AND "cursorStudentId" IS NOT DISTINCT FROM :C`.
   **If the row count is not exactly 1 → throw `FenceLost`.** The whole transaction rolls back explicitly: the cursor, the count
   **and** the obligation, coverage and audit rows of step 2.5.
5. **Commit.** The student's class, the count and the cursor move commit or roll back as one.

**If the transaction throws** (`timeout`, `unexpected`, a deadlock, or a Prisma `x` abort), it has rolled back entirely. Then:
- `FenceLost` → stop the segment and record nothing. Whoever holds the lease revisits `X`.
- **Any other error** → one fenced failure-record statement:
  `UPDATE … SET "cursorStudentId" = :X, "passPending" = "passPending" + 1 WHERE id = :seg AND "leaseToken" = :mine AND
  "cursorStudentId" IS NOT DISTINCT FROM :C`.
  - Row count 1: `X` is recorded PENDING, and the cursor moves contiguously.
  - Row count 0: stop the segment.
  - If this statement itself fails: end the visit. The next visit retries `X` (§6.4).

**Pass end:** a page read after the cursor returns no rows. One fenced compare-and-set (`cursor = :C`) does all of this:
- copies the counts to `lastPass…`;
- sets `lastPassClean` and `lastPassCompletedAt`;
- resets the cursor, the counts and `passStartedAt`;
- under D3 = Close only, evaluates closure (§9).

A repeat after a crash is harmless: the compare-and-set on the cursor makes it apply once.

**Why this is contiguous:**
- Every cursor move (step 4, failure record, pass end) is a compare-and-set from `C`, the previous committed value.
- Each move covers exactly one student, and carries that student's count in the same statement or transaction.
- There is no batched or page-level cursor move, so no commit can move past a student whose count has not committed.

**The mixed-page case** (`A` unpriced, `B` created, then a crash):

| Crash point | Committed state | Next visit |
|---|---|---|
| Before `A`'s transaction commits | Nothing for `A` or `B` | Starts at `A` |
| After `A` commits, before `B`'s transaction starts | Cursor = `A`; `passUnpriced` includes `A` | Starts at `B` |
| Inside `B`'s transaction | `A` as above; `B`'s obligation, coverage, audit, count and cursor all rolled back | Starts at `B` |
| After `B` commits | Cursor = `B`; `A` and `B` both counted; `B`'s obligation present | Starts after `B` |

At no point is the cursor at `B` without `A`'s count: `B`'s step 4 requires the cursor to equal `A`.

**Engineering cost:** one transaction per student, including non-writing ones, each taking the branch and student locks briefly.
That is the price of exact per-student atomicity. Batching runs of non-writing students into one compare-and-set is a possible
later optimization, not part of this plan.

### 6.3 Fencing, lease verification and lock ordering

**Every write to a progress row** is one of five statements:
- the claim;
- the marker (§6.4);
- step 4 of the student transaction;
- the failure record;
- the pass end.

**Each except the claim** has the predicate `WHERE "leaseToken" = :mine AND "cursorStudentId" IS NOT DISTINCT FROM :C` and
treats a row count other than 1 as fence loss. Rollover inserts only absent rows of other months (`ON CONFLICT DO NOTHING`),
never modifies an existing row, and is idempotent.

**The claim:**
`UPDATE … SET "leaseToken" = :new, "leaseUntil" = now() + L, "lastVisitedAt" = now() WHERE id = :seg AND "closedAt" IS NULL
AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) RETURNING "cursorStudentId", "inFlightStudentId", "inFlightAttempts"`.
- It runs under `lock_timeout`. If the row is locked by a student transaction, the claim times out and the run skips the row.
- Under READ COMMITTED, Postgres re-evaluates the `WHERE` against the committed row after waiting, so a claim never takes over
  a row whose lease was just extended.
- `:new` is a random UUID per claim.

**Lock order for the generator, a prefix to the ledger's existing order (`common.ts:13-16`):**

0. the progress row, `FOR UPDATE`, fenced (step 1);
1. the branch, `FOR SHARE`;
2. the student, `FOR UPDATE`;
3. terms, then policy, `FOR SHARE`.

**Why this cannot deadlock:**
- Every other transaction that locks a progress row is a single-row progress statement holding no ledger lock: the claim,
  the marker, the failure record, the pass end and rollover.
- No ledger writer or configuration save locks progress rows.
- So no transaction holds a ledger lock while waiting for a progress row.
- The closure check under D3 = Close adds one more lock; its order is given in §9.

**Lease verification is consistent:**
- **Before any write,** step 1 verifies the token, the expiry and the expected cursor, under a row lock held to commit. While a
  student transaction runs, no other run can claim the row: its claim waits on the lock, then re-checks the `WHERE`.
- **After the writes,** step 4 re-verifies the token and the cursor. A count other than 1 rolls everything back explicitly.
  With step 1's lock held this should be unreachable; it is asserted, not assumed, and a test forces it (§14).
- **The lease `L`** (engineering default: twice the host's maximum function duration, confirmed under D5) bounds how long a
  crashed run's segment stays unclaimable.

**What duplicate prevention does and does not prove:** the partial unique `MONTHLY` index and unique `DuesCoverage` remain an
independent defense against a second obligation for the same student and month. They say **nothing** about whether the cursor
and counts match what was written. That atomicity comes only from steps 1–5 committing as one transaction.

**Overlapping runs:**
- The conditional claim gives different segments to different runs.
- A stale run whose lease was taken over fails at step 1 of its next student (nothing written) and stops.
- A stale run already inside a student transaction holds the row lock. The new claimant's claim waits (and times out) until
  that transaction commits, with its cursor move, so the two runs never interleave on one row.

### 6.4 Crashes

A per-visit marker detects a student that kills the process:
- **When:** after the gate, before the visit's **first** student `X`. A crash at any later student leaves the cursor just
  before it, so the next visit's first student is the crasher.
- **What:** one fenced compare-and-set:
  `SET "inFlightStudentId" = :X, "inFlightAttempts" = CASE WHEN "inFlightStudentId" = :X THEN "inFlightAttempts" + 1 ELSE 1 END`.
- **When it clears:** a marker below or at the cursor is stale; it is cleared by the next marker write.
- **Skip rule:** if this would be the 4th consecutive visit starting at `X` without passing it, the visit instead records `X`
  as PENDING `repeatedFailure`, through the failure-record compare-and-set, which also clears the marker.

**Crash table, by commit boundary:**

| # | Crash point | Committed state | Next visit |
|---|---|---|---|
| 1 | Before the claim commits | Nothing | Normal |
| 2 | After the claim, before the marker | The lease, and `lastVisitedAt` | The segment waits ≤ `L`, then resumes at the cursor. No attempt counted |
| 3 | After the marker, inside `X`'s transaction | The marker (`X`, n). `X`'s obligation, coverage, audit, count and cursor all rolled back by the database when the connection drops | Starts at `X`; attempts n + 1; after 3, `X` is skipped as PENDING |
| 4 | After `X`'s transaction commits | `X` complete and counted; cursor = `X` | Starts after `X`; the marker is stale |
| 5 | After `X`'s transaction failed, before the failure record commits | Cursor before `X`; nothing for `X` | Retries `X` (counted by the marker only if `X` is that visit's first student, which it then is) |
| 6 | After the failure record commits | `X` PENDING; cursor = `X` | Starts after `X` |
| 7 | Mid-visit, at a later student `Y` | Every student before `Y` complete and counted | Starts at `Y`; the marker becomes `Y` |
| 8 | Before the pass-end statement commits | Cursor at the last student | The page is empty; pass end applies once |
| 9 | After the pass end | New pass, cursor null | Normal |
| 10 | During the rollover insert | One statement: all of it or none | Repeated idempotently |

- **A non-crash failure** (for example a timeout every time) is recorded PENDING and passed. It is retried in the next pass,
  never billed while it keeps failing, and stays visible (§8).
- **Database unavailable** for the marker or the failure record: the visit ends. Three such visits in a row at the same `X`
  count as attempts, and skip `X` as PENDING. It stays pending, so the pass is not clean.

---

## 7. Progress and fairness: what is guaranteed, under which assumptions

**Claims withdrawn:**
- Revision 2: the per-run shuffle with "every candidate eventually, with probability 1"; round-robin within one run; seeded
  tests as evidence of completion.
- Revision 3: "runs per pass ≤ N × ceil(students / (P × pages_per_slice))". A page read does not guarantee that a page's
  students finish before `T`. Revision 3's `configurationTooLarge` could also end a visit with no progress.

**Assumptions:**
- **A1.** Runs keep happening.
- **A2.** Each run fits discovery, a claim, the gate, a page read, a marker and one student unit before `T`.
- **A3.** When a student transaction fails, the database accepts the failure-record statement. If not, the visit ends without
  progress; it counts toward §6.4's attempts.
- **A4.** At most `N_max` segments are open during the period considered. Rollover adds segments, so `N_max` includes them.
- **A5.** The organization gate passes. A refused gate (inactive, or before S) makes no progress, by design.

**Per-visit progress (the corrected unit):** a claimed visit that passes the gate either:
- advances the cursor by **at least one student**, through step 4 or the failure record; or
- increments that student's attempt count (a crash, or A3 failing).

After 3 attempts the next visit advances. Progress is per **student**. A page is never a unit of progress.

**Selection:**
- Least recently visited first, with `lastVisitedAt` set at claim. With at least one claim per run, every open, unleased
  segment is claimed within `N_max` runs.
- A segment whose lease is held by a dead run waits at most `L` beyond that.

**Worst-case bound for one pass of a segment with `M` students visited in that pass** (`M` includes students inserted ahead of
the cursor during the pass):

    runs ≤ N_max × (M + 1 + 3·K) + D × ceil(L / I)

- `+1`: the pass-end step;
- `K`: students that crash the process (each costs up to 3 extra visits);
- `D`: visits that died holding a lease;
- `I`: the interval between runs.

Every term counts claims at one claim per run, the worst case.

**What the bound does and does not say:**
- It is linear in `M` because only **one student per visit** is guaranteed. The typical rate is up to `V` per visit, giving
  about `N × ceil(M / V)` runs, but that is **not guaranteed**: lock waits or timeouts can reduce a visit to one student.
- **Many organizations, few slots:** the bound grows with `N_max`; no segment starves.
- **Time exhaustion mid-visit:** the cursor holds every committed student, so a stop costs at most the uncommitted student.
- **It guarantees each student is examined,** not billed. A student that fails every time is recorded PENDING each pass.
- **Under D3 = Reopen,** `N_max` grows by one every month, so the bound grows without limit (§9).
- **If A1 or A2 fails, nothing progresses.** That is a health signal (E4–E7), not a fairness property.
- **Rollover catch-up** after a gap of `G` months needs `ceil(G / R)` visits to the organization's newest row. Each visit
  inserts at most `R` rows.

**The no-schema alternative, compared:**

| Concern | Persisted progress (recommended) | No schema |
|---|---|---|
| Progress after a budget or time stop | Survives, per student, with its counts (§6.2) | Lost; the next run starts over (only created obligations persist) |
| Fairness across runs | Least recently visited, with the bound above | No bound. A shuffle gives no guarantee when the candidate set changes or runs overlap |
| Knowing what a pass observed | Recorded per pass | Needs a whole pass inside one invocation, which may not fit: may be **unknowable** |
| A process-crashing student | Skipped after 3 attempts, kept pending | Retried forever; only the stuck-run alarm shows it |
| Overlapping runs | Different segments (lease); a stale writer is fenced and rolled back | Duplicate work; correct only through the unique indexes |
| Missing pricing visible later | On the month's row | Not recorded anywhere persistent |
| Schema | One table (D2) | None |

**Recommendation: the persisted design.** Without D2 the plan cannot meet these requirements. G1 should wait rather than ship
the no-schema variant with weaker claims.

---

## 8. Observability of incomplete work

**Persisted on the progress rows:**
- the current pass's cursor and counts;
- the last finished pass's counts, `lastPassClean` and time;
- the marker;
- closure.

`JobRun` is unchanged.

**Reported per run as `failed`** (so `PARTIAL` and a heartbeat `/fail`; organization and month ids and counts only):
- a pass that finished with `ELIGIBLE_UNPRICED > 0` (configuration to fix);
- a pass that finished with `ELIGIBLE_PENDING > 0` (failed, timed-out, overflowing or skipped students);
- **an overdue month:** a processed month earlier than `current_min` whose last finished pass is not clean, or which has no
  finished pass. This is detected from persisted state, not from run sequences.
  - It is phrased as "the last pass observed outstanding work", never "the month is incomplete now".
  - A clean last pass is reported as "last pass observed none", never as "complete" (§3).
- a skipped rollover (`configurationTooLarge`), and an unexpected error outside a student transaction.

**Not a failure:** a run that stops at `T` with work remaining. It is distinguishable from a finished run:
- **in the run's own body:** `remainingSegments` and the cursors left;
- **on the progress rows:** a non-null cursor means a pass is in progress.

**Outcome mapping:**
- `sent` = created;
- `skipped` = INELIGIBLE + COVERED;
- `failed` = the items above.

Sanitized as in §10.

---

## 9. Which months are processed, and month closure (D3)

**Open months:** a month is processed while its progress row is open. A row exists from S (inserted by stage 9) and for every
later month up to `current_min` (inserted at rollover, §5).

**Two coherent policies after S's work is done.** Neither is recommended over the other: this is financial policy, the owner's
choice.

**D3 = Reopen (no closure):**
- No month ever closes. Every month since S is re-walked forever, so any change is eventually observed by a later pass.
- A retroactive change is billed automatically at the month's next pass.
- **Needs no serialization:** nothing irreversible happens.
- `N` grows by one every month, so the time between passes of any month grows without limit (§7).

**D3 = Close (irreversible, bounded):**
- A closed month is never processed automatically again.
- A later change affecting it can only be billed through a reviewed manual path (not built; its own plan).
- **Closing on `lastPassClean` alone is unsafe.** A multi-run pass is not a snapshot (§3): a change behind the cursor during
  the pass, or between pass end and the close, would be silently dropped forever.

**What Close needs, so that a concurrent relevant change is detected or serialized:**

- **Additional state:** a per-organization **generation-input version**, a counter (for example a column, or a one-row-per-
  organization table). Part of D2's scope if D3 = Close.
- **Writer changes:** every write that can change a month's generation outcome increments the counter **in its own
  transaction**, taking the counter row `FOR UPDATE`. G1-close must inventory these writers by search, and add a structural
  test that every writer of these models increments it. The inputs are:
  - `Student` creation, `homeAcademyId` and status-relevant changes;
  - `StudentStatusChange`;
  - `StudentPlanAssignment` (create and correct);
  - `PaymentPlan`, `PaymentPlanTerms`, `DuesPolicyVersion`;
  - `Academy.active` and the branch timezone;
  - any removal or void of a `DuesObligation` or `DuesCoverage`.

  The generator's own creations do not increment it: they only turn PENDING into COVERED.
- **The protocol:**
  1. The first committed student of a pass records `passStartVersion`, read in that student's transaction.
  2. A pass may close the month only if all of these hold:
     - it is clean;
     - it started after the month was ≤ `current_min − 2`;
     - in the pass-end transaction, which takes the counter row `FOR SHARE` after the progress row, the counter still equals
       `passStartVersion`.
  3. Any relevant change during the pass therefore blocks closure, and a fresh pass is needed.
  4. A writer's increment and the close are serialized by the counter row lock.
     - A change that commits first makes the version differ, so there is no close.
     - A change that commits after the close happened, in serialization order, after the month closed. It is exactly the case
       the manual path covers.
- **Lock order:** the progress row, then the counter row (closure). Writers take the ledger locks, then the counter row. No
  transaction holds the counter row while waiting for a progress row or a ledger lock, so this cannot deadlock.
- **Granularity consequence:** the counter is per organization. In a busy organization almost every pass sees some change, so
  closure may be delayed, possibly indefinitely. Finer granularity (per affected month) is possible, but needs more logic in
  every writer.
- **The alternative dependency:** if stage 9's activation-gate design ends up making every relevant writer take one
  organization-level lock, closure could take that lock exclusively instead of a counter. That is a **dependency on a stage 9
  design not yet planned**, and is **not assumed** here.
- **Even with serialization,** a change after closure is **not detected automatically**. Flagging it would need writers to
  check `closedAt` (more scope). Without that, the manual path depends on a person noticing.

**Trace.** S = 2027-02, effective activation 2027-02-03, scheduler down until the first successful run, all pricing present.

| Event | D3 = Close | D3 = Reopen |
|---|---|---|
| First successful run **Apr 5** (S+2) | Rows Feb, Mar, Apr (rollover, ≤ R per visit). Feb billed. Feb may close after a clean pass that started on or after Apr 1 with no relevant change during it | Same billing. Nothing closes |
| First successful run **Jul 5** (S+5) | Rows up to Jul over `ceil(5/R)` rollover visits. Feb–Jul billed within the §7 bound. Feb–May close only after clean, unchanged passes | Same billing. Nothing closes |
| Feb has 3 eligible students with no Feb pricing | Feb stays open (its last pass is not clean); overdue alerts every run; billed after pricing is added | Same |
| An owner enters, **during** Feb's closing pass, an assignment effective Feb for a student already visited | The counter changes, so no close. The next pass bills the student | Next pass bills it |
| **Jun 20, after Feb closed:** an assignment effective Feb for a student with none | **Not billed.** Needs the reviewed manual path, and nothing flags it automatically | **Billed** at Feb's next pass, with Feb's original `dueOn` (whether a late fee then applies is the late-fee plan's question) |
| **Jun 20:** a status correction makes a student retroactively INACTIVE for Mar (Mar's obligation exists) | No automatic change, in both: generation never voids or edits obligations (existing rule) | Same |

**Reconciliation with revision 2's W2:** superseded. Under either policy, S and every month whose last pass was not clean stay
processed. The goal "S by the first monthly run" (brief §8) holds after any delay. The unapproved stage 9 activation deadline is
not relied upon.

---

## 10. Authentication, attribution, logging

**Authentication:**
- The route `GET /api/cron/monthly-generation` goes through `runScheduledJob`, unchanged: bearer `CRON_SECRET`, and a 401 before
  any write.
- No session, owner trigger or server action.
- **No request inputs:** no organization, month, budget or activation flag comes from the request.
- Holding the secret can start a run, and cannot widen what a run does.

**Attribution (D1, not authorized):**
- **Proposed:** `origin: SCHEDULED_JOB` with a null `createdById` and audit `actorId`, matching the late-fee runner and the
  `AuditLog` convention. It needs a narrow writer change to how origin and actor are passed.
- **Alternatives:** a designated real user (contrary to `resolveSystemJobContext`'s rule), or deferring.
- G1 cannot be completed until D1 is decided.

**Sanitized logging:**
- `errorSummary` and logs carry only: ids, class, reason code, and for unexpected errors the error class name and Prisma
  code.
- Never `error.message`, names, emails, amounts or plan names.
- The runner's `failure.detail` (today `error.message`, `:121`) is reduced to `{ name, code }`.
- A sentinel-message test pins this.

---

## 11. Readiness check 10: trigger health only

**Computed (G2) from in-app evidence:** pass only if all of these hold:
- **E2:** the `vercel.json` entry exists;
- **E4:** the latest `JobRun` is finalized `SUCCEEDED`, not stale and not stuck;
- **E6:** its `heartbeatStatus` is `"ok"`.

Otherwise it fails with a reason.

**Limits, in its detail text:**
1. **Not billing completeness.** A `SUCCEEDED` run may have stopped at `T` with passes in progress. Pass results (§3) live on
   the progress rows, and check 10 never reads them.
2. **Not scheduler proof** (E4 does not identify the invoker; E3 and E5 are a person's checks).
3. **Not alert delivery** (E7 is a person's test).
4. **Before activation it proves only that the trigger runs:** the progress table is empty, so zero segments are processed.
   Pricing and assignments for S belong to checks 2–9.

On main and in every test database, check 10 is `notImplemented` (before G2) or `fail` ("never ran"). `ready` stays false
(checks 11–12 `notImplemented`, 13 `decisionPending`).

---

## 12. Owner decisions

**Approved for G1 only:** D1 (`SCHEDULED_JOB`, null actor; staff behaviour preserved), D2 (`DuesGenerationProgress`), D4
(skip as unresolved configuration work). **Pending:** D3, D5. The table below is the original proposal.

| # | Decision | Recommendation | Without it |
|---|---|---|---|
| **D1** | Attribution of job-created obligations: `SCHEDULED_JOB` + null actor (a narrow writer signature change), or a designated user | `SCHEDULED_JOB` + null | G1 waits |
| **D2** | Schema: the `DuesGenerationProgress` table (§5), one migration, tenant-scoped, no ledger meaning. **If D3 = Close,** also the generation-input version counter (§9) | Approve the table | G1 waits; the no-schema variant is not recommended (§7) |
| **D3** | Month closure: **Close** (irreversible; needs the counter, increments in every relevant writer, and a reviewed manual path not yet built; may rarely close in busy organizations) or **Reopen** (automatic retroactive billing; unbounded cost growth) | **Owner's choice:** financial policy, consequences in §9 | **No default.** G1 takes the policy as a required runner input with no production value. G2 (the only production caller) cannot merge until D3 is decided, and, if Close, until G1-close is merged |
| **D4** | Eligible students of an inactive branch (`Academy.active = false`): bill them normally, or skip them as `ELIGIBLE_UNPRICED` (reason `inactiveBranch`), which keeps the pass not clean and alerting until the owner moves or deactivates them | Skip as unpriced | G1 waits |
| **D5** | Scheduling: approval to add the `vercel.json` entry and the deployment steps (E3, E5, E7), with the host's function-time and cron-frequency limits confirmed by a person (they set `T` and `L`) | Daily, after the G1/G2 review | G2 is not merged |

**Engineering defaults, not owner decisions (reviewable in the PR):**
- the limits: `s`, `w`, `x`, `T`, `L`, `P`, `V`, `k`, `R`, the caps and the attempt limit;
- the one-transaction-per-student protocol (§6.2);
- the lock order (§6.3);
- the alert rules (§8);
- check 10's computation (§11);
- sanitization (§10).

**Unchanged and not decided here:**
- the dates of an obligation created late (the writer's existing rule). Whether a fee applies at once belongs to the
  late-fee job's plan;
- eligibility, pricing, package and prepayment coverage, the resume and enrollment charges, D7, D24, D25, O2, O4.

**Mapping from revision 2:**

| Revision 2 | Revision 4 |
|---|---|
| P6 | D1 |
| P10-B / P11 | D2 |
| P1 / P7 | D3 |
| P4 | D4 |
| P5 | D5 |
| P2, P8, P9, P12 | Engineering defaults (P12's attestation is dropped: E3, E5 and E7 stay a person's checklist) |
| P3 | Deferred to the late-fee plan |

---

## 13. Build sequence

| Step | Content | Needs |
|---|---|---|
| **G1** | The migration for `DuesGenerationProgress`. The runner changes: optional in-transaction progress hooks (steps 1 and 4), a distinct `FenceLost` outcome that is not swallowed as `unexpected`, the `branchNotInMonth` check, capped reads, timeouts, sanitized detail. The visit loop (§5–§8), with closure as a required input and only the Reopen mechanics. No caller; structural tests extended | D1, D2, D4 |
| **G1-close** | Only if D3 = Close: the input-version counter, its increment in every relevant writer (with the inventory and the structural test), and the closure check at pass end | D2 (extended), D3 = Close |
| **G2** | The route (production defaults only); the job registry, heartbeat and stale entries; the `vercel.json` entry; check 10; a runbook. They ship together | G1; D3 (and G1-close if Close); D5 |
| **Deployment (a person)** | E3, E5, E7 | D5; host access |
| **Stage 9** | The activation record behind `isActive` and `generationStart`; the first progress row for S, inserted in the activation transaction; gate lock, legacy refusal, opening obligations | Stage 9 approvals |

A merged and scheduled G2 before stage 9 finds an empty progress table and creates no financial rows and no progress rows. It
can still produce E4 and E6, with E3, E5 and E7 checked by a person.

---

## 14. Tests

**G1 (isolated test database; clock, activation, start month and progress rows set only in tests):**

1. **Production defaults:** an ACTIVE organization with eligible, priced students and no progress row. The run claims nothing,
   and nothing changes: financial and ledger-audit counts, and the progress table.
2. **A progress row exists, but the stubs are closed** (`isActive` false, or `generationStart` null): zero financial rows, and
   the cursor is unchanged. The visit is reported as refused.
3. **Before S, and the timezone edge:**
   - at branch-local 2027-01-31 23:59 with S = 2027-02, nothing happens;
   - with two branches across one UTC instant, the February row is created only once both reach February
     (`current_min`);
   - `branchNotInMonth` is forced by a test-only timezone change and recorded PENDING.
4. **Rollover:** never before S; at most `R` rows per visit; a 5-month gap is caught up in `ceil(5 / R)` visits; a
   branch-list overflow skips rollover and still processes the claimed row.
5. **Bounded invocation:** a fake clock advances per unit. Assert that:
   - no unit starts after `T − U_max`;
   - every query has a `LIMIT` and a statement timeout (query spy);
   - every interactive transaction has `maxWait` and `timeout`;
   - a history overflow and a configuration overflow each record PENDING **and advance the cursor**;
   - a forced statement timeout in the writer records PENDING `timeout` and advances.
6. **Contiguity, the mixed page:** `A` unpriced, `B` priced. Use deterministic fault injection (a test hook that throws or
   kills a child process at a named boundary) at every boundary of §6.2 and §6.4: before and after the marker, inside `B`'s
   transaction before step 4, after step 4 before commit, after commit, after a failure before the failure record, and after
   the failure record. After each injected crash and a resumed visit, assert:
   - the counts equal the classes of exactly the students at or before the cursor;
   - no student is counted twice;
   - `B`'s obligation exists if and only if `B`'s count and the cursor do.
7. **Explicit fence rollback:** a test hook replaces the lease token between step 2 and step 4 inside the transaction. Step 4
   affects 0 rows. Assert that the transaction rolled back the obligation, the coverage **and** the audit row, and that the
   outcome is `FenceLost`, not `unexpected`.
8. **Fence at step 1:** a stale run whose lease was taken over writes nothing and stops. Its claimant continues from the
   committed cursor.
9. **Overlap:** two runs, with the overlap proven by `pg_stat_activity`:
   - they claim different segments;
   - a claim of a row held by a student transaction times out and skips;
   - no interleaved cursor moves.
10. **Crash skip:** three injected process kills at `X`, then the 4th visit records `X` PENDING `repeatedFailure`, advances,
    and the pass is not clean.
11. **Changes during a pass:**
    - a new student whose id sorts before the cursor is not visited this pass, and is visited the next;
    - one sorting after the cursor is visited this pass;
    - a branch move of an already-visited student and of a not-yet-visited student each give one visit per pass, using the
      branch at visit time;
    - a behind-the-cursor assignment change leaves `lastPassClean` true, and the next pass bills it (Reopen mechanics).
12. **Pass results:** a clean pass sets `lastPassClean`; a single unpriced student keeps it false; repeating the pass end after
    an injected crash applies it once.
13. **Scenarios** (each reaches every eligible priced student within the §7 bound computed for the fixture):
    - the first 500 students ineligible;
    - the first 500 unpriced (also overdue and not clean);
    - the first 500 failing in the write step (a `currencyMismatch` fixture);
    - more open segments than one run can claim;
    - `T` exhausted mid-visit.
14. **Idempotent rerun:** existing obligations are byte-for-byte unchanged.
15. **Rules preserved:** amount, currency, dates and versions equal the existing writer's; package or prepaid → COVERED.
16. **Sanitized errors** (the sentinel test); **attribution** as D1 decides.
17. **Structural:**
    - only tests make `isActive` true, return a start month, or insert progress rows;
    - G1 has no production importer;
    - the new table is in both scoped-model lists and the tenant-guard test;
    - the closure input has no production value.

**G1-close (only if D3 = Close):**

18. **The writer inventory:** a structural test that every writer of the §9 input models increments the counter.
19. **The closure race:**
    - a relevant write during the pass blocks closure;
    - a write racing the pass-end transaction either commits first (no close) or waits and commits after the close (the
      month stays closed). Proven with two connections and `pg_stat_activity`;
    - no deadlock under concurrent writers.
20. **The §9 trace rows** for Close.

**G2:**

21. A bad bearer → 401 and no `JobRun`.
22. **Dark run:**
    - `SUCCEEDED` and `organizationsProcessed = 0`;
    - exactly one `JobRun` row;
    - heartbeat `not_configured` locally;
    - zero financial rows;
    - no progress-row writes.
23. **Check 10:** fails for never ran, `PARTIAL`, `FAILED`, `RUNNING`, stale, stuck, and a heartbeat not `ok`. It passes only with
    a finalized `SUCCEEDED` run and heartbeat `ok`. The detail text carries the §11 limits; `ready` is false throughout.
24. `/api/health/jobs` includes the job, and the schedule wording covers daily.

**Checks for each PR:** typecheck, lint, guard-usage, pending-callers, unit, integration (isolated test database), and the
migration's schema test (G1, and G1-close if any). **No production run.**

---

## 15. Out of scope

- scheduling, deployment, and host or monitor configuration;
- any activation state;
- the reviewed manual path for closed months, and the automatic flagging of changes to closed months;
- batching non-writing students;
- the late-fee job's trigger;
- opening obligations;
- O2 and O4.

**Pending, preserved:** the three Stage 8 status corrections (brief §14, the 8D plan status, the 8D2 plan status) remain in
the working tree, uncommitted, for the next appropriate PR.
