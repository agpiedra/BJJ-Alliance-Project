# Stage 9 — smallest implementation plan (draft, 2026-11-10)

**Status (2026-11-10): A1–A8 approved. PR 9-1 merged as f4a5cbd; PR 9-2 (OPENING obligations + O2) merged as f9354b3; PR 9-3
(approval, atomic switch, opening charges, first progress row, condition C) implemented as a draft PR. Nothing migrated on a
hosted database, deployed or activated; activation also stays impossible until check 10 (D5's schedule) passes.** Builds on the Stage 8 brief
(`STAGE-8-READINESS-BRIEF.md` §5, §7, §8, §12–§14), O4 (`O4-PREPAYMENT-REVERSAL-PLAN.md`, migration
`20261110120000`) and the alerting plan (`MONTHLY-GENERATION-ALERTING-PLAN.md` §6, condition C).

Scope: activation (approval + manual effective activation), opening balances (`OPENING` obligations), O2 corrections,
writer gates, condition C. Out of scope: late-fee schedule (deferred), scheduling/D5, production setup.

---

## Part A — Business decisions still open (owner)

Each has a recommendation; none is approved. Owner, 2026-11-10: A2–A7 "look suitable" — still proposals pending explicit
approval; three-PR structure kept. Owner, 2026-11-10 (later): option 2 stays recommended; the automatic pause is excluded.

### APPROVED by the owner, 2026-11-10 — A1–A8 with these clarifications (binding; supersedes everything below where it differs)

**Approval boundary.**
1. Only the owner (A7) approves, withdraws, or runs the switch.
2. An approval is accepted only before the FIRST branch reaches local 00:00 on the 1st of S (so before G(S) in every branch),
   and only when readiness has no blockers. It stores S, the configuration fingerprint, every student's fingerprint, the
   approver and the time (`DuesActivation`, PR 9-1). It switches nothing.
3. One live (not withdrawn) approval per organization (database). The owner may withdraw it at any time before the switch.
   A new approval requires the previous one withdrawn.

**Activation boundary (A1: owner-initiated atomic switch, no payment pause).**
4. The switch may run only from the moment the LAST branch reaches local 00:00 on the 1st of S until the FIRST branch reaches
   local 00:00 on the 11th of S (P = 10). Outside that window it refuses ("window closed"); the owner moves S to S+1 with a
   fresh review and an approval before S+1's 1st. Due and grace days play no part; no academy changes its due dates.
5. Nothing pauses any payment at any time. The only wait is the switch's own transaction (bounded by its timeouts).
6. One READ COMMITTED transaction: the organization gate exclusively first; refuse if already active, no live approval, or
   outside the window; recompute readiness; the configuration fingerprint must equal the approval; each student whose
   fingerprint differs needs a confirmation recorded after the approval that matches current content (re-confirming after
   the 1st is allowed); classify old-system rows for months ≥ S (A8); create the `OPENING` obligations, link the opening
   items, make the activation effective and insert the first progress row for S; commit. Any refusal or error rolls back
   all of it and leaves nothing blocked.
7. From the commit: the legacy writers refuse, the ledger writers accept, monthly generation may run for S. No undo (A5).

**A8 — old-system rows for months ≥ S (stored fields only; nothing deleted, edited or ignored).**
8. Unpaid placeholder (does not block): `PENDING`, no method, no notes, amount null or > 0.
9. Ambiguous pending (blocks unless acknowledged): `PENDING` with amount null or > 0 and a method or notes present. The owner may
   record "no money was received for this row": owner-only, audited, bound to the row's exact contents, invalidated by any
   change to the row.
10. Never acknowledgeable, always block: recorded payments (`PAID` or `PROMO` with amount > 0), waivers (`PAID`, `PROMO` or
    `EXEMPT` with amount 0), and inconsistent rows (`PENDING` with amount 0; `PAID` or `PROMO` with no amount). Resolution: move S.
11. Placeholders are labelled "handled by the new system"; "billed" is shown only where the corresponding ledger charge exists.

**Old payment form at switch time (A6, rule 6).**
12. A payment waiting on the gate when the switch commits is refused, nothing written, with the staff member's input kept
    in the form for re-entry (returned in the action response; never put in a URL).

**APPROVED by the owner, 2026-11-10 — the switch's exclusive gate mode is `FOR NO KEY UPDATE`** (replacing `FOR UPDATE` in
concurrency rule 1). Basis: the real-PostgreSQL race tests and the expanded writer guard in PR 9-1.
- What it changes: `FOR NO KEY UPDATE` blocks every gate participant (`FOR SHARE`) exactly as `FOR UPDATE` would, and also
  conflicts with any `UPDATE` of the organization row. The only statements it lets through that `FOR UPDATE` would hold up
  are foreign-key checks (`FOR KEY SHARE`) from inserts into tables that reference the organization.
- Limits of the guarantee:
  1. It holds only for the tables readiness, the opening review and activation read (`Organization`, `Academy`,
     `PaymentPlan`, `PaymentPlanTerms`, `DuesPolicyVersion`, `Student`, `StudentStatusChange`, `StudentPlanAssignment`,
     `PaymentPeriod`, `DuesObligation`, `DuesCoverage`, `DuesOpeningItem`, `DuesReadinessConfirmation`, `DuesActivation`).
     Every application write to them takes the gate first; `tests/unit/dues-activation-gate-participation.test.ts` fails on
     a new unclassified writer. Inserts that pass the switch's lock (attendance, check-ins, audit log, notifications, kiosk
     attempts, promotions) write tables none of those reads use.
  2. **Not every readiness input is frozen during the switch.** `JobRun` (check 10, the monthly trigger's health) has no
     organization column and is written by the platform scheduler outside the gate: a run can start, finish or fail while
     the switch runs, so the switch decides on the `JobRun` state it reads at that moment, which may already be outdated
     at commit. This affects only check 10's health signal, never balances, opening debt or the activation record.
  3. Writes outside the application (seed, data-writing migrations, manual SQL, operator scripts) are not covered
     (KNOWN_LIMITATIONS).
  4. Proved for the writer classes 9a–9k with one representative each, plus the structural guard for every writer; not a
     proof of deadlock freedom in general.
- Evidence: `tests/integration/dues-activation-gate.test.ts` (writers blocked by the switch, with the blocked statement
  checked; the switch waits for an in-flight writer and reads what it committed; a writer that waited sees the switch's
  commit; an `AuditLog` insert passes `FOR NO KEY UPDATE` but waits under `FOR UPDATE`).

### Revision 4 — supersedes revisions 2 and 3 below wherever they differ

**Final proposals A1–A8 (all unapproved):**

1. **A1 — Activation by owner-initiated atomic transition, no payment pause.** Advance approval before the 1st of S
   (G(S)) in every branch stores S, the configuration fingerprint and each student's fingerprint. The transition runs
   in the window from the last branch's 00:00 on the 1st to the first branch's 00:00 on day 11 (P = 10, proposed). It
   is one transaction (concurrency rules below); it commits everything or nothing. Nothing pauses any payment at any
   time. If the window closes unused, the owner moves S to S+1 (fresh review, approval before S+1's 1st).
   **Refresh after the 1st:** the configuration fingerprint (plan terms and policy versions, branch set and timezones,
   organization currency, legacy plans) must equal the approval — a configuration change after the 1st is a new
   decision about a month already started, so the transition refuses and the owner moves S. Student-level content
   (legacy rows before S, opening items, status, home branch, assignment) may change after approval: each changed
   student needs a fresh `OPENING_REVIEWED` (and `PRICING_ACKNOWLEDGED` where check 6 requires it) recorded after the
   approval and matching current content. The 8c confirm actions already work at any time, so this is allowed after the
   1st. It does not violate advance approval: approval fixes S and the configuration before S starts; re-confirming
   pre-S facts that the old system legitimately kept recording (an October payment arriving 2 Nov) is review, not a new
   approval. The transition screen lists every student refreshed after approval, with old and new opening totals.
2. **A2 — Opening debt display:** "owed since activation", with its original month, no due date, never a fee (D7).
3. **A3 — O2 refuses only while a payment is currently applied** (a reversed payment no longer blocks), as O4.
4. **A4 — O2 reason:** required category (`ENTERED_IN_ERROR` / `DUPLICATE`) plus text, stored `[CATEGORY] text`;
   owner only; no time limit.
5. **A5 — No undo of activation** at launch; forward-only, corrections inside the ledger.
6. **A6 — Old payment screens after activation:** history read-only; write buttons removed; a payment that was waiting
   on the transition is refused with the staff member's input kept (concurrency rule 6).
7. **A7 — Owner only** approves, withdraws approval and runs the transition.
8. **A8 — Old-system rows for months ≥ S.** Classified from stored fields only (never from audit rows, never by free-text
   interpretation). **Unpaid placeholder** (does not block) iff all of: `status = PENDING`, `method` is null, `notes`
   is null or blank, and `amount` is null or greater than 0. **Everything else blocks:** `PAID` (any amount), `PROMO`
   (any amount), `EXEMPT` (any amount), and every inconsistent or ambiguous `PENDING` (a method set, notes present, or
   amount 0). Why so strict: `PENDING` is the app's "not collected" status (`recordPayment` accepts any status with any
   method and notes, `payment-actions.ts:23-36`), but a method or a note on a pending row could mean money changed
   hands, and the stored fields cannot rule that out.
   Consequence to expect: carry-forward copies `method` and `notes` from the previous promo row
   (`get-current-period.ts:194-212`), so a paid recurring-promo student's automatic November row is usually ambiguous
   and blocks.
   Resolutions (recommend a + b): (a) move S to S+1; (b) owner per-row acknowledgment "no money was received for this
   row", stored as a readiness confirmation bound to the row's exact content (stale if the row changes; the row itself
   is never edited); (c) later, a separate design to import recorded S payments as ledger prepayments — not at launch.
   Placeholders are not deleted or edited; they stay visible in the read-only history labelled "billed by the new
   system", and are left out of the opening-review fingerprint (check 5 re-reads S+ rows at the transition).

**Complete concurrency rules (proposed):**

1. **The gate.** The `Organization` row lock. Approval, approval withdrawal and the transition take it `FOR NO KEY UPDATE` (approved 2026-11-10; see above).
   Every writer listed in rule 9 takes it `FOR SHARE` as its first locking statement, inside its own transaction, and
   reads the activation state after it. Shared holders never block each other.
2. **Lock order** (brief §5): Organization → branches in id order → students in id order → version rows → rows written.
   Every participant follows it. This removes the gate as a deadlock source; it does not prove deadlock freedom, which
   the race tests exercise per writer.
3. **Transition isolation.** READ COMMITTED, the gate as the first statement. After the lock is granted every read sees
   all commits made before it, and no participating writer can change anything until commit. REPEATABLE READ is not
   used: its snapshot would be fixed before the lock wait and miss payments committed during it.
4. **Transition contents, in order:** gate; refuse `alreadyActive`, no approval, withdrawn approval, or outside the
   window; recompute readiness; compare configuration and student fingerprints with the approval (A1); classify S+
   legacy rows (A8); then create the `OPENING` obligations, set each opening item's `materializedObligationId`, write
   the activation record and the first progress row for S; commit. Any refusal or error rolls back all of it. Bounded
   by statement, lock and transaction timeouts (values set and measured at implementation).
5. **Writers already in progress** hold `FOR SHARE`; the transition waits for them and then sees their commits.
6. **Old-system payment waiting on the gate.** If the transition rolls back, the payment proceeds normally. If it
   commits, the payment is refused with nothing written: "This academy switched to the new payment system at HH:MM.
   Nothing was saved here. Record this payment in the new system." The response returns the submitted values; the form
   shows them again (not cleared) and offers "Record in the new system", opening the new payment form prefilled with
   student, amount, currency, method, notes and received date = the date of the attempt (editable). On lock timeout:
   "Not saved — try again", values kept the same way. Implementation notes: the existing early check
   (`payment-actions.ts:86`, before parsing and outside the transaction) moves inside the transaction after the gate,
   and parsing happens first so the values can be returned; React resets an uncontrolled `<form action>` after the
   action, so the values must come back through the action state (verified in a real browser, EN and ES).
   `markPaymentPaid` writes only through `recordPayment`, so it is covered.
7. **Page-load writers** (rule 9 c, d). Each takes the gate `FOR SHARE` with a short lock timeout inside its own
   write transaction and re-reads activation there. The page-level `ledgerActive ? … : getCurrentPaymentPeriod(…)`
   checks stay as a display shortcut only, never as the authority. After activation, or on lock timeout, the page
   writes nothing and renders anyway (no 500).
8. **Other cases.** Two transitions: the second waits, then refuses `alreadyActive`. Withdrawal vs transition:
   serialized by `FOR NO KEY UPDATE`; whichever commits first wins. Opening-item and confirmation actions (8c) after
   activation are refused (opening debt is corrected with O2). Ledger writers before activation refuse `notActive`
   (unchanged); after, they take the gate `FOR SHARE` and read active. Monthly generation reads activation under the
   same gate.
9. **Every writer affecting readiness participates** (re-checked in `src` on 2026-11-10 by searching Prisma writes to
   every reviewed table; raw SQL writes to them: none in `src`):
   a. Old-system payments: `recordPayment` (`payment-actions.ts:168`; `markPaymentPaid` through it).
   b. Students and status history: student actions (`students/[id]/actions.ts`: 6 status writes), `approve-student-core`,
      `create-student-core`, public signup (`o/[orgSlug]/signup/actions.ts`), `appendStatusChange`
      (`status-history.ts:32`), `runStatusHistoryBaseline`, ledger `resume-charge` and `genuine-return-charge`.
   c. **Page load — carry-forward** `materializeCarryForward` (`get-current-period.ts:194`), reached from the student
      list, the student portal, the overdue list, the current-status list and the contact list.
   d. **Page load — `ensureCustomPromoPlan`** (`ensure-custom-promo-plan.ts:37`), from the student detail page and the
      payments page.
   e. Assignments: `assignment-core.ts:39`, `assignment-actions.ts:144`.
   f. Dues configuration: `config-actions.ts` (terms, policy versions, plan + terms).
   g. Legacy plans: `plan-actions.ts` (create, update, activate), `ensureDefaultPlan` (inside location creation).
   h. Branches: `location-service.ts` (create, timezone).
   i. Organization currency: `plan-actions.ts:291`.
   j. Opening items and confirmations: `opening-core.ts`.
   k. Every ledger writer under `src/lib/dues/ledger/`.
   Any `UPDATE` of the `Organization` row (onboarding, branding reminder, platform suspend/activate/grace days)
   already conflicts with `FOR SHARE` by PostgreSQL's row-lock rules, so it serializes with the gate without code. Not
   reviewed, so not participating: promotion `award.ts`, `accounting-activation.ts`, kiosk token `academy.update`
   (kiosk field). Organization creation and first-branch approval happen before any readiness can exist. Outside the
   protocol, stated: `prisma/seed.ts`, data-writing migrations, manual SQL, operator scripts (`scripts/` re-checked at
   implementation). The PR 9-1 structural test fails on any new write to a reviewed table outside this list.

---

1. **A1. Activation window.** Revision 3 (comparison below) supersedes revision 2's ten-day pause, which is **not to be
   implemented**. Revision 2 kept for the record; its claim that carry-forward runs on any student page view was wrong —
   it runs only for students on a recurring promo (`get-current-period.ts:154`).

   **Revision 2 (superseded) — the "before the earliest due date" rule is withdrawn.** It gave a zero-length
   window for due day 1 (G(S) *is* the due date) and, with check 5, was unusable even for due day 5 (below).

   **Existing semantics it must match (verified in code):**
   - For `MONTHLY`, `dueOn` has no consequence. The only consequence is the grace deadline: `graceDay` of the FOLLOWING
     month, inclusive; the fee applies from the next day, judged by the payment's `receivedOn`
     (`calendar.ts:74`, `record-payment.ts:322`). Screens flag `pastGrace`, not past-due, for `MONTHLY`
     (`dues-facts.ts:261`; only `SIGNUP` has a past-due flag).
   - In normal ledger operation a due-day-1 charge is already created on its due date (generation runs after local
     midnight; condition A allows 15 h). So "created on or after `dueOn`" is ordinary, not an error.
   - Payment entry accepts a `receivedOn` up to 30 days back (`payment-entry-actions.ts:27`); lateness follows that date.
   - S's grace deadline is always in S+1, so **no S late fee can arise at any time during month S**.
   - Check 5 refuses ANY legacy row for a month ≥ S — including the PENDING row that legacy carry-forward creates when a
     student's page is viewed after the 1st (`get-current-period.ts:194`). So today an academy cannot activate after G(S)
     at all once anyone opens a student page.

   **Proposed window:**
   - **Opens** when the LAST branch reaches local 00:00 on the 1st of S (same instant as condition A's T_open).
   - **Closes** when the FIRST branch reaches local 00:00 on day **P+1** of S. Recommend **P = 10** (owner choice,
     1–25; ≤ 25 keeps every paused payment within the 30-day backdate limit with 5 days to enter it).
   - Independent of `dueDay` and `graceDay`; nobody changes due dates. The grace deadline never binds inside S.
   - Advance approval stays before G(S) (brief §8.2).

   **Old-system payments during the window — the "S pause":**
   - From G(S) of each branch until activation, an approved organization's legacy writers **refuse** months ≥ S:
     `recordPayment` for S and carry-forward creating S rows. The legacy screen says "November payments are paused until
     the new payment system is switched on; keep the receipt and enter it after activation with its received date."
   - After activation these payments are entered in the ledger with their true `receivedOn`; the S charge (created by
     generation after activation, `dueOn` 1 or 5 Nov, already past — harmless) is settled on time, no fee.
   - Legacy payments for months **before S** (e.g. October arrears) stay allowed during the window. They change that
     student's fingerprint; the activation screen lists the student; the owner updates that student's opening items and
     re-confirms; then activates (existing stale-review mechanism).
   - Students added during the window fail check 9 until reviewed (existing).
   - Legacy rows for S that existed **before** G(S) (a November paid in advance in October) are still check 5. Open item
     **A8** below.
   - If the window closes unused, the pause ends (legacy accepts S again) and the alternative below applies.

   *Example 1 — one Costa Rica branch, due day 1, grace day 5:* approval by 31 Oct. Window 1 Nov 00:00 → 11 Nov 00:00
   (P = 10). Students pay 1–3 Nov; staff keep receipts. Owner activates 4 Nov. Generation creates November charges on
   4 Nov (due 1 Nov, grace 5 Dec). Staff enter the receipts with `receivedOn` 1–3 Nov: on time, no fee. A student paying
   6 Dec pays the late fee, exactly as in normal operation.
   *Example 2 — same branch, due day 5:* identical window and handling; activation on 4 Nov creates charges before their
   due date; activation on 8 Nov after it — both ordinary.
   *Example 3 — two branches:* A = America/Costa_Rica (UTC−6) due 1, B = America/New_York (UTC−5 in Nov) due 5.
   Opens 1 Nov 06:00 UTC (Costa Rica midnight, the later one). Closes 11 Nov 05:00 UTC (New York midnight on the 11th,
   the earlier one) = 10 Nov 23:00 Costa Rica. Each branch's pause starts at its own midnight on the 1st.

   **Permitted alternative when the window is missed: move S to S+1.** Example: Costa Rica, due day 5, owner returns on
   12 Nov. Activation is refused ("window closed"); the pause ends and staff record November in legacy as before (paused
   receipts go in now). During November (before 1 Dec) the owner re-runs readiness for S = December: every S-tied
   confirmation is stale (brief §15 scenario 3) and is re-confirmed; an unpaid November becomes an opening item (no fee,
   D7); approves; activates 1–10 Dec under the same pause.

   **Why not activate November after day P:** the pause would grow past what can be safely kept on paper and entered
   (backdate limit), and the S charges would sit unrecorded in the ledger for most of the month.
   **Revision 3 — option 1 (approval-triggered pause) vs option 2 (owner-initiated atomic transition).**

   *Legacy rows for months ≥ S, classified by row state only (never by audit rows; nothing deleted or ignored):*
   - **Placeholder** — `status = PENDING`: no money received (carry-forward promo rows, or a row staff created and left
     pending). The ledger's S charge supersedes it. Not a blocker; listed on the activation screen; the row is never changed;
     after activation the read-only legacy view labels it "billed by the new system" from the activation state.
   - **Recorded payment** — `PAID` or `PROMO` with amount > 0: money received. **Blocker** (check 5), as today.
   - **Waiver** — `PAID`/`PROMO`/`EXEMPT` with amount 0 or null: a decision the ledger cannot copy automatically. **Blocker**.
   - S+ placeholders are left out of the student's opening-review fingerprint (opening review covers months before S;
     check 5 re-reads S+ rows at activation anyway, so a placeholder later changed to a payment still blocks).

   *Option 2 — owner-initiated atomic transition (recommended):*
   - One READ COMMITTED transaction. First statement: `Organization` row `FOR UPDATE` (the gate). Every participating
     writer takes `FOR SHARE` first (PR 9-1), so from that moment nothing reviewed can change, and every read sees all
     writes committed before the gate was granted. (Not REPEATABLE READ: its snapshot is fixed at the first statement,
     before the lock wait, and would miss payments committed during the wait. The 8a read-only readiness read is reused
     for its logic, not its isolation level.)
   - Then: recompute readiness and the fingerprint; compare with the approval; classify S+ rows; check the window; create
     `OPENING` obligations, the activation record and the first progress row; commit. Any refusal or error rolls back
     everything: no row written, nothing left blocked.
   - "Blocking legacy writes" lasts only as long as this transaction (bounded by its statement/lock/transaction
     timeouts — seconds). There is no standing pause.
   - **Compatible with advance approval:** yes — approval (before G(S)) stores S and the fingerprint; the transition is
     brief §8.3 with the gate as its first statement.
   - **Compatible with opening review:** yes — a legacy payment for a month before S recorded after approval changes that
     student's fingerprint; the transition refuses and names the student; the owner updates opening items, re-confirms,
     retries.
   - **Window:** opens when the last branch reaches 00:00 on the 1st of S; closes when the first branch reaches 00:00 on
     day P+1 (owner choice; recommend 10). Independent of due and grace days. Without a pause, P only limits how stale an
     approval may get.
   - **Limitation:** recorded S payments taken in the old system between the 1st and the transition block it. A due-day-1
     academy should run the transition early on the 1st. If blocked, the refusal lists the students, and the owner moves
     S to S+1 (nothing is lost; those payments stay valid legacy records for S).
   - **Concurrency:**
     - Legacy `recordPayment` during the transition waits on `FOR SHARE`. After rollback it proceeds normally. After commit
       it is refused, nothing written: "This academy switched to the new payment system at HH:MM. Record this payment
       there with its received date." On lock timeout: refused "try again", nothing written.
     - A page load that would create a carry-forward row waits the same way. After commit it creates nothing and renders
       "billed by the new system". On lock timeout it renders without creating the row; never a 500.
     - The transition waits for in-flight legacy transactions (they hold `FOR SHARE`), then sees their commits.
     - Two transition attempts: the second waits on `FOR UPDATE`, then refuses `alreadyActive`.
   - **Staff:** see nothing until commit; then old payment buttons are gone and the message above appears. No receipts held
     outside the system.
   - **Owner cancel / expiry:** nothing to cancel mid-way (one transaction). Before it, the owner may withdraw the approval
     (set-once `withdrawnAt`); after the window closes the approval is refused as expired. Neither leaves anything blocked.

   *Option 1 — approval-triggered pause with a short window (P = 2), for comparison:*
   - From each branch's 00:00 on the 1st until activation, cancellation or expiry, legacy refuses `recordPayment` for
     months ≥ S and carry-forward creates no S row. Months before S stay open.
   - **Staff:** S payment buttons replaced by "November payments are paused until the switch, at most until 3 Nov 00:00.
     Give the student a receipt; enter it in the new system after the switch with its received date." Reconciliation:
     the system holds no record of paused payments (they were never entered), so it cannot list them; matching relies
     on paper receipts — the main weakness.
   - **Owner cancel:** withdraw the approval → pause ends at once; staff then enter the held receipts in the old system.
   - **Expiry:** time-based (no job): at window close the gate stops refusing; held receipts go into the old system; S
     moves to S+1 per the alternative.
   - **Activation failure:** rolls back; the pause continues until retry success, cancel or expiry.
   - **Concurrency:** the same gate rules as option 2; a pause check is a pure time comparison inside the same `FOR SHARE`.
   - Starts unattended at midnight, needs paper handling, and still needs option 2's atomic transition at the end.

   *Recommendation:* option 2 only, with the row classification. It is required anyway (brief §8.3), adds no standing
   state, and never blocks a payment for longer than one transaction. Add option 1 later only if academies cannot run
   the transition before S payments arrive.

   **A8. Legacy months ≥ S paid in advance (new, open).** A legacy row for S created before G(S) (advance payment, or a
   carried-forward row) blocks activation (check 5). Options: (a) owner picks a later S (works today), (b) activation
   imports it as a ledger prepayment for S. **Recommend (a) for launch**; (b) is a separate design if academies commonly
   take advance payments.
2. **A2. Opening debt due date.** `OPENING` obligations carry no due/grace dates and never a fee (D7). What do the student
   and staff screens say? **Recommend:** "owed since activation", shown with the original month, no due date.
3. **A3. O2 "with applied payments".** Two readings:
   (a) refuse only while a payment is **currently** applied (a reversed payment no longer blocks), or
   (b) refuse if a payment was **ever** applied.
   **Recommend (a)**: matches O4 (reverse the payment first, then cancel), and O4's database guard already enforces it.
4. **A4. O2 reason.** **Recommend:** required category + text, stored `[CATEGORY] text` like O4 B7, categories
   `ENTERED_IN_ERROR` / `DUPLICATE`. Owner only; no time limit (as O4 B8).
5. **A5. Can activation be undone?** **Recommend: no** at launch — forward-only, like O4. Recovery is corrections inside the
   ledger (reversal, O2), never switching an organization back to legacy. "Yes" needs its own design.
6. **A6. Legacy payment screens after activation.** **Recommend:** legacy history visible read-only; legacy write buttons
   hidden and the server refuses.
7. **A7. Who executes activation.** O1 says manual. **Recommend:** owner only (not Directors, not platform admin), through
   the fresh-report diff screen of brief §8.

Already decided and reused: D7, D15, O1, O3, O4 (B1–B10), backup inbox verified before activation.

---

## Part B — Technical implementation (three PRs)

The brief's 9a–9d becomes three PRs; 9b and 9c share one migration because both widen the same `DuesObligation` CHECK
and triggers.

### PR 9-1 — Activation record + writer gates (nothing can activate yet)

- **Schema:** `DuesActivation` (one row per organization, unique `organizationId`): `startYear/startMonth` (S),
  `approvedFingerprint`, `approvedById/At`, `effectiveAt`, `effectiveById`, `ledgerStartsOn`. Set-once trigger in the O4
  style (approval columns once; effective columns null → set once; no delete). Brief §7 outline.
- **Gate helper** `lockOrganizationGate(tx, orgId, mode)`: `Organization` row `FOR SHARE` (writers) / `FOR NO KEY UPDATE`
  (approval, activation), then reads `DuesActivation.effectiveAt`. Lock-order step 1 of brief §5.
- **Ledger writers:** replace `inactiveLedgerActivation` (`src/lib/dues/ledger/activation.ts:41`) with a database-backed
  `isActive(tx, orgId)` read after the gate lock. **Delete the O4 test-only seam** (`E2E_LEDGER_ACTIVE_ORG_IDS`), its
  `verify-production-build` check and its KNOWN_LIMITATIONS entry: tests and browser runs create a real activation row.
- **Legacy writers refuse when active:** `recordPayment` and carry-forward `materializeCarryForward` (brief §5 table;
  re-verify file:line at implementation). Carry-forward degrades to "create nothing, render" on refusal or lock timeout.
  Any pause waits for the A1 decision (revision 3 recommends none).
- **Other §5 writers** (status, student, assignment, config, legacy plan, location, currency, opening items and
  confirmations): add step 1 (`FOR SHARE`) only, so they serialize with the fingerprint recompute. No behavior change.
- **Structural test:** fails on a write to any reviewed table outside the §5 inventory (style of
  `tests/unit/dues-ledger-not-exposed.test.ts`).
- **Tests:** each legacy writer refused with an active row, unchanged without; legacy write and carry-forward page load
  racing the transition (commit and rollback; lock timeout renders, never a 500); legacy write vs activation (both orders,
  `pg_blocking_pids`); lock order for one writer of each class.

### PR 9-2 — `OPENING` obligations + O2 cancellation (reuses O4)

- **Migration (one explicit `BEGIN … COMMIT`, as O4):**
  - `DuesObligationType` gains `OPENING`; `planTermsId` nullable for it only; checks so `OPENING` has no due/grace/policy
    and no fee (D7) and **no `DuesCoverage` rows** (months before S are not ledger-covered).
  - `DuesOpeningItem.materializedObligationId` (deferred in 8b), set once at activation. **Moved to PR 9-3** (as built): only the
    switch writes it, so it ships with the switch rather than as an unused column.
  - **O2 reuses O4's marker columns** (`cancelledAt`, `cancelledById`, `cancellationReason`). Widen
    `DuesObligation_cancellation_marker_complete`: `MONTHLY + PREPAYMENT` ⇒ `cancelledByReversalOfPaymentId` required
    (unchanged); `OPENING` ⇒ it must be NULL.
  - `dues_cancellation_guard`: active-settlement and late-fee checks apply to both types (A3 a); the **month-started
    check applies to `MONTHLY` only** (an opening month is always past).
  - `dues_cancellation_release_consistent`: the payment / single-settlement provenance branch applies to
    `MONTHLY + PREPAYMENT` only. (If A3 = b: add "zero settlements ever" for `OPENING` here.)
  - Reused unchanged: set-once immutability, no-marker-on-insert, `dues_refuse_cancelled_obligation` (no settlement or
    fee on a cancelled row; `FOR SHARE` serialization with the cancelling update).
- **Readers:** the 13 O4-filtered readers and the T10 unit guard already skip cancelled rows. Add `OPENING` to debt
  resolution (oldest-first places it before S) and the staff history label. Student portal: owed (A2); cancelled
  `OPENING` hidden, as O4 B10.
- **O2 writer** `cancelOpeningObligation({context, obligationId, reasonCategory, reason})`: owner only; gate `FOR SHARE`
  → branch → student `FOR UPDATE`; refuses `notFound` (other org, Director, wrong type), `hasActivePayment`,
  `alreadyCancelled`; audit row. Owner UI on the student's opening line with preview and required reason, reusing O4's
  corrections-section components.
- **Readiness check 11** (O2 writer exists) → pass.
- **Tests:** CHECK/trigger refusals per type (extend O4's database-enforcement suite); O2 vs a payment settling the same
  opening obligation (both orders); the 27 O4 tests run unchanged.

### PR 9-3 — Approval, effective activation, condition C

- **Advance approval** (brief §8.2): before G(S) in every branch timezone; gate `FOR NO KEY UPDATE`; recompute readiness; store S
  and fingerprint; switches nothing.
- **Effective activation** (brief §8.3, one transaction): gate `FOR NO KEY UPDATE`; recompute; refuse on fingerprint difference,
  any blocker, outside the A1 window, or S ≠ approved S; otherwise create the reviewed `OPENING` obligations
  from active opening items (set `materializedObligationId`), set `effectiveAt` / `ledgerStartsOn = G(S)`, **and insert
  the organization's first `DuesGenerationProgress` row for S in the same transaction**. From the commit: legacy refuses,
  ledger accepts, monthly generation may run for S.
  Why atomic: discovery visits only organizations that have progress rows, and rollover adds later months only from an
  existing row (`monthly-generation-progress.ts:583`). Without the S row, an activated organization would never be billed
  and nothing would say so. Generation's `generationStart` reads S from `DuesActivation` (today it defaults to "no start").
- **Database backing:** a deferred constraint trigger on `DuesActivation` (effective set ⇒ a progress row for S exists) and
  `DuesGenerationProgress_no_delete` (the table has no delete trigger today; only an FK `RESTRICT`).
- **Owner screen:** fresh report, diff against the approved fingerprint, opening totals per currency, confirm (A7).
- **Readiness check 12** (mechanism available) → pass.
- **Condition C (urgent, no waiting period):** the detection read (alerting plan §6) adds activated organizations
  (`effectiveAt` not null). C = an activated organization with **no progress row at all**, or progress rows for an
  organization with **no** effective activation. With the atomic insert and the no-delete trigger, C can only mean manual
  database edits or an activation bug: an invariant failure, reported at once like D.
  It is **not** "billing not finished": a row that exists but whose current month has no finished clean pass 15 h after
  the month opened (or whose current-month row rollover has not added yet) stays condition A, unchanged.
  (Correction to this plan's draft of 2026-11-10, which defined C with the 15 h window and so duplicated A.)
  Replace `conditionC: "notEvaluable"` (`src/lib/dues/monthly-generation-alerts.ts:60,72,151`); remove the STAGE-9
  BLOCKER entry (`scripts/pending-callers.ts:44`). Tests: alerting plan §7.1 item 1 with C evaluable.
- **Tests:** each stale-approval refusal; activation vs a legacy payment (both orders); activation creates exactly the
  reviewed opening rows and nothing for months ≥ S; generation creates S only after activation; real-browser owner flow
  in EN/ES (registered owner, disposable database), O2 included.
- **As built (2026-11-10):** `src/lib/dues/readiness/activation-core.ts` (approve, withdraw, switch; owner-only actions in
  `activation-actions.ts`), migrations `20261113120000` (enum `LEGACY_NO_MONEY`) and `20261113120100`. Decisions made in
  implementation, for review:
  - The configuration fingerprint an approval fixes = organization currency + every branch fingerprint (timezone, policies,
    plans incl. legacy plans, terms). Student content is NOT in it (re-confirmed instead, rule 6).
  - Rule 6 "changed" = the student's fingerprint differs from the approved one (a student added or gone counts); "refreshed" =
    a valid opening review recorded after the approval, plus a pricing acknowledgement after it where check 6 needs one. This
    applies to every changed student, active or not.
  - Fingerprint format r3: the student fingerprint is per S; S+ unpaid placeholders are left out (A8 text above); legacy rows
    now include `method` and `notes`. Every existing confirmation becomes stale (none exist outside tests).
  - A8 classification: rows rules 8–10 do not name (`EXEMPT` without an amount, negative amounts) are `inconsistent` (block,
    never acknowledgeable). The acknowledgement is a `DuesReadinessConfirmation` of kind `LEGACY_NO_MONEY` bound to the row's
    exact stored content including `recordedAt` (every legacy write sets it), so any write makes it stale for good.
  - Found in the browser pass and fixed: the system's lazily created "custom promotion" plan (`ensureCustomPromoPlan`, run by a
    student-page or payments-page load) changed the configuration fingerprint, so one page view after approval made the switch
    refuse "configuration changed". That plan is now left out of the branch fingerprint while it has no terms (it prices nothing);
    with terms it counts. Side effect: the same page view no longer stales pricing acknowledgements either.
  - Switch bounds: lock timeout 5 s (refusal `busy`), statement timeout 15 s, transaction timeout 30 s.
  - `approvedOpeningTotals` added to `DuesActivation` (old vs new totals on the switch screen, A1).
  - Not built: `ledgerStartsOn` (S is `startYear`/`startMonth`); a database rule that every OPENING obligation has an item
    (the switch is its only writer in the application; the item → charge link is database-checked).

### Migration and rollback

- Migrate first, then deploy, per PR. Both migrations are inert until the first activation.
- **After the first effective activation: forward-only** (A5), as O4 after the first cancellation. The runbook gets an
  activation section like O4's: database check for any `effectiveAt`, forward-recovery procedure, and a rehearsed schema
  rollback valid only while no organization is active.

### Not done by this plan

No hosted migration, deployment, settings change, cron enabling or activation. Activating a real organization is a
separate owner step after all 13 checks pass, the backup inbox is verified, and D5/scheduling is approved.
