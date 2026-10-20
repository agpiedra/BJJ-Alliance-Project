# Dues stage 8 PR 8b — opening-debt drafts and readiness confirmations (schema) — verification

**Base:** main `6c907cf384f8928a01e9e03732cf277be13cd5e6` (stage 8a merged).
**Contract:** `docs/dues/STAGE-8B-IMPLEMENTATION-PLAN.md` (revision 2, design C1–C6) and
`docs/dues/STAGE-8-READINESS-BRIEF.md` §4, §6, §7 (updated in this PR to the implemented design).

**Not changed:** no owner action, screen, route, cron, scheduler, activation, charge, or change to any existing financial
writer, reader or consumer. `evaluate.ts` is untouched: checks 6–12 stay `notImplemented`, 13 stays `decisionPending`,
and `ready` stays false. The stage 8a authorization-audit exception is preserved: an authorized preview writes nothing,
and a cross-organization refusal still writes the existing `organization.accessRefused` row. That test is unchanged and
still passes.

## What was built

- **Migration `20261019120000_dues_readiness_drafts_and_confirmations`** (additive; no data, backfill or defaults), plus the forward fix `20261020120000_dues_opening_item_marker_kind_required` (see the review finding below):
  - **Enums:** `DuesOpeningItemWithdrawalKind`, `DuesReadinessConfirmationKind`.
  - **`DuesOpeningItem`:**
    - tenant/student composite FKs;
    - a legacy link pinned to the same organization, student and month;
    - a successor FK (same organization and student) that is `DEFERRABLE INITIALLY DEFERRED`;
    - a partial unique index for one active draft per student and month (immediate);
    - CHECKs: amount, month, year, note 1–500 characters, reason length, marker completeness, no self-supersession;
    - triggers `dues_reject_delete` and `dues_set_once_marker` (the ledger's existing functions, unchanged).
  - **`DuesReadinessConfirmation`:**
    - composite FKs; unique (organization, student, candidate month, kind, `sequence`);
    - CHECKs: `sequence ≥ 1`, month, year, hex-64 hashes, format length, shape by kind;
    - triggers `dues_reject_delete` and the new `dues_readiness_reject_update`.
  - **`PaymentPeriod`:** one added unique index `(organizationId, studentId, year, month, id)`, the target of the
    legacy link. It includes `id`, so no existing row can conflict. No column, row or writer changes.
- **Tenant guard:** both models in `tenant-guard.ts` and in `scoped-client.ts`, whose lists a unit test keeps equal.
  Like `DuesPaymentAttempt`, neither is in the `ScopedDb` accessor union.
- **Snapshot** (`snapshot.ts`): one read of **all** drafts in the same REPEATABLE READ, READ ONLY snapshot, split into:
  - `openingItems`: active drafts, full content;
  - `withdrawnOpeningItems`: `id`, `studentId`, `withdrawalKind`, `supersededById` only.

  A withdrawn draft's amount, currency and note never leave the loader, so nothing downstream can count or hash them.
- **Fingerprint format `r2`** (`fingerprint.ts`): the student fingerprint adds active drafts' content and withdrawn
  drafts' id, kind and successor. Confirmations are in no hash.

## Review finding: a NULL loophole in the withdrawal-marker CHECK (fixed)

**Finding (reported in review of PR #147).** As first migrated, `DuesOpeningItem_withdrawal_marker_complete` was:

```
(all five marker columns NULL)
OR (withdrawnAt IS NOT NULL AND withdrawnById IS NOT NULL AND (
     (withdrawalKind = 'EDITED' AND supersededById IS NOT NULL)
  OR (withdrawalKind = 'WITHDRAWN' AND supersededById IS NULL AND withdrawalReason IS NOT NULL)))
```

**What went wrong.** With `withdrawalKind` NULL, both kind comparisons are UNKNOWN, so the whole predicate is NULL, and
PostgreSQL accepts a row whose CHECK is NULL. Concretely, with `withdrawnAt`, a valid `withdrawnById` and a reason set,
but kind and successor NULL:
- the UPDATE was accepted;
- the draft left the one-active index;
- the set-once marker trigger then refused any correction.

**Reproduced** on the isolated test database before the fix:
- **Raw evaluation:** the original predicate on exactly those values evaluates to `NULL`.
- **Regression tests, run against the original constraint:** 3 failed, because the database accepted each write:
  1. the malformed UPDATE;
  2. an INSERT carrying the same incomplete marker;
  3. a NULL kind with a **valid** successor reference (same student, so the foreign key would pass).

  The fourth new test, valid states still pass, passed.

**Fix: forward migration `20261020120000_dues_opening_item_marker_kind_required`.**
- **Why forward:** migrations are append-only (`docs/superpowers/plans/2026-09-08-phase-2-students-and-auth.md:20`).
  `20261019120000` was already applied to the test databases, so it is not edited, and no `_prisma_migrations` record
  was touched.
- **What it does:** one `ALTER TABLE` drops the constraint and re-adds it under the same name. The complete-marker
  branch adds `"withdrawalKind" IS NOT NULL`.
- **Why that is enough:** every remaining term is then an `IS [NOT] NULL` test or a comparison of a non-null value, so
  the predicate is always TRUE or FALSE.
- **Unchanged:** valid states (active; `EDITED` with a successor; `WITHDRAWN` with a reason) and the shared
  `dues_set_once_marker` trigger.

**Audit of the other CHECKs on both tables for the same pattern:** none is affected.
- **Draft CHECKs:** `amount`, `coverageMonth`, `coverageYear` and `note` are NOT NULL columns. The reason-length and
  self-supersession CHECKs start with an explicit `IS NULL OR …`.
- **Confirmation CHECKs:** `kind`, `binding`, `studentFingerprint`, `fingerprintFormat` and `sequence` are NOT NULL, and
  the nullable `branchFingerprint` and `declaredNoOpeningDebt` appear only under `IS [NOT] NULL` tests or an explicit
  `IS NULL OR …`.

**After the fix:**
- **Shared test database**, after `pnpm db:test:migrate`:
  - the 4 new tests pass, including that the malformed draft stays active and unchanged and the CHECK, not the FK,
    refuses test 3;
  - the full schema test file passes (30/30);
  - `db:check-drift` is clean.
- **Fresh application** on two new scratch databases on 5433 (dropped afterwards):
  - all 52 migrations applied;
  - `db:check-drift` clean on both comparisons;
  - `pg_get_constraintdef` shows the new `("withdrawalKind" IS NOT NULL)` term.
- **Raw `INSERT` probes on that fresh database**, with placeholder parent ids (CHECKs run before the row's FK
  triggers, so a passing CHECK surfaces as an FK error):
  - the kindless marker and the NULL kind with a successor are both refused by
    `DuesOpeningItem_withdrawal_marker_complete`;
  - a valid `WITHDRAWN` marker and an active row both pass the CHECK and stop only at the placeholder FK.

**Lesson recorded for 8c and later schema work.** A CHECK built from `=` comparisons over nullable columns must
either test those columns `IS NOT NULL` explicitly or be written so it can never be UNKNOWN. The negative tests here
had covered each column missing *with a kind present*, never the kind itself missing.

## Primary constraint design: verified first, before any other code

Run on a fresh isolated database (`alliance_bjj_8b_drift_test`) on the test server (port 5433). Prisma's shadow was a
second scratch database on the same server (`alliance_bjj_8b_shadow_test`). Neither the dev server nor its shadow
database was used. PostgreSQL 16.15.

| Step | Result |
|---|---|
| `prisma migrate deploy` (all 51 migrations, fresh) | applied |
| `db:check-drift` (a) schema.prisma vs migration history | **clean** |
| `db:check-drift` (b) migration history vs live database | **clean** |
| Catalog: successor FK `condeferrable`, `condeferred` | `t`, `t` |
| Catalog: `DuesOpeningItem_one_active_per_month_key` | `CREATE UNIQUE INDEX … USING btree ("organizationId", "studentId", "coverageYear", "coverageMonth") WHERE ("withdrawnAt" IS NULL)` |

**Negative controls (a finding).** On the same scratch database, the successor FK was altered to `NOT DEFERRABLE`, and
separately the partial index was dropped. **`db:check-drift` still reported both comparisons clean.** The drift check
is blind to deferrability and partial unique indexes. So "clean" proves there is no false drift from the hand-written
SQL, not that the protections exist.

Mitigation: the first describe block of `tests/integration/dues-readiness-schema.test.ts` asserts both from
`pg_constraint`/`pg_indexes`, plus the full trigger list and that every other FK on the two tables is immediate. Losing
either protection now fails CI. No fallback (A or B in plan §6.2) was used.

## Existing data unchanged

The shared integration test database already held data (38 students, 4 `PaymentPeriod` rows, 50 applied migrations).
Before `pnpm db:test:migrate`, every public table's row count and an md5 over all `PaymentPeriod` rows were recorded,
and compared again afterwards:

- **Row counts:** the only differences were `DuesOpeningItem=0` and `DuesReadinessConfirmation=0` (new) and
  `_prisma_migrations` 50 → 51.
- **`PaymentPeriod` md5:** `f8a319d3ea3d8e528f5d622146faa39d` before and after.

CI's parity check (seed → snapshot → migrate → snapshot → diff) runs on the PR.

## Tests

### `tests/integration/dues-readiness-schema.test.ts` (new, 30 tests, real test database; 4 added by the NULL-loophole fix above)

| Area | Proved |
|---|---|
| **Catalog** | deferred successor FK; partial unique index; four triggers; every other FK immediate |
| **Tenant, student, month integrity** | a draft or confirmation naming another organization's student is refused. A legacy link to another month's, another student's or another organization's `PaymentPeriod` is refused; a null link is unchecked. A successor in another student or organization is refused at `SET CONSTRAINTS ALL IMMEDIATE`; a successor of the same student in another month is accepted |
| **Rollback when the successor is missing** | a real committed transaction sets the marker and never inserts the successor. **COMMIT fails** with SQLSTATE 23503 on the successor FK; the old draft is still active and unmarked, and no successor row exists |
| **Invalid values** | amount 0/−1; month 0/13; year 1999/2101; blank or 501-character note (500 accepted); incomplete marker; `EDITED` without successor; `WITHDRAWN` without reason or with a successor; blank or 501-character reason; self-supersession; `sequence` 0/−1; uppercase, short or non-hex hashes; empty or 17-character format; every wrong shape by kind |
| **Same-month replacement** | marker first with a pre-generated id, then insert, in one transaction: exactly one active draft, and the old row's content unchanged |
| **Reverse order** | inserting the successor first is refused by `DuesOpeningItem_one_active_per_month_key`, which proves the order matters |
| **Changed-month replacement** | one active draft, in the new month |
| **Uniqueness** | two active drafts per month refused; active plus withdrawn allowed; `supersededById` unique |
| **Immutability** | draft content updates, marker-plus-content updates and second marker updates refused; confirmation updates refused; neither table can be deleted from |
| **Concurrent replacement** | (1) two protocol edits of one draft: the second waits at the student lock (verified with `pg_blocking_pids`), re-reads, finds the draft withdrawn, and stops; one active successor remains. (2) A rogue writer that skips the lock and re-read blocks on the row and is refused by the marker trigger after the first commits. (3) Two concurrent creates for one month: the second waits on the unique index and is refused |
| **Ordering: isolation** | the protocol's transactions are asserted to run at READ COMMITTED |
| **Ordering: equal timestamps** | two confirmations with the same `confirmedAt` get sequences 1 and 2; current = 2; a "latest by `confirmedAt`" rule has two candidates |
| **Ordering: start order ≠ lock order** | T1 begins first; T2 begins 50 ms later, takes the lock, and inserts sequence 1. T1 is verified blocked by T2, then T2 commits; T1 is granted the lock, its `MAX` read sees T2's row, and it inserts sequence 2. T1 is current although its `confirmedAt` (its transaction start) is earlier |
| **Ordering: backstop** | a duplicate (identity, `sequence`) insert that skips the lock is refused on the unique key; the first row is unchanged |
| **Ordering: why READ COMMITTED** | the same race with T1 at REPEATABLE READ: its snapshot predates T2's commit, the stale `MAX` collides on the unique key, and T1 fails. Only T2's row exists. Observed: a unique violation, not a serialization failure |
| **No ledger effect** | create, edit, withdraw and a pricing confirmation leave `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`, `DuesSettlement` and `PaymentPeriod` counts unchanged, and the linked `PaymentPeriod` row identical |
| **Tenant guard** | a query on either model without `organizationId` throws `UnscopedTenantQueryError` |

### `tests/unit/dues-readiness.test.ts` (12 new; 54 total)

- **Revival regression:**
  - add then withdraw: B2 ≠ B0 and ≠ B1;
  - edit then withdraw: four distinct bindings;
  - edit then revert: the re-entered values get a new id, so a new binding.
- **Sensitivity:** each active field (amount, currency, note, month, year, legacy link) changes the student
  fingerprint, the organization fingerprint and the opening binding, and not another student's.
- **Withdrawn drafts:** a withdrawn row carrying an amount, currency or note hashes identically to one without them;
  kind, successor and id do count. An active and a withdrawn row with the same id never hash alike.
- **Format:** `r2`. The student, branch and organization fingerprints and the opening binding for the base fixture all
  differ from the **`r1` values recorded from the 8a code on `6c907cf`** before the change.
- **Branch-only change:** still invalidates the pricing acknowledgement with drafts present.
- **Preview and checks:** drafts (active and withdrawn, two currencies) leave the preview, totals and every check
  unchanged; checks 6–12 `notImplemented`, 13 `decisionPending`, `ready` false.

### `tests/integration/dues-readiness.test.ts` (5 new; 17 total; existing 12 unchanged)

- **Revival against the real database:**
  - a stored `OPENING_REVIEWED` row with binding B0 is valid, goes stale when a draft is added, and **stays stale**
    after the draft is withdrawn; the stored row is unchanged;
  - edit-then-withdraw and edit-then-revert: five distinct bindings.
- **Loader:**
  - active drafts carry exactly their content;
  - withdrawn drafts carry exactly `{ id, studentId, withdrawalKind, supersededById }`;
  - the serialized snapshot contains neither the withdrawn amount (`777.77`) nor its note;
  - no other organization's drafts are loaded.
- **Snapshot isolation:** a draft committed in the `afterFirstRead` pause is invisible to that snapshot and visible to
  the next.
- **With drafts present:** the preview equals the pre-draft preview, both from `evaluateReadiness` and from
  `getDuesReadinessForOwner`; checks unchanged; `ready` false.

## Failing-before and mutation evidence

**Red before green.** The 12 new unit tests were run against the 8a fingerprint code before `snapshot.ts` and
`fingerprint.ts` changed: **12 failed, 42 passed.**

**Code mutations** (each applied, run, then reverted; the working tree was verified restored):

| Mutation | Caught by |
|---|---|
| M1: fingerprint ignores withdrawn drafts (the revision-1 active-only design) | 3 unit tests (both revival regressions, withdrawn contribution) and 2 integration tests (both real-database revival tests) |
| M2: loader reads only active drafts (`withdrawnAt: null`) | 3 integration tests (both revival tests, loader shape) |
| M3: format tag left at `r1` | the `r1`/`r2` unit test |
| M4: protocol reads `MAX(sequence)` before taking the student lock | the start-order-vs-lock-order test (T1 also gets sequence 1) |

**Database mutations** on the isolated test database (each applied with SQL, run, then restored from the migration's own
statements; the full schema test passed 26/26 afterwards, before the NULL-loophole tests were added):

| Mutation | Caught by |
|---|---|
| D1: successor FK `NOT DEFERRABLE` | 8 tests: catalog ×2, successor integrity, same- and changed-month replacement, both concurrent-edit tests, no-ledger-effect |
| D2: one-active partial index dropped | 4 tests: catalog, two-active refusal, reverse order, concurrent creates |
| D3: marker-once trigger dropped | 3 tests: catalog trigger list, immutability, rogue-writer backstop |
| D4: confirmation (identity, `sequence`) unique key dropped | 2 tests: the backstop and the REPEATABLE READ test |

Robustness fix found by D2: when a lock-wait assertion failed, the held transaction was never released and a later test
timed out in cascade. Each release is now in `finally`; a D2 re-run fails only its 4 intended tests.

## Checks run locally (isolated test databases only)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm lint` | 0 errors, 23 warnings (identical to the base; none in changed files) |
| `pnpm check:guard-usage` | all 80 guards have a production call site |
| `pnpm db:check-drift` (fresh scratch database + scratch shadow, both on 5433; repeated on the migrated shared test database after the mutation runs) | both comparisons clean each time (see the limit above) |
| `pnpm test:unit` | 131 files, 1920 tests passed, including the unchanged `dues-ledger-not-exposed` and `dues-eligibility-not-exposed` structural tests |
| `pnpm test:integration` | 168 files, 2214 tests passed (full suite, isolated test database); after the NULL-loophole fix: 168 files, 2218 passed |

## Deviations from the plan (all small, none weakening integrity)

1. **`scoped-client.ts` also changed** (one file outside plan §10). `tests/unit/tenant-guard.test.ts` requires the two
   tenant lists to match.
2. **Snapshot shape.** Two arrays instead of one array with a `withdrawnAt` flag. Withdrawn amounts, currencies and
   notes are dropped inside the loader, so "never counted, never hashed" is structural, not a convention.
3. **Constraint names.**
   - The successor FK keeps Prisma's generated name, `DuesOpeningItem_organizationId_studentId_supersededById_fkey`,
     not the plan's `DuesOpeningItem_successor_fkey`, so the migration matches what Prisma generates for the schema
     (only the `DEFERRABLE INITIALLY DEFERRED` clause is hand-added).
   - The legacy-link FK is Prisma's truncated `DuesOpeningItem_organizationId_studentId_coverageYear_cove_fkey`.
4. **Two additions.**
   - `@@unique([organizationId, studentId, supersededById])`: Prisma requires it for the one-to-one succession relation.
     `supersededById` is already unique on its own.
   - A separate `DuesOpeningItem_withdrawal_reason_length` CHECK: a reason, when present (optional for `EDITED`), is 1–500
     characters after trimming. `WITHDRAWN` still requires one, via the marker CHECK.
5. **`confirmedAt` clock.** The plan said `confirmedAt` "defaults to `now()`, which is the transaction start time".
   That is the database default, but Prisma fills `@default(now())` on the app server at insert time. The
   start-order test therefore stamps each transaction's own `now()` explicitly. Either way the conclusion stands:
   `confirmedAt` is display only, and order comes from `sequence`.
6. **Held-lock technique.** The plan cited `monthly-generation.test.ts`. The tests instead verify real lock waits with
   `pg_blocking_pids`, as `awaiting-rate-receipt.test.ts` does.

## Limitations

- **No writer exists.** The edit and confirmation protocols are proved as SQL protocols by test helpers. Stage 8c's
  writers must implement them exactly:
  - lock order: branch `FOR SHARE`, student `FOR UPDATE`;
  - READ COMMITTED;
  - re-read the draft as active after the lock;
  - marker before insert;
  - `MAX + 1` after the lock;
  - fingerprint computed under the lock.
- **Legacy payment writers do not take the student lock** in stage 8 (plan §4). A confirmation can be recorded at the
  same moment as a legacy edit. This is harmless, because validity is recomputed at every read; the authoritative gate
  is stage 9.
- **The drift check cannot see `DEFERRABLE` or partial indexes** (above). The catalog test is the guard.
- **FK actions.** Both FKs use Prisma's default `ON UPDATE CASCADE`.
  - No writer changes `PaymentPeriod`'s key columns: `recordPayment`'s upsert updates status, amount, notes, method and
    promo fields only (`src/lib/payments/payment-actions.ts:201`). A cascade into a draft would be refused by the marker
    trigger anyway.
  - `ON DELETE RESTRICT` means a linked `PaymentPeriod` cannot be deleted. No application code deletes `PaymentPeriod`
    rows.
- **Deploy-time lock.** The `PaymentPeriod` unique index is built inside the migration transaction and briefly blocks
  writes to that table.
- **Recovery.** Before 8c writers exist the tables are empty and can be dropped by a forward migration. Afterwards rows
  are immutable history: withdraw, never delete.
