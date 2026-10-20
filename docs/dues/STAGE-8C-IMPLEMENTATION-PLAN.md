# Stage 8 PR 8c — implementation plan (owner actions for opening-debt drafts and readiness confirmations) — revision 2

**Status:** implemented as written. Deviations, findings and evidence are in
`design/matroom/verification/dues-stage8c-actions/README.md`.

**Revision 2:**
- U1 recorded (§5, §7);
- a confirmation write no longer needs a second pooled connection while it holds its transaction (§4.2–§4.4);
- acceptance scenarios for a constrained pool (§6);
- one consistent error contract for the legacy-payment reference (§2, §3.2).

Everything else is unchanged from revision 1.
**Base:** `main` @ `eeabc0f0f77ae0b571974c942e7c6839d7c90033` (8a and 8b merged; 8b's migrations applied only to isolated
test databases).
**Contract:**
- `docs/dues/STAGE-8-READINESS-BRIEF.md` (§4, §6, §7, §9–§12, §15);
- `docs/dues/STAGE-8B-IMPLEMENTATION-PLAN.md` (rev 2) and its evidence,
  `design/matroom/verification/dues-stage8b-schema/README.md` (protocols in its "Limitations");
- the code in `src/lib/dues/readiness/`.

**In scope:**
- five owner-only server actions: create, replace and withdraw a draft; record an opening review; record a pricing
  acknowledgement;
- readiness checks 6–9 become computed;
- the brief's §12 warnings and per-student confirmation state in the report.

**Not in scope:** screens (8d), bulk assignment, scheduling, ledger charges or their cancellation, activation, gate locks in
existing writers (stage 9), and any change to an existing financial writer or to the MONTHLY preview.

**No new schema.** Every requirement below is met by the 8b tables. No requirement was found that needs a migration.

---

## 1. Files

| File | Change |
|---|---|
| `src/lib/dues/readiness/opening-actions.ts` | **new**, `"use server"`. Exports exactly the five actions in §2 and nothing else (every export of a `"use server"` file is a callable action) |
| `src/lib/dues/readiness/opening-core.ts` | **new**, plain module: input parsing, the transactional cores, the confirmation protocol, `loadReviewContentInTx` (the single-statement read, §4.2), audit rows. Not `"use server"`: its functions trust their caller's authorization and must never be client-invocable (the `assignment-core.ts` precedent) |
| `src/lib/dues/readiness/snapshot.ts` | load `confirmations` (all rows of the organization; §4.1) |
| `src/lib/dues/readiness/evaluate.ts` | checks 6–9 computed; §12 warnings; per-student confirmation state; opening-draft totals per branch and currency (separate from `wouldCreate`) |
| `tests/unit/dues-readiness-not-exposed.test.ts` | the existing four read-only files keep every assertion. A new block for the two 8c files asserts:<ul><li>`opening-core.ts` is not `"use server"`;</li><li>`opening-actions.ts` exports exactly the five names;</li><li>neither imports a ledger writer;</li><li>both stay inside the folder</li></ul> |
| `tests/unit/dues-ledger-not-exposed.test.ts` | one named `AUTHORIZED_CALLERS` entry: `opening-core.ts` imports `lockBranchShared` (a lock primitive, not a writer) from `ledger/common.ts` (§3.1) |
| `scripts/pending-callers.ts` | register the five actions as built ahead of their caller (8d), as 8a did |
| `tests/integration/dues-opening-actions.test.ts` | **new** (§6) |
| `tests/unit/dues-readiness.test.ts`, `tests/integration/dues-readiness.test.ts` | checks 6–9, warnings, confirmation state, totals (§6) |
| `docs/dues/STAGE-8-READINESS-BRIEF.md` | §12 table status; §6 protocol pointer |
| `design/matroom/verification/dues-stage8c-actions/README.md` | evidence, mutations, limits |

**Not touched:**
- `index.ts` (`getDuesReadinessForOwner` is unchanged);
- `fingerprint.ts` (format stays `r2`: no covered field changes);
- the schema, existing writers, pages and routes.

## 2. Action contracts

All five follow `assignPlan` (`src/lib/dues/assignment-actions.ts:63`): `(organizationId: string, _prev: ActionState,
formData: FormData) => Promise<ActionState>`, read with a `text()` helper (never strict zod over raw `FormData`, which
breaks on `$ACTION_*` keys).

**Authorization, the same for all five, in this order:**
1. **Owner of this organization only:** `resolveActionContext(organizationId, ["ADMIN"])`.
   - A **non-member** gets `{ error: "notFound" }`. The helper's existing `organization.accessRefused` audit row is
     preserved (not in our transaction; best-effort, as today).
   - A **member with another role** (Director, Instructor) throws `FORBIDDEN`. It is mapped to `notFound`, as
     `getDuesReadinessForOwner` does (brief §11: Directors learn nothing). Any other error propagates.
2. **Only server-derived values are trusted.**
   - The actor is `context.actorUserId`; no actor id is accepted from the form.
   - The organization is `context.organizationId`.
   - Every referenced row is re-read with `organizationId` in the `where`: student, draft, legacy row.
   - Amounts, currencies, months and notes are parsed from text.
   - A submitted binding is compared, never stored as given (§4.2).
3. Every write and its `AuditLog` row are in **one** transaction (§3.4).

**Return codes** (`ActionState.error`):

| Code | Meaning |
|---|---|
| `notFound` | unauthorized, or a student, draft or legacy row that is not in this organization, including one that exists in another organization (uniform: no disclosure) |
| `invalid` | with `fieldErrors` keyed by field. This includes an accessible legacy row of this organization that belongs to another student or another month: `fieldErrors.legacyPaymentPeriodId = ["mismatch"]` (§3.2) |
| `stale` | the draft is no longer active, the binding no longer matches, or the student's home branch changed while the action waited |
| `monthHasDraft` | another active draft exists for that student and month (the partial unique index, P2002) |

Success returns `{ ok: true }`. Nothing else is returned: 8d revalidates and re-reads. No page exists yet, so there is no
`revalidatePath`; 8d adds it.

| Action | Inputs (form fields) | Effect |
|---|---|---|
| `createOpeningDraft` | `studentId`, `coverageYear`, `coverageMonth`, `amount`, `currency`, `note`, optional `legacyPaymentPeriodId` | inserts one active draft |
| `replaceOpeningDraft` | `draftId`, plus the **full** new content (same fields as create, without `studentId`) | marks the old draft `EDITED` naming a pre-generated successor id, then inserts the successor |
| `withdrawOpeningDraft` | `draftId`, `reason` | marks the draft `WITHDRAWN` |
| `recordOpeningReview` | `studentId`, `candidateYear`, `candidateMonth`, `binding`, `declaration` (`noOpeningDebt` or `itemsAsShown`) | appends one `OPENING_REVIEWED` confirmation |
| `acknowledgePricing` | `studentId`, `candidateYear`, `candidateMonth`, `binding` | appends one `PRICING_ACKNOWLEDGED` confirmation |

Replacement takes the full content, so there is no partial-merge semantics. The student never changes: a successor is
always the same student, which the database also enforces.

## 3. Draft operations

### 3.1 Locks and isolation
- **Transaction:** one `prisma.$transaction` per action, with `isolationLevel: ReadCommitted` set explicitly (it is the
  database default; stating it makes the protocol's requirement visible) and an explicit `timeout`.
- **Lock order** (ledger, `src/lib/dues/ledger/common.ts:13`):
  1. `lockBranchShared(home branch)`, `FOR SHARE`;
  2. `lockStudent(student)`, `FOR UPDATE`.
- **Home branch moved while waiting:** the home branch is read before the transaction (to know which branch to lock),
  then **re-read from the locked student row**. If it changed, return `stale`, because the wrong branch is locked. No
  retry loop.
- **Why import `lockBranchShared`:** the brief requires branch-then-student, and `lockBranchShared` is the existing
  primitive. Importing it needs one named entry in the ledger-exposure test, as the precedents there do for other
  non-writer helpers (`isRealDate`, `inTenantScope`, `todayIn`). The alternative is a local copy of the 3-line query,
  which would drift; not recommended.

### 3.2 Validation (before the transaction; re-checked under the lock where noted)

| Field | Rule | Source |
|---|---|---|
| `studentId` | exists in this organization | scoped read |
| `coverageYear`/`coverageMonth` | `parseEffectiveMonth`: a real month, 2000–2100. **Under the lock:** not after the current month in the student's home-branch timezone (`currentMonthIn`); debt cannot belong to a future month | `config-input.ts` |
| `amount` | `parseMoney(raw, { allowZero: false })`: canonical two-decimal string, more than zero, within `Decimal(10,2)`, never rounded. Unpaid principal only (D7): no fee field exists | `config-input.ts:31` |
| `currency` | one of the `Currency` enum values, typed by the owner. Never inferred from the organization or plan, never converted | enum |
| `note` | trimmed, 1–500 characters (same as the CHECK) | — |
| `legacyPaymentPeriodId` | optional. Read with `{ id, organizationId }`. **Not found in this organization**, including a row of another organization, returns `notFound` (the same uniform refusal as a foreign student or draft). **Found, but another student or another month** returns `invalid` with `fieldErrors.legacyPaymentPeriodId = ["mismatch"]`. That row is the owner's own, so naming the mismatch discloses nothing. The composite FK is the backstop | scoped read |
| `reason` (withdraw) | trimmed, 1–500 | — |

- **Check 8 is a report check, not a write refusal.** The write-time upper bound is "not after the current month", not
  "before S", because S is not known when a draft is written.
- **Database CHECKs remain the backstop** for every rule above; the action never relies on them for its error code.

### 3.3 Operations, after both locks

**Create:**
1. Insert the draft.
2. On P2002 for the one-active index, return `monthHasDraft`, caught outside the transaction (the `assignPlan` pattern).
3. Write the audit row.

**Replace:**
1. Re-read the old draft **under the lock**, scoped by organization. Return `notFound` if it is absent, `stale` if
   `withdrawnAt` is not null. A draft is editable only while active, so this alone rejects every stale edit: there is
   no in-place change for a revision token to detect.
2. Pre-generate the successor id (`cuid` via `createId` from the existing Prisma default, or `crypto.randomUUID()`;
   the column is `TEXT`).
3. **Set the old row's marker first:** `EDITED`, `withdrawnById` = actor, `withdrawnAt` = now, `supersededById` =
   successor id. It leaves the one-active index.
4. **Then insert the successor** with that id, the same student, and the new content.
5. Write the audit row, then commit. The deferred successor FK is checked at commit.

If the new month already has another active draft, step 4 raises P2002, the whole transaction rolls back (including
step 3), and the action returns `monthHasDraft`.

**Withdraw:**
1. Re-read under the lock exactly as in replace.
2. Set the marker: `WITHDRAWN`, actor, now, reason.
3. Write the audit row.

**Concurrent edits.** Two replacements or withdrawals of one draft serialize on the student lock. The second re-reads,
finds it withdrawn, and returns `stale`. If a future writer ever skips the lock, the 8b marker trigger refuses its
update: it never succeeds twice.

### 3.4 Audit (atomic, record only, never read as state)

| `action` | `entityType` / `entityId` | `before` | `after` |
|---|---|---|---|
| `duesOpeningItem.create` | `DuesOpeningItem` / new id | `DbNull` | `{ studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }` |
| `duesOpeningItem.replace` | `DuesOpeningItem` / old id | old content | `{ successorId, …new content }` |
| `duesOpeningItem.withdraw` | `DuesOpeningItem` / id | content | `{ reason }` |
| `duesReadinessConfirmation.record` | `DuesReadinessConfirmation` / new id | `DbNull` | `{ studentId, kind, candidate, sequence, binding, declaredNoOpeningDebt }` |

`academyId` is the student's home branch. The audit write is inside the same transaction as the change, so a failed
audit write rolls back the change and the reverse.

### 3.5 Paid legacy months and the "above-normal" warning: no new policy

- **A paid legacy month is never refused at write time.** The brief makes it a readiness concern:
  - **check 7 fails** for an active draft over a `PAID` legacy month with **no** link;
  - **a warning** is shown for a draft linked to a `PAID` row.
- **The "above-normal-charge warning" does not exist in code today** (searched `src`). Its only definition is the
  brief's §12 warning text: "an item amount above that month's legacy or plan amount". 8c implements that text as a
  **report warning**, never a refusal, comparing like currencies only:
  - **legacy:** the student has a legacy row for that month with a non-null amount in the draft's currency, and the
    draft amount is greater;
  - **plan:** the student's assignment effective for that month names a monthly plan whose terms effective for that
    month are in the draft's currency, and the draft amount is greater than that price. Effective versions are resolved
    with `latestEffective`, as the preview does.
  - **No reference:** when neither reference exists (no row, no assignment, a package plan, another currency), no
    amount warning is raised. Nothing is guessed.
- **Currency warning:** the draft currency differs from the currency of the plan terms effective for that month, when
  those terms exist.
- **Not checked:** a draft over a `PROMO`/`EXEMPT` legacy month, and a draft amount compared with anything else. The
  brief defines neither; this is stated, not invented.

## 4. Confirmations

### 4.1 Snapshot loading for the report

`loadReadinessSnapshot` adds `confirmations`:

```
{ id, studentId, candidateYear, candidateMonth, kind, sequence, fingerprintFormat, binding, declaredNoOpeningDebt, confirmedAt }[]
```

- **One read**, filtered by `organizationId`, inside the same REPEATABLE READ, READ ONLY snapshot.
- **Never in any fingerprint:** `fingerprint.ts` reads only named arrays, and a unit test proves adding confirmations
  changes no fingerprint.

### 4.2 The write protocol

`recordOpeningReview` and `acknowledgePricing` share one core, `recordConfirmation(context, studentId, S, kind, submitted)`.

1. **Before the transaction:**
   - authorize, and parse S (the same `isCandidateMonth` rule as the report);
   - require `binding` to match `^[0-9a-f]{64}$`, else `invalid`;
   - for an opening review, require `declaration` to be `noOpeningDebt` or `itemsAsShown`;
   - read the student and home branch, scoped.
2. **Transaction W** (READ COMMITTED, explicit):
   1. **Take the locks.** `lockBranchShared(home)`, then `lockStudent`; re-check the home branch (§3.1).
   2. **Read the reviewed content in ONE SQL statement on W's own connection, after the locks.** Call
      `loadReviewContentInTx(tx, organizationId, studentId, homeAcademyId)`: one `SELECT json_build_object(...)` whose
      scalar subqueries return, as JSON arrays:
      - **for the student:** the `Student` row, its `StudentStatusChange`, `StudentPlanAssignment`, `PaymentPeriod`,
        `MONTHLY` `DuesObligation`, `DuesCoverage` and `DuesOpeningItem` rows;
      - **for the home branch:** the `Academy` row and its `DuesPolicyVersion`, `PaymentPlan` and `PaymentPlanTerms`
        rows.

      Every subquery filters by `organizationId`. The column formats are the loader's:
      - amounts as `numeric(10,2)::text`, which gives the same two-decimal text as `Decimal.toFixed(2)`;
      - dates as `to_char(…, 'YYYY-MM-DD')`;
      - enums as text.

      The result is mapped into a `ReadinessSnapshot` holding only that student's and that branch's rows (other arrays
      empty), and active and withdrawn drafts are split exactly as `snapshot.ts` splits them. Then the unchanged
      `fingerprint.ts` functions compute:
      - `studentFp = studentFingerprint(content, studentId)`;
      - for pricing, `branchFp = branchFingerprint(content, home)`;
      - `fresh` = `openingReviewBinding(S, studentFp)` or `pricingAckBinding(S, studentFp, branchFp)`.

      Both fingerprints filter by student or branch id, so omitting other students' rows cannot change them. An
      equivalence test proves this (§6).
   3. **Compare.** If `fresh !== submitted.binding`, return `stale`.
   4. **Opening review only: the declaration.** `active` = the student's active drafts in that same statement's result.
      - `noOpeningDebt` requires `active.length === 0`, and stores `declaredNoOpeningDebt = true`.
      - `itemsAsShown` requires `active.length > 0`, and stores `false`.
      - A mismatch is `invalid`. The binding already proves the owner saw this exact draft set; the declaration makes
        the owner's statement explicit and checked.
   5. **Sequence.** In W, *after* the lock: `SELECT COALESCE(MAX("sequence"), 0) + 1` for the identity (organization,
      student, S, kind). Under READ COMMITTED this statement sees every confirmation committed before the lock was
      granted (proved in 8b).
   6. **Insert** with:
      - `fingerprintFormat: FINGERPRINT_FORMAT`;
      - `binding: fresh` (equal to the submitted one);
      - `studentFingerprint: studentFp`, and `branchFingerprint: branchFp` for pricing only;
      - the declaration;
      - `confirmedById` = actor.

      `confirmedAt` is display only.
   7. **Audit** row (§3.4), then commit. A P2002 on the sequence key (only possible for a writer that skips the lock)
      propagates as an error, never as success.

**Current and valid.** The current confirmation is the highest `sequence` for its identity; timestamps and ids are never
compared. It is valid iff `fingerprintFormat === FINGERPRINT_FORMAT` and `binding` equals the binding recomputed for the
report.

### 4.3 Consistency while legacy writers stay outside the protocol

**What the locks protect**, for this student and branch, from W's lock until its commit: every **participating**
writer is excluded. These are draft and confirmation writers (8c), status-history writers, `assignPlan`, the ledger
writers (all take the student lock), and the configuration writers (they take the branch row `FOR UPDATE`).

**What they do not protect** (verified on `eeabc0f`; none takes a branch or student lock):
- `recordPayment` and carry-forward (`PaymentPeriod`);
- the legacy plan writers (`PaymentPlan` name and active flag, both in the branch fingerprint);
- `location-service.ts` (branch timezone);
- `correctAssignment` (it locks only its future assignment row).

**The design does not claim the student lock covers any of these.**

**How the binding stays consistent anyway:**
- **One statement, one snapshot.** Under READ COMMITTED, PostgreSQL gives each statement one snapshot, taken when the
  statement starts, and every subquery in it uses that snapshot. The reviewed content therefore comes from one
  statement issued **after** both locks were granted. It describes a state that existed at one instant, never a mix of
  reads taken at different times (which the multi-statement loader would produce if run inside W under READ
  COMMITTED).
- **What that instant includes and excludes:**
  - every participating writer's commit from before the lock grant;
  - no participating writer's later work, because they are blocked by W's locks until W commits;
  - non-participating writes exactly as committed when the statement started.
- **Recorded only on a match.** It is recorded only if it equals what the owner reviewed.
- **A later non-participating write.** One can still commit after the statement started, before or after W commits.
  The confirmation is then simply stale at the next report. Validity is recomputed from a fresh REPEATABLE READ snapshot
  on every read, so such a confirmation is **never falsely valid later**.
- **What it cannot do:** prevent such a write.
- **Final activation concurrency protection stays stage 9's:** the gate lock across the §5 writer inventory, and a
  fresh organization-fingerprint comparison at effective activation.

### 4.4 Connection availability (why revision 1's second snapshot was dropped)

**Revision 1's problem.** It held W's pooled connection, and its locks, while `runReadOnlySnapshot` asked the pool for a
second connection. With the pool's `max` connections all taken by outer confirmation transactions, or by transactions
waiting on a student lock, none would be left for any snapshot. Every holder would then wait on the pool until its
timeout, with no row-lock conflict involved: a pool deadlock.

**Revision 2 never asks for a second connection while it holds one.** Every 8c action uses exactly one pooled
connection for its whole duration (W). The content read, the `MAX(sequence)` read, the insert and the audit all run on
it. Therefore:
- **progress is guaranteed with any pool size ≥ 1.** A transaction holding a connection needs nothing more from the
  pool. It either runs, or waits on a row lock held by another transaction that also needs nothing more from the pool
  and will finish;
- **requests beyond `max` wait in the pool's ordinary queue**, before any transaction or lock exists, and each proceeds
  as a connection is released. That is plain queuing, not a cycle;
- **no retry, timeout increase or pool-size change** is part of the design.

**Existing primitives considered first:**

| Option | Verdict |
|---|---|
| `runReadOnlySnapshot` inside W | rejected: the second connection described above |
| The full `loadReadinessSnapshot` inside W under READ COMMITTED | rejected: many statements, so many snapshots; a non-participating write could land between them |
| W at REPEATABLE READ | rejected: its snapshot is taken by the first statement, the lock request itself, before the lock is granted, so it misses participating commits made while it waited (shown by the 8b REPEATABLE READ test) |
| SERIALIZABLE | rejected: it shares that snapshot timing, and it needs serialization-failure retries, which are excluded |
| `runReadOnlySnapshot` before W, then W | rejected on its own: content could change between the two; making W safe would need the single statement anyway |
| **A single-statement read inside W** | **chosen** |

**The chosen design's tradeoffs:**
- **A second implementation of the reviewed-content read, limited to one student and one branch.** It must stay
  field-for-field equal to `loadReadinessSnapshot` for the fingerprinted columns. Mitigations:
  - **types:** it produces the same `ReadinessSnapshot` row types, so a field `fingerprint.ts` reads cannot be silently
    missing;
  - **an equivalence test (§6):** on a fixture with every fingerprinted field, nulls, both currencies, active and
    withdrawn drafts and promo rows, `studentFingerprint` and `branchFingerprint` from `loadReviewContentInTx` equal
    those from `loadReadinessSnapshot` for every student and branch;
  - **mutations:** removing any one covered column from the statement fails that test;
  - **format changes:** any future change of covered fields (format `r3`) must change both, and the test enforces it.
- **The read is SQL text, not Prisma queries.** It is held to the same organization scoping and reviewed by the same
  catalog of fields.
- **Cost:** one statement over one student and one branch, cheaper than revision 1's whole-organization load.

## 5. Readiness integration (`evaluate.ts`)

`identity(S, kind)` = the current (highest-`sequence`) confirmation for that student, S and kind. *Valid* is as defined
in §4.2.

| # | Key | Status | Pass when | Fail items |
|---|---|---|---|---|
| 6 | `pricingAcknowledged` | **computed** | every promo/exempt student (8a's existing definition: any legacy row `PROMO`, `EXEMPT` or `promoRecurring`) has a valid current `PRICING_ACKNOWLEDGED` for S. Zero such students passes | `student:<id>` with reason `missing` or `stale` |
| 7 | `openingItemsOverPaidMonths` | **computed** | no **active** draft has a `PAID` legacy row for the same student and month while its `legacyPaymentPeriodId` is null | `openingItem:<id>` |
| 8 | `openingItemsBeforeStart` | **computed** | no **active** draft has a month ≥ S | `openingItem:<id>` |
| 9 | `openingReviewed` | **computed** | every student whose `Student.status` is currently `ACTIVE`, plus every student with an active opening draft (U1, recorded), has a valid current `OPENING_REVIEWED` for S | `student:<id>` with `missing` or `stale` |
| 10–12 | unchanged | `notImplemented` | — | — |
| 13 | unchanged | `decisionPending` | — | — |

**Consequences:**
- **`ready` stays false**, because 10–12 and 13 can never pass in 8c. A test pins this with every check 1–9 passing.
- **No revival:** the r2 draft-history contribution is untouched, so add/withdraw, edit/withdraw and edit/revert keep
  stale reviews stale. The 8b regression tests stay as they are, and new ones run through the actions.
- **Warnings** (`report.warnings`, keys added beside the existing `notEligibleForStart`):
  - `openingItemLinkedToPaidRow`;
  - `openingItemAboveReference` (legacy or plan, §3.5);
  - `openingItemCurrencyDiffersFromPlan`.
- **Report additions:**
  - `confirmations`: one entry per student, giving `openingReview` and `pricingAck` as `{ state: valid | stale |
    missing, sequence?, confirmedAt?, declaredNoOpeningDebt? }`;
  - `preview.openingDrafts`: active-draft count and total per branch and currency, in exact minor units via the
    already-approved `ledger/minor-units`, never summed across currencies (brief §10).
- **MONTHLY preview unchanged:** `preview.students`, `preview.branches` and the `wouldCreate` totals are untouched. The
  8a equivalence test with the real monthly writer stays as is.

## 6. Verification (isolated test databases only)

**Authorization and isolation:**
- an owner succeeds;
- Directors and Instructors get `notFound`;
- an owner of another organization gets `notFound` with the existing `organization.accessRefused` audit row, and no
  draft, confirmation or other audit row;
- a student, draft or legacy row of another organization gets `notFound`;
- a forged actor field is ignored (`createdById` and `confirmedById` are the session user).

**Validation.** Every rule in §3.2, at its boundaries:
- amount `0`, `0.001`, `1,000`, a sign, and 100,000,000;
- an unknown currency;
- note and reason blank and at 501 characters (500 accepted);
- month 0, 13 and a future month (relative to a pinned clock in the branch timezone);
- legacy link:
  - another organization's row, or a nonexistent id → `notFound`, with no draft and no audit row;
  - this organization's row for another student, or for the same student in another month → `invalid` with
    `fieldErrors.legacyPaymentPeriodId = ["mismatch"]`;
  - the matching row → accepted;
- a malformed binding;
- a wrong declaration.

**Draft operations:**
- **same- and changed-month replacement** leaves one active draft and the old content unchanged;
- **a successor collision** (new month occupied) rolls back the marker: the old draft is still active, there is no audit
  row, and the result is `monthHasDraft`;
- **stale replace and withdraw** of an already-withdrawn draft return `stale`;
- **concurrency:**
  - two concurrent replacements, or a replacement against a withdrawal: exactly one succeeds and the other returns
    `stale`. A real lock wait is verified with `pg_blocking_pids`, and each hold is released in `finally`;
  - two concurrent creates for one month: one succeeds and one gets `monthHasDraft`.

**Confirmations:**
- **stale on student content:**
  - a legacy row edited through the real `recordPayment` after the binding was read → `stale`;
  - a draft added, then withdrawn → `stale`;
  - a status change → `stale`;
- **stale on branch content, for pricing:**
  - a D25 terms correction through the real config action → `stale`;
  - a plan rename through the real legacy plan action → `stale`;
- **explicit no debt:**
  - accepted only with zero active drafts; the report's check 9 passes;
  - a draft then added makes it `stale` and check 9 fails;
  - withdrawing the draft does **not** revive it.
- **ordering:**
  - two concurrent confirmations for one identity get sequences 1 and 2, in lock-grant order;
  - the one current in the report is sequence 2;
  - a confirmation and a draft write for one student serialize, and the confirmation either sees the draft (binding
    refused if the owner had not seen it) or precedes it (and is stale afterwards).
**Three separate properties, each tested on its own.**

*A. Transaction ordering* (the student lock and `sequence`):
- **A1.** Three concurrent `recordOpeningReview` calls for one student and one S, all with the correct binding:
  - each later call is verified waiting on the first holder (`pg_blocking_pids`);
  - all three commit, with sequences 1, 2 and 3 in lock-grant order;
  - the report's current confirmation is sequence 3.
- **A2.** A confirmation and a `createOpeningDraft` for one student, concurrently:
  - they serialize on the student lock;
  - if the draft commits first, the confirmation's binding (computed before the draft existed) is refused as `stale`;
  - if the confirmation commits first, it is stale in the next report.
- **A3.** A confirmation and a `replaceOpeningDraft` for one student: the same two outcomes, never an accepted
  confirmation over content the owner did not see.

*B. Snapshot consistency* (the single statement):
- **B1. Equivalence.** On a fixture covering every fingerprinted field, `loadReviewContentInTx` and
  `loadReadinessSnapshot` give equal `studentFingerprint` and `branchFingerprint` for every student and branch.
- **B2. Non-participating writes before the statement are seen.** A test-only hook between the lock grant and the
  statement commits a legacy edit through the real `recordPayment`, which takes no student lock. The fresh binding
  includes it, so a binding computed before that edit is refused as `stale`.
- **B3. Non-participating writes after the statement are not seen.** A legacy edit committed after the statement (a
  hook between the content read and the insert):
  - the confirmation is recorded with the pre-edit binding;
  - the next report shows it stale;
  - it never revives.
- **B4. No mix within one statement.** This is PostgreSQL's per-statement snapshot rule, not something a test hook can
  interleave. It is documented and relied on, and covered indirectly by B1–B3.

*C. Connection availability* (no nested acquisition). These tests run the actions against a test-only client whose
`PrismaPg` pool is constrained (`max: 1`, then `max: 2`), injected the way the 8a integration test already replaces
`@/lib/prisma`. Observers use the separate test client, so the observation never consumes the constrained pool.
- **C1. Pool of 1:**
  - a single `recordOpeningReview` and a single `acknowledgePricing` both complete;
  - each create, replace and withdraw completes.

  Revision 1's design hangs here until its transaction or pool timeout, so this test fails against it.
- **C2. Pool of 2, six concurrent confirmations:** three for one student and identity, three for three other students.
  - all six complete, with no pool-acquisition error (Prisma `P2024`) and no transaction timeout, under the action's
    ordinary timeout;
  - the same-student three get sequences 1–3; the others get 1 each.
- **C3. Pool of 2, a same-student confirmation and two draft writes concurrently:** all complete, ordered as in A2 and
  A3.

C proves connection availability only. Ordering is proved by A and content consistency by B.

**Atomicity and rollback:** a test-only `deps` hook throws after the change and before the audit write, and again after
the audit write. Each time, no draft or marker change, no confirmation and no audit row persists.

**No financial effect:**
- counts of `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`, `DuesSettlement` and `PaymentPeriod` are
  unchanged across every action, and the linked legacy row is byte-identical;
- the existing writers' test suites pass unchanged;
- the ledger-exposure test admits only `lockBranchShared`.

**Readiness:**
- each pass and fail condition of checks 6–9;
- the three warnings, including the no-reference and different-currency cases, where no amount warning is raised;
- confirmation state `valid`, `stale` and `missing`;
- opening totals per currency;
- `ready` false with checks 1–9 passing;
- the 8a equivalence test and the MONTHLY totals unchanged.

**Red before green:**
- the action tests fail before `opening-core.ts` exists;
- checks 6–9 tests fail on the 8a `evaluate.ts`.

**Mutations** (each applied, run, reverted, and recorded in the README):

| Mutation | Expected to be caught by |
|---|---|
| successor inserted before the marker | the reverse-order refusal |
| active re-read skipped | `stale` expected, the database refusal surfaces as an error instead |
| binding computed **before** the locks | the concurrent confirmation versus draft test |
| content read with the multi-statement loader inside W | B2/B3 with a hook between the loader's reads |
| content read through `runReadOnlySnapshot` inside W (revision 1) | C1 (pool of 1) |
| one fingerprinted column dropped from the single statement | B1 equivalence |
| content read before the locks | A2 |
| a cross-organization legacy row returns `invalid` instead of `notFound` | the legacy-link validation test |
| `MAX(sequence)` read before the lock | the ordering test |
| declaration not checked against the drafts | the explicit no-debt test |
| check 9 picks the latest confirmation by `confirmedAt` | the ordering test in the report |
| check 6 ignores the branch fingerprint | the D25 pricing test |
| check 7 ignores the link | — |
| check 8 uses `>` instead of `≥` | — |
| audit written outside the transaction | atomicity |
| actor taken from the form | the forged-actor test |
| organization scoping dropped from the draft or legacy read | the cross-tenant tests |

The four rows marked "—" have their own direct pass/fail tests.

**Checks:** `tsc`, `lint`, `check:guard-usage`, `check:pending-callers`, `db:check-drift` (isolated shadow on 5433), unit,
integration, and CI parity.

## 7. Decisions

**U1, recorded.** An opening review is required for every student whose `Student.status` is currently `ACTIVE`, plus
every student with an active opening draft (whatever their status).
- **What it is:** only the set of students check 9 lists.
- **What it is not:** current `ACTIVE` status does **not** decide monthly eligibility or what S would charge. The
  existing history-based preview stays authoritative for that, with `eligibleAndAssigned` over status history before
  G(S) and checks 1–5 unchanged.
- **The two can differ:** a currently `ACTIVE` student may be `UNDECIDABLE` or not eligible for S in the preview. They
  still need an opening review, which concerns debt from before S, not eligibility for S.

**Nothing else is open.** Everything else in this plan follows the brief, the 8b schema, or an existing convention named
above, or it is a technical choice stated with its reason:
- the write-time "not after the current month" bound;
- allowing a pricing acknowledgement for any student;
- the single-statement content read on the write transaction's own connection (§4.2–§4.4).

O4 stays undecided and keeps check 13 `decisionPending`; it is not reopened here.
