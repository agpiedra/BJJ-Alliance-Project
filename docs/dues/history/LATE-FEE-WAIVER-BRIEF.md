# Brief: waiving a valid late fee (owner discretion)

Status: **brief only, nothing implemented.** Written 2026-09-29 from main `b171641` (through the payment-reversal PR #74, merged). Every claim below was checked directly against that commit's actual code — file:line references throughout.

**Reminder of the confirmed distinction, restated exactly as `LATE-FEE-CORRECTION-BRIEF.md` §3 already drew it — this brief does not reopen it:**

- **VOIDED** answers a question of fact: given the receivedOn the owner attests to, was this fee ever actually owed? Built in PR #73 (`correctLateFeeAndSettle`).
- **WAIVED** answers a question of policy: the fee was genuinely, correctly assessed — it *is* owed — and an owner chooses to forgive it anyway, for reasons this system does not verify (goodwill, a hardship exception, a negotiated correction unrelated to timing). **This is what this brief scopes.**

## 0. What already exists, verified — this is the smallest possible addition, not a new subsystem

- **The removal marker is already schema-complete, DB-enforced, and generic over both kinds** — nothing about it is VOIDED-specific. `DuesLateFee.removedAt`/`removalKind` (`WAIVED`/`VOIDED`)/`removedById`/`removalReason`, guarded by `DuesLateFee_removal_marker_complete` (`prisma/migrations/20260927153000_dues_ledger_schema/migration.sql:256-259`): all four null, or all four set **and `removalReason` non-blank after trimming**, enforced by Postgres regardless of which enum value is written. The one-time guarantee is likewise generic: `DuesLateFee_marker_once` (`migration.sql:342-343`) fires `dues_set_once_marker('removal', 'removedAt,removalKind,removedById,removalReason')` on **any** update to those four columns — a fee already removed (either kind) cannot have its removal marker changed at the database level, not just refused by application code. **A waiver writer needs zero migration.**
- **Every reader that decides whether a fee is currently owed already checks `removedAt` alone, never `removalKind`** — verified by reading the actual logic, not assumed:
  - `record-payment.ts:276,282-283`: `const removed = o.lateFees[0]?.removedAt != null;` then `lateFeeMinor: removed || o.lateFeeAmount === null ? 0 : ...` — the comment already on that line (`"a waived or voided fee is not owed: preserved as it is, never re-charged"`) shows this was written anticipating exactly this brief.
  - `record-payment.ts:301-304`: the `feeOwed` computation for a chosen obligation is `late && lateFeeMinor > 0`, so a removed fee (either kind) is `false` regardless of lateness.
  - `late-fee-assessment.ts:91-92` (`assessLateFeeInTx`): `if (existingFee) return { ok: true, feeId: existingFee.id, owed: existingFee.removedAt === null, created: false };` — once *any* `DuesLateFee` row exists for an obligation, no second one is ever created (unique `(obligationId)`), and `owed` is `false` the instant `removedAt` is set. A waived obligation is therefore permanently protected from ever being re-assessed a fee, the same as a voided one — for free, no new logic.
  - **Consequence verified, not assumed: this brief's writer needs to touch exactly one row (the fee) plus one audit row. No settlement, no obligation, no coverage write, ever.** Unlike `correctLateFeeAndSettle`, which must pair its void with a settlement because voiding is what *unblocks* a payment (`recordDuesPayment`'s `feeAlreadyAssessed` refusal at `record-payment.ts:303` only fires while a fee is active and the payment claims to be on time), waiving an *unpaid* fee unblocks nothing that was blocked — an ordinary `recordDuesPayment` call for that obligation already succeeds once the fee is removed, at the tuition-only amount, with no special composition required.
- **`versionRevision` (`src/lib/dues/config-input.ts:76-82`) and `lockStudent` (`src/lib/dues/ledger/common.ts:6`, re-exported from `src/lib/students/lock.ts`) are directly reusable, verbatim, exactly as `correctLateFeeAndSettle` (`correct-late-fee.ts:41-43,105-106`) already uses them.** No new locking or staleness mechanism needed.
- **`reversePayment`'s reversal-blocking check is VOIDED-specific, verified by reading the actual condition, not inferred**: `reverse-payment.ts:102`: `if (settlements.some((s) => s.obligation.lateFees.some((f) => f.removalKind === "VOIDED"))) return refuse("voidedFeeBlocksReversal");` — a `removalKind: "WAIVED"` fee does **not** match this condition. §4 below verifies this is the correct, intended behavior for waiver, not a gap.

## 1. What the writer does, and does not, need to check or write

**Owner-only, one transaction, one row touched.** The application-level check `context.organizationRole === "ADMIN"` is required — nothing DB-level enforces role, exactly the same gap `correctLateFeeAndSettle` (`correct-late-fee.ts:78`) and `reversePayment` (`reverse-payment.ts:64`) already close themselves rather than trusting a caller. Proposed scope, mirroring `correctLateFeeAndSettle`'s shape but *without* its settlement composition (§0's consequence):

```
check activation.isActive(organizationId) — refuse (notActive) otherwise
check context.organizationRole === "ADMIN" — refuse (notFound) otherwise
check lateFeeId, expectedRevision, removalReason are non-blank strings — refuse (invalid) otherwise, before any DB read
  (reason non-blank is checked here too, not left to surface as a raw DB constraint violation — same pattern
  correct-late-fee.ts:81 already uses)

pre-lock read: the fee row + its obligation's studentId/academyId, for tenant-scope check
refuse (notFound) if missing or out of scope (inTenantScope)

lockStudent(tx, organizationId, studentId) — same lock every other ledger writer takes; serializes against a concurrent
  recordDuesPayment, assessLateFeesForStudent, correctLateFeeAndSettle, reversePayment, or a second waiver attempt on the
  same fee — whichever acquires it first fully determines what the others see (§3)
refuse (notFound) if the lock disagrees with the pre-lock academy read

re-read the fee row fresh under the lock (the pre-lock read could be stale) — this is the authoritative state
  expectedRevision and the removal check below are judged against
refuse (notFound) if it no longer exists
refuse (alreadyRemoved) if removedAt !== null — a fee already removed, either kind, is a one-time marker, not
  re-appliable (matches correct-late-fee.ts:112's exact language and reasoning)
refuse (stale) if versionRevision({removedAt, removalKind}) !== expectedRevision — a concurrent change (assessment
  hasn't touched this row, but a second waiver or a void attempt could) is caught, not silently overwritten

[§6: refuse (alreadyPaid) if the fee has an ACTIVE settlement pointing to it — open policy question, see §6]

mark removalKind: WAIVED, removedAt: now, removedById: owner, removalReason: (required, non-blank, already checked above)
write its own AuditLog row (action: "duesLateFee.waive", entityType: "DuesLateFee", entityId: fee.id,
  before: { removedAt: null, removalKind: null }, after: { removedAt, removalKind: "WAIVED", removedById, removalReason })
  — the writer's own responsibility, exactly as correct-late-fee.ts:125-136 and reverse-payment.ts:116-127 already do it
  for their own actions; the DB's removal-marker CHECK constraint guarantees the fee row's own metadata, nothing about
  whether an audit row exists alongside it (same two-separate-guarantees correction LATE-FEE-CORRECTION-BRIEF.md §4 made)

return { ok: true, feeId }
```

No `recordDuesPaymentInTx` composition, no settlement write, no coverage write, no obligation write, no tuition change. The obligation's tuition and coverage are completely untouched by this action — verified by the fact that nothing in the scope above ever reads or writes `DuesObligation` or `DuesCoverage`.

## 2. Repeated requests

- **A second waiver attempt on the same fee**: `alreadyRemoved` (the row's `removedAt` is no longer null) — clean refusal, no re-audit, no double-write. Matches `correctLateFeeAndSettle`'s existing behavior for the same shape of retry.
- **A void attempt on an already-waived fee, or a waiver attempt on an already-voided fee**: both refuse `alreadyRemoved` for the same reason — `removedAt !== null` regardless of which `removalKind` got there first. Whichever writer's transaction commits first under the student lock wins; the second sees the committed state and refuses. No special cross-writer coordination needed beyond the lock both already take.
- **The DB itself backstops all of this even if application logic were ever wrong**: `DuesLateFee_marker_once` rejects a second UPDATE to any of the four removal columns outright, independent of which application writer attempted it.

## 3. Concurrency with a live payment, assessment, or correction attempt

Closed the same way every other race in this ledger has been closed this session: `lockStudent`, first, before any fee/obligation/settlement data is read for the decision. A concurrent `recordDuesPayment` call, `assessLateFeesForStudent` run, or `correctLateFeeAndSettle` attempt for the same student is strictly serialized against this waiver by that same lock — whichever acquires it first fully determines what the others see, verified as the identical property already proven (real two-connection concurrency, not wall-clock timing) for `correctLateFeeAndSettle` vs. assessment/payment and for `reversePayment` vs. all three real writers in PR #74's test suite. No new concurrency mechanism needed; the same test shape (hold the lock, prove the other side genuinely blocks via `waitUntilBlockedOnLock`, release, assert) applies directly.

One sequencing detail worth stating plainly since it is new to this writer: if `assessLateFeesForStudent` and a waiver attempt race for the *same not-yet-assessed* obligation, only one fee row can ever be created (`DuesLateFee_obligationId_key`), and whichever transaction commits first decides what exists — either a fee gets assessed and then must be waived in a *second* request (this writer requires an existing row; it never creates one), or the obligation moves out of "overdue with no fee" before assessment ever reaches it. Neither ordering is a bug; both are the same "whichever acquires the lock first wins" property already established, not a new race to design around.

## 4. How existing payment and reversal readers handle WAIVED fees — verified, not assumed

- **Payment recording**: already covered in full in §0 — `record-payment.ts` decides everything from `removedAt` alone, never `removalKind`. A waived fee behaves identically to a voided one from `recordDuesPayment`'s perspective: permanently excluded from `amountDueMinor`, never re-assessed. **No change needed anywhere in `record-payment.ts`.**
- **Reversal — verified finding, not a gap**: `reverse-payment.ts:102` checks `removalKind === "VOIDED"` specifically. A waived fee does **not** trigger `voidedFeeBlocksReversal`; reversing a payment behind an obligation carrying a waived fee proceeds normally. **This is correct, and should not change:**
  - Decision B's restriction exists because a VOID's entire premise is a *specific, timing-dependent claim* — "given this attested `receivedOn`, the fee was never owed" — and reversing a payment tied to that same obligation could call the premise the void relied on into question (PAYMENT-REVERSAL-BRIEF.md §2.2).
  - A WAIVER's premise is *not* timing-dependent and not tied to any specific payment's existence: the fee **was** genuinely owed, and the owner forgave it anyway, unconditionally, regardless of what happens to any payment on that obligation afterward. Reversing an unrelated (or even the same) payment on that obligation does not undermine the waiver's premise — nothing about "the owner chose to forgive this" becomes less true because a payment was reversed.
  - Concretely: obligation's fee is waived while unpaid, then a tuition-only payment settles the obligation (the settlement's `lateFeeId` is `null` — §0's `feeOwed` computation already excludes a removed fee, so nothing ever links this settlement to the waived fee), then that payment is reversed. The obligation becomes unpaid again; the fee stays waived (`removedAt` is still set, one-time marker) — exactly the intended, stable outcome. Nothing about this sequence needs `reversePayment` to know or care that a waiver ever happened.
  - **Conclusion: preserve `reverse-payment.ts:102`'s check exactly as `"VOIDED"`-specific. Adding `WAIVED` to that condition would be wrong, not merely unnecessary** — it would block a reversal for a reason that has nothing to do with why Decision B exists.

## 5. What happens if the fee is already paid — genuinely unresolved, flagged, not decided here

A `DuesLateFee` can be attached to an active settlement: `DuesSettlement.lateFeeId` is set at payment time whenever the fee was owed and the payment covers it (`record-payment.ts:341-343`: `lateFeeFor.set(o.id, assessed.owed ? assessed.feeId : null)`). If a fee is already paid — an active (`reversedAt: null`) `DuesSettlement` row exists with `lateFeeId` pointing at it — "waiving" it cannot mean what it means for an unpaid fee: the money has already been received and the payment has already been recorded as including it. Making that fee disappear now would require a refund, a credit, or a retroactive rewrite of what the historical settlement was for — every one of which this codebase's existing proposal explicitly leaves pending (`PROPOSAL.md:238`: *"a refund of prepaid coverage is an owner-approved exception... the refund amount... are pending (D4) and no refund is implemented before they are decided"* — stated about prepayment refunds specifically, but the same unresolved shape applies here: nothing in this codebase decides what a monetary correction to an already-settled amount looks like).

**This brief does not decide that question.** The smallest, safest default — proposed, not assumed approved — is for the waiver writer to **refuse** (`alreadyPaid`, a new refusal code) whenever the fee has an active settlement pointing to it, writing nothing, exactly the same shape as `alreadyRemoved`. This keeps "waive" meaning only "excuse a fee that has not yet been collected" — the one case this brief's schema and readers already fully support without inventing refund logic. It does **not** resolve:

- Whether "waiving" an already-paid fee should ever be possible at all (a goodwill credit toward a future bill? a literal refund? a reporting-only annotation with zero monetary effect?).
- If it should be possible, what writes that state and how it interacts with the settlement it's attached to — a settlement is immutable except for its own one-time reversal marker, so "waiving after payment" cannot mean editing the settlement; it would need either a new mechanism or a decision that reversal is the only path back to "unpaid" (in which case waiving after payment is just: reverse the payment, wait for the tuition/fee to become owed again per Decision A, then waive — no new writer needed, but that is itself a policy choice about the required *sequence*, not something this writer should silently assume).

**Ask, not decide:** should the waiver writer refuse outright on an already-paid fee (the proposed default above), or is there an already-settled scenario this needs to handle that the brief hasn't been told about? If the answer is "refuse," this brief proceeds as scoped; if not, this needs its own brief, the same way refunds already do.

## 6. Owner decisions

- **Owner-only.** `context.organizationRole === "ADMIN"`, checked inside the writer itself — not deferred to whatever eventually calls it, matching `correctLateFeeAndSettle`'s and `reversePayment`'s own precedent (`PROPOSAL.md:77,238`: fee waivers are owners-only, already confirmed and retired as a question — this brief only implements it, not reopens it).
- **Required, non-blank reason.** Enforced twice: application-level (`invalid` if blank, before any write) and DB-level (`DuesLateFee_removal_marker_complete`'s `btrim("removalReason") <> ''`), exactly the same two-layer pattern every other removal/reversal marker in this schema already uses.
- **Confirmation: an explicit submission with a required reason is sufficient — no additional checkbox**, matching the identical resolution `LATE-FEE-CORRECTION-BRIEF.md §5` already reached for the same shape of action (owner-only, reason required, revision-checked).
- **Genuinely open, not decided here**: §5's already-paid question. Nothing else about this writer's scope is left open — everything else in this brief is a direct, verified reuse of patterns this codebase has already built and already proved correct three times over (`correctLateFeeAndSettle`, `reversePayment`, and the assessment writer's own fee-row creation).

## 7. Tests, planning-level

Real-database, all required, reusing the established test infrastructure (`newStudent`, `newObligation`, `pay`, `assessAsOf`, `feeIdFor`, `context()`, `deps()`, `waitUntilBlockedOnLock`):

- An owed, unpaid fee is waived: `removalKind: "WAIVED"`, `removedAt` set, audit row written; the obligation's tuition-only amount is now payable (an ordinary `recordDuesPayment` call for it succeeds at tuition-only, `lateFeeId: null` on the resulting settlement).
- A second waiver attempt on the same fee: `alreadyRemoved`, no re-write, no second audit row.
- A void attempt on an already-waived fee, and a waiver attempt on an already-voided fee: both `alreadyRemoved`.
- A stale `expectedRevision` (fee changed between read and submission by a concurrent action): `stale`, refused, nothing written.
- A non-`ADMIN` context: `notFound`, nothing written.
- Cross-tenant and out-of-branch requests: `notFound`, nothing written.
- Blank/malformed `lateFeeId`/`expectedRevision`/`removalReason`: `invalid`, before any DB read.
- **The already-paid case, per §5's proposed default**: a fee with an active settlement pointing to it refuses `alreadyPaid`, writing nothing — and once that settlement is reversed (reopening the fee per Decision A), the same fee waives successfully, proving the refusal is keyed on the settlement's *current* active state, not a permanent lockout.
- **Concurrency, genuine overlap (not sequential), same shape PR #74 was corrected to prove**: waiver paused mid-transaction (needs its own equivalent of `afterReversalMarkersForTest`, or reuse of an existing hook if this writer's shape allows one) while a real `recordDuesPayment`, `assessLateFeesForStudent`, or `correctLateFeeAndSettle` attempt for the same student is proven genuinely blocked via `waitUntilBlockedOnLock`, then released, then both results and final ledger state asserted.
- Reversal interaction, verified per §4: waive an unpaid fee, settle the obligation (tuition-only), reverse that payment — the fee stays `WAIVED`, is never re-created, and the reversal itself is **not** refused by `voidedFeeBlocksReversal` (proving §4's "preserve as VOIDED-specific" conclusion holds in practice, not just on paper).

## 8. Order after this brief

This phase's own implementation (once §5's open question is answered), then whatever §5 resolves to if the answer isn't "refuse" (a separate, later brief — the same deferral pattern refunds already follow), then activation/scheduler rollout and a UI for owners to use any of `correctLateFeeAndSettle`/`reversePayment`/this writer, then the decided prepayment/package work, resume payment-write integration, refunds, signup, opening balances, consumer integration, readiness, activation last.
