# Dues stage 8 PR 8c — owner actions for opening-debt drafts and readiness confirmations — verification

**Base:** main `eeabc0f0f77ae0b571974c942e7c6839d7c90033` (8a and 8b merged).
**Contract:** `docs/dues/STAGE-8C-IMPLEMENTATION-PLAN.md` (revision 2), `docs/dues/STAGE-8-READINESS-BRIEF.md` (§12 updated).

**Not changed:** no schema or migration, screen, route, scheduler, ledger charge, activation or existing financial writer.
`index.ts` (`getDuesReadinessForOwner`) and `fingerprint.ts` (format stays `r2`) are untouched. The MONTHLY preview code
is untouched; its output is pinned equal by tests. The 8a authorization-audit exception is preserved: a cross-organization
refusal still writes `organization.accessRefused`.

## What was built

- **`src/lib/dues/readiness/opening-actions.ts`** (`"use server"`): exactly five actions:
  - `createOpeningDraft`, `replaceOpeningDraft`, `withdrawOpeningDraft`;
  - `recordOpeningReview`, `acknowledgePricing`.

  Authorization comes first: owner (`ADMIN`) of this organization only. A non-member gets `notFound` with the existing
  audit row; a Director's `FORBIDDEN` is mapped to `notFound`. The actor is always the session user. Fields are read one
  by one from FormData.
- **`src/lib/dues/readiness/opening-core.ts`** (plain module):
  - parsing (money via `parseMoney`, month via `parseEffectiveMonth`, note and reason 1–500 code points);
  - the legacy-link contract;
  - the transactional cores;
  - the single-statement `loadReviewContentInTx`;
  - the audit rows;
  - test-only hooks (`afterLocks`, `afterContentRead`, `beforeAudit`, `afterAudit`, `now`), which the actions never
    pass.
- **Every write:** one `READ COMMITTED` transaction (explicit `isolationLevel`), branch `FOR SHARE` then student
  `FOR UPDATE`, and its `AuditLog` row in the same transaction.
  - **Replace:** marks the predecessor `EDITED` (naming a pre-generated successor id) **before** inserting the successor.
  - **Stale edits:** only an active draft can be replaced or withdrawn; this is re-read under the lock.
- **Confirmations:**
  1. after the locks, ONE parameterized SQL statement reads the student's and home branch's reviewed content on the
     transaction's own connection;
  2. the unchanged `fingerprint.ts` functions compute the binding, and the submitted binding must equal it, else
     `stale`;
  3. for an opening review the declaration must match the active drafts in that same result;
  4. then `MAX(sequence)+1` is read **after** the lock and inserted.
- **`snapshot.ts`:** loads all confirmations; they are in no fingerprint.
- **`evaluate.ts`:**
  - checks 6–9 computed, with U1 for check 9;
  - per-student confirmation state (`valid` / `stale` / `missing`, current = highest `sequence`);
  - the three brief §12 warnings;
  - `openingDrafts` totals per branch and currency.

## Findings during implementation

1. **A report-breaking defect, found by the integration tests and fixed.**
   - **What failed:** opening totals first used `minorToDecimal`, which is bounded by one column's range
     (99,999,999.99). A total of several drafts can legitimately exceed it, for example a 99,999,999.99 CRC draft plus
     another. `getDuesReadinessForOwner` then **threw** for the whole organization.
   - **Fix:** `evaluate.ts` formats sums with `totalToDecimal`, which is exact for any safe integer.
   - **Regression:** a unit test with a total of 100,000,000.01 (mutation M17 below).
   - **Not fixed (out of scope):** the 8a MONTHLY `wouldCreate` totals use the same bounded function, so a branch whose
     MONTHLY total for S exceeds 99,999,999.99 in one currency would make the report throw. That is about 4,000
     students at ₡25,000. It was left unchanged, because this PR must not change MONTHLY preview behaviour. It is
     recorded for a separate fix.
2. **Two plan expectations were wrong and corrected in tests, not code.**
   - **Lock-wait chain:** a third concurrent request for one student waits behind the *second* request's tuple lock,
     not directly behind the holder. Lock-wait verification now follows the blocking chain.
   - **Behavioural reach:** the plan expected B2/B3 to catch "multi-statement loader inside W" behaviourally. The core
     exposes no pause between the loader's statements, so no behavioural test can interleave it. That design rule is
     guarded by a **structural** test instead (below), and is labelled as such.
3. **One plan mutation needed a new test.** "Audit written outside the transaction" survived the "failure before the
   audit" and the real-audit-failure tests: an outside audit row is only exposed by a failure *after* it. An
   `afterAudit` hook and test were added, and the mutation is now caught.

## Tests

### `tests/integration/dues-opening-actions.test.ts` (new, 32 tests, real isolated test database)

**Authorization:**
- the owner succeeds; the actor is the session user even when the form names another user, organization or
  `withdrawnById`;
- a Director and an anonymous caller get `notFound` for every action, with nothing written;
- another organization's owner gets `notFound`, the existing `organization.accessRefused` row is written, and nothing
  else;
- a foreign student or draft is `notFound`.

**Validation:**
- amount `0`, `0.00`, `0.001`, `1,000`, signed and `100000000`; currency `EUR` and empty; note blank and 501 characters;
  month 0, 13 and year 1999 → `invalid` naming the field;
- 2100-12 → `coverageMonth: ["future"]`;
- 99,999,999.99 and a 500-code-point note (`é`×500, trimmed) are accepted.

**Legacy-link contract:**
- another organization's row, or a nonexistent id → `notFound`;
- this organization's row for another student, or another month → `invalid` `{ legacyPaymentPeriodId: ["mismatch"] }`;
- the matching row → accepted.

**Draft operations:**
- same-month and changed-month replacement leave one active draft; the predecessor is `EDITED` with its content
  unchanged; one audit row per replace;
- replacing into an occupied month → `monthHasDraft`, with the marker rolled back, no successor and no audit row;
- a withdrawn draft can be neither withdrawn nor replaced (`stale`); a blank reason is `invalid`.

**A. Ordering:**
- two edits of one draft at once: the second waits at the student lock (verified), then gets `stale`; one successor
  exists;
- two creates for one month: `ok` and `monthHasDraft`;
- **A1:** three concurrent reviews of one identity → sequences 1, 2, 3; the report's current one is 3;
- **A2:** a draft committed first → the waiting confirmation is `stale`; a confirmation committed first → stale after the
  draft;
- **A3:** a replacement committed first → the waiting confirmation is `stale`.

**Stale reviews:**
- after a legacy payment recorded through the **real `recordPayment`**;
- after a status change;
- pricing, after a D25 terms correction through the **real `correctPlanTerms`**, and after a plan rename through the
  **real legacy `updatePlan`**: stale in the report, and resubmitting the old binding is refused.

**Explicit no debt and no revival:**
- accepted only with zero active drafts; a contradicting declaration is `invalid`;
- valid, then `stale` after a draft is added; **still `stale` after that draft is withdrawn**, and check 9 lists the
  student again; the old binding is refused on resubmission;
- edit then revert through the actions → `stale`.

**B. Single-statement read:**
- **B1, equivalence:** inside a rolled-back transaction, a rich fixture: a second branch in another timezone with CRC
  terms (two versions, 1 and 3 months) and an inactive plan; a policy with `maxPrepaidMonths` and a zero fee; status
  rows with equal dates; null and real assignments; legacy rows `PAID`, `PENDING` with a null amount, `PROMO` with a
  non-ASCII name and `promoRecurring`, and `EXEMPT` in CRC; a MONTHLY obligation with its coverage; drafts `EDITED` with
  a CRC successor and a non-ASCII note, active with a link, and `WITHDRAWN`. `studentFingerprint` and
  `branchFingerprint` from `loadReviewContentInTx` equal the report loader's for **every** student and branch.
- **B1, scoping:** asked for another organization, the content is empty.
- **B2:** a non-participating write (a legacy row, which takes no student lock) committed after the lock grant but
  before the statement is **seen**:
  - the pre-edit binding is `stale`;
  - the post-edit binding is accepted and stored.
- **B3:** a non-participating write committed after the statement is **not** in the stored binding; the next report shows
  `stale`.

**C. Connection availability.** Each action ran on a client whose pg pool was constrained to 1 or 2 connections:
- **C1:** with a pool of **1**, all five actions complete;
- **C2:** with a pool of **2**, six concurrent confirmations (three for one identity, three for other students) all
  complete, the same identity gets sequences 1–3, and the pool never exceeded 2 connections;
- **C3:** with a pool of **2**, a confirmation and two draft creates for one student complete; the confirmation is
  `ok` or `stale`, and never valid over drafts it did not see.

**Atomicity:**
- an injected failure before the audit row, and another after it (still in the transaction), leave no draft, marker,
  confirmation or audit row;
- a **real** audit-insert failure (a test-only `BEFORE INSERT` trigger on `AuditLog` scoped to this organization,
  dropped in `finally`) rolls back the draft and the confirmation.

**No financial effect and the report:**
- every action leaves the `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`, `DuesSettlement` and
  `PaymentPeriod` counts unchanged, and the linked legacy row byte-identical;
- the report: checks 10–12 `notImplemented`, 13 `decisionPending`, `ready` false; the linked-PAID warning and the
  opening totals appear.

### `tests/unit/dues-readiness.test.ts` (66 tests; 13 new)

- **Confirmations:** confirmation records are in no fingerprint. With checks 1–9 all passing, `ready` is still false
  (10–12 `notImplemented`, 13 `decisionPending`).
- **Check 9 (U1):** an inactive student is listed only with an active draft; withdrawing that draft does not revive the
  earlier review.
- **No revival:** an added draft makes a no-debt review stale, and add-then-withdraw does not revive it.
- **Current confirmation:** the highest `sequence` wins with equal timestamps and with an older timestamp. An `r1` row
  is stale, and another S is missing.
- **Check 6:** passes with a valid acknowledgement; a price or policy change on the student's branch makes it stale; a
  change on another branch does not.
- **Check 7:** fails over PAID without a link; passes and warns with the link; ignores PENDING and withdrawn drafts.
- **Check 8:** S fails; S−1 passes; withdrawn drafts are ignored.
- **Warnings:**
  - above the legacy amount and above the plan price, each alone;
  - equal is not above;
  - no reference, no warning;
  - another currency is never compared (a USD draft larger than a CRC legacy amount does not warn);
  - the currency-differs warning is raised only when terms exist.
- **Totals:** per branch and currency, active drafts only; the MONTHLY preview is deep-equal; the >99,999,999.99
  regression.
- **Updated to the new contract:**
  - checks 6–9 were `notImplemented` and are now computed (the 8a/8b assertions changed accordingly);
  - check 6 now *fails* listing promo students instead of `notImplemented`.

### Structural (`tests/unit/dues-readiness-not-exposed.test.ts`, `dues-ledger-not-exposed.test.ts`)

- `opening-actions.ts` is `"use server"` and exports exactly the five names (no re-exports or default).
- `opening-core.ts` is not `"use server"`.
- Ledger imports: the core imports only `common:lockBranchShared`; the actions import nothing from the ledger.
  `opening-core.ts` is one named `AUTHORIZED_CALLERS` entry.
- `opening-core.ts` never references `loadReadinessSnapshot` or `runReadOnlySnapshot` and does call
  `loadReviewContentInTx(tx,` (plan §4.4).
- All five actions are registered in `scripts/pending-callers.ts`.
- The 8a read-only files keep every original assertion.

## Red before green, and mutations

**Red before green.** The 13 new unit tests were run against main's `evaluate.ts` (8b): **14 failed** (the 13 new tests
and the updated contract test). This is behavioural failure, not a missing module: the snapshot type is the new one.

**Mutations.** Each was applied by an exact substitution (aborting if the pattern did not apply), the targeted tests
were run, and the file was restored and verified byte-identical.

| # | Mutation | Caught by |
|---|---|---|
| M1 | successor inserted before the predecessor's marker | same/changed-month replacement; A3 |
| M2 | active re-read skipped | withdrawn draft not replaceable (stale); two concurrent edits |
| M3 | confirmation content read **before** the locks | A2; A3 |
| M4 | content via the multi-statement loader inside W | **structural only** (no behavioural hook can interleave one statement) |
| M5 | revision-1 design: content via a nested `runReadOnlySnapshot` inside W | **C1** (pool of 1): "transaction expired… timeout 5000 ms, 5022 ms passed"; and structural |
| M6 | `MAX(sequence)` read before the lock | A1; C2 |
| M7 | declaration not checked against the drafts | confirmation-inputs test |
| M8 | current confirmation chosen by `confirmedAt` | highest-sequence unit test |
| M9 | pricing acknowledgement accepted without matching | check 6 unit test |
| M9b | old fingerprint format accepted | highest-sequence unit test (`r1` case) |
| M10 | check 7 ignores the explicit link | check 7 unit test |
| M11 | check 8 uses `>` instead of `≥` | check 8 unit test |
| M12 | audit written outside the transaction | the after-audit atomicity test (added for this) |
| M13 | actor taken from the form | forged-actor test |
| M14 | cross-organization legacy row returns `invalid` | legacy-link contract test |
| M15 | single statement: the student read not organization-scoped | B1 scoping test |
| M16 | single statement: a covered column dropped (`promoRecurring`) | B1 equivalence |
| M16b | single statement: withdrawn drafts treated as active | B1 equivalence |
| M17 | opening totals via the column-bounded `minorToDecimal` | the >99,999,999.99 regression |
| M18 | check 9 ignores students with drafts | U1 unit test |
| M19 | amount warning compared across currencies | warnings unit test. It **survived** at first, and the missing case was added |

## Checks run (isolated test databases only)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm lint` | 0 errors, 23 warnings (identical to the base; none in changed files) |
| `pnpm check:guard-usage` | all 80 guards have a production call site |
| `pnpm check:pending-callers` | exit 0; the five actions listed |
| `pnpm test:unit` | 131 files, 1936 tests passed |
| `pnpm test:integration` | 169 files, 2250 tests passed (full suite, isolated test database) |
| `pnpm db:check-drift` | both comparisons clean (test database, scratch shadow on 5433, dropped afterwards); no schema file changed |

**Environment note:** the local Docker daemon was stopped at the start of the integration runs. Docker Desktop was
started and only the test container was brought up by `pnpm db:test:up`. The dev container auto-started under its own
restart policy; nothing in this work connected to or wrote to it.

## Deviations from the plan

1. **`openingDrafts` placement.** It is at report top level, not `preview.openingDrafts`, so the MONTHLY `preview`
   object stays deep-equal (tests pin this).
2. **Fail items for checks 6 and 9** are `student:<id>`. The `missing` or `stale` reason is in
   `report.confirmations[].{openingReview,pricingAck}.state`, not encoded in the item string.
3. **Transaction timeouts:** Prisma's defaults (5 s timeout, 2 s maxWait). No explicit timeout was set, so nothing was
   raised to hide contention, and the constrained-pool tests ran under the defaults.
4. **Successor id:** `crypto.randomUUID()` (`TEXT` column).
5. **Test-only hooks:** an `afterAudit` hook was added beyond the plan (finding 3).
6. **No `revalidatePath`.** No page exists until 8d.

## Limitations (bounded claims)

- **C establishes only its scenarios:** pools of 1 and 2 and the request mixes above. It says nothing about unlimited
  concurrency or production capacity. What it does establish structurally is that no 8c action asks for a second pooled
  connection while it holds one.
- **Non-participating writers are not locked.** These are legacy payments and carry-forward, legacy plan writers, the
  branch-timezone writer and `correctAssignment`.
  - **When their changes surface:** a confirmation goes stale once their resulting content differs from its binding,
    and only then. A change that leaves covered content equal to what was bound (for example, an edit followed by a
    revert) is not detected, by design, because validity is about content, not history.
  - **What is not claimed:** that every historical edit is permanently detectable.
- **Single-statement consistency** is PostgreSQL's per-statement snapshot rule. It is relied on and documented, and
  covered indirectly (B1–B3) and structurally (M4), not by interleaving inside the statement.
- **Activation:** final concurrency protection for activation remains stage 9's gate.
- **The 8a MONTHLY total bound** (finding 1) is unfixed here by scope.
