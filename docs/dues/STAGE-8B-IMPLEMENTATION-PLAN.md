# Stage 8 PR 8b — implementation plan (schema for opening-debt drafts and review confirmations) — revision 2

**Status:** implemented as written, with the small deviations and the drift-check finding recorded in
`design/matroom/verification/dues-stage8b-schema/README.md`. Fallbacks A and B (§6.2) were not used.
**Base:** `main` @ `6c907cf384f8928a01e9e03732cf277be13cd5e6` (stage 8a merged).
**Contract:** `docs/dues/STAGE-8-READINESS-BRIEF.md` revision 3, §4, §6, §7, §12, plus the 8a code in
`src/lib/dues/readiness/`.

**Scope:** an additive schema only, plus the minimal 8a snapshot/fingerprint change that makes drafts part of the
reviewed content.

**Not in this PR:** no owner actions, screens, scheduling, activation, ledger charges or change to any existing financial
writer. Checks 6–12 stay `notImplemented`, 13 stays `decisionPending`, and `ready` stays false.

**Recorded decisions carried in, not reopened:**
- D7: no automatic late fee on opening debt; the amount is the unpaid principal only, and a note is required.
- O3: pre-switch signup debt is excluded, not waived.
- O2: opening-charge cancellation is later work.
- O4: undecided, and it blocks activation.

**Working design:** C1–C6 as recommended in revision 1 (§9).

**Revision 2 resolves:**
- an authoritative confirmation ordering (§2.3, §4);
- confirmation revival after an add-and-withdraw cycle (§5);
- the deferred-constraint fallback, documented and not substituted (§6.2);
- one consistent draft-edit order throughout: withdraw first, then insert (§3).

---

## 1. Shape

- **Drafts are append-only (C1).**
  - An edit sets a once-only withdrawal marker on the old row (`EDITED`, with `supersededById` = the successor's id),
    then inserts the successor.
  - A withdrawal sets the marker (`WITHDRAWN`, with a reason).
  - Rows are never updated otherwise and never deleted. This reuses `dues_set_once_marker` and `dues_reject_delete` from
    `20260927153000_dues_ledger_schema`.
- **Confirmations are append-only (C2).** Within one identity (organization, student, candidate month, kind) they carry
  an authoritative `sequence` (§2.3). Rows are never updated or deleted.
- **No `academyId` on drafts (C4); notes of 1–500 characters (C3).**
- **Successor constraints (C5):** same organization and same student in the database; the month may change.
- **Legacy-payment link (C6):** constrained to the same organization, student and month, via one additive unique index
  on `PaymentPeriod`.
- **`materializedObligationId` is deferred to stage 9.**

## 2. Schema

### 2.1 Enums

```prisma
enum DuesOpeningItemWithdrawalKind {
  EDITED      // superseded by a newer draft (supersededById set)
  WITHDRAWN   // withdrawn by the owner (reason required)
}

enum DuesReadinessConfirmationKind {
  OPENING_REVIEWED
  PRICING_ACKNOWLEDGED
}
```

### 2.2 `DuesOpeningItem`: an owner-staged opening-debt draft, never a charge

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | the writer pre-generates the successor's id for an edit |
| `organizationId` | `String` | |
| `studentId` | `String` | composite FK `(organizationId, studentId)` → `Student(organizationId, id)` (existing `@@unique`) |
| `coverageYear`, `coverageMonth` | `Int` | the past month the debt belongs to |
| `amount` | `Decimal @db.Decimal(10, 2)` | unpaid principal only (D7) |
| `currency` | `Currency` | typed by the owner; never converted or inferred |
| `note` | `String` | required (D7) |
| `legacyPaymentPeriodId` | `String?` | optional partial-payment link (§2.4) |
| `createdById` | `String` | FK → `User`, restrict |
| `createdAt` | `DateTime @default(now())` | display only |
| `withdrawnAt` | `DateTime?` | once-only marker |
| `withdrawnById` | `String?` | FK → `User`, restrict |
| `withdrawalKind` | `DuesOpeningItemWithdrawalKind?` | |
| `withdrawalReason` | `String?` | required when `WITHDRAWN` |
| `supersededById` | `String?` | unique; required when `EDITED` |

**Prisma-level keys:**
- `@@unique([organizationId, id])`;
- `@@unique([organizationId, studentId, id])` (the successor FK target);
- `@@index([organizationId])`;
- `@@index([organizationId, studentId])`.

**Migration SQL:**

| Constraint | Rule |
|---|---|
| `DuesOpeningItem_amount_positive` | `"amount" > 0` |
| `DuesOpeningItem_month_valid` | `"coverageMonth" BETWEEN 1 AND 12` |
| `DuesOpeningItem_year_sane` | `"coverageYear" BETWEEN 2000 AND 2100` |
| `DuesOpeningItem_note_present` | `char_length(btrim("note")) BETWEEN 1 AND 500` |
| `DuesOpeningItem_withdrawal_marker_complete` | `withdrawnAt`, `withdrawnById`, `withdrawalKind` all null or all set; `EDITED` ⇔ `supersededById` not null; `WITHDRAWN` ⇒ `char_length(btrim("withdrawalReason")) BETWEEN 1 AND 500` and `supersededById` null |
| `DuesOpeningItem_not_self_superseding` | `"supersededById" IS NULL OR "supersededById" <> "id"` |
| `DuesOpeningItem_one_active_per_month_key` | partial unique **index** on `("organizationId", "studentId", "coverageYear", "coverageMonth") WHERE "withdrawnAt" IS NULL` (immediate) |
| `DuesOpeningItem_successor_fkey` | `FOREIGN KEY ("organizationId", "studentId", "supersededById") REFERENCES "DuesOpeningItem"("organizationId", "studentId", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED` (primary proposal; §6.2) |

**Triggers** (existing functions):
- `DuesOpeningItem_no_delete` → `dues_reject_delete()`;
- `DuesOpeningItem_marker_once` → `dues_set_once_marker('withdrawal', 'withdrawnAt,withdrawnById,withdrawalKind,withdrawalReason,supersededById')`.

### 2.3 `DuesReadinessConfirmation`: the owner's statement about one student for one candidate month

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `organizationId` | `String` | |
| `studentId` | `String` | composite FK → `Student(organizationId, id)` |
| `candidateYear`, `candidateMonth` | `Int` | candidate start month S |
| `kind` | `DuesReadinessConfirmationKind` | |
| **`sequence`** | `Int` | **authoritative order within the identity**: 1, 2, 3… (§4) |
| `fingerprintFormat` | `String` | format the hashes were computed with (`"r2"`) |
| `binding` | `String` | `openingReviewBinding(S, studentFp)` or `pricingAckBinding(S, studentFp, branchFp)` |
| `studentFingerprint` | `String` | component hash, so the UI can say student vs branch changed |
| `branchFingerprint` | `String?` | required iff `PRICING_ACKNOWLEDGED` |
| `declaredNoOpeningDebt` | `Boolean?` | required iff `OPENING_REVIEWED`; `true` = explicit "no opening debt" |
| `confirmedById` | `String` | FK → `User`, restrict |
| `confirmedAt` | `DateTime @default(now())` | **display only, never used for ordering** |

**Prisma-level keys:**
- `@@unique([organizationId, studentId, candidateYear, candidateMonth, kind, sequence])`, which is also the current-row
  lookup (highest `sequence`);
- `@@index([organizationId])`.

**Migration SQL:**

| Constraint | Rule |
|---|---|
| `DuesReadinessConfirmation_sequence_positive` | `"sequence" >= 1` |
| `_month_valid` / `_year_sane` | on the candidate month |
| `_hashes_hex` | `binding`, `studentFingerprint` (and `branchFingerprint` when set) match `^[0-9a-f]{64}$` |
| `_format_present` | `char_length("fingerprintFormat") BETWEEN 1 AND 16` |
| `_shape_by_kind` | `OPENING_REVIEWED` ⇒ `declaredNoOpeningDebt IS NOT NULL AND branchFingerprint IS NULL`; `PRICING_ACKNOWLEDGED` ⇒ `branchFingerprint IS NOT NULL AND declaredNoOpeningDebt IS NULL` |

**Triggers:**
- `_no_delete` → `dues_reject_delete()`;
- `_no_update` → a new `dues_readiness_reject_update()` (with its own message).

### 2.4 The legacy-payment link (C6)

`(organizationId, studentId, coverageYear, coverageMonth, legacyPaymentPeriodId)` →
`PaymentPeriod(organizationId, studentId, year, month, id)`

- **`MATCH SIMPLE`:** unchecked when the link is null.
- **On delete:** restrict.
- **Same organization, same student, same month,** all enforced by the database.

**Requires** `@@unique([organizationId, studentId, year, month, id])` on `PaymentPeriod`:
- it includes `id`, so it can't conflict with any existing row;
- no row, column or writer changes;
- it's built inside the migration transaction and briefly blocks writes to `PaymentPeriod`.

### 2.5 Tenant guard

Add `"DuesOpeningItem"` and `"DuesReadinessConfirmation"` to `src/lib/tenant/tenant-guard.ts`.

## 3. Draft lifecycle (one order, used everywhere)

All draft and confirmation writers (8c) take the **student row lock** (`lockStudent`, `FOR UPDATE`), in the ledger's
existing order: branch `FOR SHARE`, then student `FOR UPDATE`. Every draft operation and every confirmation for one
student is therefore serialized.

| Operation | Steps, in one transaction, after the student lock |
|---|---|
| **Create** | Insert. The partial unique index refuses a second active draft for the same month |
| **Edit** (same or different month) | 1. Re-read the old draft; refuse with "changed since you opened it" unless `withdrawnAt IS NULL`. 2. Pre-generate the successor id. 3. **Set the old row's marker first:** `EDITED`, actor, time, `supersededById` = successor id. The old row leaves the partial unique index. 4. **Then insert the successor** with that id. 5. Commit. The deferred successor FK is checked here |
| **Withdraw** | Re-read as in edit; set the marker (`WITHDRAWN`, reason) |
| **Delete / any other change** | Refused by trigger |

- **Why withdraw before insert:** a same-month edit must never have two active rows. The partial unique index is
  immediate, so the old row has to stop being active before the successor exists. The successor's id is referenced
  before the row exists, which is why that FK is deferred (§6).
- **No revision token:** a draft is editable only while active, and an edit or withdrawal makes it inactive forever. A
  stale edit can't apply.
- **Audit information:** actor and time are on the row, and a withdrawal carries its reason. 8c also writes one
  `AuditLog` record per operation, as a record only.
- **No ledger charges:** no relation to `DuesObligation`, and no writer touches the ledger.

## 4. Confirmation ordering

**Problem.** `confirmedAt` defaults to `now()`, which is the **transaction start** time.
- Two confirmations can share a timestamp.
- A transaction that started first can commit last, after waiting on a lock.
- A random id doesn't order anything.

So neither the timestamp nor the id says which review came last.

**Mechanism.** The same one `StudentStatusChange.sequence` already uses, under the student lock:
1. The writer takes the student row lock (`FOR UPDATE`). Every writer for that student serializes here, in the order
   they **acquire** the lock, not the order they started.
2. **Under the lock,** it reads `MAX(sequence)` for the identity (organization, student, candidate month, kind) and
   inserts with `MAX + 1` (or 1).
3. It recomputes the fingerprint **under the same lock**, so the hash describes the content as of its place in that
   order (drafts written by other writers for this student are already committed or still waiting).
4. **The database backstop:** the unique key on (identity, `sequence`) means two writers that somehow skipped the lock
   can't both take the same number; one fails and nothing is overwritten.

**Current confirmation** = the row with the highest `sequence` for the identity. `confirmedAt` is shown to people and
never compared.

**Scope of this guarantee:**
- It orders confirmations relative to each other and to draft writes, which share the student lock.
- Legacy payment writers don't take the student lock in stage 8. A confirmation can therefore be recorded at the same
  moment as a legacy edit. That's harmless, because validity is recomputed at every read and the edit makes the
  confirmation stale.
- The authoritative "nothing changed" check is stage 9's gate.

## 5. Staleness and no revival after an add-and-withdraw cycle

**The problem.** If the student fingerprint covers only *active* drafts, this sequence revives a stale confirmation:
1. Owner confirms "no opening debt" (hash H0).
2. A draft is added (hash H1, so the confirmation is stale).
3. The draft is withdrawn (hash back to H0, so the old confirmation looks valid again).

That contradicts the rule that draft changes require renewed review.

**Fix:** the smallest durable contribution, using what the schema already guarantees. Drafts are never deleted, so the
student fingerprint covers **every draft row ever created for the student**:

| Draft | Contributes to the student fingerprint | Contributes to active debt / preview totals |
|---|---|---|
| Active | `id`, month, amount, currency, note, legacy link | **yes** |
| Withdrawn (`EDITED` or `WITHDRAWN`) | `id`, `withdrawalKind`, `supersededById` (no amount, currency or note) | **no** |

- **No revival:** after step 3 the hash is H2, which includes the withdrawn draft's id. H2 is neither H0 nor H1, so the
  confirmation from step 1 stays stale until the owner reviews again.
- **Permanent:** rows can't be deleted (trigger), so a contribution can never disappear and an old hash can never
  recur.
- **Edits work the same way:** the old draft becomes withdrawn and the successor is a new id, so every edit leaves a
  durable change.
- **Withdrawn amounts** are not hashed and never counted. The snapshot loads all drafts, and everything except the
  fingerprint uses the active ones only.
- **Confirmation records are still excluded from every content hash.** Including them would make confirmations
  invalidate themselves.
- **Validity of a confirmation:** `fingerprintFormat` = current format **and** `binding` = the binding recomputed now.
  - For `OPENING_REVIEWED`: student content, including the draft history.
  - For `PRICING_ACKNOWLEDGED`: student content plus the branch pricing/policy fingerprint, so a price or policy change
    alone makes it stale.
  - The stored row is never modified.

## 6. Integration with 8a, and the deferred constraint

### 6.1 8a changes (minimal)

| File | Change |
|---|---|
| `src/lib/dues/readiness/snapshot.ts` | Add `openingItems: { id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId, withdrawnAt (as a flag), withdrawalKind, supersededById }[]`, loaded with `where: { organizationId }` (**all** drafts, active and withdrawn) inside the same snapshot. Confirmations are not loaded in 8b |
| `src/lib/dues/readiness/fingerprint.ts` | Student fingerprint adds §5's contributions. `FINGERPRINT_FORMAT` goes from `"r1"` to `"r2"` |
| `src/lib/dues/readiness/evaluate.ts` | No check changes: 6–12 `notImplemented`, 13 `decisionPending`, `ready` false. Drafts don't enter the `MONTHLY` preview totals |

**Format versioning:**
- The format tag is hashed into every fingerprint and binding, and each confirmation stores its format.
- A changed covered-field set means a new tag, and an old-format confirmation is stale by definition.
- No `r1` hash was ever stored, so the bump needs no data change.

### 6.2 Deferred successor FK: primary proposal, verification, and documented fallbacks

**Primary (proposed):**
- the partial unique **index** (immediate) for one active draft per month;
- the successor FK `DEFERRABLE INITIALLY DEFERRED`, needed because the edit sets the old row's marker, referencing the
  successor's id, before the successor is inserted (§3).

**Verify first, before any other implementation step:**
- Prisma's schema language has no `DEFERRABLE`, so that clause exists only in the migration SQL.
- Run `pnpm db:check-drift` (`scripts/check-drift.ts`) on the isolated test database after applying the migration.
  - If it reports no drift, proceed.
  - If it reports drift, **stop and report the exact output**. Do not substitute a fallback without approval.

**Fallback A — deferrable exclusion constraint** (documented only, not chosen):
- **SQL:** the edit order becomes insert-successor-first, so the FK can be immediate. One-active-per-month then has to be
  checked at commit:
  ```sql
  ALTER TABLE "DuesOpeningItem" ADD CONSTRAINT "DuesOpeningItem_one_active_per_month_excl"
    EXCLUDE USING btree ("organizationId" WITH =, "studentId" WITH =, "coverageYear" WITH =, "coverageMonth" WITH =)
    WHERE ("withdrawnAt" IS NULL)
    DEFERRABLE INITIALLY DEFERRED;
  ```
  It replaces the partial unique index. A partial unique *index* can't be deferrable, and a `UNIQUE` *constraint* can't
  have a `WHERE`.
- **Extension:** none for this form. `EXCLUDE USING btree` with only `=` operators works on core PostgreSQL, and
  `btree_gist` would only be needed for `USING gist`. This is to be confirmed on the target PostgreSQL version during
  verification, not assumed.
- **Compatibility:**
  - Exclusion constraints and `DEFERRABLE` have existed for many PostgreSQL major versions. Production is already
    required to be 12+ (#142).
  - Prisma can't represent exclusion constraints either, so **fallback A carries the same drift-check question as the
    primary** and must pass the same verification.
- **Concurrency:**
  - A deferred constraint is checked at `COMMIT`, so a violation surfaces as a commit-time error, not a statement error.
    The writer must expect the transaction commit to throw.
  - Two concurrent transactions inserting the same key: the later committer waits for the earlier and fails if it
    committed.
  - `INSERT ... ON CONFLICT` can't use a deferrable constraint as its arbiter (the repo doesn't use `ON CONFLICT` on
    this table).
  - In practice the student lock (§3) serializes writers before any of this.
- **Integrity:**
  - Uniqueness stays database-enforced (at commit), and the successor FK becomes immediate.
  - Every `EDITED` row still has a valid successor, via the immediate FK plus the existing marker CHECK.

**Fallback B — reverse pointer, no deferral at all** (documented only, not chosen):
- **Shape:** the successor points back with `supersedesId` (immediate FK to the predecessor, unique); the old row's
  marker no longer names its successor.
- **Order:** withdraw first, then insert, so the immediate partial unique index stays as in the primary.
- **Prisma:** fully representable, with no hand-written constraint clause.
- **Integrity cost:** "every `EDITED` row has a successor" can't be checked by a CHECK or an immediate FK, only by a
  deferred constraint trigger, which is itself hand-written SQL. Without one, a writer bug could leave an `EDITED` row
  with no successor, so database-enforced reference integrity for that rule would be lost.
- **Recommendation:** therefore not recommended unless that loss is accepted.

**Fallback approval:** if the primary fails verification, I report the drift output and propose A or B with this
analysis. Neither is used without approval.

## 7. Migration

One additive migration, `<timestamp>_dues_readiness_drafts_and_confirmations`:
- the enums, tables, FKs (successor FK deferred), CHECKs, partial unique index, triggers,
  `dues_readiness_reject_update()`, and the added `PaymentPeriod` unique index;
- **no data:** no backfill, seed or reinterpretation, and no default amount, currency or month.

**Preservation:** no existing row, column, constraint, trigger or index changes except the added `PaymentPeriod` index.
The parity check must show only additions.

**Recovery:**
- **Before 8c writers exist,** the tables are empty and droppable by a forward migration.
- **Afterwards,** rows are immutable history and recovery is forward-only (withdraw, never delete).

**Applied only to isolated test databases** (`pnpm db:test:migrate`, guarded `TEST_DATABASE_URL`).

## 8. Verification (implementation PR)

**Schema tests** — new `tests/integration/dues-readiness-schema.test.ts`, real test DB, private temporary organizations,
cleanup via `session_replication_role = replica`:

1. **Tenant and reference integrity:** refused when a draft or confirmation names another organization's student; when
   the legacy link points at another organization's, another student's or another month's `PaymentPeriod`; or when the
   successor is another organization's or another student's draft. A successor id that never gets inserted fails at
   commit (deferred FK).
2. **Invalid values:**
   - amount ≤ 0;
   - month 0 or 13, year 1999 or 2101;
   - blank or 501-character note;
   - a non-hex or short hash; an empty format; `sequence` 0;
   - a wrong shape by kind;
   - an incomplete marker, `EDITED` without successor, `WITHDRAWN` without reason, a self-supersession.
3. **Uniqueness and edit order:**
   - two active drafts for the same month are refused;
   - an active draft plus a withdrawn one is allowed;
   - a **same-month edit in the specified order** (marker on old with pre-generated successor id, then insert, one
     transaction) leaves exactly one active;
   - the **reverse order** (insert successor first) is refused by the partial unique index, which proves the order
     matters;
   - an edit that changes the month leaves one active in the new month;
   - `supersededById` is unique;
   - a duplicate (identity, `sequence`) confirmation is refused.
4. **Immutability:**
   - draft content can't be updated, and the marker is set once only;
   - a confirmation can't be updated;
   - neither can be deleted.
5. **Concurrent supersession:** two transactions superseding the same draft (one held at the student lock): the second
   is refused by the marker trigger.
6. **No ledger effect:** no change in counts of `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`,
   `DuesSettlement` or `PaymentPeriod`.
7. **Tenant guard:** a query on either model without `organizationId` throws.

**Ordering** — schema-level, simulating the 8c protocol directly in SQL, since there's no writer yet:

8. **Equal timestamps:** two confirmations for one identity inserted with the **same** `confirmedAt` and sequences 1 and
   2. Current is sequence 2. A test helper that picks the "current" row by `confirmedAt` or `id` would give no answer or
   the wrong one, which the test documents.
9. **Start order differs from lock order:**
   - transaction T1 begins (earlier `now()`), then T2 begins;
   - T2 takes the student lock first and inserts `MAX+1 = 1`, while T1 waits on the lock;
   - T2 commits; T1 acquires the lock, reads `MAX = 1`, inserts 2, and commits.
   - **Expected:** T1's row is current (sequence 2) although its `confirmedAt` is earlier. Uses the held-lock technique
     from `monthly-generation.test.ts`.
10. **Backstop:** two inserts with the same identity and `sequence`, skipping the lock: one fails on the unique key, and
    the other row is unchanged.

**Fingerprints and no revival** — unit and integration:

11. **Revival regression** (replaces revision 1's "withdrawing returns the fingerprint to the no-draft value"):
    - record the opening-review binding B0 for a student with no drafts ("no opening debt");
    - add a draft, then withdraw it;
    - the recomputed binding is **neither B0 nor the with-draft binding**, so a confirmation stored with B0 is
      **stale**;
    - the same holds after edit-then-withdraw and after edit-then-revert (re-entering the original values gives a new
      id, hence a new hash).
12. **Unit sensitivity:**
    - any active-draft field changes the student fingerprint, the organization fingerprint and the opening binding, and
      not other students';
    - a withdrawn draft's amount, currency or note does **not** affect the hash (only its id and marker do);
    - the `r1` and `r2` formats never collide;
    - the branch-only change still invalidates the pricing acknowledgement.
13. **Snapshot:** a draft committed after a snapshot started is invisible to it (the `afterFirstRead` hook).
14. **Totals:** withdrawn drafts never appear in active debt. Drafts don't change `MONTHLY` preview totals.
15. **Unchanged behaviour:** checks 6–12 `notImplemented`, 13 `decisionPending`, `ready` false, and the 8a equivalence
    test still passes.
16. **Structural:** the not-exposed tests pass unchanged (no new importer, no action, no `"use server"`).

**Checks:** `tsc`, lint, `check:guard-usage`, **`db:check-drift` (the §6.2 gate)**, unit, integration, and parity in CI.
The revival regression and at least one constraint test are shown failing before their code exists.

## 9. Design choices (working proposal)

| # | Choice | Working design |
|---|---|---|
| C1 | Draft edit | Append-only: marker on old (withdraw first), then insert successor |
| C2 | Confirmations | Append-only; current = highest `sequence` per identity, assigned under the student lock |
| C3 | Note length | 1–500 characters after trimming |
| C4 | Branch on drafts | None; derived from `Student.homeAcademyId` |
| C5 | Successor | Same organization and same student in the database; the month may change |
| C6 | Legacy link | Composite FK, with the added `PaymentPeriod` unique index |
| — | Deferral | Primary as §6.2; fallbacks A/B only with approval if drift verification fails |

## 10. Bounded file scope (implementation PR)

| File | Change |
|---|---|
| `prisma/schema.prisma` | 2 enums, 2 models, the `PaymentPeriod` unique key, back-relations |
| `prisma/migrations/<ts>_dues_readiness_drafts_and_confirmations/migration.sql` | the additive migration (§7) |
| `src/lib/tenant/tenant-guard.ts` | 2 model names |
| `src/lib/dues/readiness/snapshot.ts` | `openingItems` (all drafts) and one read |
| `src/lib/dues/readiness/fingerprint.ts` | §5 contributions; format `r2` |
| `tests/integration/dues-readiness-schema.test.ts` | new (§8, items 1–10) |
| `tests/unit/dues-readiness.test.ts`, `tests/integration/dues-readiness.test.ts` | §8, items 11–15 |
| `design/matroom/verification/dues-stage8b-schema/README.md` | evidence and limits |
| `docs/dues/STAGE-8-READINESS-BRIEF.md` | §6/§7 updated to this design |

**Not touched:** existing writers, consumers, pages, routes; `evaluate.ts` checks; ledger tables; cron; activation.

## 11. Acceptance

- Drift verification passes for the primary design, or implementation stops with the exact drift output reported.
- The migration applies cleanly to a fresh isolated test database and to one with data. Parity shows only additions,
  and `db:check-drift` is clean.
- Every constraint in §2 is proved by a test that fails without it.
- The edit order is withdraw-then-insert everywhere, and the reverse order is proved refused.
- Confirmation order comes from `sequence` under the student lock. The equal-timestamp and
  start-order-versus-lock-order scenarios pass, and `confirmedAt` is display only.
- **No revival:** after add-and-withdraw (and edit-and-revert), an earlier confirmation stays stale. Withdrawn amounts are
  never hashed or counted, and confirmations are in no content hash.
- No ledger row, legacy payment or existing behaviour changes. Checks 6–12 `notImplemented`, 13 `decisionPending`,
  `ready` false.
- No owner action, screen, schedule, activation or charge exists after the PR.
