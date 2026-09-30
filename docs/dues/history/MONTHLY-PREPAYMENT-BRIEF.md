# Brief: prepaying future monthly obligations

Status: **brief finalized, implementation approved pending the design details below being closed — tracked as closed in this revision.** Written 2026-09-29 from main `533198a` (through the late-fee-waiver PR #75, merged). **Finalized 2026-09-29**: the user approved four policies (§1, §8) and required five targeted design details be closed before implementation (assignment provenance completeness, both `correctAssignment` serialization orders, the shared write core staying internal/transaction-only, the purchase-time instant's exact capture point, and current-month gaps being explicitly out of scope) — all five are resolved below. No further policy blocker identified. Previous versions: `MONTHLY-PREPAYMENT-BRIEF-before-reuse-and-gap-correction.md`, `MONTHLY-PREPAYMENT-BRIEF-before-finalization.md`. Scope remains **ordinary monthly prepayment only** — packages, refunds, CRC conversion, and UI are out of scope.

## 0. What already exists, verified

- **`DuesObligation.origin` already has a `PREPAYMENT` value** (`schema.prisma:1285-1289`), unreferenced anywhere in application code today. This phase is the first writer that would ever set it.
- **The per-branch prepayment limit already exists, already wired into the owner config UI**: `DuesPolicyVersion.maxPrepaidMonths Int?` (`schema.prisma:1145-1147`), parsed/validated/round-tripped by `correctPolicyVersion` (`config-actions.ts:78,96-103,154,163`) already. **No migration needed for the limit itself.**
- **The limit is versioned exactly like every other policy field**, resolved by `latestEffective(versions, month)` (`common.ts:74-82`).
- **`createMonthlyObligationInTx` does not work unchanged for this phase** — it unconditionally refuses any future month (`create-monthly-obligation.ts:63`) and hardcodes `origin: "STAFF"` (`:106`). §2 is the proposed fix: a narrow internal extraction, not a bypass.
- **Monthly generation already recognizes any pre-existing obligation and skips it, once one exists — for free** (`monthly-generation.ts:42-123` → `create-monthly-obligation.ts:66-72`'s existing duplicate/`coverageTaken` handling).
- **The global lock order for ledger writers vs. configuration corrections is already documented and verified**: branch `FOR SHARE` (ledger) vs. `FOR UPDATE` (corrections), student `FOR UPDATE`, terms/policy `FOR SHARE` (ledger) vs. `FOR UPDATE` (their corrections) — deadlock-free, each side waits only on locks later in the same fixed order (`common.ts:10-19`).
- **Assignment locking is not uniform, verified by reading both writers**: `assignPlan` (`assignment-actions.ts:91`) locks the **student** row. `correctAssignment` (`:154-159`) locks only the **specific `StudentPlanAssignment` row** (`lockAssignment`, module-private, `FOR UPDATE`), and only permits correcting a row whose effective month is still strictly future (`notFuture` otherwise, `:158`). The student lock does not serialize against this.
- **`assignmentRevision` already exists** (`assignment-actions.ts:56`: `const assignmentRevision = (row) => versionRevision({ planId: row.planId })`, module-private) — the exact fingerprint `correctAssignment` itself checks staleness against. Exporting it (a one-line change) is the smallest way to reuse the identical value for provenance (§5), rather than recomputing an equivalent by hand.

## 1. The prepayment limit — CONFIRMED policies (not reopened below)

**Approved, exactly as stated:**

1. **`maxPrepaidMonths` is a standing calendar horizon measured from the branch's current month, not a per-transaction count.** Worked example, exactly as given: current month September, limit 3 → coverage may stand through December (Oct, Nov, Dec — 3 future months). A student who already holds all three cannot purchase a fourth until the calendar advances and one of the three becomes current (freeing one month of horizon). Repeated purchases can never extend the horizon beyond the limit at any single point in time.
2. **The limit is read from the policy version effective at recording time, in the branch's timezone — never from an older version a backdated `receivedOn` might otherwise select.** A payment recorded today against a backdated `receivedOn` is measured against **today's** effective `maxPrepaidMonths`, full stop — `receivedOn` has no bearing on which policy version governs the limit. **Tuition (and fee) remain priced per §5's existing rule: each covered month's own effective terms/policy version, unaffected by this.** These are two different resolutions for two different purposes, deliberately: the limit is a *today* governance gate; price is a *per-month* snapshot.
4. **Lowering the limit never changes existing purchased coverage.** Confirmed exactly as the prior draft's worked example already showed (§11 keeps that example) — a later, lower `maxPrepaidMonths` only constrains *new* purchase attempts going forward; nothing about it is retroactive, and no existing `DuesObligation`/`DuesCoverage`/settlement row is ever touched by a policy correction.

**The check, precisely**: `standing horizon = latestEffective(policyHistory, purchaseTimeMonth).maxPrepaidMonths` (§6 defines `purchaseTimeMonth` precisely); refuse `prepaymentUnavailable` if `null`; otherwise refuse `prepaymentLimitExceeded` if `(months already covered strictly after purchaseTimeMonth) + (months in this request)` exceeds it.

## 1b. Authorization — CONFIRMED: owner-only

**Approved**: `prepayMonthlyObligations` is owner-only (`context.organizationRole === "ADMIN"`), checked **inside the writer itself**, alongside tenant/branch scope and the inactive-by-default activation gate — not relied upon from any future caller, the same "trust nothing from the caller" discipline `correctLateFeeAndSettle`/`reversePayment`/`waiveLateFee` already apply to their own role requirement. `recordDuesPayment` itself has no role restriction today (D5, "who records purchases and edits plans," remains explicitly pending in the original proposal) — this brief does not resolve D5 for ordinary payment recording, and explicitly does not change `recordDuesPayment`'s existing behavior. D5 is recorded as a prerequisite that must be resolved before any staff-facing payment-recording exposure, prepayment included, reaches a route or UI (§10).

## 2. The internal reuse design — internal, transaction-only, no bypass

**Extract everything in `createMonthlyObligationInTx` after its branch/student locks and its `futureMonth` check** (`create-monthly-obligation.ts:66-138`: duplicate detection, terms/policy resolution+locking+staleness, applicability/currency checks, the write itself) into a new function, `writeMonthlyObligationInTx(tx, { context, student, coverage, planTermsId, policyVersionId, origin: DuesObligationOrigin }, deps)`. `origin` becomes a parameter instead of the hardcoded `"STAFF"` literal.

**Kept internal and transaction-only, exactly as required — not a general future-month bypass:**

- `writeMonthlyObligationInTx` is **not exported for external use** beyond this ledger's own internal composition — no route, no server action, no scheduler entry ever calls it directly, the same closed-by-default posture every writer in this ledger already has. It takes an already-open `tx`; it never opens its own transaction, and nothing about its existence changes how a caller from outside the ledger could reach it (it isn't reachable at all).
- It **preserves every existing check unmodified**: activation (`deps.activation.isActive`), coverage-month format (`isValidCoverageMonth`), tenant scope (`inTenantScope`), and the full terms/policy lock-then-read-then-staleness sequence (`lockTermsShared`/`lockPolicyShared`, then `latestEffective` re-verification) — nothing is skipped, nothing is weakened, only the `futureMonth` decision and the `origin` literal move to the caller.
- `createMonthlyObligationInTx` keeps its exact existing signature, behavior, and error set: branch/student locks, the **unmodified** `futureMonth` refusal, then delegates to `writeMonthlyObligationInTx(tx, { ...args, origin: "STAFF" }, deps)`. Every existing caller (`createMonthlyObligation`, `generateMonthlyObligationForStudent`) is unaffected, proven by their own unmodified test suites passing unchanged.
- The new prepayment writer takes its own branch/student locks, does its own future-only/no-gap validation (§3, §4) under those locks, then calls `writeMonthlyObligationInTx(tx, { ..., origin: "PREPAYMENT" }, deps)` per month — never `createMonthlyObligationInTx`, which would always refuse a future month.
- **No `deps.now` override to fake the clock past the `futureMonth` check, and no flag/parameter on any existing function to skip it.** The refusal stays entirely inside `createMonthlyObligationInTx`, untouched and unbypassable; the new writer earns its future-month capability by calling a different, lower-level function that simply has no opinion on direction, not by disabling a check.

## 3. Current-month gaps are explicitly out of scope — no invented enrollment/resume charges

**This writer's notion of "uncovered" is floored at `currentMonth + 1` and never looks earlier.** The proposal's own ordered list (§9) already separates "(a) every unsettled obligation, oldest first" — which covers the *current* month if its obligation exists but is unpaid, and is `recordDuesPaymentInTx`'s job, composed as-is for whatever current debt the caller explicitly names — from "(b) future coverage periods." This writer implements **only (b)**. Concretely:

- If the current month's own obligation does not yet exist (the monthly job hasn't run, or the student was just assigned), or exists but is unpaid, **this writer does nothing about it, reads nothing about it beyond determining that "future" starts at `currentMonth + 1`, and creates nothing for it.** That is ordinary billing's job (the monthly job, staff entry, or an explicit current-debt obligation id passed into the same receipt, §9) — never this writer's.
- If a genuine historical gap exists further back (a month that was never billed at all — a paused/resumed student, a data correction, anything predating the current month), this writer **does not detect it, does not attempt to fill it, and does not invent an enrollment or resume-charge obligation to reconcile it.** Such a gap is a distinct, unrelated, out-of-scope concern (an eventual "opening balance"/resume-charge mechanism, not decided or touched here). `firstUncovered` (§4) is defined with a hard floor at `currentMonth + 1` specifically so this writer's own gap check can never even observe a pre-existing historical gap, let alone react to one.

## 4. Explicit coverage-gap validation

`firstUncovered` = the smallest `YearMonth >= currentMonth + 1` (§3's floor; §6 defines the exact instant `currentMonth` is derived from) with no `DuesObligation` row (any type) and no `DuesCoverage` row for this student.

```
refuse (coverageGap) unless:
  requestedMonths, sorted, are consecutive (each step exactly +1 calendar month), AND
  requestedMonths[0] === firstUncovered
```

**Dated example, current month 2030-09**: `firstUncovered = 2030-10` (nothing future covered yet). `[2030-10, 2030-12]` refuses `coverageGap` (November absent between the two) — zero writes. `[2030-10, 2030-11, 2030-12]` succeeds. `[2030-11, 2030-12]` refuses `coverageGap` (`requestedMonths[0] !== firstUncovered`, since October is still open) — zero writes.

## 5. Lock order, `correctAssignment`'s race, and complete provenance

**Lock order for one purchase:**

```
lockBranchShared(tx, organizationId, academyId)
lockStudent(tx, organizationId, studentId)
capture purchaseInstant ONCE, here — AFTER both locks above are held (§6)
validate requestedMonths against firstUncovered (§4) using purchaseInstant's derived currentMonth
resolve and check the limit (§1) using purchaseInstant
for each requested month, oldest first:
  resolve the candidate StudentPlanAssignment row for this month (unlocked, cheap read)
  lockAssignmentShared(tx, organizationId, assignment.id)   — NEW, FOR SHARE, added to common.ts, mirrors lockTermsShared/
    lockPolicyShared exactly
  RE-READ the assignment row's planId/effectiveYear/effectiveMonth fresh, now that the lock is held — the pre-lock read
    above could already be stale; only the locked, re-read values are trusted for both pricing and provenance
  resolve that month's effective planTermsId/policyVersionId (latestEffective) using purchaseInstant
  writeMonthlyObligationInTx(tx, { ..., origin: "PREPAYMENT" }, deps) — takes lockTermsShared/lockPolicyShared itself, per
    month, since different months may resolve to different effective versions across a scheduled change mid-span
  write this month's AuditLog entry with COMPLETE assignment provenance (below), not merely an id
  refuse the WHOLE purchase (rollback) if any month's call refuses
then settle (§9)
```

**Why `lockAssignmentShared` is necessary, and both serialization orders it must be proven to produce:**

`correctAssignment` locks the specific assignment row `FOR UPDATE` and only for a row whose effective month is still future — precisely the rows this writer resolves and relies on. Two orders are possible and both must be proven correct, not just one:

- **Purchase acquires the assignment lock first**: `correctAssignment`'s own `FOR UPDATE` attempt on that row queues behind this writer's `FOR SHARE`, and only proceeds (or refuses `stale`/`notFound` against whatever changed) after this purchase's transaction commits or rolls back. The purchase's provenance (below) reflects the plan that was actually in effect for its own decision, permanently, regardless of what `correctAssignment` does next.
- **`correctAssignment` acquires the row lock first**: this writer's `lockAssignmentShared` call queues behind the correction's `FOR UPDATE`, and only proceeds once the correction commits (or rolls back) — so the purchase's subsequent re-read (mandatory, above) sees the **corrected** `planId`, never the pre-correction value, and resolves/prices/records provenance against the genuinely current state. There is no window where the purchase could price against a value `correctAssignment` had already superseded.

Both orders leave the system in a well-defined, correct state; neither can ever interleave inconsistently. §7 requires both be proven as genuine-overlap tests, not merely reasoned about.

**Provenance, corrected to be complete — capturing only an id is insufficient, since the row it points to is mutable (`correctAssignment` can still change it while its effective month remains future):** the `AuditLog` entry this writer creates for each obligation (`after` payload, mirroring `create-monthly-obligation.ts:121-137`'s existing shape) must record, for the assignment relied upon:

- `assignmentId` — which row.
- `effectiveYear`/`effectiveMonth` — the assignment period, which itself never changes even if `planId` does (`correctAssignment` only ever updates `planId`, never the effective month, `assignment-actions.ts:161-164`).
- `planId` — the value **actually resolved and relied upon**, read fresh after `lockAssignmentShared` succeeds, not the pre-lock candidate.
- `revision` — `assignmentRevision(row)` (exported from `assignment-actions.ts`, reused verbatim, not recomputed by hand), the exact fingerprint of the row's mutable state (`planId`) at the moment this writer relied on it. A later reader can compare this recorded revision against the row's *current* `assignmentRevision` to know definitively whether it has since been corrected, and to what it pointed before — the same stale-detection value `correctAssignment` itself already uses to detect a stale *edit*, reused here to detect a stale *reference* after the fact.

This is an append-only `AuditLog` write — `correctAssignment`'s later update can never alter or erase it, satisfying "preserves the evidence used after that assignment is corrected" completely, not just partially (an id alone, pointing at a row whose `planId` may have since moved on, would leave a reader unable to reconstruct what was actually relied upon without this).

## 6. One consistent purchase-time reference — captured after the relevant locks

**Corrected placement, precisely, per the requirement**: `purchaseInstant` is captured **once**, immediately after `lockBranchShared` and `lockStudent` both succeed (§5's lock-order block) — not before. Acquiring those locks can itself take real time (queued behind a contending configuration correction or another purchase), so capturing "now" before them could use an instant that is already stale relative to the state this transaction is about to examine; capturing it right after means every subsequent decision in this purchase (`currentMonth` for §3/§4's floor, the limit resolution in §1, and — via `deps` — anything any composed `writeMonthlyObligationInTx`/`recordDuesPaymentInTx` call needs) uses the exact same value, computed from the moment this transaction's real work actually begins. No later step in the purchase calls `new Date()`/`deps.now()` again on its own; `purchaseInstant` is threaded through explicitly everywhere it's needed. (Removed from the prior draft: the incorrect claim that Postgres's snapshot isolation itself stabilizes the application clock — it doesn't; a single explicit capture point is what actually provides the guarantee.)

## 7. Failed validation, retries, explicit binding

**Whole-purchase atomicity**: any month's `writeMonthlyObligationInTx` refusal, the limit check, the gap check, or the final settlement's refusal rolls back the entire transaction — the same throw-and-convert-after-rollback mechanism `correctLateFeeAndSettle` already established.

**Retries bound to explicit selections, never recomputed scope**: the writer's contract requires an explicit, caller-supplied `requestedMonths: YearMonth[]` and, for combined receipts (§9), explicit current-debt `obligationIds` — never an implicit "prepay the next N uncovered months." A retried identical request hits the existing coverage/duplicate checks (§0, §4) and refuses or no-ops cleanly; it can never silently extend into further, not-originally-requested months on a second attempt.

## 8. Reversal — APPROVED as a temporary restriction, its cost stated, a readiness-review item

**Approved, exactly as stated**: temporarily refuse reversal of the **entire** payment if **any** settlement it contains covers a `PREPAYMENT`-origin obligation — permanently, even after that obligation's coverage month has passed and it looks, in every other respect, like an ordinary settled obligation. `reverse-payment.ts:101`'s existing `unsupportedObligationType` check (`type !== "MONTHLY"`) cannot distinguish this case; add `origin` to its settlement/obligation select (currently only `type`, `:77`) and refuse `prepaymentBlocksReversal` accordingly — mirroring Decision B's exact shape.

**Cost, stated plainly, not left implicit**: because `reversePayment` reverses a whole payment's settlements atomically with no partial-reversal mechanism, a payment that combined ordinary current debt with even one prepaid future month becomes entirely unreversible through this writer — including the ordinary-debt portion. This is deliberate, conservative, and permanent (an `origin` never changes back), pending a real prepayment-reversal/cancellation policy this brief does not design.

**Readiness-review item, required by this revision**: this restriction must be recorded as an explicit item for the readiness/activation review that precedes turning the ledger on for any organization — not merely left as a comment in the writer's own file. Concretely: the writer's doc comment states it (mirroring `reverse-payment.ts`'s own existing doc-comment precedent for Decision B), **and** its `scripts/pending-callers.ts` entry's `reason` field states it explicitly as a standing limitation review must consider — the same mechanism this session has already used to surface every other "not yet production-exposed, here's exactly why" fact for `correctLateFeeAndSettle`/`reversePayment`/`waiveLateFee`. No separate document is invented for this; the existing review surface is reused.

## 9. Existing outstanding debt plus future months in one receipt

Unchanged: `record-payment.ts`'s existing `settleReceipt`/`outstandingItems` (`settlement.ts:70-75,97-117`) already enforce single-currency, exact-total, k-prefix-only acceptance. The combined list is current debt (explicit `obligationIds`, §7) oldest first, then the newly created future months in requested order; `settleReceipt` runs over the combined list exactly as today. §4's gap check governs only the future portion; §1's limit counts only future months, never current debt.

## 10. Explicitly out of scope, dependencies identified, not designed

- **Packages**: a structurally different creation path (one obligation row, not N); this phase's lock-order/atomicity reasoning would likely transfer, needs its own brief.
- **Refunds**: depends on refund policy, explicitly pending (`PROPOSAL.md:238`, D4).
- **CRC conversion**: unrelated — reuses the existing single-currency gate unmodified.
- **UI**: depends on this writer's finalized shape.
- **Historical/current-month billing gaps** (§3): explicitly not this writer's concern; no enrollment/resume-charge mechanism is invented here.

## 11. Owner decisions

- **Approved, not reopened (§1)**: standing calendar horizon from the branch's current month; limit resolved at recording time in the branch timezone, unaffected by a backdated `receivedOn`; lowering the limit never touches existing coverage.
- **Approved, not reopened (§8)**: the `origin`-keyed, whole-payment, permanent reversal restriction — recorded as a readiness-review item.
- **Closed by this revision**: complete assignment provenance (§5), both `correctAssignment` serialization orders proven (§5, §7 tests), the shared write core kept internal/transaction-only with no bypass (§2), the purchase-time instant's capture point fixed after the relevant locks (§6), current-month gaps explicitly out of scope with no invented reconciliation (§3).
- **Not reopened**: D1 (CRC), D4 (refunds), packages, UI, activation/scheduler rollout, `maxPrepaidMonths: null` meaning unavailable.
- **No further policy blocker identified. Ready for implementation.**

## 12. Tests, planning-level

Real-database, all required, genuine concurrency discipline throughout (`waitUntilBlockedOnLock`/PID-scoped chain proofs, never wall-clock):

- The internal-reuse extraction: `createMonthlyObligation`/`generateMonthlyObligationForStudent`'s full existing suites pass unmodified against the `writeMonthlyObligationInTx`-backed core.
- §1's standing-horizon example exactly: September, limit 3, coverage through December; a fourth month refused `prepaymentLimitExceeded` until one of the three becomes current; a backdated `receivedOn` request still measured against today's effective limit, not an older one.
- §4's exact dated gap example (Oct/Dec skipping Nov refused; Oct/Nov/Dec succeeds; Nov/Dec while Oct open refused).
- **Both `correctAssignment` serialization orders (§5), each a genuine-overlap proof**: (a) purchase locks the assignment row first, `correctAssignment` queues and only proceeds after; (b) `correctAssignment` locks first, the purchase's re-read after its own lock acquisition sees the corrected `planId`, and its recorded provenance (`assignmentId`/`effectiveYear`/`effectiveMonth`/`planId`/`revision`) matches exactly what was actually relied upon in each case.
- §3: a request for future months succeeds regardless of whether the current month's own obligation exists, is unpaid, or has a historical gap behind it — proving this writer never reads, touches, or reacts to any of that.
- §6: a purchase artificially slowed between lock acquisition and its later steps (via a test hook) still uses one consistent `purchaseInstant` throughout — the limit check and every month's future-ness agree even if wall-clock time would have moved on.
- §7: an identical retried request (same explicit months) either succeeds once or cleanly refuses/no-ops on retry — never silently extends further.
- §8: a payment settling a `PREPAYMENT`-origin obligation (alone, and combined with current debt) refuses `prepaymentBlocksReversal`, including after the clock advances past that month; an otherwise-identical `STAFF`/`SCHEDULED_JOB`-only payment reverses normally.
- Price/policy changes mid-span: two consecutive future months at two different effective versions, both obligations correctly frozen at their own month's rate.
- Lowering the limit below already-purchased coverage: existing rows entirely untouched; only new purchase attempts are gated going forward.
- Any single month's refusal (stale version, currency mismatch, duplicate) rolls back every other month's provisional obligation in the same purchase; the settlement step's own refusal does likewise — zero partial writes.
- Concurrent monthly generation, concurrent `assignPlan`, concurrent price/policy corrections: all serialize correctly on the existing shared locks, unaffected by this phase.
- Ordinary generation and ordinary payment behavior: `generateMonthlyObligationForStudent`'s and `recordDuesPayment`'s full existing suites pass entirely unmodified.

## 13. Order after this brief

This phase's implementation (now authorized), then packages, then payment-write integration, then refunds, then consumer integration, readiness, activation last.
