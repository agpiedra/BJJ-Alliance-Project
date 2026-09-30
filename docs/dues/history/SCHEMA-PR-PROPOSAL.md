# Proposal: the additive schema PR for student dues

Status: **proposal only. Nothing is implemented.** Written 2026-09-26 from main `97b4d4b` (PR 1, the calculation library, is merged). Based on `PROPOSAL.md` (v6 with A7) and the existing `prisma/schema.prisma`.

## 1. Principles for this PR

1. **Additive only.** New enums, tables, indexes and CHECK constraints. **No column, index or row of an existing table changes**, so `PaymentPeriod`, `PaymentPlan` (including its mutable `defaultAmount`), every legacy payment record and today's overdue behaviour are untouched. Prisma back-relation fields on existing models do not change the database.
2. **Dark.** No code reads or writes the new tables. No seed, migration or default carries an amount, a fee, a package price, a limit or an activation date. Empty tables on every database.
3. **Start strict, relax later.** Where a policy is pending, the schema takes the more restrictive form, because a unique index can be loosened by a later migration but a duplicate cannot be un-written. This is what keeps **consumed months from ever becoming billable again** without deciding refund behaviour now.
4. **Reuse the existing patterns:** `(organizationId, id)` composite foreign keys and `@@unique([organizationId, id])` for tenant safety; `year Int` and `month Int` for months (as `PaymentPeriod`); `Decimal(10, 2)` plus the `Currency` enum for money (as `PaymentPeriod`); `@db.Date` for calendar dates (as `AttendanceRecord.date`); `PaymentMethod` and `User` as they are; `AuditLog` for audit (written, never read back); raw-SQL CHECK and partial-unique migrations documented in `schema.prisma` (precedents: `PromotionConfig_manual_promotions_only`, the attendance partial indexes).
5. **Tenant registration:** every new table carries `organizationId` and is added to `TENANT_SCOPED_MODELS` in `tenant-guard.ts` and `scoped-client.ts` (plus the `ScopedDb` type), which `tests/unit/tenant-guard.test.ts` keeps in sync.
6. **Money history is never deleted:** no cascading deletes; foreign keys restrict.

## 2. Recommended split (one decision for you, engineering scope)

- **PR 2A, configuration schema** (unblocks the owner settings PR): `DuesPolicyVersion`, `PaymentPlanTerms`, `StudentPlanAssignment`.
- **PR 2B, ledger schema** (needed before the ledger core): `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`, `DuesSettlement`, `StudentStatusChange`, `DuesSettings`.

Order: 2A, settings UI, 2B, ledger core. Each PR is small enough to review table by table. (One PR with two migrations is the alternative.)

## 3. PR 2A: configuration tables

**`DuesPolicyVersion`** (append-only; one row per branch per effective month): `id`, `organizationId`, `academyId` (the branch, composite FK to `Academy`), `effectiveYear`, `effectiveMonth`, `dueDay`, `graceDay`, `lateFeeAmount Decimal(10,2)`, `lateFeeCurrency Currency`, `maxPrepaidMonths Int?`, `createdById`, `createdAt`.
- Unique `(academyId, effectiveYear, effectiveMonth)`. CHECK month 1 to 12, `dueDay` and `graceDay` 1 to 31, `lateFeeAmount >= 0`, `maxPrepaidMonths >= 1` when set.
- Per-branch due day, grace day (the next-month day, inclusive) and fee, each independently editable by a new version; **nullable limit = "not entered"** (what that allows is D24, decided in a later PR).
- No days-after-due grace rule, no accepted-currencies column (needed only when the CRC path is decided, D1).

**`PaymentPlanTerms`** (append-only price versions of the existing branch-owned `PaymentPlan`): `id`, `organizationId`, `planId` (composite FK to `PaymentPlan`), `effectiveYear`, `effectiveMonth`, `priceAmount Decimal(10,2)`, `currency Currency`, `monthsCovered Int`, `createdById`, `createdAt`.
- Unique `(planId, effectiveYear, effectiveMonth)`. CHECK `priceAmount > 0`, `monthsCovered >= 1`, month 1 to 12.
- A plan with `monthsCovered = 1` is the ordinary monthly plan; more is a package. `PaymentPlan` itself is unchanged, so Manage Plans keeps working and is extended later.

**`StudentPlanAssignment`** (append-only): `id`, `organizationId`, `studentId` (composite FK to `Student`), `planId Text?` (composite FK to `PaymentPlan`; **null = explicitly unassigned from that month**), `effectiveYear`, `effectiveMonth`, `createdById`, `createdAt`. Unique `(studentId, effectiveYear, effectiveMonth)`.

## 4. PR 2B: ledger schema (revised 2026-09-27 against main `fcefc45`; reversal decision applied)

Status: **proposal only. 2B is not started.** This section replaces the earlier 2B design. Sections 2, 5 and 7 are left as the record of the earlier state; where they list 2B tables (including `StudentStatusChange` and `DuesSettings`) this section governs.

**Basis on main.** PR 2A (#66) and the owner configuration (#67, `fcefc45`) are merged. `DuesPolicyVersion` and `PaymentPlanTerms` exist, their future-effective rows can be corrected in place (D25), and package plans are excluded from every legacy payment path. Nothing writes an obligation or a payment. **Local databases:** the dev database has not received #66's migration, so it is **not current and not drift-clean** against main (`db:check-drift` reports a mismatch there); the migrated test database is clean. Nothing in this work depends on the dev database.

**Scope: five tables.** `DuesObligation`, `DuesCoverage`, `DuesLateFee`, `DuesPayment`, `DuesSettlement`. Two additive unique indexes on the 2A tables and the triggers in 4.2 (coverage rows are never updated or deleted), 4.3 and 4.6. **Legacy tables (`PaymentPeriod`, `PaymentPlan`) and every legacy payment record are untouched**, and no migration moves or backfills data.

**Left out on purpose** (each waits for its decision or its writer): the `SIGNUP` and `OPENING` obligation types; refunds; **coverage release and obligation cancellation** (no columns, no operation); exchange-rate storage, receipt statuses and the exception queue; obligation adjustments; an exceptions table; `StudentStatusChange` (ships with its writers, as agreed); `DuesSettings` (ships with activation).

### 4.1 Confirmed rules, and where each is enforced

| Confirmed rule | Database | Code and tests (still required) |
|---|---|---|
| Tenant isolation | every table carries `organizationId`; composite `(organizationId, id)` foreign keys; no cascading deletes; tenant-guard registration | owners-only writers, `resolveActionContext` |
| Exact currency: `Decimal(10,2)` with a `Currency`; nothing is summed or compared across currencies | a settlement stores **no amount of its own**, so it cannot disagree with its obligation's `amount`, `lateFeeAmount` and `currency`. **That is all it guarantees.** It does **not** guarantee that the payment is for the full amount, or that the tender's currency matches | **the payment is validated against its obligations**: tender currency equals every settled obligation's currency (until D1), and the tender equals the sum of their amounts plus applicable fees. One transaction, real-database tests, and a readiness consistency query |
| Full settlement, no partial payment, no credit | at most one **active** settlement per obligation (4.6) | the same validation, oldest outstanding first with an explicit prefix; a payment with any other total is refused before anything is written |
| Oldest outstanding first, consecutive future coverage | none (an ordering rule cannot be a constraint) | one validation function; a per-student `Student` row lock (`FOR UPDATE`) makes it race-safe |
| No duplicate monthly charge | partial unique `(studentId, coverageYear, coverageMonth) WHERE type = 'MONTHLY'` | idempotent inserts (`ON CONFLICT DO NOTHING`) in every creation path |
| No overlap between months, prepaid months and packages | unconditional unique coverage row per `(studentId, year, month)`; **a reversal never releases coverage** (4.6) | a package fails as a whole, with its payment and coverage, if any month is covered |
| One late fee per obligation, never repeated; only monthly obligations | unique `(obligationId)`; fee row must point at a `MONTHLY` obligation | fee applies when `receivedOn` is after the grace deadline; only an on-time full settlement or an owner waiver removes it |
| A package is never created unpaid, never late | `PACKAGE` rows carry no dates, no fee | purchase, payment, obligation and coverage in one transaction; reversal refuses such payments (4.6) |
| Frozen prices and coverage | the obligation snapshots amount, currency, dates and fee; configuration versions it references cannot change (4.3) | writers never update amount, currency or coverage |
| Owners only for prices, waivers, reversals | none | role list `["ADMIN"]` on those actions |
| Reversal history is kept | payments and settlements are never deleted or edited; the only permitted update is setting the reversal marker once (4.6) | reversal action, audit row |

### 4.2 Tables

**`DuesObligation`** (the whole row is immutable, including its due and grace dates: rescheduling has no approved policy, so the database gives it no exception; a later migration adds one when D5 is decided). `id`, `organizationId`, `studentId`, `academyId` (branch at creation), `type` enum `DuesObligationType { MONTHLY, PACKAGE }`, `origin` enum `DuesObligationOrigin { SCHEDULED_JOB, PREPAYMENT, STAFF }`, `coverageYear`, `coverageMonth` (first covered month), `monthsCovered`, `amount Decimal(10,2)`, `currency`, `lateFeeAmount Decimal(10,2)?`, `dueOn Date?`, `graceDeadline Date?`, `planTermsId` (the terms it was priced from), `policyVersionId?` (the policy its dates and fee came from), `createdById?` (null = the job), `createdAt`. **No status column**: "settled" means "has an active settlement", "unpaid" means "has none".
- CHECK `amount > 0`, month 1 to 12, year 2000 to 2100, `monthsCovered >= 1`. `MONTHLY`: `monthsCovered = 1`, `dueOn`, `graceDeadline`, `lateFeeAmount` (zero allowed) and `policyVersionId` all set, `graceDeadline >= dueOn`. `PACKAGE`: `monthsCovered >= 2`, and dates, fee and policy all null.
- Unique `(organizationId, id)`, `(organizationId, id, studentId)` and `(organizationId, id, type)` (targets for the composite foreign keys below). Foreign keys, all restrict: student, branch, `planTermsId`, `policyVersionId`.
- `SIGNUP` and `OPENING` are added later with `ALTER TYPE ... ADD VALUE` and a re-created type CHECK; no data is rewritten.

**`DuesCoverage`** (one row per covered calendar month; written in the same transaction as its obligation: one row for a `MONTHLY`, `monthsCovered` consecutive rows for a `PACKAGE`). `id`, `organizationId`, `studentId`, `obligationId`, `year`, `month`. Foreign key `(organizationId, obligationId, studentId)` to the obligation. CHECK month 1 to 12. **Unconditional unique `(studentId, year, month)`; no release column.** Rows are never updated or deleted (a trigger rejects both), so coverage stays reserved through anything 2B allows. See 4.5.

**`DuesLateFee`.** `id`, `organizationId`, `obligationId`, `obligationType` (CHECK `= 'MONTHLY'`), `assessableFrom Date`, `assessedAt`, `removedAt?`, `removalKind` enum `{ WAIVED, VOIDED }?`, `removedById?`, `removalReason?`. **No amount column**: the fee is the obligation's own `lateFeeAmount` in its `currency`. Unique `(obligationId)`; foreign key `(organizationId, obligationId, obligationType)`; unique `(organizationId, id, obligationId)`. CHECK removal fields all null or all set. A removed fee stays as a row. A payment reversal never touches fee rows.

**`DuesPayment`** (history is never deleted or edited). `id`, `organizationId`, `studentId`, `academyId`, `receivedOn Date` (branch calendar date), `tenderCurrency`, `tenderAmount Decimal(10,2)`, `method PaymentMethod`, `recordedById`, `recordedAt`, `notes?`, and the **reversal marker** `reversedAt?`, `reversedById?`, `reversalReason?`. CHECK `tenderAmount > 0`; marker all null or all set, and the reason is non-blank. Unique `(organizationId, id, studentId)`; index `(studentId, receivedOn)`. **No exchange-rate or receipt-status columns.**

**`DuesSettlement`** (history is never deleted or edited). `id`, `organizationId`, `studentId`, `paymentId`, `obligationId`, `lateFeeId?`, `createdAt`, and the same reversal marker (`reversedAt?`, `reversedById?`, `reversalReason?`). Foreign keys `(organizationId, paymentId, studentId)` to the payment and `(organizationId, obligationId, studentId)` to the obligation (a payment cannot settle another student's obligation), and `(organizationId, lateFeeId, obligationId)` to the fee when set. **Partial unique `(obligationId) WHERE reversedAt IS NULL`: at most one active settlement.** Tuition is the obligation's `amount`; the fee is its `lateFeeAmount` when `lateFeeId` is set.

**Not enforceable by the database (stays in code, each with a real-database test and a readiness consistency query):** the payment validation described in 4.1 (tender equals the settled totals and shares their currency); the fee applies exactly when `receivedOn` is after the grace deadline; a payment exists only with at least one settlement; a payment and its settlements are reversed together and atomically; a package has `monthsCovered` consecutive coverage rows and a `MONTHLY` exactly one; terms and policy currency equal the obligation's; oldest outstanding first; the prepayment limit (D24, unavailable until the branch has one). A deferred database trigger for the totals is **not** proposed: the rule changes when D1 (CRC for USD) is decided.

### 4.3 Protecting configuration versions that financial records reference

D25 lets an owner correct a future-effective version in place. A future prepayment can reference such a version, so before any financial writer ships:
1. `PaymentPlanTerms` and `DuesPolicyVersion` each gain `@@unique([organizationId, id])` (additive) so obligations reference them tenant-safely.
2. A `BEFORE UPDATE OR DELETE` trigger on each rejects the change **if any `DuesObligation` references the row**. This is the database-level guarantee that a referenced version, and therefore the price and coverage a payment was made under, cannot change. Delete is already blocked by the restrict foreign key; the trigger closes the update path the D25 correction uses.
3. `correctPlanTerms` and `correctPolicyVersion` (PR 3) gain a friendly `referenced` result in the 2B PR, so an owner sees a message instead of a database error.
4. Independent of the trigger, the obligation snapshots amount, currency, dates and fee, so what was paid is frozen even if a later version changes.

The triggers are new objects on the 2A tables; no column, index or row of a legacy table changes. Test: a prepaid future month locks its price version, an unreferenced future version stays correctable, a current or past version stays immutable.

### 4.4 Unresolved decisions: kept out of 2B, not turned into permanent constraints

| Decision | Not in 2B | What a later change looks like |
|---|---|---|
| **Refunds (D4)**: money actually returned: the amount, which months, exception receipts | refund columns and tables, the exception queue | new tables and columns in the refund PR |
| **Mistaken prepaid months or packages** (4.6, item 4) and **any coverage release or obligation cancellation** | any release or cancel column or operation; the reversal action refuses such payments | a separate operation once its rules are approved |
| **Signup (D3, D9, D13, D14)** | the `SIGNUP` type. The earlier "one signup per student, ever" index is **removed**, because it encoded D9 | the enrollment PR adds the enum value and its identity key once decided |
| **Opening balances (D7) and legacy periods** | the `OPENING` type, any link to `PaymentPeriod` | the readiness PR, with the owner's opening-items screen |
| **Exchange rates (D1)** | rate and receipt-status columns, an exchange-rate table; CRC-for-USD stays disabled, so v1 records only same-currency payments | a later additive migration |
| **Who may reschedule, cancel, grant exceptions (D5, D8)** | an adjustments table, an exceptions table; obligation amount is **not** forced to equal the plan price | later PRs |
| **Fee treatment when a reversal reopens an obligation already past its grace deadline** (B6 already lists it) | nothing: reversal does not touch fee rows | decided with D4 |

### 4.5 Coverage uniqueness: the one item that needs your explicit yes

`DuesCoverage` keeps the **unconditional** unique `(studentId, year, month)` and no release column. This follows directly from the approved behaviour (a reversal does not release coverage, so an October charge or an overlapping package can never be created for a month that is already reserved). It is nevertheless stricter than the eventual policy, because releasing coverage is unresolved. It is relaxable later (drop the index, add a release column, create a partial index; no data rewritten) and is therefore **provisional, not permanent**. **I will not include it without your explicit approval.**

### 4.6 Reversal is not a refund (approved 2026-09-27)

- **Reversal:** an owner corrects a mistaken payment entry. **Refund:** money actually received is returned; its policy remains pending (D4).
- A reversal marks the payment and its settlements reversed and **changes nothing else**: it does not delete or recreate an obligation, does not release coverage, does not cancel anything, does not touch fee rows. Recording the right payment afterwards is a separate, validated action.
- **The reversal marker** (on `DuesPayment` and on each of its `DuesSettlement` rows): `reversedAt`, `reversedById` (the owner), `reversalReason` (required, non-blank), all set together or all null. A trigger allows exactly one kind of update on these two tables, setting the marker once (from all null), and rejects any other change, any un-reversal and any delete.

**Ana and Bruno.** On Oct 3 staff record USD 100 for Ana's October, but the money was Bruno's. Ana's October obligation already existed (it is an ordinary monthly obligation created by the job). An owner reverses the payment:

1. **Settling again while keeping history.** The reversal sets the marker on the payment and on its settlement in one transaction. Nothing is deleted, so the wrong payment, its settlement, the owner, the time and the reason stay forever. Ana's October obligation now has **no active settlement**, so it is unpaid again (state is derived; there is no status to flip back). A later valid payment for it inserts a **new** settlement row for the same obligation; the reversed row stays beside it as history.
2. **No duplicate active settlement.** `unique (obligationId) WHERE reversedAt IS NULL`: while the first settlement is active a second insert fails, and once it is reversed exactly one new active row can be added. Two staff settling at the same moment conflict on that index (and on the per-student lock). A reversed row can never be reactivated: the marker cannot be cleared.
3. **Coverage stays protected.** The reversal does not touch `DuesCoverage` or the obligation. Ana's October is still reserved by the unique coverage row and still has its one monthly obligation, so a second October charge (the job's `ON CONFLICT DO NOTHING` skips it), a prepaid October, or a package that includes October **fails at insert**, before and after the reversal.
4. **Bruno's payment** is a separate action validated against Bruno's own obligations; the composite foreign keys make it impossible to attach it to Ana's.

**What remains unresolved (no cancellation or refund behaviour is invented).** The example works because the obligation existed before the payment. When a mistaken payment **created** its obligations (prepaid months, or a package) the reversal would leave those obligations unpaid with their coverage reserved:
- for a **package** that contradicts the confirmed rule that no unpaid package ever exists, and it has no approved way to be cancelled or have its months released;
- for a **prepaid month** it would leave a monthly obligation that later becomes overdue and fee-bearing, which nobody has decided is intended.

So cancelling such an obligation and releasing its coverage is a separate operation whose rules are not approved. **Interim, fail-closed:** the reversal action **refuses** a payment that created prepaid or package obligations and writes nothing. That is a refusal, not a policy; it changes only when the owner approves the cancel and release rules. Not needed for 2B (2B has no reversal writer); needed before the reversal action ships.

### 4.7 Order and rollout

- **Activation stays last.** 2B is dark: empty tables, no seed, no default amount, fee, limit or date, no reader, no writer. Existing overdue behaviour and all legacy payment records are unchanged until an organization is activated, after all consumers and payment writers are integrated.
- Sequence: 2B, then the ledger core (payment validation and the per-student lock), the reversal action (with the refusal above), then the decided refund, cancel and release, signup and opening-balance work, the status history with its writers, the readiness PR, and activation.
- One migration. CI must pass the drift check, seed-migrate parity, typecheck and the tenant-guard sync test, plus new real-database tests for every constraint and trigger in 4.1 to 4.6, each proven by a mutation that removes it: two active settlements refused, settle-reverse-settle succeeds and keeps three rows, a cleared marker refused, a blank reason refused, coverage unchanged after a reversal, an overlapping package refused before and after, cross-student settlement refused, referenced configuration version locked. Also a test that the legacy tables are byte-identical in the migration diff. Rollback before any writer exists is dropping the new tables and triggers.

## 5. What the database guarantees, and what stays in code

| Guaranteed by the database (this PR) | Stays in application code (later PRs) |
|---|---|
| tenant-safe composite foreign keys; no cascading deletes | a price history is single-currency (PR 1's library rejects it; a CHECK cannot span rows) |
| one policy per branch per month; one price version per plan per month; one assignment per student per month | the assigned plan belongs to the student's branch |
| one coverage row per student per month, forever | a fee's currency equals its obligation's currency |
| one settlement per obligation; one fee per obligation; one signup charge per student | a payment's settlements sum to its tender; oldest-first; full settlement |
| type-specific required and forbidden columns; positive amounts; valid months and days | effective months are not in the past; who may write which table (owners only for money) |

## 6. Migration scope and rollout

- **One migration per PR** (two for 2A and 2B), plain additive SQL plus the CHECK and partial-index statements documented in `schema.prisma`. **No backfill and no data movement.**
- **Empty and existing databases behave the same:** tables are created empty, so the release checklist's duplicate-preflight does not apply; the usual runbook path applies (`docs/DEPLOYMENT_RUNBOOK.md`, "Releasing a commit that adds migrations"). Rollback before any writer exists is dropping the new tables, which hold no data.
- **CI:** the migration must pass the drift check, the seed-migrate parity step (empty tables), typecheck, the tenant-guard sync test, and new tests for the constraints against a real database.
- **Tests in the PR:** each constraint proven against the test database (duplicate coverage month, second settlement, second fee, second signup, cross-tenant foreign key, invalid month, mismatched type columns), and a test that the legacy tables are byte-identical in the migration diff.
- **Explicitly not in the PR:** seeds, fixtures, prices, activation, status writers, jobs, UI, exchange-rate tables, refund or reversal columns, coverage-release columns, an exceptions table, a signup-price table, a tracking flag, accepted-currencies setting.

## 7. Owner decisions that touch this PR

None **blocks** it as scoped. These are the answers that would change the schema later, and how the PR stays safe until then:

| Decision | Effect on the schema if answered differently | Handling now |
|---|---|---|
| **D9** returning student: a new signup charge? | the one-signup-per-student index would need an enrollment key | strict now (one per student); a later migration relaxes it |
| **D14** signup price: always tuition, or its own setting? | a signup-price version table exists only if it is its own setting | table **left out**; the amount is snapshotted on the obligation anyway |
| **D8** individual amounts, scholarships, promos | an exceptions table would be added | **left out**; everyone pays the branch plan price today |
| **D4** refunds, reversals, release of coverage | columns to mark a settlement reversed or coverage released | **left out**; strict uniqueness means consumed months cannot become billable again |
| **D1** rounding, quotes, CRC receipts | an exchange-rate table and receipt statuses | **left out**; CRC-for-USD stays disabled until decided |
| **D24** a branch with no prepayment limit | none (a nullable column either way) | limit stored as nullable; behaviour decided in the ledger PR |

## 8. Choices for you (engineering scope, not policy)

1. **Split into 2A then 2B (recommended), or one PR?**
2. **`Decimal(10,2)` and `(year, month)` integers,** matching `PaymentPeriod`, with conversion to the library's minor units at the boundary (recommended), versus storing integer minor units.
3. **Strict-first uniqueness** (no release or reversal columns until D4), as described (recommended).
4. **`StudentStatusChange` in 2B with its writers later,** or move the table to the PR that adds the writers.
5. **`DuesSettings` as its own table** (recommended) versus two nullable columns on `Organization`.

Nothing here touches subscription billing, onboarding or contact-email handling.

## 9. Decisions taken for PR 2A (2026-09-26, owner-approved engineering choices)

1. Configuration and ledger are **separate PRs**; this one is **2A only** (`DuesPolicyVersion`, `PaymentPlanTerms`, `StudentPlanAssignment`).
2. `Decimal(10,2)` with `Currency` and `year`/`month` integers, as elsewhere. **Later conversion to the calculation library's integer minor units must be exact, range-checked, never floating-point multiplication, never silent rounding.** No conversion helper is added until a writer needs one.
3. **Ledger constraints stay unapproved** (refunds, reversals, returning students, coverage release): PR 2B is not started.
4. **`StudentStatusChange` moves to the PR that integrates its writers**, before any billing consumer relies on that history. It is not in 2A or 2B.
5. **`DuesSettings` stays separate from `Organization` and is added only when it becomes necessary.** Not in 2A.

Corrections to section 1 made while building 2A: these tables are **append-only by convention only**. Nothing in the database prevents an UPDATE or a DELETE (there is no trigger), so a writer that edits or removes a row can rewrite history. The database enforces tenant-safe composite foreign keys, version uniqueness, the CHECK constraints and restricted deletes; single-currency plan terms, the plan belonging to the student's branch, and effective months not being in the past stay with later writers. The real-database tests assert both the rejections and these documented non-guarantees.
