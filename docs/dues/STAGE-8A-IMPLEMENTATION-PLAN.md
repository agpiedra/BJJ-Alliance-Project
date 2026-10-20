# Stage 8 PR 8a — implementation plan

**Status:** plan only, awaiting review. Implements nothing yet.
**Base:** `main` @ `61d95f53ce2876dde4917313141478e911eee3b7`.
**Contract:** `docs/dues/STAGE-8-READINESS-BRIEF.md` (revision 3), §4, §10, §11, §12.

**Goal:** a read-only, owner-only function that, for one organization and a candidate start month S, returns:
- deterministic content fingerprints;
- a dry-run preview;
- the readiness checks, each `pass` / `fail` / `notImplemented` / `decisionPending`.

All are computed from one consistent database snapshot over **current tables only**.

## Global constraints

- **Read-only.** No schema, migration, data write, cron, UI, server action or activation. No change to any existing
  writer, reader or consumer.
- **Not a `"use server"` file.** Nothing new is callable from a browser.
- **Owner only.** Authorization is `resolveActionContext(organizationId, ["ADMIN"])`; anyone else gets the uniform
  `notFound`. Every query filters by `organizationId` explicitly.
- **Currency.** No sum, average or comparison across currencies. Exact integer minor units via
  `src/lib/dues/ledger/minor-units`.
- **Never falsely ready.** `ready` is true only when every check is `pass`. In 8a it is **always false**, because checks
  6–12 are `notImplemented` and 13 is `decisionPending`.
- **No parallel decision logic.** It reuses `eligibleAndAssigned` (`src/lib/dues/eligibility.ts`) and `latestEffective`
  (`src/lib/dues/ledger/common.ts`). The locking resolvers (`resolveMonthlyConfigCandidateInTx`,
  `writeMonthlyObligationInTx`) are **not** called: they take `FOR SHARE`/`FOR UPDATE`, which a read-only transaction
  refuses.

## Files

| File | Responsibility |
|---|---|
| `src/lib/db/read-only-snapshot.ts` (new) | `runReadOnlySnapshot(prisma, fn)`: an interactive transaction whose **first** statement is `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`. It verifies `SHOW transaction_read_only = on` and `SHOW transaction_isolation = repeatable read`, otherwise throws (the same pattern as `scripts/lib/read-only-transaction.ts`). That script helper stays as it is |
| `src/lib/dues/readiness/fingerprint.ts` (new) | Pure. Canonical serialization (`versionRevision`-style sorted keys; `toFixed(2)` amounts; `YYYY-MM-DD` dates; rows sorted by id; format version `"r1"`) and SHA-256 via `node:crypto`. `studentFingerprint`, `branchFingerprint`, `organizationFingerprint`, and the two confirmation bindings (`openingReviewBinding`, `pricingAckBinding`), defined now so 8c only stores them |
| `src/lib/dues/readiness/evaluate.ts` (new) | Pure. `evaluateReadiness(snapshot, candidateS)` → `{ ready, checks[13], warnings, preview, fingerprints }`. No database or clock access |
| `src/lib/dues/readiness/snapshot.ts` (new; as built, the planned `load.ts` merged with the snapshot type) | `ReadinessSnapshot` type and `loadReadinessSnapshot(tx, organizationId)`: plain `findMany` reads (no locks) of students, status rows, assignments, legacy `PaymentPeriod`, branches, plans, terms, policies, existing `MONTHLY` obligations and coverage, every query `where: { organizationId }`. Returns plain data (Decimal → string). A test-only `afterFirstRead` pause point, never passed by production |
| `src/lib/dues/readiness/index.ts` (new) | `getDuesReadinessForOwner(organizationId, candidateS)`: validates S (`isValidCoverageMonth`), authorizes ADMIN, runs load + evaluate inside `runReadOnlySnapshot`. Not an action. **As built:** the `server-only` package is not installed and no dependency was added; browser exposure is guarded by `tests/unit/dues-readiness-not-exposed.test.ts` (no `"use server"`, no importer outside the folder, no writes or locks) |
| `scripts/pending-callers.ts` | Register `getDuesReadinessForOwner` (due by: 8d readiness screen) |

## Check semantics in 8a

| # | Check | 8a result |
|---|---|---|
| 1 | Status row before G(S) for each student who would be charged | computed |
| 2 | `Student.status` = latest status row | computed |
| 3 | Each branch: policy and `monthsCovered = 1` terms effective for S for the plans assigned there | computed |
| 4 | Each `ACTIVE` student: assignment effective for S, or explicit `planId: null` | computed |
| 5 | No legacy `PaymentPeriod` with (year, month) ≥ S | computed |
| 6 | Promo/exempt pricing acknowledged | `notImplemented`, **with the list of promo/exempt students** (so it is never silently empty) |
| 7, 8, 9 | Opening-item checks and opening review | `notImplemented` (drafts and confirmations don't exist) |
| 10 | Monthly generation scheduled and healthy | `notImplemented` |
| 11 | O2 cancellation writer | `notImplemented` |
| 12 | Stage 9 activation mechanism implemented and available (not "organization already active") | `notImplemented` |
| 13 | O4 prepaid-reversal policy | `decisionPending` |

**Preview, per branch and per currency:**
- would-be `MONTHLY` count and minor-unit total for S;
- lists: `UNDECIDABLE`, not eligible, explicit no-plan, unassigned, configuration gap.

**Org-wide:** legacy rows ≥ S, promo/exempt students, status mismatches. The O3 note: "pre-switch signup debt excluded
from this activation, not waived".

## Tasks (TDD; each: failing test → minimal code → green → commit)

1. **Snapshot helper**
   - Integration tests (test DB): a write inside fails at the database; isolation reads back `repeatable read`.
   - **Snapshot proof:** a concurrent transaction commits a legacy row between two reads inside one snapshot, and the
     second read does not see it.
2. **Fingerprints** (unit)
   - Determinism: same content in a different row order or key order gives the same hash.
   - Sensitivity: each listed field changes the hash. That includes a legacy row's `status`/`amount`/`currency` edited
     in place with the same id/`createdAt`, a D25-style in-place policy value change, a plan `name`/`active` change and
     a timezone change.
   - Version tag included.
   - `pricingAckBinding` changes when only the branch fingerprint changes; `openingReviewBinding` does not.
3. **Evaluate** (unit, pure fixtures)
   - Checks 1–5 each pass and fail, with the right rows listed.
   - Checks 6–12 are `notImplemented` and 13 `decisionPending`.
   - `ready === false` in every fixture, including one where checks 1–5 all pass.
   - Preview totals stay per currency, with no cross-currency field.
   - An explicit `planId: null` counts as assigned (check 4) and appears in the no-plan list.
4. **Equivalence** (integration)
   - On a fixture, the preview's per-student outcome matches what `generateMonthlyObligationForStudent` returns when
     run with an **injected active stub** inside a transaction that is **rolled back**.
   - **As built:** the writer also runs with its injected clock inside S. Its run-time `futureMonth` refusal is a clock
     rule, not configuration, and the preview predicts the run during S. The first run without that clock found the
     difference (every eligible student came back `futureMonth`); it was a test-setup gap, not a preview defect.
   - Categories compared: created vs `notEligible`/`UNDECIDABLE`/`NO_ASSIGNMENT` vs `configurationGap`, and amounts.
5. **Loader and entry** (integration)
   - Every query is organization-filtered (a second organization's rows never appear in fingerprints or lists).
   - ADMIN of the organization → result.
   - DIRECTOR, an INSTRUCTOR, another organization's ADMIN, or no session → `notFound`.
   - An invalid S → refused before any query.
   - Ledger tables, `PaymentPeriod` and `AuditLog` row counts are unchanged after a call.
6. **Never exposed**
   - Unit: the readiness module is not imported by any `"use server"` file or route.
   - `pending-callers` entry present.
7. **Checks:** `tsc`, lint, `check:guard-usage`, unit, integration. Show at least one key test failing against main
   before its code exists.

## Acceptance

- One call returns fingerprints, preview and 13 checks computed from a single `REPEATABLE READ` read-only snapshot.
  Repeated calls on unchanged data return identical fingerprints.
- Any change to reviewed content, including an in-place edit that leaves id and `createdAt` unchanged, changes the
  relevant fingerprint.
- `ready` is false, and the report names exactly which checks are `notImplemented` or `decisionPending`.
- An authorized preview modifies no data. Authorization runs first, through the unchanged `resolveActionContext`, and
  a cross-organization refusal is recorded by its existing security audit (`organization.accessRefused`). Nothing is
  callable from a browser, and the existing financial behavior and test suites are unchanged.

## Out of scope for 8a

Drafts, confirmations, UI (8b–8d); the gate lock and every stage 9 item; the monthly trigger; the O2 writer; any
decision on O4.
