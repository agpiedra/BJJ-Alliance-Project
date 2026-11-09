# O4 — prepaid-payment reversal: smallest safe option-4 plan (revision 3)

**Status (2026-11-09):** **B1–B10 APPROVED by the owner** ("including current-price rebilling, whole-payment reversal,
owner-only access, required reason, no time limit, and the launch restriction on reversals after branch transfers").
**Implemented locally, draft PR only** (see §11). Not merged, not deployed; no hosted migration; ledger activation unchanged.
**Pinned to:** `main` @ `cd1da1a` (2026-11-09).

**Owner inputs (2026-11-09):**
- Prepayments are required at launch.
- O4 direction: option 4.
- Late fees are assessed only when a late payment is recorded. The standalone schedule and its correction screen are deferred.
- "Prepayments yes" approves **none** of the rules below.

**Revision 2 changes:**
- Rule R1 is tightened to "exactly one settlement ever, and it belongs to the payment being reversed".
- Invariant I1 is named and proved.
- A branch transfer refuses reversal outright. This is existing behavior, which is why B9 changed.
- New sections: the database exception, authorization, audit trail, concurrency, and migration/rollback.

## 1. Verified facts this plan rests on

1. **Creating prepaid charges.** Only two code paths create a charge with `origin: PREPAYMENT`:
   - `prepay-monthly.ts:327-329`;
   - `awaiting-rate-receipt.ts:348`, when a receipt captured for lack of an exchange rate is resolved.
   
   Every other caller of `writeMonthlyObligationInTx` passes `origin: "STAFF"`:
   - `enrollment-charge.ts:129`;
   - `resume-charge.ts:80`;
   - `genuine-return-charge.ts:88`.
   
   `purchase-package.ts` also uses `"STAFF"`. The monthly job uses `SCHEDULED_JOB` (`create-monthly-obligation.ts:185`).
2. **Payment happens in the same transaction.** Both PREPAYMENT paths pay the charges they create in that same transaction:
   - `prepay-monthly.ts:360` calls `settleObligationsInTx`;
   - `awaiting-rate-receipt.ts:361` does the same.
   
   Any refusal throws, which rolls back the charges too (`PrepaymentRefusedError`, `ResolutionRefusedError`).
3. **Settlements.** A settlement pays one charge in full and has no amount column. A database index allows at most one *active* (unreversed) settlement per charge (migration `20260927153000`, line 281). Settlements are never deleted (line 334).
4. **Reversal today.**
   - It is whole-payment and owner-only.
   - It refuses any payment that touched a prepaid charge (`reverse-payment.ts:114`).
   - **It refuses (`notFound`) if the student's home branch is no longer the branch the payment was recorded in** (`reverse-payment.ts:100`).
   - It is reachable today from the owner's financial-corrections screen.
5. **Database constraints.**
   - Charges are immutable: a trigger rejects any change (lines 319-337).
   - Coverage rows can never be updated.
   - No ledger row can be deleted.
   - One live MONTHLY charge per student-month (line 277) and one coverage row per student-month (line 126).
   - The original migration says a cancellation exception would be added "when a policy is approved" (lines 319-321).
6. **The monthly job.** It decides "has this month started?" with the student's **home-branch timezone**, under that branch's shared lock. It then locks the student and skips any month that already has a charge or coverage row (`monthly-generation.ts:117-123, 177-188`).
7. **Lock order.** Every ledger writer that locks a branch takes it **shared before** the student lock:
   - generation;
   - prepayment;
   - package purchase;
   - resume charge;
   - receipt resolution;
   - opening items.
   
   Configuration saves lock the branch **for update** and never lock a student (`config-actions.ts:112`). Ordinary payments, late-fee assessment, waivers and corrections lock only the student.

## 2. Terms

1. **Payment reversal:**
   - Records that a payment was never validly received (a bounced transfer, money never arrived) or was recorded in error.
   - No money moves.
   - This is the only thing this plan builds.
2. **Refund:** money handed back to the payer.
   - Not built and not in scope.
   - A reversal must never be used to represent a refund of money that was actually received.
3. **Membership cancellation:** the student stops training, recorded as a status change.
   - It does not touch payments, charges or prepaid months.
   - A departing student's prepaid months stay paid. Giving money back for them would be a refund, which is a separate future decision.

## 3. Charge-outcome rules (proposed, unapproved)

When the owner reverses payment P, every charge that P paid ends in exactly one of three outcomes. Each is decided under the locks in §7, at one instant captured after those locks are taken.

1. **R1. Cancelled.** All three conditions must hold:
   - the charge has `origin = PREPAYMENT`;
   - it has had **exactly one settlement ever** (counting reversed ones), and that settlement belongs to P;
   - its coverage month is **after** the current month in the student's home-branch timezone.
   
   Result:
   - P's settlement on it is reversed;
   - the charge receives a cancellation marker;
   - its coverage row receives a release marker.
   
   The student no longer owes it. When that month arrives, the monthly job treats it as never billed (B2).
2. **R2. Owed again (started prepaid month).** The charge meets R1's first two conditions, but its coverage month is the current month or earlier. Result: P's settlement is reversed and the charge is unpaid and owed. It keeps its original price, due date and grace date, which never change.
3. **R3. Owed again (independent charge).** Any other charge P paid:
   - regular monthly charges (`SCHEDULED_JOB`);
   - staff-created charges (`STAFF`: enrollment, resume, return);
   - a prepaid charge that has had more than one settlement.
   
   Result: P's settlement is reversed and the charge is unpaid and owed, exactly as reversal works today.
4. **R4. Late fees.** Any late fee that P paid becomes owed again (approved Decision A, unchanged). A cancelled charge was never due, so it cannot carry a fee.
5. **R5. Refusals that remain.** Each refuses the whole reversal and writes nothing:
   - `alreadyReversed`;
   - `inconsistentState`;
   - `unsupportedObligationType` (packages);
   - `voidedFeeBlocksReversal` (approved Decision B);
   - `notFound`, which includes the branch-transfer case.
   
   Two refusals are new:
   - `changedSinceReview` (§7.6);
   - `notActive` (the ledger is not activated). `notActive` exists today; it is listed for completeness.
6. **R6. All or nothing.** All markers on the payment, its settlements, the cancelled charges and their coverage are written in one transaction. A partial result is impossible.

## 4. Why "exactly one settlement ever, and it is P's" proves P created the charge

**Invariant I1:** every `PREPAYMENT` charge is created in the same transaction as the payment that bought it, and that payment is its first settlement. No `PREPAYMENT` charge is ever committed unpaid, and no `PREPAYMENT` charge is created any other way.

**Why I1 holds today:**
- Fact 1.1: only the two prepayment paths create `PREPAYMENT` charges.
- Fact 1.2: both pay those charges in the same transaction, or roll everything back.
- Settlements are never deleted, so that first settlement stays on record forever.

**Why the rule follows from I1:**
- A charge's settlements, oldest first, always start with its creating payment C.
- A second settlement is possible only after C's settlement was reversed, because only one active settlement is allowed.
- So "exactly one settlement ever, and it is P's" means P = C, and nobody else has ever paid it.

**Why an independently owed charge cannot qualify:**
- Its origin is `SCHEDULED_JOB` or `STAFF`, so R1's first condition already excludes it, however many times it was paid.
- A prepaid month whose creating payment was reversed after the month started (R2) and that a later payment Q then paid has two settlements. Reversing Q therefore lands in R3, owed again, never cancelled.

**Strengthening I1 (part of B1, recommended).** Today I1 is guaranteed only by the code. One database check would enforce it:
- add a deferred check, run when the transaction commits;
- it refuses to commit any new `PREPAYMENT` charge that has no settlement in the same transaction.

Together with "settlements are never deleted", the database would then guarantee that the first settlement is always the creating payment. A static test also fails if any third code path passes `origin: "PREPAYMENT"`.

## 5. Branch transfers and the timezone

1. **Today a transfer blocks reversal entirely.**
   - `reverse-payment.ts:100` refuses when the student's current home branch differs from the payment's branch.
   - So under this plan, the timezone used is always the branch the payment was recorded in, which is also the student's current branch.
   - A transfer **cannot** change cancellation eligibility, because no reversal happens at all.
   - The cost is a known limitation: an owner cannot reverse a pre-transfer payment, for example one that bounced after the student moved.
2. **If B9 relaxes that refusal later, the timezone does matter.**
   - Two branches disagree on what month it is only in the hours around midnight at the start of a month (the gap between their UTC offsets). A reversal in that window could classify the same prepaid month differently depending on which branch's timezone is used.
   - The plan would then use the **current** home branch, because the monthly job uses it too.
   - The old branch's timezone could cancel a month the job has already treated as started and covered. That month could then be left with no live charge. Whether a later job run would revisit it is not verified.
   - Away from month boundaries, the choice of branch changes nothing.
3. **Editing a branch's timezone has the same small window.**
   - The edit takes the branch for update.
   - The reversal holds the branch shared while it decides.
   - So the decision always uses one consistent timezone.

## 6. Business decisions (all open)

1. **B1. Database exception.** Approve:
   - a set-once cancellation marker on charges;
   - a set-once release marker on coverage rows;
   - making the two one-per-student-month rules ignore cancelled or released rows;
   - the deferred I1 check (§4).
   
   Nothing is ever deleted and every amount and date stays immutable. Without B1, option 4 cannot be built, and the remaining choices are option 3 (prepaid months become owed again) or not offering prepayment.
2. **B2. What happens to a cancelled month when it arrives.** The monthly job bills it normally if the student is then still eligible, at the price in effect then. That price can differ from what was prepaid. *Recommended.* The alternative, never billing it, gives a free month.
3. **B3. Meaning of "already started".** The coverage month has begun in the student's home-branch timezone at the moment of reversal. *Recommended*, because it matches the monthly job. The alternative is "its due date has passed", which would cancel more months but disagree with the job.
4. **B4. Late fees on a started month that becomes owed again.** Either the ordinary rule applies (a fee if paid after the grace date, waivable by the owner with the existing waiver), or such months are automatically exempt. *Recommended: the ordinary rule.*
5. **B5. Whole payments only.** Reversing part of a payment (for example only its prepaid months) is not offered. *Recommended.*
6. **B6. Who may reverse.** The owner (ADMIN) only, as today.
7. **B7. Allowed reasons.** The owner must choose a category, either "not received or bounced" or "recorded in error", plus free text. The category is stored as a prefix of the existing reason, with no schema change. The screen states that reversal is not for refunds or departing students. *Recommended.*
8. **B8. Time limit.** None. Started months stay owed regardless, so a limit protects nothing. *Recommended.*
9. **B9. Branch transfer.** Keep today's refusal: a payment recorded before a transfer cannot be reversed. *Recommended for launch.* The alternative is to allow it using the current branch's timezone (§5.2). That is extra work and testing (about 1 day), and the payment's charges may then be priced by a branch the student has left.
10. **B10. What people see.**
    - Cancelled months disappear from the student's balance, coverage and portal.
    - The owner's payment history keeps showing them, labelled "Cancelled: payment reversed", together with who reversed the payment, when and why.

## 7. Database exception, authorization, audit, concurrency, migration

### 7.1 Database exception (needs B1)

1. **Charges.** Add four optional columns to charges:
   - `cancelledAt`;
   - `cancelledById`;
   - `cancellationReason`;
   - `cancelledByReversalOf`, pointing at the reversed payment. It stays empty for a future O2 opening-item cancellation, which can reuse the same marker.
   
   A database check requires all four together (the reversal link optional) and a non-blank reason.
2. **Coverage.** Add `releasedAt` to coverage rows.
3. **Triggers.** Replace the "charges can never change" trigger and the "coverage can never be updated" trigger with the existing set-once rule (`dues_set_once_marker`), which lets only the marker columns change, once, from empty. Every price, date, currency and coverage column stays immutable. Delete stays forbidden on every table.
4. **Uniqueness.** Narrow the two one-per-student-month indexes to live rows: charges not cancelled, coverage not released.
5. **The I1 check.** Add the deferred check from §4.
6. **Cross-row rule.** "Coverage released only together with its charge's cancellation" is enforced by the writer and tested. A database trigger for it is optional.

### 7.2 Authorization

1. **Two owner checks.** The server action checks the owner (ADMIN) role, and the writer checks it again itself. A non-owner gets `notFound`, revealing nothing.
2. **Tenant scope.** The payment must belong to the caller's organization and to a branch within their scope.
3. **Activation.** While the ledger is inactive, everything refuses with `notActive`. That is the state everywhere today.
4. **Student identity.** The student must be the payment's student, in the payment's branch (§5).
5. **No new route, cron entry or caller.** The existing owner screen is the only entry point.

### 7.3 Audit trail

Nothing is deleted, and state lives on the rows, never only in the audit log.

1. **The payment** keeps who reversed it, when, and the reason (set once).
2. **Each settlement** keeps the same marker.
3. **Each cancelled charge** keeps who, when, why, and which payment's reversal cancelled it.
4. **Each released coverage row** keeps when it was released.
5. **One `AuditLog` entry** lists the three outcome groups (R1, R2, R3) as a readable record.
6. **Reconstruction.** From any cancelled month: charge → cancelling payment → its reversal marker → the original settlement and the prepayment's `duesObligation.prepaymentAssignment` audit row.

### 7.4 Concurrency

1. **Lock order.** Reversal adopts the ledger's standard order:
   1. exchange-rate namespace, shared (reversal currently skips this);
   2. the payment's branch, shared;
   3. the student, for update.
   
   This matches every writer in fact 1.7, so no deadlock is introduced. Configuration saves (branch for update) wait or are waited on; they never cross-lock.
2. **One instant.** The current time is captured once, after the locks. Everything is re-read under the locks.
3. **Against the monthly job,** which uses the same locks, timezone and rule:
   - reversal first, before the month opens: the month is cancelled, and the job later bills it;
   - job first, after the month opens: the month is already covered, and the reversal then sees it as started (R2).
   
   Neither ordering can lose a month or bill it twice.
4. **Against a payment naming a charge being cancelled:** the payment waits on the student lock, re-reads, sees the cancellation, and refuses.
5. **Against prepaying the same months:** they serialize on the student lock. The live-row unique index is the database backstop.
6. **Against waivers, corrections and receipt resolution:** they serialize on the student lock.
7. **Two reversals of the same payment:** they serialize. The second gets `alreadyReversed`, and the set-once markers reject it at the database too.
8. **Stale preview.** The owner confirms the list of months shown as "will be cancelled". If the recomputed list differs (midnight passed, or another write intervened), the reversal refuses with `changedSinceReview` and the screen shows the new preview.

### 7.5 Migration and rollback

1. **Order.**
   - The migration is additive: optional columns, trigger swaps, index swaps, the deferred check.
   - It must run **before** the code deploys.
   - The trigger and index swaps must run in one transaction, so there is no moment without protection. Whether Prisma wraps a migration in a transaction must be verified before writing it; this is not verified.
   - Ledger tables are small before activation, so the index rebuild is brief.
2. **Old code on the new schema:** safe until the first cancellation, because nothing is cancelled before then.
3. **Rolling back the code after any cancellation exists: unsafe.** Old code does not skip cancelled rows, so it would show cancelled months as owed or covered, and the monthly job would skip those months. After the first real cancellation, the only safe path is a forward fix.
4. **Rolling back the schema:** possible only while no cancelled or released row exists. Restoring the full unique indexes fails loudly if duplicates exist, which is the intended guard.
5. **Hosted migrations:** none run without separate approval. The ledger is inactive everywhere, so no real cancellation can exist before activation.

## 8. Change set (after decisions)

1. **S1:** the migration in §7.1.
2. **S2:** the writer, `reverse-payment.ts`. It applies the locks and the instant, classifies charges by R1–R3, writes the markers and the audit entry, and checks the stale preview.
3. **S3:** about 17 readers must skip cancelled or released rows. The list is regenerated by grep as the first coding step. A guard test fails on any new unfiltered query. The known readers:
   - `create-monthly-obligation.ts`
   - `prepay-monthly.ts` (`firstUncoveredFrom`)
   - `purchase-package.ts`
   - `record-payment.ts`
   - `late-fee-assessment.ts`
   - `correct-late-fee.ts`
   - `waive-late-fee.ts`
   - `awaiting-rate-receipt.ts` (lines 303-304)
   - `enrollment-charge.ts`
   - `resume-charge.ts`
   - `genuine-return-charge.ts`
   - `monthly-config-resolution.ts`
   - `dues-facts.ts`
   - `readiness/opening-core.ts` and `readiness/snapshot.ts`
   - `financial-corrections-queries.ts`
   - `payment-entry-queries.ts`
   - `payment-history-queries.ts`
   - coverage and portal displays
4. **S4:** the owner screen. A three-list preview, the required reason category, and messages in English and Spanish.
5. **S5:** readiness check 13 can pass, and the registry and limitation wording are updated.
6. **Effort:** about 6–8 working days, plus about 1 day if B9 is relaxed.

## 9. Tests to agree before coding

1. **T1. Classification at every boundary:** the current month and the next month; a timezone near midnight; `STAFF`, `SCHEDULED_JOB` and `PREPAYMENT` origins; one versus two settlements.
2. **T2. A mixed payment, end to end:** current debt, a started prepaid month, two future prepaid months and a late fee. Check every marker on every row.
3. **T3. I1:** for both creation paths, the first settlement is the creating payment. The deferred check refuses an unpaid `PREPAYMENT` charge. A static test refuses a third `PREPAYMENT` creator.
4. **T4. Database:**
   - snapshot columns are still immutable;
   - the marker can be set only once;
   - all-or-none and blank-reason rules hold;
   - coverage can be released only once;
   - delete is still refused;
   - two live charges for one month are refused, while one cancelled plus one live is allowed.
5. **T5. Re-billing:** a cancelled month is billed by the monthly job once it opens. A released month can be prepaid again or covered by a package.
6. **T6. Genuine races,** with `waitUntilBlockedOnLock`. The reversal races each of the following:
   - itself;
   - an ordinary payment naming a charge being cancelled;
   - the monthly job across midnight;
   - prepaying the same months;
   - a waiver;
   - a receipt resolution;
   - a branch timezone edit.
   
   Both orderings are asserted for each, with no deadlock.
7. **T7.** `changedSinceReview`.
8. **T8. Repeats:** reversing twice gives `alreadyReversed`. Prepay, reverse, prepay, reverse leaves two cancelled charges and no live one.
9. **T9. Readers:** a cancelled charge never appears as owed or covered anywhere, and does appear, labelled, in history.
10. **T10. Guard test** for unfiltered queries.
11. **T11. Existing suites unchanged:** Decisions A and B, packages refused, and the branch-transfer refusal.
12. **T12. Browser pass** on the real owner screen, in both languages.

## 10. Not in this plan

Refunds; membership-cancellation effects on prepaid months; partial reversal; the late-fee schedule and its correction screen (deferred); O2 itself (it only shares the marker shape); packages.

## 11. Implementation status (revision 3, 2026-11-09)

**Owner requirements added at approval:**
- database enforcement that cancellation and release stay consistent;
- verified transaction handling for the swaps;
- races tested without claiming deadlock freedom, and failures leaving no partial change;
- a prominent rollback warning with a forward-recovery procedure.

**Done as planned:**
- S1, the migration `20261110120000_dues_prepayment_reversal_cancellation`;
- S2, the writer (`reverse-payment.ts`, with the pure classifier in `src/lib/dues/reversal-classification.ts`);
- S3, the readers: 13 files filtered, with guard test T10 and zero exceptions;
- S4, the owner screen: preview, required category, the stale-preview refusal, and the branch-moved restriction;
- S5, readiness check 13 now passes, and the registry is updated.

**Beyond the plan, and why:**
1. **Provenance is enforced at commit, not only in code.** A cancelled obligation must have had exactly one settlement ever, by the cancelling payment, and that payment must be reversed. This makes rule R1 a database fact.
2. **"A started month is never cancelled" (B3) is also enforced by the database,** using the transaction start time in the student's home-branch timezone. That instant is never later than the writer's own, so the two cannot conflict except under server clock skew. That case surfaces as `changedSinceReview` with nothing written (tested).
3. **No settlement or late fee can be inserted on a cancelled obligation.** The insert takes a `FOR SHARE` lock on the obligation row, so it serializes against a concurrent cancellation.
4. **A row cannot be inserted already cancelled or released.**
5. **The cancellation marker is restricted** (CHECK) to `MONTHLY` + `PREPAYMENT` + cancelled-by-reversal. O2 widens this later, deliberately, in its own migration.

**Transaction handling, verified locally:**
- Prisma 7.10's `migrate deploy` does **not** wrap a migration file in a transaction: a failing statement left the earlier ones applied.
- The migration is therefore one explicit `BEGIN … COMMIT`. A failing file then changed nothing.
- A schema rollback script (`docs/dues/o4-schema-rollback.sql`) was rehearsed. After migrating to the head and rolling back, the schema dump and migration records were identical to a database without O4. With a released row present, it refused and changed nothing.

**Rollback:** code rollback is unsafe after the first cancellation. See `docs/DEPLOYMENT_RUNBOOK.md`, "O4 prepaid-payment reversal": the warning, the database check, and forward recovery.
