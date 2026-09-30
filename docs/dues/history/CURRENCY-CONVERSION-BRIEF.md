# Brief: converting between USD and CRC at settlement (BCR sell rate)

Status: **brief only, nothing implemented.** Written 2026-09-29 from main `7781206` (through the package-purchase PR #77, merged). **All twelve currency policies are now CONFIRMED by the owner (§1, §1b) and are not reopened anywhere below (§9).** This revision also corrects: resolution does not always reach `recordDuesPaymentInTx` — a package-originated receipt must resolve through the shared settlement core directly, the same reason `purchasePackage` itself never composes that function (§7.2); the exact in-transaction step order is now stated per `kind`, quote lock first, then this ledger's established row-lock order (§7.2); a real database uniqueness backstop is added for "at most one payment per receipt," not the application-level guard alone (§7.3); and a cancellation writer is designed (§7.4). A three-PR implementation sequence is proposed for approval (§11). Previous full-rewrite versions: `CURRENCY-CONVERSION-BRIEF-before-comparison-and-versioning-correction.md`, `CURRENCY-CONVERSION-BRIEF-before-revision-ordering-correction.md`, `CURRENCY-CONVERSION-BRIEF-before-policy-confirmation-and-awaiting-rate-design.md`, `CURRENCY-CONVERSION-BRIEF-before-outermost-lock-and-evidence-correction.md`. Rate units throughout: **CRC per 1 USD**. Received date and recording date are distinguished throughout.

## 0. What already exists, verified

- **`Currency` already has both values, already generic on every model that prices anything.** A CRC-priced obligation is structurally representable today — confirmed needed in practice too (policy 5).
- **Money is already currency-agnostic at exactly two decimal places, for both currencies** (`minor-units.ts:1-7`).
- **No conversion mechanism exists anywhere today.** `settleReceipt` (`settlement.ts:97-117`) refuses any currency mismatch outright.
- **`settleReceipt` is called from two separate, un-consolidated sites**: `recordDuesPaymentInTx` and `purchasePackage`. Prepayment and fee correction both compose `recordDuesPaymentInTx`.
- **`selectableTotals?: string[]` is a bare, currency-unlabeled array** (`record-payment.ts:157-165`), safe today only because it is always implicitly the item currency.
- **`ExchangeRateQuote` was sketched in `PROPOSAL.md:259`** — its originally-proposed uniqueness cannot support a correction (§5).
- **A shared, correctable configuration value that a settlement must not race is already established four times as a real row lock**: `lockBranchShared`/`lockTermsShared`/`lockPolicyShared`/`lockAssignmentShared`.
- **A deterministic-ordering-under-lock precedent exists separately from row locks**: `StudentStatusChange.sequence`, computed as `MAX(sequence) + 1` under a lock.
- **Advisory-lock organization-wide serialization is also already established — four call sites, verified across all of `src/`**: `staff-service.ts:69` (bare `hashtext(organizationId)`), `locations/location-service.ts:75` and `promotion/accounting-activation.ts:395` (a `"namespace:orgId"` string-prefix convention), and `kiosk/rate-limit.ts:137`. **All four use the single-bigint-argument form of `pg_advisory_xact_lock`.** None combines the advisory lock with any ledger row lock in the same transaction — the full scope actually checked (§4 states precisely what this claim does and doesn't cover).
- **`correctLateFeeAndSettle` is a top-level, self-transacting function, not a composable `*InTx` core** — verified directly (`correct-late-fee.ts:88-89`: `return await prisma.$transaction(async (tx) => {...})`), and it settles exactly one obligation (`obligationIds: [fee.obligation.id]` internally). **It cannot be called from inside another function's own transaction without nesting `prisma.$transaction` — the exact composition mistake this session has avoided everywhere else — and it cannot handle a multi-obligation receipt as-is.** §7 corrects a proposal in an earlier round of this brief that assumed otherwise.

## 1. Confirmed policies — all six, not reopened

1. **CRC rounding**: required CRC amounts round to the **nearest whole colón** — an approved business rule, not a technical necessity (the schema holds fractional colones exactly).
2. **Missing exact-date rate**: use the **most recent earlier** quote. Never a later one.
3. **No quote at all**: preserve an **awaiting-rate receipt** (§7). Settles nothing.
4. **Correcting a quote**: warn the owner how many completed payments used the value being replaced. Those payments are preserved unchanged, permanently.
5. **Reverse direction confirmed needed**: a CRC-priced obligation may be paid in USD, using BCR's **SELL** rate in both directions — never buy, never substituted.
6. **Rates are organization-wide.**

**The bidirectional rule**: converting **to CRC** multiplies by the rate; converting **to USD** divides by it. Same sell rate either way (§3).

## 1b. Six further confirmed policies — resolving §9's prior open items

1. **Halfway amounts round up** (both directions).
2. **No tolerance** around the required rounded total — an exact match is required, matching every same-currency payment.
3. **USD tender rounds to the nearest cent, halfway up** — the direct parallel to policy 1 for direction 2 (§3).
4. **An earlier-rate fallback (policy 2) has no automatic maximum age.** The actual `quoteDate` used is preserved and displayed distinctly from `receivedOn` (§6) — however old the fallback, a reader always sees exactly which date's rate actually governed the settlement.
5. **Awaiting-rate receipts are resolved by owners only** — `context.organizationRole === "ADMIN"`, checked inside the resolution writer itself, the same discipline every owner-only writer in this ledger already applies to its own role check.
6. **No automatic expiry.** A pending receipt may be **cancelled, owner-only, with a required reason** — §7.4 designs this writer. Cancellation preserves the receipt and every field on it permanently (never deleted), and implies no refund, credit, or settlement of any kind — it only records that the owner decided not to pursue completing this receipt.

## 2. Proposed schema addition

**`ExchangeRateQuote`**: `id, organizationId, provider ("BCR"), pair ("USD/CRC"), side ("SELL"), quoteDate, revision (Int, allocated under lock — §4/§5, never a timestamp), value, enteredById, enteredAt (audit metadata only), sourceNote?, supersedesId?`. `@@unique([organizationId, provider, pair, side, quoteDate, revision])`.

**On `DuesPayment`**: `appliedRateId String?` (null for same-currency payments), plus a snapshotted copy of the quote's `value`, `quoteDate`, and `revision` — never re-read live (§6).

**No changes to `DuesObligation`, `DuesSettlement`, `DuesCoverage`, or any existing enum.**

## 3. The comparison arithmetic — bidirectional

**To CRC (multiply)**: for each candidate USD settlement total (exact), multiply by the exact rate, round once to the nearest whole colón (policy 1), compare against the tendered CRC amount.

**To USD (divide), confirmed needed by policy 5**: for each candidate CRC settlement total (exact), divide by the exact rate, round once to the nearest USD cent, compare against the tendered USD amount. Same `SELL` side either direction.

**Worked examples, recalculated by hand:**
- USD 100.00 × 505.37 = **50,537.00 CRC** exactly.
- USD 96.43 × 505.37 = **48,732.8291 CRC** raw → **48,733 CRC** (nearest whole colón, rounding up on a tie per §1b policy 1, approved).
- CRC 50,000.00 ÷ 505.37 = **98.937...** USD raw → **USD 98.94** (nearest cent).

**Rounding collisions**: two distinct exact totals can round to the same required figure. A tendered amount matching more than one refuses (`ambiguousSelectableTotal`) — never guessed. Same-currency behavior is completely untouched.

## 4. Concurrency — the advisory-lock namespace, and where it must actually be acquired

### 4.1 Namespace: the two-integer form, not a string prefix

**Corrected again**: an earlier round of this brief recommended following the codebase's existing `"namespace:orgId"` string-prefix convention (three of the four existing call sites use it). **That does not satisfy "an explicitly separate advisory namespace"** — a string prefix lowers collision probability against those specific existing keys but provides no structural guarantee, and (as the user's own prior correction already established) a probabilistic argument isn't what was asked for.

**Corrected design**: Postgres's two-integer form, `pg_advisory_xact_lock(key1, key2)`, occupies a lock-key space **entirely separate** from the single-bigint form all four existing call sites use — not a matter of probability, a documented Postgres guarantee that the two forms never collide with each other. Reserve a fixed `key1` for exchange-rate quotes (e.g., a named constant, documented as never reused for any other feature's two-integer lock), and use `key2 = hashtext(organizationId)`.

**Residual risk, stated precisely, not claimed away and not called universally harmless**: this guarantees separation from the four *existing* single-bigint locks. It does **not** eliminate the possibility that two *different organizations'* `hashtext(organizationId)` values collide within the reserved `key1` namespace — `hashtext` is a 32-bit function, and two distinct inputs can map to the same output. If that happens, those two organizations' quote operations would serialize against each other unnecessarily for the duration of one transaction. This is the only mechanical effect reasoned through here: the lock is used purely for ordering, never as a substitute for the real `organizationId` columns and constraints that actually scope every row this design touches, so a collision cannot cause one organization's data to be read, written, or confused with another's. That is as far as this brief's own reasoning goes — it is not a claim that no other consequence exists anywhere in the application, and it is not a claim that deadlocks are impossible in general (§4.3 states precisely what *is* verified).

### 4.2 Where the lock must be acquired — traced across every real entry point, corrected

**A prior round of this brief proposed acquiring the lock "as `recordDuesPaymentInTx`'s own first statement." This is wrong, verified by tracing every caller, not assumed correct because it sounded like the right shape.** `recordDuesPaymentInTx` is sometimes invoked directly inside a *fresh* transaction (via `recordDuesPayment`), and sometimes invoked as a *composed, inner* call after its caller has already taken `lockStudent` (or `lockBranchShared`) itself. Putting the lock inside `recordDuesPaymentInTx` only ever protects the first case.

**Traced, one by one:**

- **`recordDuesPayment`** (the public wrapper): opens its own transaction, calls `recordDuesPaymentInTx(tx, ...)` immediately — no lock is taken before that call today. **Fix**: `recordDuesPayment` itself takes the advisory lock as the first statement inside its own transaction callback, before calling `recordDuesPaymentInTx`.
- **`correctLateFeeAndSettle`**: opens its own transaction, does an unlocked pre-read, then calls `lockStudent` (`correct-late-fee.ts:105`) — *before* it later composes `recordDuesPaymentInTx`. **Fix**: takes the advisory lock as the first statement inside its own transaction, before its own `lockStudent` call — a lock placed inside `recordDuesPaymentInTx` would run too late for this caller, exactly the bug found.
- **`prepayMonthlyObligations`**: opens its own transaction, takes `lockBranchShared` then `lockStudent` itself, before composing `recordDuesPaymentInTx` at the end. **Fix**: same shape — the advisory lock is this function's own first statement, before its own `lockBranchShared`.
- **`purchasePackage`**: identical shape to prepayment. **Fix**: same.
- **Awaiting-rate resolution** (§7, new): opens its own transaction. **Fix**: the advisory lock is its own first statement too.

**Consequence for the shared settlement core**: `recordDuesPaymentInTx` (and any lower `*InTx` core it or `purchasePackage` share) **never takes the advisory lock itself** — it trusts that whichever outermost function invoked it already has, the same trust relationship every `*InTx` core in this ledger already has toward its own caller's branch/student locks. **No nested transactions anywhere** — the lock is always the first raw statement inside a transaction callback that already exists; nothing opens a second transaction to acquire it early.

### 4.3 Scope of what is verified — restated precisely

Checked: every `pg_advisory_xact_lock` call site in `src/` as of main `7781206` (four, §0), and whether any of the five real entry points that would need the new quote lock (§4.2) already take a ledger row lock before a point where the quote lock could still be inserted first (all five can — traced above). **Not claimed**: that no deadlock is possible anywhere in the application, or that every future caller will necessarily follow this rule without being told to. What §4.2 establishes is a rule for these five specific, named entry points, verified against their actual current code — not a general guarantee.

### 4.4 Corrected: the lock must be SHARED for settlements, EXCLUSIVE only for a rate write — an unconditional exclusive lock was a real scalability regression

**PR 2's first cut acquired an unconditional, always-EXCLUSIVE `pg_advisory_xact_lock` at every one of §4.2's four settlement entry points.** This closed the intended race (a settlement using a rate value a concurrent correction is simultaneously replacing) but introduced one this brief never reasoned through: an EXCLUSIVE hold conflicts with every other holder, EXCLUSIVE or not, regardless of where in the transaction it sits — so every settlement for an organization serialized against every OTHER settlement for that same organization, same-currency payments included, for the full duration of each transaction. Discovered only after implementation, by re-reading a test's own comment stating the broadening plainly, not by reasoning through the design up front — the honest description is "moving the lock earlier fixed the ordering bug and silently introduced a throughput bug," not "a smaller refinement."

**Corrected design — a genuine reader/writer split, on the identical reserved key, at the identical position:**

- **Neither the reserved namespace (`key1`, §4.1) nor the "literal first statement, before any row lock" ordering rule (§4.2) changes.** Only the **lock MODE** changes, and only for the four settlement entry points.
- **`enterExchangeRateQuote` takes `pg_advisory_xact_lock` (EXCLUSIVE)** — unchanged from §4.1/§4.2. A rate's first entry or correction is the only writer of this table; it is an occasional, owner-initiated administrative action, never a per-payment hot path.
- **The four settlement entry points (`recordDuesPayment`, `correctLateFeeAndSettle`, `prepayMonthlyObligations`, `purchasePackage`) take `pg_advisory_xact_lock_shared` (SHARED) instead.** Postgres's advisory locks support this natively on the identical `(key1, key2)` pair: any number of SHARED holders coexist with zero contention among themselves — this is what restores per-student and cross-student settlement throughput to what it was before PR 2 touched this at all. A SHARED hold and an EXCLUSIVE request on the same key genuinely conflict (the standard reader/writer relationship): a correction still waits for every currently-open settlement's shared hold to release, and no new settlement can acquire the shared lock while a correction holds the exclusive one — the actual race this section exists to close remains fully closed.
- **No settlement path ever requests the exclusive mode or calls `enterExchangeRateQuote`** — settlements only ever *read* a quote (`resolveEffectiveQuote`), never write one, so no shared-to-exclusive upgrade is ever needed inside a settlement's own transaction. Verified directly against the four writers' actual code, not assumed.

**The remaining trade-off, stated plainly, not minimized**: a quote entry or correction (the EXCLUSIVE holder) can still temporarily block *every* open settlement for that organization from even acquiring the SHARED lock — including same-currency ones, since the lock is taken unconditionally regardless of whether that particular settlement needs a rate at all. This is real, and smaller and far rarer than the regression it replaces: entering or correcting a rate is an occasional administrative action, not something that happens per payment.

**Verified by four genuine, PID/lock-scoped concurrency proofs** (`tests/integration/dues-currency-settlement.test.ts`, reading `pg_locks.mode`/`granted` directly rather than matching lock-wait query text — `pg_advisory_xact_lock` is a literal prefix of `pg_advisory_xact_lock_shared`, so a substring match cannot reliably tell the two modes apart): two different students' settlements (one same-currency, one cross-currency) genuinely overlap with no contention; a correction genuinely waits on an open settlement's shared hold and proceeds once released; a settlement genuinely waits on an open correction's exclusive hold and proceeds using the just-committed revision (asserted on the resulting payment's own evidence, not merely "it succeeded"); and `purchase-package.test.ts`'s own pre-existing same-*student* concurrency test continues to prove the student row itself still serializes two settlements for the *same* student, unaffected by this split.

**A genuine, confirmed dependency on READ COMMITTED, not assumed**: this whole design — a settlement waking from a blocked SHARED-lock wait genuinely seeing a correction that committed while it waited — depends on Postgres's READ COMMITTED isolation (the server default, and this codebase's actual behavior: no `$transaction` call anywhere sets `isolationLevel`, verified by reading every call site, not assumed). Confirmed by direct experiment: temporarily forcing a settlement's transaction to REPEATABLE READ and re-running "a settlement waits on an open correction's exclusive hold" reproduced real staleness — the settlement woke up, but `resolveEffectiveQuote` still returned the PRE-correction revision (its snapshot was fixed before the wait resolved), so a tender priced against the just-committed rate was refused as `notASelectableTotal` against the STALE one instead. This is not a hypothetical: it is the actual, observed behavior of this exact codebase under that isolation level. Nothing here changes as a result — every transaction in this ledger already runs under READ COMMITTED, by omission of any override — but the dependency is now stated plainly rather than left implicit: if any caller's transaction is ever changed to REPEATABLE READ or SERIALIZABLE, this section's whole guarantee breaks silently, and must be re-verified against a real concurrent correction before shipping such a change. Documented identically in `resolveEffectiveQuote`'s own doc comment (`exchange-rate.ts`).

## 5. Reconciling append-only quotes with correction

Unchanged in substance: multiple rows per `quoteDate` are legitimate (`revision` incrementing under the §4 lock); "currently authoritative" is the highest revision, never a timestamp; a payment's snapshot (§6) is permanent regardless of later corrections. Policy 4: a correction warns the owner how many completed payments used the value being replaced.

## 6. Conversion evidence and output

A settled cross-currency payment preserves: original tender currency/amount; the obligation's own currency and settled total in that currency; the exact quote's row identity, `revision`, `quoteDate`, and `value`, snapshotted, never re-read live; the rounding rule variant applied. `quoteDate` is preserved distinctly from `receivedOn` (policy 2's fallback makes these genuinely different dates).

**Refusal totals expressed in tender currency, by contract** — `selectableTotals?: string[]` needs no type change; a cross-currency refusal populates it with the converted, rounded values from §3, at both existing `settleReceipt` call sites.

## 7. Awaiting-rate receipts

### 7.1 What must be preserved — corrected: far more than the caller's raw arguments

**A prior round of this brief said the receipt preserves "a structured, verbatim snapshot of exactly what was explicitly selected... the equivalent explicit arguments." This understates what "never silently reprice, move coverage, or treat a pending receipt as paid" actually requires, verified against what those arguments actually contain.** `prepayMonthlyObligations`'s own arguments (`studentId, requestedMonths, existingObligationIds, receivedOn, tender, method, notes, maxBackdateDays`) name *which* months and *which* existing debt — they contain no quoted price, no resolved `planTermsId`, and no assignment row/revision, all of which are normally resolved **fresh, at the moment of the real attempt**, from whatever is currently effective. The same is true of `purchasePackage`'s arguments relative to its own terms resolution.

**Corrected: an awaiting-rate receipt must capture a full snapshot of what a successful attempt would have resolved at the moment it was made** — not just the caller's input, but the *result* of running every resolution step (terms lookup, price, assignment id and its own `assignmentRevision`, and for a package, `staleTerms` check) up to the point where only the missing rate stopped it. Concretely, alongside the explicit selection: each obligation's or future month's resolved `planTermsId` and priced amount; for a package, the resolved terms id and its price; for prepayment, each month's resolved assignment id and revision. This is the same evidence PR #76's own audit-provenance design already captures for an ordinary successful prepayment — an awaiting-rate receipt needs the identical evidence, captured *before* it's known whether the attempt will ever complete, not only after.

**What happens if any of it changes before resolution — one principle, four named cases, never a silent substitution:**
- **Price/terms changed** (a correction lands while pending): resolution refuses (`staleTerms`-shaped), never silently reprices to whatever is current.
- **Assignment changed**: resolution refuses, never silently settles against a different plan than the one originally resolved.
- **Coverage availability changed** (something else settled one of the originally-named months or obligations while this receipt sat pending): resolution refuses (a stale-selection error), never silently substitutes a different month or obligation.
- **The current month itself has advanced** far enough that an originally-requested *future* month (prepayment's own `currentMonth + 1` floor) is no longer future by the time resolution runs: resolution refuses rather than reinterpreting what "prepaying" that month would even mean now. A fresh attempt (which may itself become a new awaiting-rate receipt, or may now succeed outright if a rate exists) is what a payer does next — resolution itself never adapts the original request to fit changed circumstances.

**A pending receipt is never treated as paid coverage**: no `DuesObligation`, `DuesCoverage`, `DuesSettlement`, or `DuesPayment` row exists while `PENDING` — this remains unchanged from the prior round.

### 7.2 Resolution — corrected twice: cannot compose `correctLateFeeAndSettle` as a black box, and does not always reach `recordDuesPaymentInTx`

**§0 verifies why one earlier design doesn't work: `correctLateFeeAndSettle` opens its own transaction (cannot be called from inside resolution's own transaction without nesting) and settles exactly one obligation (a receipt can span several).**

**A second overclaim, corrected here**: an earlier round of this brief described resolution as always ending in "ONE `recordDuesPaymentInTx` call... covering every obligation the receipt named." **This is only true for a receipt that originated from an ordinary payment or a prepayment attempt — both settle obligations that genuinely are `type: "MONTHLY"`.** A receipt that originated from a **package** attempt cannot resolve this way: `recordDuesPaymentInTx`'s own obligation query is `type: "MONTHLY"`-filtered (verified, `record-payment.ts:259-261`, and restated in the package-purchase brief) and would refuse a package's id as `notFound`, the identical reason `purchasePackage` itself never composes `recordDuesPaymentInTx` for its own package item. **Resolution must branch on which kind of attempt the receipt records** (a `kind: "ordinary" | "prepayment" | "package"` field on `AwaitingRateReceipt`, set at creation), dispatching to the shape that attempt's own real writer already uses — not a single uniform call for all three.

**Proposed, smallest fix for the `correctLateFeeAndSettle` composability problem — the same "narrow transaction-aware extraction" pattern already used five times this session**: extract its own void-a-single-fee logic into `voidLateFeeInTx(tx, { context, feeId, expectedRevision, removalReason, receivedOn }, deps)`, taking an already-open `tx`. `correctLateFeeAndSettle` becomes a thin wrapper composing it — its own behavior, signature, and test suite unchanged, the same proof bar every prior extraction here was held to. Resolution calls `voidLateFeeInTx` directly, once per obligation whose fee was wrongly assessed while pending (zero, one, or several) — never through `correctLateFeeAndSettle` itself.

**Awaiting-rate resolution, one new writer, one transaction, branching on `kind` — exact step order, quote lock first, then this ledger's established row-lock order:**

```
take the namespaced advisory lock — the literal first statement (§4.2)
lockBranchShared  — only for kind: "prepayment" | "package" (both create new obligations needing branch-locked terms
                     resolution); NOT needed for kind: "ordinary", which only ever touches existing debt
lockStudent        — every kind
re-read the pending receipt under the lock; refuse (alreadyResolved/alreadyCancelled) if its status is no longer
  PENDING — the first half of "concurrent resolution creates at most one payment" (§7.3's DB backstop is the second)
re-validate every snapshotted piece of evidence (§7.1) against current state — refuse (stale) on any drift, before
  any write, for any of §7.1's four named cases

kind: "ordinary" —
  void any wrongly-assessed fees on the named obligations (voidLateFeeInTx, per obligation)
  recordDuesPaymentInTx(tx, { obligationIds: the original debt selection }, deps)   — ONE call, ONE payment

kind: "prepayment" —
  create each prepaid obligation (writeMonthlyObligationInTx, re-checked against the snapshotted evidence, not
    re-resolved fresh — a changed price/terms/assignment refuses per §7.1, it is never silently re-picked)
  void any wrongly-assessed fees on the named EXISTING debt portion, if any
  recordDuesPaymentInTx(tx, { obligationIds: [...existing debt, ...the newly created prepaid obligation ids] }, deps)
    — ONE call, ONE payment, reusing prepayMonthlyObligations's own exact composition shape

kind: "package" —
  create the package obligation and every one of its coverage rows (mirroring purchasePackage's own creation step,
    re-checked against the snapshotted evidence — a changed terms id, or a month no longer uncovered, refuses)
  resolveMonthlyDebtItemsInTx for any named existing debt (the shared core, extracted in PR #77)
  void any wrongly-assessed fees on that debt portion, if any
  writeSettlementInTx(tx, { settledItems: [...debt items, the package item (feeEligible: false)] }, deps) — DIRECTLY,
    never through recordDuesPaymentInTx, the exact reason purchasePackage itself never does either

mark the receipt RESOLVED under a guarded UPDATE (WHERE status = 'PENDING'), checking exactly one row was affected —
  refuse if zero rows were affected (a concurrent resolution or cancellation won first), even though the earlier
  re-read already made this vanishingly unlikely; this is the application-level half of the "at most one payment"
  guarantee, backed by §7.3's DB constraint as the actual backstop
any refusal at any step rolls back everything already written in this transaction — the same throw-tagged-error-
  then-convert-after-rollback mechanism every writer since correctLateFeeAndSettle has used
```

### 7.3 Enforcing one completed payment per receipt — application check plus a real DB backstop

The guarded `UPDATE ... WHERE status = 'PENDING'` above, combined with the student lock two concurrent resolution attempts both serialize on, makes a second attempt see the receipt already `RESOLVED` before it ever reaches a write — but this ledger never relies on an application check alone where a database constraint can back it up (`DuesObligation_student_month_monthly_key`, `DuesCoverage`'s per-month uniqueness, `ExchangeRateQuote`'s own `revision` uniqueness — §2 — are all the same pattern). **Proposed backstop**: `DuesPayment.resolvedFromReceiptId String? @unique` — a nullable, unique foreign key back to the `AwaitingRateReceipt` it resolved, `null` for every ordinary payment. Even in a scenario where the application-level guard were somehow bypassed, a second attempt's own `DuesPayment` insert would violate this constraint and fail, rather than silently creating a second payment for the same receipt.

### 7.4 Cancellation — owner-only, required reason, no refund or settlement implied

**`cancelAwaitingRateReceipt`** (new, small writer, owner-only): takes `receiptId`, a required non-blank `reason`. Under a guarded `UPDATE ... WHERE status = 'PENDING'` (the same race-safety shape as resolution — whichever of a concurrent resolve/cancel attempt actually updates a row wins, the other sees zero rows affected and refuses cleanly), marks the receipt `CANCELLED`, writes its own audit row. **Never** touches `DuesObligation`/`DuesCoverage`/`DuesSettlement`/`DuesPayment` — cancellation records only that the owner decided not to pursue completing this receipt; the receipt row itself, and everything on it, is preserved permanently (policy 6), exactly like every other removal/reversal marker in this ledger.

### 7.5 What remains genuinely open — narrowed to one item

§1b resolved who may resolve a receipt (owners only) and how non-resolution ends (owner-only cancellation, no expiry). The one item still open, not decided here: **staff visibility into pending receipts** — a consumer-integration/UI dependency, flagged so it isn't silently forgotten, not designed in this brief.

## 8. Scope

Finishing this brief's design is one more piece of a larger, unfinished payment project — not its completion. Untouched and unadvanced: enrollment/resume-charge work, payment-write UI, consumer integration, the readiness check, and activation itself. Packages, prepayment, reversal, and waiver (PRs #74-77) are unaffected by anything this brief decides about currency.

## 9. All twelve currency policies now confirmed

§1 (six) and §1b (six) are both approved and not reopened. **Confirmed by this design already, restated, not a new question**: correction-after-use only ever affects later settlements (the highest revision a future resolution reads), never a payment that already snapshotted an earlier one (§6) — the warning (policy 4) is informational only.

## 10. Atomicity, audit, authorization, tests — planning-level

- **Atomicity**: the namespaced advisory lock is the first statement inside each of the five entry points' own transaction (§4.2) — no nested transactions anywhere.
- **Audit**: extend the existing `duesPayment.record` audit payload with the applied rate's snapshotted identity/value/rounding-rule-variant.
- **Authorization**: a new owner-only writer, `enterExchangeRateQuote`; resolution and cancellation are both owner-only too (§1b).
- **Tests**: both-direction worked examples as real-database scenarios; a rounding-collision refusal; §4's genuine-overlap concurrency proof (a settlement's advisory lock held while a correction attempt queues behind it, and vice versa); §7.2's per-`kind` resolution, each branch correctly voiding every wrongly-assessed fee and reaching the right settlement path (`recordDuesPaymentInTx` for ordinary/prepayment, `writeSettlementInTx` directly for package); two concurrent resolution attempts for the same receipt producing exactly one payment, both via the guarded update and via §7.3's DB constraint; a resolve racing a cancel, whichever writes first wins, the other refuses cleanly; a resolution refusing cleanly on each of §7.1's four drift cases; every existing same-currency suite passing completely unmodified.

## 11. Implementation sequence — APPROVED, three PRs, with four adjustments

**A dependency is "ready" once its PR is merged to `main` and `main`'s CI passes — deployment and activation are never prerequisites** (this ledger's writers are all closed-by-default library functions regardless; nothing here is user-reachable until the separate, later activation milestone, §8).

**PR 1 — Rate storage and arithmetic (foundational, no settlement integration yet).**
- Schema: `ExchangeRateQuote` (§2), the reserved two-integer advisory-lock namespace (§4.1).
- Writer: `enterExchangeRateQuote` — one function handling both first entry and correction (§4.2/§5), owner-only, revision allocated under the advisory lock.
- Pure functions: bidirectional conversion and rounding (§3) — nearest-whole-colón and nearest-cent, half-up, no tolerance (§1b) — and rounding-collision detection.
- Dependencies: none — buildable and fully testable against current `main` today, in isolation. Touches no existing writer.

**PR 2 — Settlement integration (the invasive one: touches every existing money-writer).**
- Each of the four existing entry points that can reach a cross-currency settlement (`recordDuesPayment`, `correctLateFeeAndSettle`, `prepayMonthlyObligations`, `purchasePackage`) takes the namespaced advisory lock as its own first statement (§4.2).
- The comparison logic (§3) is wired into both existing `settleReceipt` call sites; `selectableTotals` becomes tender-currency-denominated on a cross-currency refusal (§6); `DuesPayment` gains `appliedRateId` and the snapshotted `value`/`quoteDate`/`revision` (§6) — **not** `resolvedFromReceiptId`, moved to PR 3 (below), since it has no meaning until `AwaitingRateReceipt` exists.
- **Missing-rate handling stays inactive and unexposed in this PR.** When no quote exists at all (exact date or earlier fallback), PR 2's writers simply refuse cleanly (a plain typed refusal) — they do **not** yet implement or expose anything resembling the approved awaiting-rate behavior (policy 3). That behavior only becomes real, and only then anything users could encounter, once PR 3 ships — PR 2 alone must never leave a caller facing a half-built "pending" state.
- `correctLateFeeAndSettle`'s `voidLateFeeInTx` extraction (§7.2) happens here — proven behavior-preserving against its own unmodified test suite.
- Dependencies: PR 1 merged, `main` CI green. Proof bar: every existing same-currency suite for all four touched writers passes completely unmodified, plus new cross-currency scenarios for each.

**PR 3 — Awaiting-rate receipt capture and resolution.**
- Schema: `AwaitingRateReceipt` (§7.1, full resolved-evidence snapshot, `kind` discriminator), **and** `DuesPayment.resolvedFromReceiptId` — both introduced together here, including its unique constraint and a tenant-safe (`organizationId`-scoped) relationship, not split across PR 2/PR 3 as an earlier draft of this sequence had it.
- Writers: receipt creation (replacing PR 2's plain refusal once a rate is genuinely missing — this is what actually activates policy 3 for users); the per-`kind` resolution writer (§7.2's three branches); `cancelAwaitingRateReceipt` (§7.4).
- **Package-kind resolution reuses `purchasePackage`'s own validation and creation, not just the settlement core** — corrected here: calling `writeSettlementInTx` alone is not a complete resolution path for a package. Proposed: extract `purchasePackage`'s own terms/staleness/horizon/gap-check-through-creation logic into its own `*InTx` core (mirroring `writeMonthlyObligationInTx`'s exact precedent for monthly obligations), so resolution calls that core — re-validated against the snapshotted evidence (§7.1) — rather than re-deriving package creation inline or assuming the settlement write alone suffices.
- Dependencies: PR 1 and PR 2 merged, `main` CI green on each.
- Proof bar: §7.1's four drift-refusal cases; §7.3's concurrent-resolution-produces-one-payment (both the application guard and the DB constraint); a receipt that resolves on-time correctly voiding a wrongly-assessed fee via `voidLateFeeInTx`; a package-kind resolution correctly re-running full package validation, not just settling; cancellation preserving history with zero settlement/refund.

Sequencing is strict (1 → 2 → 3) — each PR's proof bar depends on the previous one already merged with green CI.

## 12. Order after this brief

All twelve currency policies confirmed (§9). Approval of §11's three-PR sequence, then implementation in that order, then (§8, unaffected) enrollment/resume charges, payment-write UI, consumer integration, readiness, and activation — the full-codebase review milestone remains preserved.
