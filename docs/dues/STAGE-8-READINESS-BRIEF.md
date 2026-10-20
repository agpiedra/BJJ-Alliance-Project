# Dues ledger — stage 8 (readiness) brief — revision 3

**Planning only.** Against `main` @ `61d95f53ce2876dde4917313141478e911eee3b7`. No schema, data, cron or financial
behavior changes. Activation stays off (`inactiveLedgerActivation`, `src/lib/dues/ledger/activation.ts:23`).
Scope is the full agreed launch, including the ledger and monthly generation.

Labels: **[code]** on main · **[proposal]** `docs/dues/history/PROPOSAL.md` (historical; parts superseded) ·
**[tech]** engineering design choice in this brief · **[owner]** owner decision.

**Revision 3:**
- owner decisions recorded (§0);
- pricing acknowledgement bound to the branch's pricing and policy content (§6);
- full stage-9 lock order and writer inventory, with the writers it cannot protect (§5);
- manual activation after the 1st (§8);
- stage 8 completion separated from activation readiness (§13).

The PR 8a implementation plan is in `docs/dues/STAGE-8A-IMPLEMENTATION-PLAN.md`.

---

## 0. Owner decisions (recorded 2026-10-19)

| ID | Decision | Consequence for the design |
|---|---|---|
| **D7** | **No automatic late fee on opening debt** | An `OPENING` obligation carries no fee, due or grace dates, or policy version; `DuesLateFee` stays `MONTHLY`-only; no `lateFeeApplies` column. The opening amount is the unpaid part of that month's charge, with a required note, never a surcharge folded in. Declared opening debt **is** newly visible to students and staff from activation |
| **D15** | **Start on the 1st of the next month** | S is always a whole month; the ledger never owns part of a month; no part-month charge path |
| **O1** | **Manual effective activation, with a fresh final readiness check** | An owner executes step 3 (§8) on or after G(S); nothing switches by date alone; no freeze window before G(S) |
| **O2** | **Owner-only cancellation of an erroneous `OPENING` obligation**, with a required reason and immutable audit history. An obligation **with applied payments cannot be cancelled** until its payment-handling policy is defined separately. **Not implemented yet** | A stage-9-era writer plus a narrow database exception for unsettled `OPENING` obligations. Until it exists, activation is blocked (§12, blocker 11) |
| **O3** | **Historical (pre-switch) signup debt is excluded from this first activation scope, not waived** | Stage 8/9 never create, stage or convert it. It stays outside the ledger, owed as before; readiness shows it as an informational note, not a waiver |
| **O4** | **Prepaid-payment reversal remains undecided and blocks activation** | Readiness blocker 13 until decided |

## 1. What stage 8 is, and what it is not

Stage 8 prepares an organization for a later stage 9. It **creates no ledger rows**, changes nothing anyone is
charged, and **modifies no existing writer** (the gate lock in §5 is stage 9).

- **Stage 8:** baseline review; assignments; opening items staged as editable drafts; per-student confirmations; a
  read-only preview and readiness report for a candidate start month S.
- **Stage 9:** the gate lock in writers; `OPENING` type and writer; O2 cancellation writer; advance authorization;
  manual effective activation; legacy writers refusing; trusted activation state.

## 2. Current code that matters

- **Status history [code].**
  - `StudentStatusChange` rows are written under the student lock by every status-changing action.
  - `runStatusHistoryBaseline` (owner-only, repeatable, no UI) writes one `BASELINE` row for each student with none.
  - Month M is `UNDECIDABLE` without a row dated strictly before G(M) (`src/lib/dues/eligibility.ts`).
  - There is no `statusHistoryTrustedFrom`; it was superseded.
- **Assignments [code].** `assignPlan`/`correctAssignment`: owner-only, revision token, student lock. A `planId` of
  null is an explicit "no plan".
- **Configuration [code].**
  - `DuesPolicyVersion`, `PaymentPlanTerms` and `PaymentPlan` are written by owner actions that lock the `Academy` row
    `FOR UPDATE` (`src/lib/dues/config-actions.ts`).
  - A future version can be corrected in place (D25).
- **Ledger [code, dark].**
  - Types are `MONTHLY`, `PACKAGE` and `SIGNUP`.
  - `planTermsId` is required on every obligation.
  - Coverage is unique per student and month; obligations are immutable.
  - Lock order: `Academy` `FOR SHARE` → `Student` `FOR UPDATE` → version rows `FOR SHARE`
    (`src/lib/dues/ledger/common.ts`).
- **Legacy [code].**
  - **`recordPayment`** **upserts** `PaymentPeriod`, so it can edit older rows in place, and takes **no student or
    branch lock**. It can record up to one month ahead.
  - **Carry-forward** creates the current month's recurring-promo row **on page read**, also with no lock.
  - `PaymentPeriod` has no revision column.
- **Monthly generation [code].** Exists, no caller, no cron.

## 3. Dates and the three activation steps

| Concept | Meaning | Where |
|---|---|---|
| Baseline date (per student) | Date of the student's `BASELINE` row | Existing rows |
| **Candidate S** | Month being prepared; input to the preview; recorded on every confirmation | Stage 8 |
| **Advance approval** | The owner approves S and the organization fingerprint once readiness passes; switches nothing | Stage 9 |
| **Effective activation** | Manual step (O1) that makes the ledger authoritative from G(S) (`ledgerStartsOn`) | Stage 9 |

Every student meant to be charged for S needs a status row before G(S), so the baseline is taken **before** the 1st
of S.

## 4. Content fingerprints [tech]

Latest id or timestamp is not a freshness signal: legacy edits keep a `PaymentPeriod`'s id and `recordedAt` (it has no
`createdAt`), and D25 corrections keep a version's id and `createdAt`, while changing content. Freshness is a **SHA-256 over a canonical serialization of the reviewed content**:
- sorted keys (the `versionRevision` pattern, `src/lib/dues/config-input.ts:76`);
- amounts as `toFixed(2)` strings, dates as `YYYY-MM-DD`, enums and currencies as their codes;
- rows sorted by id;
- a version tag so a future format change cannot collide with an old fingerprint.

| Fingerprint | Content |
|---|---|
| **Student** | `Student.status`, `homeAcademyId`; every status row (`status`, `effectiveOn`, `sequence`, `source`); every assignment (`planId`, effective month); every legacy `PaymentPeriod` (`year`, `month`, `status`, `amount`, `currency`, `planId`, `promoName`, `promoRecurring`); since format `r2` (stage 8b): every **active** opening draft (`id`, month, `amount`, `currency`, `note`, legacy link) and every **withdrawn** one as `id`, `withdrawalKind`, `supersededById` only — never its amount, currency or note. Drafts are never deleted, so a draft that ever existed changes the hash permanently and an add-then-withdraw cannot revive an older confirmation |
| **Branch pricing/policy** | `Academy.timezone`; every `DuesPolicyVersion` (due day, grace day, fee amount and currency, prepayment limit, effective month); every `PaymentPlan` of the branch (`active`, `name`, which drives promo classification); every `PaymentPlanTerms` (price, currency, months covered, effective month) |
| **Organization** | Version tag, candidate S, `Organization.currency`, all branch fingerprints, all student fingerprints (id order) |

All fingerprints for one report are computed inside **one read-only `REPEATABLE READ` transaction**, so they describe
one database snapshot.

**Carry-forward** creates a new legacy row for a recurring-promo student when a page is viewed in a new month. That
changes the student fingerprint, so their review goes stale at each month change. This is correct, and the report
names the row.

**Older legacy payment edited later:** a `PENDING` ₡25,000 August row marked `PAID` after the preview, or after the
owner confirmed August as owed, changes the student fingerprint. The confirmation becomes stale and the student shows
"changed since review"; stage 9 refuses until re-reviewed.

## 5. Stage 9 lock order and writer inventory [tech; implemented in stage 9, not stage 8]

**Complete lock order.** Every participating writer acquires locks in this order, taking only the levels it needs:
1. **`Organization` row** — `FOR SHARE` in every participating writer; `FOR UPDATE` only in advance approval and
   effective activation;
2. **`Academy` row(s)**, in id order — `FOR SHARE` (ledger, legacy, student, assignment writers) or `FOR UPDATE`
   (configuration writers, location writers);
3. **`Student` row(s)**, in id order — `FOR UPDATE`;
4. **Version rows** (`StudentPlanAssignment`, `PaymentPlanTerms`, `DuesPolicyVersion`) — `FOR SHARE`;
5. **Ledger and legacy rows** being written.

Writers already following 2→3→4 only add step 1 at the start. Writers taking no lock today (`recordPayment`,
carry-forward) add steps 1, 2 and 3.

**Writers that must participate** (found by searching `src`, `scripts` and `prisma` for Prisma writes and raw
`INSERT`/`UPDATE`/`DELETE` on the reviewed tables):

| Table / field | Writer(s) |
|---|---|
| `PaymentPeriod` | `recordPayment` (`src/lib/payments/payment-actions.ts:168`); carry-forward `materializeCarryForward` (`src/lib/payments/get-current-period.ts:194`) |
| `StudentStatusChange` | `appendStatusChange` (`src/lib/students/status-history.ts`) and every caller: `students/[id]/actions.ts`, `approve-student-core.ts`, `create-student-core.ts`, public signup `o/[orgSlug]/signup/actions.ts`, ledger `resume-charge.ts` and `genuine-return-charge.ts`; `runStatusHistoryBaseline` |
| `Student` (`status`, `homeAcademyId`) | `students/[id]/actions.ts` (archive/restore/pause/resume paths), `approve-student-core.ts`, `create-student-core.ts`, signup action, ledger `resume-charge.ts` and `genuine-return-charge.ts`. Writers of other student fields (promotion `award.ts`, `accounting-activation.ts`, profile edits) are **not** reviewed content and need not participate |
| `StudentPlanAssignment` | `assignPlan`/`correctAssignment` (`src/lib/dues/assignment-actions.ts`, `assignment-core.ts`) |
| `PaymentPlanTerms`, `DuesPolicyVersion`, dues side of `PaymentPlan` | `src/lib/dues/config-actions.ts` |
| `PaymentPlan` (legacy) | `src/lib/payments/plan-actions.ts`; `ensure-default-plan.ts`; `ensure-custom-promo-plan.ts` |
| `Academy` (`timezone`; branch existence) | `src/lib/locations/location-service.ts:88,105`; `approve-organization.ts:124` (first branch at approval). `kiosk-tokens/actions.ts:71` writes a kiosk field only, not reviewed |
| `Organization.currency` | `src/lib/payments/plan-actions.ts:291` |
| Opening items and confirmations | stage 8c actions |
| Ledger writers | every writer under `src/lib/dues/ledger/` once callable |

Stage 9's PR adds a structural test that fails if a new write to any reviewed table appears outside this list, in the
style of `tests/unit/dues-ledger-not-exposed.test.ts`.

**Not protected — stated, not claimed:**
- `prisma/seed.ts` writes `PaymentPeriod`, `PaymentPlan`, `Student`, `Academy` and `Organization` with no gate. It must
  never run against a production database; that is an operating rule, not a lock.
- Data-writing migrations (one historical one touches these tables:
  `20260921035356_payment_plan_amount_and_organization_currency`) and any future migration.
- Manual SQL (`psql`, Prisma Studio, the Supabase dashboard) or any operator script.

Effective activation can detect changes these make only if they commit **before** it takes the gate, because the
fingerprints then include them. It cannot prevent them afterwards. The runbook rule is: no manual or scripted writes
to an organization's financial tables between advance approval and the end of effective activation.

No operator script in `scripts/` writes these tables today (`scripts/lib/read-only-transaction.ts` is read-only; the
two verify scripts write only synthetic test-database fixtures).

## 6. Confirmations, bound to fingerprints [tech]

A confirmation is the owner's statement about one student, for one candidate S, bound to fingerprints. It is valid only
while recomputed fingerprints and S still match. **An existing assignment is never evidence.**

| Kind | Bound to | Meaning |
|---|---|---|
| `OPENING_REVIEWED` | `hash(version, S, studentFingerprint)` | "For S, this student's pre-S debt is exactly the items shown (possibly none)". "No opening debt" is this confirmation over zero items |
| `PRICING_ACKNOWLEDGED` | `hash(version, S, studentFingerprint, branchFingerprint(student's home branch))` | Required for any student with legacy `PROMO`/`EXEMPT`/`promoRecurring` rows: "from S this student is charged per the assignment shown, at the branch's prices and policy shown" |

Because the pricing acknowledgement includes the branch fingerprint, **any change to that branch's terms, policy
(including a D25 in-place correction), plan name or active flag, or timezone invalidates it**, even if nothing about
the student changed.

| Event after confirming | `OPENING_REVIEWED` | `PRICING_ACKNOWLEDGED` |
|---|---|---|
| Item edited (amount, currency, month, link), withdrawn, or a new draft | stale | stale (student fingerprint) |
| Linked or same-month legacy row edited | stale | stale |
| Assignment changed | stale | stale |
| Status change | stale | stale |
| Branch price, policy, plan or timezone changed | unchanged | **stale** |
| Candidate S changed | stale | stale |

Submitting a confirmation sends the fingerprint the page showed. The server recomputes it and refuses on mismatch
("review again"). Opening items have **no** confirmed state of their own.

**Which confirmation is current (stage 8b schema; 8c writer protocol).** Confirmations are append-only. Within one
identity (organization, student, candidate S, kind) the current one is the highest `sequence`. The 8c writer, in a
READ COMMITTED transaction, takes the branch `FOR SHARE` and the student `FOR UPDATE`, **then** reads `MAX(sequence)` and
inserts `MAX + 1`, and computes the fingerprint under that lock. A unique key on (identity, `sequence`) is the
backstop. `confirmedAt` is display only: neither a timestamp nor an id says which review came last. Prisma's
`@default(now())` is filled on the app server at insert time, the database default is the transaction start, and a
writer may stamp its action's start; none of these is the lock order (proved in
`tests/integration/dues-readiness-schema.test.ts`).

**Valid** = `fingerprintFormat` equals the current format **and** the stored `binding` equals the binding recomputed now.
The stored row is never modified. Confirmation rows are in no content hash.

## 7. Schema (stage 8b, implemented)

Migration `20261019120000_dues_readiness_drafts_and_confirmations`; plan and rationale in
`docs/dues/STAGE-8B-IMPLEMENTATION-PLAN.md` (revision 2); evidence in
`design/matroom/verification/dues-stage8b-schema/README.md`.

1. **`DuesOpeningItem`** (draft, never a charge):
   - **Columns:**
     - `organizationId`, `studentId`, `coverageYear`, `coverageMonth`;
     - `amount` (unpaid principal only, D7), `currency`;
     - required `note` (1–500 characters after trimming) and optional `legacyPaymentPeriodId`;
     - created-by/at;
     - a once-only withdrawal marker: `withdrawnAt`, `withdrawnById`, `withdrawalKind` (`EDITED`/`WITHDRAWN`),
       `withdrawalReason` (required for `WITHDRAWN`), `supersededById` (required for `EDITED`, unique).
   - **No `academyId`:** the branch is the student's home branch.
   - **`materializedObligationId`:** deferred to stage 9.
   - **No fee column (D7).**
   - **Constraints:**
     - tenant- and student-safe composite FKs;
     - the legacy link is pinned to the same organization, student **and** month, via an added
       `PaymentPeriod(organizationId, studentId, year, month, id)` unique index;
     - at most one **active** draft per student and month (partial unique index, immediate);
     - the successor FK is the same organization and student (the month may change), `DEFERRABLE INITIALLY DEFERRED`;
     - positive amount; range checks; marker completeness; no self-supersession;
     - no deletes, and no update except setting the marker once.
   - **Edit:** under the student lock, set the old row's marker first (naming a pre-generated successor id), then insert
     the successor; the deferred FK is checked at commit.
2. **`DuesReadinessConfirmation`** (append-only):
   - **Columns:**
     - `organizationId`, `studentId`, candidate S, `kind`, `sequence`;
     - `fingerprintFormat`, `binding`, `studentFingerprint`, `branchFingerprint` (iff pricing);
     - `declaredNoOpeningDebt` (iff opening review);
     - actor, `confirmedAt` (display only).
   - **Constraints:**
     - unique (identity, `sequence`); `sequence ≥ 1`;
     - hex-64 hashes; shape by kind;
     - no update, no delete.
   - **Audit:** 8c also writes an `AuditLog` record per operation, as a record only, never read as state.

Both tables are in the tenant guard. Preview and readiness are computed, not stored. Nothing writes either table until
stage 8c.

**Drift-check limit (found in 8b):** `pnpm db:check-drift` does not see `DEFERRABLE` or partial unique indexes. It stays
clean even with the successor FK made immediate or the one-active index dropped, so the schema test asserts both from
the PostgreSQL catalog.

**Stage 9 schema, outlined only:**
- the `OPENING` type, with nullable `planTermsId` for it and the check and trigger changes;
- the O2 cancellation marker on `OPENING` obligations: reason, actor, time, set once and never removed, refused when
  any active settlement exists;
- an activation record: approved S, approved organization fingerprint, approval actor and time; effective time and
  actor.

## 8. Activation boundary (stage 9), with manual execution (O1)

1. **Candidate S (stage 8):** previews and confirmations.
2. **Advance approval (stage 9):**
   - allowed only **before G(S)** (in every branch's timezone) and only when readiness has no blockers;
   - takes the gate `FOR UPDATE`, recomputes, and stores S and the organization fingerprint;
   - switches nothing.
3. **Effective activation (stage 9, manual):** one transaction:
   1. take the gate `FOR UPDATE`;
   2. recompute readiness and the organization fingerprint;
   3. refuse if anything differs from the approval or any blocker exists;
   4. otherwise create the reviewed `OPENING` obligations and record `ledgerStartsOn = G(S)` with the actor and time.

   From its commit: trusted state is active, legacy writers (both) refuse for the organization, ledger writers accept,
   and monthly generation may run.

**Executing after the 1st (the normal case with O1):**
- **Allowed window:**
  - **Before G(S):** refused. The ledger can't own the end of month S−1.
  - **Upper limit — PROPOSAL pending stage 9 approval, not an approved decision:** no later than the earliest `dueOn`
    that S's policy versions give any branch. After it, the approval would be stale and the owner would re-approve for
    S+1 with a fresh review. Stage 9 confirms or replaces this limit.
- **Months generated:** exactly S, by the first monthly run after activation. Never any month before S. S+1 follows on
  the normal schedule.
- **Late fees:** with the proposed upper limit, none can apply to S at execution. A `MONTHLY` fee is assessable only
  after the grace deadline, which is in month S+1. Without that limit, S's obligations could already be past their due
  date (not their grace deadline) when created; stage 9 decides. Opening obligations never get a fee (D7).
- **What the owner reviews at execution:**
  - the fresh report;
  - a diff against the approved fingerprint: which students or branches changed since approval and why (for example,
    a legacy payment for S recorded after the 1st, which is blocker 5);
  - the opening totals per currency that are about to be created.
- **Stale approval is refused when:**
  - the organization fingerprint differs;
  - any blocker exists;
  - execution is before G(S), or after the upper limit if stage 9 approves one;
  - S is not the approved S.
- **Legacy writes stop** at the commit of effective activation, and **ledger writes begin** at the same commit.
  - Between G(S) and execution, legacy is still authoritative, so a legacy payment for S may be recorded. It is in the
    recomputed fingerprint and is blocker 5, so execution refuses until it is resolved.
  - A legacy write racing execution either committed before the gate was taken (and is seen), or waits and is then
    refused as legacy-inactive.
  - Writers that bypass the protocol (§5) are the stated exception.

**Monthly generation** stays dark until trusted activation is effective. Its trigger (built between stage 8 and stage
9) creates nothing for an organization without an effective activation record, and nothing before S.

## 9. Treatment of existing money and history

| Case | Treatment |
|---|---|
| Legacy rows before S | History; never edited, deleted or reinterpreted |
| Legacy row for a month ≥ S | Blocker 5; owner picks a later S or resolves the student explicitly in stage 9 |
| Legacy `PROMO`/`EXEMPT`/recurring promo | Blocker 6 until `PRICING_ACKNOWLEDGED` is valid (D8 exceptions remain deferred) |
| Declared unpaid past month | Draft opening item; the unpaid part of that month's charge, with a note; no fee (D7) |
| Legacy partial payment | Remaining amount, explicitly linked to that legacy row (warning) |
| Pre-switch signup debt | **Excluded from this activation, not waived (O3)**: nothing created; the report shows it as out of scope |
| Unknown history | Never debt. Once `OPENING_REVIEWED` over zero items, nothing is owed from before S |

## 10. Dry-run preview

Computed from the §4 snapshot for candidate S, reusing the **pure** decision code monthly generation uses
(`eligibleAndAssigned`, `latestEffective`, `ledger/minor-units`). The locking wrappers are not reused: a read-only
transaction cannot take row locks. A test pins the preview's per-student outcome to `generateMonthlyObligationForStudent`'s
outcome on the same fixture.
- **Per branch and per currency, never summed across currencies:** count and total of the `MONTHLY` obligations S
  would create; opening items (stage 8b+).
- **Lists:**
  - `UNDECIDABLE`, not eligible, explicit "no plan", unassigned, configuration gap;
  - legacy rows ≥ S;
  - promo/exempt students;
  - status mismatches;
  - confirmation state per student.

## 11. Authorization and isolation

- **Owner (`ADMIN`) only**, via `resolveActionContext(org, ["ADMIN"])`. Directors and other organizations get the
  uniform `notFound`.
- **Every query filters by `organizationId`** (the snapshot transaction uses the raw client, so scoping is explicit and
  tested).

## 12. Readiness checks

Each check reports exactly one of:
- **pass**;
- **fail**, with the affected rows;
- **not yet implemented**, meaning the check cannot pass because the machinery it needs doesn't exist;
- **decision pending**.

The report is **ready only when every check is pass**. "Not yet implemented" and "decision pending" are never treated
as pass.

| # | Check | Can pass on main today? |
|---|---|---|
| 1 | Every student to be charged has a status row before G(S) | Yes (computable) |
| 2 | `Student.status` matches latest status row | Yes |
| 3 | Every branch has policy and terms effective for S | Yes |
| 4 | Every active student assigned or explicitly "no plan" | Yes |
| 5 | No legacy row for a month ≥ S | Yes |
| 6 | Every promo/exempt student has a valid `PRICING_ACKNOWLEDGED` | **Computed (8c)**: fails listing each promo/exempt student whose current acknowledgement for S is missing or stale |
| 7 | No opening item over a `PAID` month without an explicit link | **Computed (8c)**, over active drafts |
| 8 | No opening item for a month ≥ S | **Computed (8c)**, over active drafts |
| 9 | Every relevant student has a valid `OPENING_REVIEWED` | **Computed (8c)**. "Relevant" (U1, recorded): every student currently `ACTIVE` plus every student with an active opening draft. Current status only selects who must be reviewed; it does not decide monthly eligibility (the history-based preview does) |
| 10 | Monthly generation built, scheduled and healthy | **Not yet implemented** (trigger not built) |
| 11 | O2 cancellation writer exists | **Not yet implemented** (decided, deferred) |
| 12 | The stage 9 activation **mechanism** is implemented and available (approval, manual execution, legacy refusal, gate lock). This requires the mechanism to exist; it does **not** require the organization to be activated already | **Not yet implemented** (stage 9) |
| 13 | O4 prepaid-reversal policy | **Decision pending** (owner: undecided, blocks) |

D7, D15, O1 and O3 are recorded (§0) and are no longer checks. O3's exclusion is shown as an informational note.

**Warnings** (acknowledged, not blocking):
- an item linked to a `PAID` row;
- an item amount above that month's legacy or plan amount;
- an item currency differing from the plan currency;
- not-eligible students listed.

## 13. Stage 8 completion vs activation readiness

| | Requires | Blocked by O4 / O2 implementation / scheduler / stage 9? |
|---|---|---|
| **Stage 8 complete** | 8a–8d merged and accepted. The report correctly computes checks 1–9 and shows 10–13 as not implemented or decision pending | **No.** Stage 8 is buildable and completable now |
| **Activation-ready** | All 13 checks pass: stage 8 done and reviewed for a real S; monthly trigger built and healthy; O2 writer built; the stage 9 activation mechanism implemented and available (the organization is not yet active; activating it is the step that follows readiness); O4 decided | **Yes** |

## 14. Breakdown

| PR | Content | Schema |
|---|---|---|
| **8a** | Read-only fingerprints + preview + readiness over current tables (plan: `STAGE-8A-IMPLEMENTATION-PLAN.md`) | none |
| 8b | `DuesOpeningItem`, `DuesReadinessConfirmation`, tenant guard, constraints, schema tests | additive |
| 8c | Owner actions: stage/edit/withdraw items; confirm `OPENING_REVIEWED`/`PRICING_ACKNOWLEDGED` (fingerprint must match); checks 6–9 become computable | none |
| 8d | Owner readiness screen; baseline review and the existing baseline action's UI. Split in two (plan: `STAGE-8D-IMPLEMENTATION-PLAN.md`): **8d-1**, the read-only screen (implementation complete on its branch; verification in progress; no PR opened yet); 8d-2, the interactive forms (not started) | none |
| (optional) 8e | Bulk assignment, only if needed | none |

**Then:** monthly-generation trigger (dark) → stage 9:
- 9a: the gate lock across the §5 inventory, plus the structural test;
- 9b: the `OPENING` schema and writer;
- 9c: the O2 cancellation writer;
- 9d: approval, effective activation and legacy refusal.

## 15. Acceptance scenarios (stage 8 overall)

1. **Baseline:** a rerun writes nothing; `EVENT` students are untouched.
2. **Late baseline:** baseline on or after G(S) → check 1 fails and lists the students.
3. **Legacy month ahead:** a legacy row for S → check 5 fails; choosing S+1 passes it and stales every confirmation tied
   to S.
4. **Promo student:** check 6 fails even with an assignment. After acknowledgement it passes. A branch price correction
   (D25) then stales it.
5. **No opening debt:** a student with no items fails check 9 until `OPENING_REVIEWED` over zero items.
6. **Item changes:** editing, withdrawing or adding an item stales the student's review.
7. **Older legacy row edited:** through `recordPayment`, with the same id and `recordedAt` → the student fingerprint
   changes and the review is stale.
8. **Stale submit:** refused.
9. **Snapshot:** a concurrent legacy commit appears entirely or not at all in one report.
10. **Currencies:** totals are separate per currency.
11. **Isolation and roles:** another organization and Directors get `notFound`.
12. **Nothing changes:** no ledger rows; writers and consumers behave as before.
13. **Never falsely ready:** on main and after 8a–8d, checks 10–13 are not implemented or decision pending, and the
    report is **not ready**.

## 16. What this brief does not do

It implements nothing. It creates no historical debt, waives nothing, and adds no cron, migration, backfill, gate lock
or activation. O4 remains undecided.
