# Brief: monthly generation (the job that finally calls `createMonthlyObligation`)

Status: **brief only, nothing implemented.** Written 2026-09-28 from main `e82f66e` (PR 1 #65, PR 2A #66, owner config #67, ledger schema #68, first ledger writers #69, and eligibility-prerequisites #70 are all merged). Every claim below was checked directly against that commit's actual code — file:line references throughout are to files as they exist there, not recalled from an earlier brief. **Revised 2026-09-28, corrected after review:** the first draft wrongly accepted an assignment race as tolerable (reasoning from the wrong precedent — no-backfill for a pause is approved policy; a race-induced skip of an eligible student is not), wrongly said a missed month "self-heals," misattributed the missing-terms/policy refusal to D24 (an unrelated, already-settled prepayment-limit decision), and used a stale "pending your answer" note for resume timing, which is already resolved. §2, §3, §5 and §7 are corrected below with an actual transaction design; §8 is updated to match. Previous version kept as `MONTHLY-GENERATION-BRIEF-before-transaction-correction.md`.

## 0. What already exists, verified, that this phase builds on

Two independent pieces are already fully built, tested, and merged — this phase's only job is to connect them, safely, and nothing more:

- **`eligibleAndAssigned`** (`src/lib/dues/eligibility.ts:34-75`): a pure function of a student's `StudentStatusChange` history, `StudentPlanAssignment` history, `academyId`, and a target `month`. Returns `UNDECIDABLE`, `NOT_ELIGIBLE`, `NO_ASSIGNMENT`, or `ELIGIBLE` with a `planId`. No `now()` anywhere in it — verified by reading the function body: the only inputs are the arrays and `month`. **Has no caller** (`tests/unit/dues-eligibility-not-exposed.test.ts`).
- **`createMonthlyObligation`** (`src/lib/dues/ledger/create-monthly-obligation.ts:37-140`): given `{ context, studentId, coverage, planTermsId, policyVersionId }`, creates one `DuesObligation` (type `MONTHLY`) and its `DuesCoverage` row, atomically, in one transaction, in the lock order branch `FOR SHARE` → student `FOR UPDATE` → terms/policy `FOR SHARE` (`:56-79`). Refuses with a typed error otherwise: `notActive` (ledger inactive), `invalid`, `notFound`, `futureMonth`, `staleVersion`, `inapplicable`, `currencyMismatch`, `coverageTaken`, `conflict`. A duplicate `MONTHLY` row for the same student+month returns the **existing row unmodified** (`:65-70`); a `DuesCoverage` row already covering the month (package) returns `coverageTaken` (`:71-72`) — these are two separate checks against two separate tables, not one guard. **Has no caller** (`tests/unit/dues-ledger-not-exposed.test.ts`), gated by `LedgerActivation` (defaults inactive) at `:44`.

Neither function knows the other exists. This phase's whole job is the code that calls both, in the right order, for every eligible student, every month — nothing else.

## 1. How status history, baseline and effective-month assignments determine eligibility

Already fully built (0 above) — this phase adds no new eligibility logic. The job's only responsibility here is to **fetch** the two histories correctly before calling the pure function:

- `StudentStatusChange` rows for the student, mapped to `{ effectiveOn, sequence, status }` (matches `StatusHistoryRow`, `eligibility.ts:4-9`).
- `StudentPlanAssignment` rows for the student, each joined to its plan's `academyId` (matches `AssignmentRow`, `eligibility.ts:11-17` — `planAcademyId` isn't a column on `StudentPlanAssignment` itself; the job's query must join to `PaymentPlan.academyId`).
- Baseline (`src/lib/students/baseline-action.ts`) already guarantees every existing student has at least one row before this phase's job would ever need to ask about them — the job does not need its own "has this student been baselined" check; `UNDECIDABLE` from the reader already is that check, honestly.

## 2. How missing or uncertain history/configuration produces an explicit skip, never guessed debt — and how that differs from a configuration gap or a real failure

**Corrected:** the earlier draft folded three different kinds of outcome into one "skip, uniformly" bucket. They must stay distinct in the job's own reporting, even though none of them creates an obligation:

- **Not eligible (ordinary, expected)** — `eligibleAndAssigned`'s `UNDECIDABLE` (no status row before the month — pre-baseline gap), `NOT_ELIGIBLE` (not `ACTIVE`), `NO_ASSIGNMENT` (no assignment row, `planId` explicitly null, or a branch mismatch). Nothing to fix; this is the pure function working correctly.
- **Configuration gap (worth surfacing, not a policy question)** — even after `ELIGIBLE`, the resolved plan may have **no effective `PaymentPlanTerms` or `DuesPolicyVersion`** for the coverage month at all. `createMonthlyObligation` already refuses this cleanly — `staleVersion`, `inapplicable`, `notFound`, `currencyMismatch` (verified `:74-93`) — never inventing a price or a policy. This is **not** D24 (D24 is the unrelated, already-settled prepayment-months-ahead-limit decision) — it is simply the writer's own existing refusal set, doing exactly what it was built to do. An owner needs to see "eligible but unpriced" as a distinct fact from "not eligible," since only the first is something to go fix. **Gap for this phase:** nothing today resolves "given a `planId` and a target month, find the currently-effective `PaymentPlanTerms` id" outside `createMonthlyObligation`'s own internal use of `latestEffective` (`src/lib/dues/ledger/common.ts`), which the job cannot import from outside `src/lib/dues/ledger/` without tripping the same no-caller guard `lockStudent`'s extraction (`src/lib/students/lock.ts`) exists to avoid weakening. Not blocking — `createMonthlyObligation` re-validates and refuses cleanly regardless of how the job picked its candidate — but the job needs its own small resolver query.
- **Failure (a real problem, never reported as a skip)** — `conflict` (a genuine concurrency collision, e.g. the student's branch changed while the transaction waited) or an unhandled database error. These must be surfaced as failures to investigate, never folded into "skipped this month" the way the earlier draft implied.

## 3. Recovery, defined honestly

**Corrected:** pure date math guarantees identical output only for identical *stored inputs* — it does not, by itself, guarantee identical outcomes "regardless of anything," and the earlier draft implied more than that. Stated precisely:

- **Same stored inputs, asked at two different real times → identical outcome.** `eligibleAndAssigned` reads no clock (§0); `dueOn`/`graceDeadline` are computed purely from `coverage` and the policy's configured day-of-month (`:95-96`), never the creation instant. If nothing about a student's status, assignment, terms or policy history changes between an on-time run and a later recovery run, both produce the identical result.
- **Different stored inputs → correctly different outcomes, not a bug.** If October was skipped for a configuration gap (§2) and an owner then adds the missing `PaymentPlanTerms`, re-running for October correctly creates the obligation. Recovery does not mean reproducing a wrong answer; it means reproducing the same answer only when nothing relevant changed.
- **Existing obligations remain unchanged on rerun** — already guaranteed by `createMonthlyObligation`'s own duplicate check (`:65-70`), which this phase does not touch: a rerun for an already-generated month returns the existing row, unmodified.
- **A skipped month is not marked "permanently skipped" anywhere** — no such flag exists, and this phase does not add one. A month that produced `UNDECIDABLE`/`NO_ASSIGNMENT`/a configuration gap this run can be explicitly retried later and will succeed once the missing input is actually supplied through its own proper writer. A missed month does **not** "self-heal" when the next month bills normally — the earlier draft's claim to that effect is withdrawn; a skipped month stays unbilled forever unless someone retries it after fixing the actual gap.
- **A retry never invents status history.** If a student is `UNDECIDABLE` because no baseline or event row exists before the target month, retrying the job does not, and must not, fabricate one — that gap closes only through baseline (owner-run) or a real event. The job is a reader of history, never a writer of it.
- **Missing configuration, a concurrency conflict, and an unexpected failure remain three distinct reported outcomes** (§2), never uniformly folded into "skipped."

## 4. How obligations and coverage are created atomically without duplicates, including overlap with prepaid/package coverage

Fully answered by `createMonthlyObligation` alone, for one student/month at a time (verified `:66-72`, `:100-120`): the `MONTHLY`-per-student-per-month unique key and `DuesCoverage`'s unconditional uniqueness are checked as two separate guards inside the same transaction that creates both rows, so a prepaid or package-covered month is never double-billed and a duplicate call is idempotent. **Nothing new for this phase to build here** — the job's job is only to call this once per eligible student per month, which it will naturally do if it iterates students once per run.

## 5. Closing both assignment races: one consistent transaction, assignment writers included

**Corrected — the earlier draft accepted a race that must not be accepted.** It reasoned from the wrong precedent: no-backfill for a paused period is approved *policy* (the student genuinely owed nothing during that time); a race-induced skip of a student who was actually eligible is a correctness gap, not a policy outcome, and does not "self-heal" (§3). This section replaces that reasoning with an actual design.

A **status** change racing the job is still harmless by construction, unaffected by anything below: `pauseStudent`/`resumeStudent` write `effectiveOn = today`, which the strict-`<` cutoff (`eligibility.ts:46`) can never let affect the month being generated *right now*. Only the two assignment races need closing.

**Both races, restated precisely:**
1. A student has no assignment for the target month when the job reads eligibility (`NO_ASSIGNMENT`); a first-time assignment for that same month is inserted before the job would otherwise finish.
2. A student already has an applicable assignment (from an earlier month, still carrying forward under the `<=` rule) when the job reads eligibility (`ELIGIBLE`, priced against that plan); a *fresh* assignment row for the target month itself — a first-time assignment, not a correction; `assignPlan` allows the current month, only `correctAssignment` is future-only — is inserted before the job creates the obligation, changing which plan should actually apply.

**Root cause, verified directly against the merged code:** `assignPlan` (`src/lib/dues/assignment-actions.ts:59-112`) takes no lock on the student row at all — it relies solely on the `[studentId, effectiveYear, effectiveMonth]` unique constraint to stop a *second* assignment for the same month, which does nothing for a reader elsewhere observing a stale state. `correctAssignment` locks the assignment row (`lockAssignment`, `:36-45`) but never the student — irrelevant to both races, since its own `notFuture` precondition (`:143`) already makes it structurally incapable of touching a current-month row.

**The design: one lock order, extended, with every writer that touches a student's billing-relevant state taking the same first lock.**

1. **`assignPlan` gets one addition: `lockStudent(tx, organizationId, student.id)` as the first statement inside its existing transaction**, before `studentPlanAssignment.create`. Nothing else about it changes — same validation, same unique-constraint refusal, same audit row. This is the missing half of "assignment writers must participate in the synchronization too": once `assignPlan` holds the same lock the job holds, the two are strictly serialized by Postgres, not by timing. `correctAssignment` needs no change (structurally can't touch a current-month row).

2. **`createMonthlyObligation` gets a narrow, transaction-aware extraction, not a rewrite.** Its current body (`:55-139`) already does everything the job needs — branch `FOR SHARE`, student `FOR UPDATE`, then terms/policy `FOR SHARE`, then validate-and-create — inside one `prisma.$transaction` it opens itself. Extract that callback's body into an exported function that *takes* an already-open `tx` instead of opening one:
   ```
   export async function createMonthlyObligationInTx(
     tx: Tx,
     args: { context: TenantContext; studentId: string; coverage: YearMonth; planTermsId: string; policyVersionId: string },
     deps: LedgerDeps = {},
   ): Promise<CreateMonthlyObligationResult>
   ```
   identical logic, identical refusal set, identical lock order — it simply receives `tx` instead of opening one. The existing public `createMonthlyObligation` becomes a thin wrapper: its current pre-transaction checks (activation, format validation, student lookup) stay exactly as they are, then it calls `prisma.$transaction(tx => createMonthlyObligationInTx(tx, args, deps))`. Byte-identical behavior for a caller of the public function — there is none yet, so this is a safe, zero-behavior-change refactor. **This is the "narrow transaction-aware extraction," and the public wrapper is never called from inside another transaction** — the job calls the inner function directly.

3. **The job's own per-student transaction — the same order `createMonthlyObligation` already uses, with the status/assignment read inserted where the data actually needs to be read:**
   ```
   prisma.$transaction(async (tx) => {
     branch  := lockBranchShared(tx, organizationId, academyId)                    // existing order
     student := lockStudent(tx, organizationId, studentId)                        // existing order
     status  := read StudentStatusChange for this student                         // NEW — now inside the lock
     assign  := read StudentPlanAssignment (+ each plan's academyId)              // NEW — now inside the lock
     outcome := eligibleAndAssigned(status, assign, academyId, month)             // pure, unchanged
     if outcome is not ELIGIBLE: return { skipped: outcome }                      // commits; nothing written
     termsId, policyId := resolve a candidate effective version (§2's small gap)
     return createMonthlyObligationInTx(tx, { context, studentId, coverage: month, planTermsId: termsId, policyVersionId: policyId }, deps)
   })
   ```
   This is not a new lock order — it is `createMonthlyObligation`'s own order, unchanged, with one read inserted between the student lock and the terms/policy lock. Because `assignPlan` now takes the same student lock first, whichever transaction acquires it first fully determines what the other sees — a real, serializable order, not a timing accident. Either race above then resolves to one of two outcomes, both correct: the job proceeds with the assignment truly in effect at the moment it held the lock, or `assignPlan`'s insert waits and lands cleanly after the job's transaction commits — in which case the assignment genuinely arrived one moment too late for this month, a legitimate outcome (§3's retry path picks it up), not a bug.

**No deadlock introduced:** every writer here takes at most {branch, student, terms, policy} in that fixed order; `assignPlan` takes only {student}, a strict subset that cannot form a cycle against a writer taking the full ordered set.

## 6. How approved enrollment and resume-month charges remain separate from recurring monthly generation

Already true by construction, restated, not reopened: `createMonthlyObligation`'s own doc comment states it plainly (`:12-14`, verified verbatim): *"It decides nothing about WHO is billed or WHEN: eligibility, status history, assignments and the monthly job are separate work."* `eligibleAndAssigned` has no branch for "was recently resumed" or "just joined" (confirmed, `eligibility.ts` has no such input). A4's `enrollmentTiming` (`src/lib/dues/calendar.ts:87`) and the approved resume-charge rule (documented, not implemented, in `ELIGIBILITY-PREREQUISITES-BRIEF.md` §3.4) are both **separate, explicit callers** of `createMonthlyObligation` whenever they are eventually built — the monthly job this phase adds is a **third**, independent caller, and none of the three needs to know the others exist. Nothing to decide here; this phase's job must simply not grow a branch for either case.

## 7. How generation stays inactive and unscheduled until rollout approval

Two independent gates, both already in place, both to be preserved unchanged by this phase:

- `LedgerActivation` (`activation.ts`, injected into `createMonthlyObligation`, defaults inactive) — the job calling the writer with the production default still creates nothing; every attempt returns `notActive`.
- **Scheduler registration is a literal, named file**: `vercel.json`'s `crons` array (currently one entry, `/api/cron/weekly-digest`). This phase adds no entry there — since this phase builds no route at all (below), there is nothing to register in the first place; "unscheduled" here means the same structural no-caller discipline `createMonthlyObligation`/`eligibleAndAssigned` already use, extended to this new function.
- **Corrected shape:** not an HTTP route, not a server action, no manual production entry point. A plain, server-only library function, following the exact isolation discipline `eligibleAndAssigned` and `createMonthlyObligation` already use — no caller at all, tested by calling it directly, registered in `scripts/pending-callers.ts` alongside the eligibility reader. `weekly-digest`'s per-item-isolation *shape* (one student's failure doesn't block another's within a run) is still worth following internally as an in-process loop, but the function itself is never wired to a route, an action, or `vercel.json` in this phase.

## 8. Scope for this phase, given the above

1. **`assignPlan`**: add `lockStudent` as its first transactional step (§5.1) — the only change to an existing writer this phase makes. `correctAssignment` unchanged.
2. **`createMonthlyObligation`**: narrow transaction-aware extraction (§5.2) — `createMonthlyObligationInTx(tx, args, deps)`, with the existing public function becoming a thin wrapper around it. No behavior change for the public function (it has no caller yet).
3. **A new, server-only library function** (not a route, not a server action, §7) that, per student per branch per month: opens one transaction in the order in §5.3, reads status/assignment fresh under the student lock, decides via `eligibleAndAssigned`, and — only when `ELIGIBLE` — resolves candidate terms/policy ids and calls `createMonthlyObligationInTx` inside that same transaction. Reports three distinct outcome categories per student (§2/§3): not-eligible, configuration-gap, failure.
4. No caller wired anywhere — not `vercel.json`, not a route, not a server action. No change to `LedgerActivation`'s default (stays inactive). No change to `eligibleAndAssigned`'s own logic (still pure, untouched).
5. Tests, real-database:
   - Both assignment races (§5), via genuine two-connection concurrency (the `pg_stat_activity`-polling pattern, not wall-clock) — proving a deterministic, consistent outcome under real lock contention.
   - Simultaneous generation for the same student (two concurrent calls serialize on the student lock; no duplicate obligation).
   - A rerun after the missing input (assignment or configuration) is supplied succeeds and creates the obligation correctly (§3).
   - A rerun of an already-generated month changes nothing (existing row returned unmodified, verified byte-for-byte).
   - On-time vs. delayed generation with **equivalent** stored history produces an identical result (§3's corrected claim — equivalent inputs, not "regardless of anything").
   - Structural: the new function has no caller; `assignPlan`'s added lock changes none of its existing test outcomes.

**Explicitly not reopened:** resume-charge timing — already resolved (`ELIGIBILITY-PREREQUISITES-BRIEF.md` §3.4: full price, no proration, coverage month = the calendar month of the resume date), unaffected by and unrelated to this phase. D24/D25, reversal-vs-refund, permissions on any existing writer, package/prepayment policy — none of this phase's scope touches any of them.

## 9. Order after this brief

This phase, then the fee job (late-fee assessment against `graceDeadline`, using the same per-student isolation shape), the reversal action, the decided prepayment/package work, the resume payment-write integration (§3.4), refunds, signup, opening balances, consumer integration, readiness, activation last.
