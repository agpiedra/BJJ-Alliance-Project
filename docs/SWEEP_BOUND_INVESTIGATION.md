# Throttle sweep batch-bound investigation

Status: **investigated, then repaired** (§4 and §5; branch `fix/throttle-sweep-bound`). Investigation base: main
`76982f4d6059176f7705b548034dfc38ba3495ad`.

Scope:

- `sweepExpiredResetRequests` (`src/lib/auth/password-reset-throttle.ts:86`);
- `sweepExpiredLoginAttempts` (`src/lib/auth/login-throttle.ts:119`);
- the index assertion in `tests/integration/password-reset.test.ts` ("the sweep's candidate scan can use the createdAt
  index").

## Environment

- **Database:** a disposable `sweep_investigation_test`, created on the test Postgres container (`localhost:5433`),
  migrated with the repo's migrations, holding synthetic rows only, and **dropped afterwards**. No other database was
  touched, and no other connection used this one (checked: 0).
- **Server:** **PostgreSQL 16.15** (x86_64-pc-linux-musl).
- **Planner settings: server defaults throughout** unless a run below is labelled **DIAGNOSTIC** — `enable_seqscan`,
  `enable_nestloop`, `enable_hashjoin`, `enable_mergejoin` and `enable_material` on; `random_page_cost=4`;
  `default_statistics_target=100`; `autovacuum` on.
- **Holding statistics fixed:** to keep a chosen statistics state while a run executes, `autovacuum_enabled` was set to
  false on the two tables of the disposable database only, then reset. That is a table storage parameter, not a planner
  setting.
- **Indexes:**
  - `PasswordResetRequest`: `(createdAt)`, `(keyKind, keyDigest, createdAt)`, `pkey(id)`;
  - `LoginAttempt`: `(createdAt)`, `(accountDigest, createdAt)`, `(ipDigest, createdAt)`,
    `(accountDigest, ipDigest, createdAt)`, `pkey(id)`.

Both sweeps run:

```sql
DELETE FROM <table> WHERE "id" IN (
  SELECT "id" FROM <table>
  WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => 24)
  ORDER BY "createdAt" LIMIT 100
  FOR UPDATE SKIP LOCKED)
```

## 1. Batch-bound violation — demonstrated with the real functions and the default planner

The real functions, unchanged, were called through the app's own Prisma client (a parameterized `$executeRaw`), five
times each. Every case started from 250 expired rows (more than 24h old) plus 5 recent rows.

| Statistics state | Reset sweep returns | Login sweep returns | Recent rows after |
|---|---|---|---|
| never analyzed | `[100,100,50,0,0]` | `[100,100,50,0,0]` | 5 / 5 |
| analyzed while empty | `[100,100,50,0,0]` | `[100,100,50,0,0]` | 5 / 5 |
| analyzed after insert (matching statistics) | `[100,100,50,0,0]` | `[100,100,50,0,0]` | 5 / 5 |
| analyzed with only recent rows (5), expired rows added after | `[100,100,50,0,0]` | `[100,100,50,0,0]` | 5 / 5 |
| **bloated heap: 2000 dead tuples + 1 live row analyzed, then rows added** | **`[150,100,0,0,0]`** | **`[150,100,0,0,0]`** | 5 / 5 |

**The first invocation deleted 150 rows against a bound of 100, for both functions, with default planner settings.**
Recent rows were never deleted.

## 2. Mechanism — demonstrated

### Plans with matching or simple statistics

`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` of the exact DELETE ran inside `BEGIN … ROLLBACK`, because EXPLAIN ANALYZE
executes the deletion; row counts were verified unchanged afterwards. The candidate subquery
(`Limit → LockRows → Index Scan/Sort`) is placed:

- on the **outer** side, de-duplicated by HashAggregate or Sort+Unique;
- or under a **Hash** (Hash Semi Join);
- or as the inner side of a Nested Loop Semi Join under a **Materialize** node.

In all three it executes **once** (`LockRows … loops=1`), and exactly 100 rows are deleted.

### The failing shape

Statistics taken when the heap held almost no live rows over many dead-tuple pages (`reltuples` 0–1, `relpages` 5–167)
make the planner estimate **about 1 outer row**. It then chooses a **Nested Loop Semi Join with the candidate subquery
as the inner side and no Materialize**, since nothing seems worth caching for one row.

The subquery is then **re-executed for every outer row** (`candidateLoops=255` for 255 table rows). Each re-execution
runs `LIMIT 100 FOR UPDATE SKIP LOCKED` again. Rows this same statement has already deleted are skipped as
self-modified, so the LIMIT admits **further** expired rows, which the outer scan then deletes when it reaches them.

### Default-planner search

Seq/hash/merge settings were left at their defaults. The search covered both tables, both physical row orders, and
statistics from 0 to 5000 analyzed recent rows combined with 0 to 20,000 dead tuples:

- **Without bloat:** 72 states, every one with `candidateLoops=1` and exactly 100 deleted.
- **Bloated, 0–1 live rows at ANALYZE:**
  - 255 re-executions;
  - **250 deleted** in one statement when expired rows lie in chronological physical order;
  - **150 deleted** in reverse physical order.

  Both physical orders are **synthetic test conditions**. Production storage order was not verified.
- **Bloated, 2–5 live rows:** Materialize or a hash join returns, and the bound holds.

### Diagnostic confirmation (not the default planner)

With `SET LOCAL enable_hashjoin, enable_mergejoin, enable_material, enable_hashagg, enable_sort = off`, the same
inner, re-executed plan appears on unbloated statistics:

- chronological order: **250 deleted**;
- reverse order: 100.

The violation therefore needs both a re-executed candidate subquery and expired rows that the outer scan reaches
after they become new candidates.

### Recent rows

Recent rows stay protected in every case: a row is deleted only if it is in the candidate set, and the candidate
subquery only returns rows past the retention cutoff.

### Impact

- **Throttle decisions are unaffected.** They count only rows inside 15 minutes (login) or 60 minutes (reset); every
  overshot row is already past 24 hours.
- **The per-request cost cap fails.** Both sweeps are awaited inline on the request path (`password-reset.ts:36`,
  `login-throttle.ts:156`). The 100-row bound exists to limit each request's work and lock time, and in the failing
  shape a single request can delete the whole expired backlog in one statement.

## 3. The index assertion — the test over-specifies a valid planner choice

The test's own statement (`SET LOCAL enable_seqscan = off; EXPLAIN SELECT "id" … ORDER BY "createdAt" LIMIT 100`) was
run under each statistics state. The cost of the alternative was obtained by dropping the chosen index inside a
rolled-back transaction.

| Statistics state | Chosen | Cost | Alternative | Cost |
|---|---|---|---|---|
| never analyzed | `createdAt_idx` | 3.29 | seq/sort | 96.88 |
| analyzed empty, rows added | `createdAt_idx` | 7.30 | seq/sort | 39.01 |
| analyzed recent-only | `createdAt_idx` | 4.16 | composite + Sort | 22.12 |
| **bloated (2000 dead + 1 live)** | `createdAt_idx` | **8.28** | **composite + Sort** | **8.29** |
| realistic (255 rows, ANALYZE after) | `createdAt_idx` | 7.43 | seq/sort | 39.06 |
| realistic large (10,000 rows) | `createdAt_idx` | 6.98 | seq/sort | 871.83 |

- **Bloated statistics produce a near-tie.** There, a small statistics difference makes the composite index plus a
  Sort the cheaper plan, which is exactly what the failing run captured (estimated rows=1, cost 6.04). Both plans are
  **valid and return the same rows**.
- **The query and indexes are correct.** `PasswordResetRequest_createdAt_idx` exists and wins clearly whenever the
  statistics resemble real data.
- **The defect is in the test.** It asserts one specific index while inheriting whatever statistics earlier tests left
  behind.

## 4. Bounded repair (implemented in `fix/throttle-sweep-bound`)

### Sweeps

Evaluate the candidate set **once**, keeping every other element unchanged: same retention cutoff, `ORDER BY
"createdAt"`, `LIMIT 100` and `FOR UPDATE SKIP LOCKED`, and the same try/catch with its fixed log event that returns 0.
The recommended form for both functions is a materialized CTE:

```sql
WITH candidates AS MATERIALIZED (
  SELECT "id" FROM "<table>"
  WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${RETENTION_HOURS}::int)
  ORDER BY "createdAt"
  LIMIT ${SWEEP_BATCH}::int
  FOR UPDATE SKIP LOCKED
)
DELETE FROM "<table>" target USING candidates WHERE target."id" = candidates."id"
```

**Why at most 100.** `MATERIALIZED` makes Postgres evaluate the CTE exactly once into a work table, whatever the join
strategy or planner settings, and the DELETE can only remove ids from that ≤100-row set.

**What it bounds.** The repair bounds the **rows deleted** and the **candidate-set size** per call. It does **not**
bound the statement's total runtime or scan cost: the candidate scan still reads index and heap pages, and a bloated
heap still costs time to scan.

**Deployment check.** `MATERIALIZED` requires PostgreSQL 12 or later. The test container and CI run 16 (16.15 locally,
`postgres:16-alpine` in CI). **Production's version is not verified here and remains a deployment check.**

**Tested as scratch SQL** in the failing bloated state (the current statement deleted 250):

| Condition | Current | A: materialized CTE | B: `= ANY(ARRAY(…))` |
|---|---|---|---|
| Default planner | 250 | **100** | **100** |
| Hostile diagnostic settings | 250 | **100** | **100** |
| Two concurrent sessions (the second ran while the first held its locks uncommitted) | — | **100 + 100, overlap 0** | **100 + 100, overlap 0** |

In the concurrent runs, 50 expired and 5 recent rows remained. SKIP LOCKED is preserved: the second sweep skips the
first one's locked rows instead of waiting. `$executeRaw` still returns the deleted count, because the command tag is
`DELETE n`.

**Equivalent alternative (B).** `DELETE … WHERE "id" = ANY (ARRAY(SELECT … LIMIT n FOR UPDATE SKIP LOCKED))` turns
the subquery into a once-evaluated InitPlan and also held the bound in every test above. A is recommended as the more
explicit statement of intent.

**Unchanged:** the throttle limits, windows, reservation behavior, retention period, batch size, call sites, failure
handling and authentication semantics.

### Index test

Keep the exact-index assertion, which is still meaningful, but make the statistics deterministic. Inside the test:

1. seed representative rows (expired and recent);
2. run `ANALYZE "PasswordResetRequest"`;
3. EXPLAIN.

The `createdAt` index then wins by a wide margin (for example 7.43 vs 39) instead of riding a near-tie inherited from
earlier tests. This is not an unconditional pass: if the index were dropped or unusable, the assertion would still
fail.

### Regression tests

All against the isolated test database. A test can force the failing shape deterministically by building the bloated
statistics:

1. insert many rows, delete them (no vacuum), insert 1 live row, `ANALYZE`;
2. delete that row;
3. insert more than 100 expired rows in chronological order, plus recent rows.

| Test | What it proves |
|---|---|
| **Batch bound, both sweeps** | Each call returns ≤100 and deletes exactly that many (row counts checked). The sequence is `[100,100,50,0]` for 250 expired. **Fails today** (returns 150 or 250). |
| **Recent rows preserved, both sweeps** | All recent rows remain after sweeping to 0. At the cutoff, at storage precision under a controlled transaction clock: the earliest storable instant not before it is kept, the latest before it is deleted (§5). |
| **Concurrent sweeps** | Two sessions; the first holds its transaction open while the second sweeps. Each deletes ≤100, with no overlap, and the second does not block (SKIP LOCKED). |
| **Plan-shape guard** | In the bloated state, `EXPLAIN (ANALYZE)` in a rolled-back transaction shows the candidate scan executed once (`loops=1`). |
| **Index test** | Rewritten with seeded rows and ANALYZE as above, keeping the exact index assertion. |

## 5. Implementation and verification

**Change.** Both sweeps now use the materialized-CTE form above. Unchanged:

- the retention cutoff (`make_interval(hours => …)` against the UTC wall clock);
- `ORDER BY "createdAt"` and the batch constants (`RESET_SWEEP_BATCH`, `LOGIN_SWEEP_BATCH`);
- `FOR UPDATE SKIP LOCKED`;
- the returned count (`$executeRaw`, command tag `DELETE n`);
- the try/catch with its sanitized log event, returning 0;
- the call sites.

Throttle limits, windows, reservations and authentication are untouched.

**Tests.** `tests/integration/throttle-sweep-bound.test.ts` has 8 tests: 4 per function, each calling the **real**
function.

1. **Batch bound on the reproduced bloated-statistics fixture.**
   - Every call returns ≤100 and returns exactly the rows it deleted, checked by counting before and after.
   - The sequence is `[100,100,50,0]`, and all 5 recent rows survive.
2. **Candidate set evaluated once.**
   - The function's exact SQL is captured through a test-only Proxy over `@/lib/prisma`.
   - `EXPLAIN (ANALYZE, FORMAT JSON)` of it runs inside a rolled-back transaction.
   - Only the row-locking (`LockRows`) nodes are asserted, each running a single loop; other plan nodes are not
     constrained.
3. **Retention boundary at storage precision, under a controlled transaction clock.**
   - The real function runs inside one interactive transaction, so `now()` is fixed for both the inserted rows and the
     sweep. Freezing JavaScript `Date` would not freeze PostgreSQL `now()`.
   - `createdAt` is `TIMESTAMP(3)` while `now()` carries microseconds, so the test uses the **earliest storable instant
     not before** the cutoff, which is the cutoff itself when `now()` falls on a whole millisecond. That row is **kept**.
   - The latest storable instant before the cutoff (1 ms earlier) is **deleted**.
   - A row 1 s inside the window and a recent row are kept.
4. **Concurrent sweeps.**
   - The first runs inside an open transaction holding its row locks; the second runs (autocommit) and **completes
     while those locks are held**.
   - Each deleted 100, and exactly 50 of 250 remain, so the batches were disjoint. Recent rows are untouched.

**Index test** (`password-reset.test.ts`). It now has its own representative fixture (300 expired + 300 recent rows,
mixed keys) and runs `ANALYZE` before its EXPLAIN. The exact-index assertion is kept. A comment states that it
verifies the `createdAt` index is **usable under that fixture**, not that production's planner must always choose it.

**Old query vs repair.** Main's two sweep files were put back temporarily, then restored byte-identical (sha256
verified).

| | Old query | Repair |
|---|---|---|
| Batch bound | **fails** — `call 1 returned 250` | passes |
| Evaluated once | **fails** — `LockRows` loops `[255]` | passes |
| Concurrent sweeps | **fails** — the first alone deleted 250 | passes |
| Retention boundary | passes (semantics the repair must keep, not the defect) | passes |

**Confinement.** The fixture's statistics and autovacuum changes touch only the two throttle tables of the isolated
test database, during this one test file. `afterAll` deletes the fixture rows, runs `RESET (autovacuum_enabled)` and
re-`ANALYZE`s both tables; afterwards both have `reloptions = null` and no fixture rows. The index test removes its
rows and re-`ANALYZE`s. No planner setting is changed in these tests apart from the index test's existing
`SET LOCAL enable_seqscan = off`.

**Checks** (isolated test database only): `tsc --noEmit` clean · eslint clean on changed files ·
`check:guard-usage` OK · unit **1846/1846** · integration **2171/2171** (2163 + 8 new). The full integration run had
no failures, which says nothing about the earlier intermittent failures beyond this one run.

## Demonstrated vs unresolved

**Demonstrated**

- The real functions exceed the bound (150 on the first call) under the default planner on bloated statistics.
- The mechanism: a re-executed inner candidate subquery without Materialize, measured by `loops`.
- Recent rows stay protected, and throttle decisions are unaffected.
- The index assertion fails on a near-tie (8.28 vs 8.29) under bloated statistics; both plans are valid.
- Both candidate repairs hold the bound under the default planner, hostile settings and concurrency.

**Unresolved**

- **The local suite failure.** The original 178-row incident remains **consistent with, but not conclusively attributed
  to,** this mechanism: the suite's statistics at that moment were not captured. 178 falls between the 100 and 250
  measured here.
- **The production server.**
  - Its PostgreSQL version: 12 or later is required for `MATERIALIZED`, a **deployment check**.
  - Whether it ever reaches the bloated-statistics state: not verified. Throttle tables plausibly do (frequent deletes,
    few live rows at analyze time), but that is not observed.
  - Its physical storage order: not verified.
- **Generic plans.** Whether Prisma's prepared statements switching to a generic plan after five executions changes the
  odds is not tested. The proposed repair is independent of plan choice.
