# Dues stage 8 PR 8a — read-only readiness report — verification

**Base:** main `61d95f5`.
**Contract:** `docs/dues/STAGE-8-READINESS-BRIEF.md` (revision 3, with the two clarifications below) and
`docs/dues/STAGE-8A-IMPLEMENTATION-PLAN.md`.

**Not changed:** no table, migration, screen, cron, gate lock, charge or activation; no existing writer, reader or
consumer.

## What was built

- **`runReadOnlySnapshot`** (`src/lib/db/read-only-snapshot.ts`):
  - one interactive transaction whose first statement is `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
  - `SHOW` reads both settings back and aborts if either is wrong.
- **`loadReadinessSnapshot`** (`src/lib/dues/readiness/snapshot.ts`):
  - plain reads, no locks, each filtered by `organizationId`;
  - covers students, status rows, assignments, legacy `PaymentPeriod`, branches, plans, terms, policies, and existing
    `MONTHLY` obligations and coverage;
  - amounts as `toFixed(2)`, dates as `YYYY-MM-DD`.
- **Fingerprints** (`fingerprint.ts`): SHA-256 over canonical JSON (sorted keys, rows by id, format tag `r1`), for the
  student, branch and organization, plus the two confirmation bindings stage 8c will store. Pricing acknowledgement
  includes the branch fingerprint.
- **`evaluateReadiness`** (`evaluate.ts`), pure:
  - the preview mirrors `generateMonthlyObligationForStudent` → `createMonthlyObligationInTx` in order, using
    `eligibleAndAssigned`, `latestEffective` and `ledger/minor-units`;
  - totals per branch and per currency;
  - checks 1–5 computed, 6–12 `notImplemented` (check 6 lists the promo/exempt students), 13 `decisionPending`;
  - `ready` is true only if every check is `pass`.
- **`getDuesReadinessForOwner`** (`index.ts`):
  - validates the month, then requires `ADMIN` of that organization;
  - a non-member, unauthenticated caller or another role gets `notFound` (the existing `FORBIDDEN` error is mapped;
    other errors propagate);
  - not a `"use server"` file; registered in `scripts/pending-callers.ts`.

**Deviation from the plan:** the `server-only` package is not installed and no dependency was added. Browser exposure is
guarded by `tests/unit/dues-readiness-not-exposed.test.ts`: no `"use server"`/`"use client"`, no importer outside the
folder, no Prisma write, lock call or writer call.

## Two documentation clarifications (brief revision 3, as instructed)

1. The upper limit on manual activation (no later than the first due date of S) is now a **proposal pending stage 9
   approval**, not an approved decision.
2. Check 12 requires the stage 9 activation **mechanism** to be implemented and available. It does **not** require the
   organization to be activated already.

The brief also now records that `PaymentPeriod` has `recordedAt`, not `createdAt`.

## Tests

**Unit — `tests/unit/dues-readiness.test.ts` (40):**
- **Determinism:** reversed row and key order give the same hash.
- **Sensitivity**, each edit changing only the right fingerprint:
  - legacy status, amount, currency and promo flag edited in place;
  - a new carry-forward row;
  - status rows, assignment and `Student.status`;
  - existing obligations;
  - terms price and currency; policy due day, fee and prepayment limit; plan name and active; timezone;
  - organization currency and candidate month.
- **Bindings:** a branch change invalidates the pricing acknowledgement but not the opening review.
- **Checks 1–5,** pass and fail each:
  - strict "before the 1st";
  - a same-day tie broken by `sequence`;
  - a branch without a policy; package plans and a currency mismatch as configuration gaps;
  - a future assignment, an explicit "no plan", another branch's plan;
  - legacy rows ≥ S.
- **Never ready:** checks 6–12 `notImplemented` and 13 `decisionPending` even when 1–5 pass.
- **Preview:** per-currency totals, the writer's classification order, and the version effective for S.

**Unit — `tests/unit/dues-readiness-not-exposed.test.ts` (8).**

**Existing structural guards, deliberately extended.** The first full unit run failed two of them, which is correct:
`dues-ledger-not-exposed` and `dues-eligibility-not-exposed` require every new importer to be named.
- `src/lib/dues/readiness/evaluate.ts` was added to both approved-caller lists, with the reason: only pure
  `latestEffective`, minor units and `eligibleAndAssigned`, no writer.
- `index.ts` was changed to validate the month with the pure `assertYearMonth` (plus the same 2000–2100 range), so it no
  longer imports `create-monthly-obligation.ts` at all.

**Integration — `tests/integration/dues-readiness.test.ts` (12, isolated test DB):**
- **The database enforces the snapshot:** `SHOW` reads back `on` and `repeatable read`, and an `UPDATE` inside is
  refused with "read-only transaction".
- **Snapshot isolation:** a row committed by another connection between two reads inside one snapshot is not seen.
- **Loader:** a legacy row edited in place (same id, same `recordedAt`) between the loader's first and later reads is
  invisible to that report. The next report changes that student's fingerprint and the organization's, and not another
  student's.
- **Price correction:** an in-place price correction changes the branch fingerprint.
- **Authorization:**
  - the owner gets a report, `ready: false`, with 6–12 `notImplemented` and 13 `decisionPending`;
  - a Director, another organization's owner and an unauthenticated caller each get `notFound`;
  - an invalid month gets `invalid`.
- **Isolation:** another organization's student and branch ids never appear.
- **No writes:** row counts of `PaymentPeriod`, obligations, coverage, late fees, status rows, assignments, terms,
  policies and `AuditLog` are unchanged after two calls.
- **Equivalence:** `@/lib/prisma` is pinned to one outer transaction, and the **real** `generateMonthlyObligationForStudent`
  runs for each of 9 fixture students with an injected active stub and its clock inside S. The transaction is then
  rolled back.
  - The fixture reaches all 7 categories: created, `UNDECIDABLE`, `NOT_ELIGIBLE`, `NO_ASSIGNMENT`, `currencyMismatch`,
    `inapplicable`, `noEffectiveVersion`.
  - The preview matches every student's outcome and amount/currency.
  - Afterwards 0 obligations and 0 coverage rows remain.

**Found during testing:** the first equivalence run, without the writer's clock in S, returned `futureMonth` for every
eligible student. The writer refuses a month later than its own clock. The preview predicts the run during S, so the
test now sets the writer's clock inside S, and the preview's comment says why `futureMonth` is not mirrored. This was a
test-setup gap, not a preview defect.

## Mutations (each applied alone, both suites run, files restored byte-identical by sha256)

| Mutation | Caught by |
|---|---|
| M1: snapshot `READ ONLY` without `REPEATABLE READ` | runtime guard: 8 integration tests fail |
| M1+M1b: same, with the `SHOW` guard silenced | behaviour tests: 3 integration tests fail (DB settings, mid-snapshot visibility, loader mid-load edit) |
| M2: fingerprint omits legacy `status`/`amount` | 2 unit + 1 integration |
| M3: `ready` treats `notImplemented`/`decisionPending` as passing | 1 unit |
| M4: a Director authorized | 1 integration (Director gets `notFound`) |
| M5: preview skips the currency-mismatch rule | 1 unit + 1 integration (equivalence) |
| M6: loader reads students across organizations | 6 integration, including isolation |
| M7: check 1 uses `<=` instead of `<` against the 1st of S | 1 unit |

## Checks (isolated test database only)

`tsc --noEmit`, lint, `check:guard-usage`, unit and integration. The results are in the PR body.

## Limits of the evidence

- **Equivalence** covers the categories reachable before activation. `alreadyCovered` is covered by the unit tests only:
  creating real obligations needs activation, and ledger rows cannot be deleted afterwards.
- **The equivalence fixture** uses one branch and one policy; multi-branch classification is unit-tested.
- **The snapshot** gives one consistent report. It does not stop writes afterwards; that is stage 9's gate.
- **The report never says ready on current code.** Checks 6–13 require later PRs, the scheduler, the O2 writer, the
  stage 9 mechanism and the O4 decision.
- **Not run:** no real organization data, no normal-dev or production database, no deployment.
