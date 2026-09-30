# Brief: the first ledger-writing PR (PR 4a)

Status: **brief only, nothing implemented.** Written 2026-09-27 from main `c6e53ad` (PR 1 library #65, 2A schema #66, owner configuration #67 and ledger schema 2B #68 are merged). Every claim about current code below was checked against that commit.

**Local databases.** The dev database (`alliance_bjj`) has **not** received #66's migration or #68's: `prisma migrate status` reports 37 migrations found and **two not applied** (`20260926051927_dues_config_schema`, `20260927153000_dues_ledger_schema`). It is not current and not drift-clean. The migrated test database is. Nothing in this brief requires touching the dev database.

## 1. Recommendation: the smallest useful scope

**PR 4a = two writers behind a closed gate, no automation, no UI, no action exposed:**

1. **Create one monthly obligation** (with its coverage row) atomically, from an explicit student, month, terms version and policy version.
2. **Record one payment that settles whole outstanding monthly obligations, oldest first, in the obligation's own currency.**

That is the part where money bugs live (atomicity, locking, exact amounts, concurrency, tenant isolation), so it is reviewed on its own before anything decides *who* is billed or *when*. It needs **no schema change** (2B suffices) and **no new owner decision** (section 6).

**Why not the monthly job in the same PR.** A job must decide who is eligible, which needs stored status history, a baseline and assignments. Those prerequisites are separate work (section 5). Bundling them would put an unreviewed eligibility rule next to the money code.

**Deliberately out** (each waits for a decision or a writer): packages, prepaid or future months, CRC-for-USD conversion, signup, opening balances, refunds, reversals, fee waivers and voids, the fee job, the monthly job, any UI or server action (section 7).

## 2. The gate: how the writers stay unavailable to live billing

Confirmed rules that force this: activation comes last; no organization creates ledger obligations while its screens still use the old overdue rule (B10); legacy `PaymentPeriod` rows are never touched. Three layers:

1. **Unreachable.** The writers are plain server-side functions in `src/lib/dues/ledger/`, **not** `"use server"`, with no page, route, action, cron or job importing them. A static test lists every importer outside `src/lib/dues/ledger/` and `tests/` and fails if any exists. They are registered in `scripts/pending-callers.ts` (the repo's existing "built ahead of its caller" list, printed by CI).
2. **Closed by default.** Each writer takes an explicit `activation` argument and refuses (`notActive`, nothing written) unless it reports the organization active. The only production implementation returns inactive for every organization, because the source of truth (`DuesSettings.ledgerStartsOn`, readiness checks) does not exist until the activation stage. Tests inject an active stub.
3. **Legacy untouched.** The writers never read or write `PaymentPeriod`; the old `recordPayment` and `markPaymentPaid` are not modified. Their server-side refusal for activated organizations is the later payment-write integration PR.

*Approved 2026-09-27 (with corrections):* an injected `activation` argument, defaulting inactive in production, plus the importer test and the pending-callers registration. **It is not authorization.** Before any caller is exposed, activation must come from trusted organization state read by the server, never from request data or a caller-supplied boolean. No additional activation infrastructure is built in this PR. The alternative, a hard-coded `false` constant, would make the code untestable and is not proposed.

## 3. Behaviour of the two writers

### 3.1 Create a monthly obligation (atomic)
Input: organization, student, coverage month, origin (`STAFF` or `SCHEDULED_JOB`, an internal parameter), terms version, policy version, actor (null for a job). One transaction, in this **lock order** (also the global order for every future ledger writer):

1. **Branch row, `FOR SHARE`.** PR 3's configuration writers hold the same `Academy` row `FOR UPDATE`, so a ledger creation and a configuration save for one branch cannot interleave. (Without it, a price version effective this month could appear between "choose the version" and "insert".)
2. **Student row, `FOR UPDATE`** (serializes everything about this student's ledger).
3. **The terms row, then the policy row, each `FOR SHARE`, and only then read their values** (price, currency, months covered, due day, grace day, fee). Reading first and locking afterwards can snapshot a value a concurrent correction (D25) is about to change; the 2B trigger checks only branch, currency and duration, never the amount.
4. Validate: the student's branch owns the terms' plan and the policy; terms cover exactly one month; the fee currency equals the terms currency; the version is the one effective for the coverage month (PR 1 `priceFor`).
5. Compute the dates with PR 1 (`dueDateFor`, `graceDeadlineFor`: due day clamped to short months, grace day of the following month, inclusive).
6. Insert the obligation, then its one `DuesCoverage` row, then an `AuditLog` row. **Any failure rolls back all three.** The 2B constraints are the backstop: one `MONTHLY` per student per month, one coverage row per student per month, the agreement trigger.
7. Idempotent: if the student already has that month's obligation, return it (`alreadyExists`), never a second one.

### 3.2 Record a payment (whole obligations, oldest first)
Input: organization, student, `receivedOn`, tender (currency and **exact text** amount), method, the **explicit ordered obligation ids** chosen, notes, actor. One transaction:

1. Lock the student row `FOR UPDATE`.
2. Load the student's outstanding `MONTHLY` obligations (no active settlement), ordered by coverage month, plus their fee rows. Amounts come from the **immutable obligation snapshots**; no configuration is read on this path, so no configuration lock is needed.
3. **Validate everything first, writing nothing** (corrected 2026-09-27: an earlier draft created fee rows before validating, which would have left a fee behind on a refused payment). Under the locks, with the obligations and their fee state loaded, check in this order: the selected ids exist for this student and are not already settled; they are exactly the first *k* outstanding obligations (nothing older skipped); the received date; the currency; the fee state; and the exact total, using PR 1 (`outstandingItems`, `settleReceipt`), where the tender must equal the sum of the chosen obligations' amounts due on the received date and the amount must agree with the chosen selection. A fee is owed for an obligation when `receivedOn` is after its inclusive grace deadline (PR 1 `lateFeeApplies`), its fee is greater than zero, and no removed (waived or voided) fee row exists; a removed fee is preserved untouched and is not owed; an already-assessed active fee is reused; an earlier received date that would have avoided an already-assessed active fee is refused (`feeAlreadyAssessed`) because removing a fee is undecided policy. Any failed check returns a typed refusal, with the selectable totals where relevant (for example 100, 220, 320 when the second obligation is late), and **every table, including `AuditLog`, is unchanged**.
4. **Only after every check has passed**, in the same transaction: insert any required `DuesLateFee` rows (the unique key prevents a second), then the payment, one settlement per obligation (with its fee id when owed), and the audit rows. The partial unique index (one active settlement per obligation) is the backstop.

### 3.3 Duplicate submissions and concurrent payments
- **A replay cannot double-record, and is never re-aimed.** The request carries the **explicit obligation ids**; nothing is recalculated from "the next unpaid months". A payment always settles at least one whole obligation and an obligation has at most one active settlement, so a lost-response retry finds its own obligations already settled and is refused (`alreadySettled`, typed, nothing written), **even when later unpaid obligations cost exactly the same amount**. Tested with October and November unpaid at the same price, and with concurrent duplicate submissions. No idempotency column is needed. (A UI submission token is a later convenience, not a correctness mechanism.)
- **Two staff, same student, same moment:** the student row lock serializes them; the loser sees the obligations settled and is refused. If the lock were ever bypassed, the partial unique index still allows only one.
- **Payment during a configuration save:** unaffected (settlement reads snapshots only); creation during a save is serialized by lock 1.

### 3.4 Exact money
- Amounts are `Decimal(10,2)` for both currencies. Convert to the library's integer minor units **only from the fixed-scale string** (`decimal.toFixed(2)`, digits, no float), with **exponent 2 for USD and CRC** (storage scale; colones display without cents but are stored with them, and PR 3 already saved ₡25,000.50). Range-check against 99,999,999.99 (below 2^53). Convert back to a two-decimal string. **Never** `toNumber()`, `Number(x) * 100`, or `Math.round`.
- The tender is parsed from the typed text with the existing exact `parseMoney` (config-input); more than two decimals, exponents, signs, separators are refused, never rounded.
- One conversion module, property-tested over every cent in a range plus the boundary values, and mutation-checked against a float implementation (for example `1.15 * 100` is `114.99999999999999`).

### 3.5 Tenant isolation
Every query carries `organizationId`; the student, obligations and configuration ids are re-read scoped to the organization and the student's branch is checked with `isAcademyInTenantScope`. Forged or foreign ids return `notFound` and write nothing. The tenant guard already registers all five ledger tables; the 2B composite foreign keys (a settlement's payment and obligation must belong to the same student) are the database backstop. Raw lock statements include the organization in their `WHERE`.

### 3.6 Audit
One `AuditLog` row per created obligation, payment and fee, written in the same transaction with exact string amounts. Audit rows are written and never read back by code.

## 4. Fail-closed defaults 4a applies (parameters, not policies)
These enter as **injected parameters with no default**, the precedent PR 1 set, so no assumption becomes code:
- **Received date:** `receivedOn` must not be in the future in the branch's timezone; how far back is allowed is a required parameter (`maxBackdateDays`) that tests set explicitly and no production caller supplies yet.
- **Currency:** tender currency must equal the obligations' currency; otherwise refused (`currencyMismatch`). No conversion exists.
- **Who may call:** the functions do no role check; the eventual action does (`resolveActionContext`, owners first, D5).

## 5. Prerequisites kept separate: who gets billed, and when

The **monthly job** (a later PR) needs, per student and month, eligibility from *stored* history, an assignment, and a resolvable price (B8). Verified against `c6e53ad`:

- **There is no status history.** `StudentStatusChange` was deferred to ship with its writers, so nothing records when a status changed.
- **The status writers today** are exactly: staff create (`create-student-action.ts:142`, `ACTIVE`), public signup (`o/[orgSlug]/signup/actions.ts:149`, creates the student), approve (`students/[id]/actions.ts:432-439`, `PENDING` to `ACTIVE`), archive (`:253-257`, keeps `statusBeforeArchive`), restore (`:350`). **No code path ever sets `INACTIVE`**, so the proposal's mapping "paused = Inactive" (D9) has no writer today.
- **No assignment writer** exists for `StudentPlanAssignment`.

So the prerequisite work is its own PR(s): the status-history table written in the same transaction as each of those actions, the owner-reviewed baseline and `statusHistoryTrustedFrom`, assignments (single and bulk), and the D9 mapping. Payment recording (3.2) needs none of it: it settles obligations that already exist, whoever created them.

## 6. Unresolved decisions that block this scope

**None.** 4a is dark, uses no configuration value that is not already stored, and has no caller. The decisions that will matter *before the first caller* (the action and screen), each already handled above as a parameter or a refusal, are listed so they are asked in time, not now:

- **Backdating (D4).** Example: a parent's SINPE transfer is made Oct 5 at 23:50 (the inclusive grace deadline, so USD 100), and staff record it Oct 6 at 08:00. With "today only" the ledger charges USD 120. How far back may staff record, and who can override?
- **Who records payments (D5).** Example: Escazú's Director at the front desk records Ana's payment. Owners only, or Directors of their own branch as today?
- **CRC for USD (D1).** Example: a parent pays ₡52,000 against a USD 100 obligation at BCR's sell rate of 520.00. 4a refuses it (`currencyMismatch`); until D1 (rounding, tolerance, missing quote) is decided Alliance cannot record colones receipts, which matters for activation, not for 4a.

## 7. What stays out, and what each waits for
| Excluded | Waits for |
|---|---|
| Monthly job, eligibility, fee job | status history, baseline, assignments, D9 |
| Prepaid months, packages | the per-branch prepayment-limit setting existing (**D24 is decided and approved: an unset limit means prepayment is unavailable**, no default is invented), D5 (who records a purchase), and the rule for reversing a purchase that created obligations |
| Signup obligation | D3, D9, D13, D14 |
| Opening balances | D7, readiness stage |
| CRC conversion, rate-pending receipts | D1, D2 |
| Reversal and refund writers | the approved cancel and release rules; refund policy (D4); the reversal action must refuse purchases that created obligations |
| UI and server actions | the payment-write integration PR, then activation |

## 8. Tests and PR shape
- **Real-database tests, failing first:** creation atomicity (any failure rolls back all three rows); the 2B backstops still refuse a bypass; fee boundary (a payment on Nov 5 is USD 100, on Nov 6 is USD 120, inclusive deadline); oldest-first (refusing a payment that skips November for December); refusals of 200, 230, 250 with the selectable totals; a fee row created once; a waived fee row excluded.
- **Concurrency, two real connections:** two payments for one student at once (one wins, the other `alreadySettled`); a replayed submission; obligation creation racing a configuration save (both orderings, using the 2B trigger and the branch lock); creation racing creation for one month.
- **Money:** the conversion property tests and the float-mutation check.
- **Tenant:** forged student, obligation and terms ids across organizations; a Director's scope later.
- **Gate:** the importer test; refusal when inactive.
- **Mutation-check** every decision point: lock order (remove the branch lock, the student lock, the version `FOR SHARE`), the prefix rule, the fee boundary, the conversion, the gate. Use rollback-isolated fixtures; cleanup never weakens a production trigger.
- One focused PR; no schema change expected (if one becomes necessary, it is reported before implementing); CI normal, no retriggering; no deploy, no activation.

## 9. Order after this brief
4a (this), then status history with baseline and assignments, then the monthly and fee jobs (dark), then the reversal action (with its refusal), then the decided prepayment and package work, refunds, signup and opening balances, payment-write integration, consumer integration, readiness, and activation last (B10, Part F). Subscription billing, onboarding and contact-email handling stay deferred.
