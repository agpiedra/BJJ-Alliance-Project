# Stage 8 PR 8d-2 — implementation plan (the readiness screen's interactive forms)

**Status:** revision 2, D1–D4 recorded as the working design. **PR #151 open, held unmerged for review.** Evidence and deviations: `design/matroom/verification/dues-stage8d2-forms/README.md`.
- **Revision 2:** D1–D4 recorded as the working design (§10).
- **§4.4 rewritten:** a lost response is "outcome unknown". There is no inferred "saved" or "not saved" and no comparison
  inspector.
- **D3 corrected.**
- **Deterministic recovery scenarios added** (§7.4); copy, tests and browser checks updated to match.
**Base:** `main` @ `2bfd794da730526311fd131b2e583873cba6035b`. 8a, 8b, 8c and 8d-1 (PR #150, the read-only screen) are merged.
8d-1 is complete in code only. Stage 8d is incomplete until this PR lands. 8b's migrations are applied only to isolated test
databases.
**Contract:**
- `docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md` (§4–§5 and §10; decisions U1–U3);
- `docs/dues/STAGE-8-READINESS-BRIEF.md` (§10–§15);
- the code as merged, cited below by file and line on `2bfd794`.

**In scope:** forms on `/[locale]/payments/readiness` that call the **existing** actions, unchanged:
- the status-history baseline;
- per-student plan assignment, and correction of a strictly future assignment;
- opening-debt drafts: create, replace, withdraw;
- opening reviews, including the explicit "no opening debt";
- pricing acknowledgements.

**Not in scope:**
- activation controls or wording;
- bulk assignment (8e);
- a scheduler;
- a change to a financial writer, a server action, the schema, a migration, a fingerprint or a check;
- new financial policy;
- the sidebar.

**Stays fixed:** `ready` stays false (checks 10–12 not implemented, 13 decision pending). O4 stays undecided.

---

## 1. The contracts being reused (as merged)

Every action below is a `"use server"` export, called as `action(organizationId, prevState, formData)` and returning
`ActionState` (`{ ok: true }` or `{ error, fieldErrors? }`). **None calls `revalidatePath`.**

### 1.1 The five 8c actions (`src/lib/dues/readiness/opening-actions.ts`)

**Authorization** (`owner()`, :31-39):
- `resolveActionContext(org, ["ADMIN"])`;
- a non-member gets `notFound`, with the existing `organization.accessRefused` audit;
- a Director's `FORBIDDEN` is mapped to `notFound`.

**Fields are read one by one** (:41-44). Each action reads only these:

| Action | Fields | Refusals |
|---|---|---|
| `createOpeningDraft` (:46) | `studentId`, `coverageYear`, `coverageMonth`, `amount`, `currency`, `note`, `legacyPaymentPeriodId` (blank = none) | `notFound` (student or link not in this organization); `invalid` with `coverageMonth` (`invalid` or `future`), `amount`, `currency`, `note` or `legacyPaymentPeriodId: mismatch`; `monthHasDraft` |
| `replaceOpeningDraft` (:57) | `draftId` + the same content fields | as above; `stale` when the draft is no longer active (`opening-core.ts:217-223`) |
| `withdrawOpeningDraft` (:68) | `draftId`, `reason` (1–500 code points) | `notFound`, `invalid` (`reason`), `stale` |
| `recordOpeningReview` (:88) | `studentId`, `candidateYear`, `candidateMonth`, `binding` (64 hex), `declaration` (`noOpeningDebt` or `itemsAsShown`) | `notFound`, `invalid`, `stale` when the recomputed binding differs, `invalid` with `declaration: mismatch` when it disagrees with the active drafts (`opening-core.ts:410-417`) |
| `acknowledgePricing` (:102) | `studentId`, `candidateYear`, `candidateMonth`, `binding` | `notFound`, `invalid`, `stale` |

**Locking and limits** (`opening-core.ts`):
- **Writes:** one READ COMMITTED transaction with the branch `FOR SHARE`, then the student `FOR UPDATE` (:140-166).
- **Draft month:** may not be after the current month in the branch time zone (`future`, :168-170). Check 8 separately
  requires it to be before S.
- **Replace** marks the predecessor `EDITED` and inserts a successor (:228-264). **Withdraw** marks it `WITHDRAWN` with the
  reason (:266-293). History is never deleted.
- **Confirmations** append `MAX(sequence)+1` after the lock (:419-423).
  - A second submission with the **same, still-valid binding is accepted and appends another row.** The confirmation
    itself is not part of any fingerprint (`fingerprint.ts:35-55`), so it does not invalidate itself.
  - This matters for §4.4 and D3.
- **No action carries a request identity or idempotency key.** Nothing in the data records which request wrote a row. The
  screen therefore can never attribute a recorded row to one particular submission (§4.4).

### 1.2 The baseline (`src/lib/students/baseline-action.ts:21`)

- **Signature:** `runStatusHistoryBaseline(org, prev, formData) → { ok: true, count } | { error: "notFound" }`. Owner
  only. It reads **no** form fields.
- **What it writes:** for **every** student in the organization with zero `StudentStatusChange` rows (any status, every
  branch), one `BASELINE` row: the student's current status, dated **today in that student's branch time zone** (:45).
  - The zero-rows test is re-checked under the student lock, so a rerun or a race is a no-op.
- **One transaction per student** (:33). A run interrupted midway has committed some rows. A rerun completes the rest.
  It is idempotent.
- **Limitations, existing and kept:**
  - **No confirmation exists on the server.** The action has no token and no preview. A confirmation dialog is UI only,
    and its absence cannot be detected by the server.
  - **It is organization-wide, not per S.**
  - **Timing:** check 1 needs a status row **strictly before the 1st of S** (`evaluate.ts:144-145`). A baseline taken on
    or after the 1st of S, in a branch's time zone, **cannot** satisfy check 1 for that branch's students for this S.
  - **Fingerprints:** a new status row changes the student fingerprint, so it makes that student's existing reviews and
    acknowledgements stale.
  - **Non-owner members:** a Director is not mapped to `notFound`; `FORBIDDEN` propagates as a thrown error
    (`context.ts:126-133`). The screen is owner-only, so this is unreachable from it. It is not changed.

### 1.3 Plan assignment (`src/lib/dues/assignment-actions.ts`)

**`assignPlan` (:64):**
- **Fields:** `studentId`, `effectiveYear`, `effectiveMonth`, `planId`.
- **Refusals:**
  - `notFound`;
  - `invalid` for `effectiveMonth` or for `planId` (another branch's plan, another organization's plan, or a package plan:
    `assignment-core.ts:61-66`);
  - `pastMonth`: before the current month, evaluated under the student lock (`assignment-core.ts:38`);
  - `monthAssigned`: the unique key on student and month.
- **Allowed months:** the current month and later months.
- **History:** append-only. An existing month is never overwritten.
- **`planId` absent or empty means an explicit "no plan"** (`resolvePlanId`, `assignment-core.ts:62`). That is a
  first-class value, distinct from "no row" (undecidable). **See decision D1.**
- **`resolvePlanId` does not check `active`**: an inactive plan of the branch is accepted by the server. The form offers
  only active plans. That is a UI choice; the server stays unchanged.

**`correctAssignment` (:116):**
- **Fields:** `assignmentId`, `expectedRevision`, `planId`. Only `planId` changes.
- **Refusals:** `notFound`, `invalid` (`expectedRevision` or `planId`), `notFuture` (the row's month is the current month
  or earlier), `stale` (the revision differs; the token is `versionRevision({ planId })`, `config-input.ts:76`).

**Both:**
- owner-only via `resolveActionContext`, and **a Director's `FORBIDDEN` propagates** (as for the baseline);
- an assignment change alters the student fingerprint, so it makes existing reviews stale.

### 1.4 What the merged screen already has (`src/lib/dues/readiness/screen.ts`)

One REPEATABLE READ, READ ONLY snapshot. It returns:
- the unchanged report: checks, preview, fingerprints, confirmation states and opening totals;
- `asOf` (the database time), branches `{ id, name }` and students `{ id, name, academyId, status, promoOrExempt }`;
- active drafts with the month, status and amount of each linked legacy row;
- the legacy rows that a check names.

**No binding, plan list, legacy row list or assignment detail is returned yet** (`screen.ts:15-16`).

## 2. Missing capability (explicit, not added silently)

**M2. Form data in the read model.** All of it is computed in `screen.ts` from **the same snapshot** as everything
displayed. No new query is needed: `loadReadinessSnapshot` already carries plans (with name and `active`), terms,
assignments, legacy rows, status rows and branch time zones (`snapshot.ts:7-40`).

Additions to `ReadinessScreen`:

| Field | Source (same snapshot) | Used by |
|---|---|---|
| `students[].openingBinding` | `openingReviewBinding(S, report.fingerprints.students[id])` | the opening-review form |
| `students[].pricingBinding` (promo/exempt only, else `null`) | `pricingAckBinding(S, studentFp, report.fingerprints.branches[academyId])` | the pricing form |
| `students[].legacyRows` | the student's `legacyPayments`: `id, year, month, status, amount, currency, promoName, promoRecurring` | link picker, pricing display |
| `students[].assignment` | the assignment effective for S (`planId`, `null` = explicit no plan, or absent), plus the **strictly future** assignments `{ id, year, month, planId, revision }`, with `revision = versionRevision({ planId })` | assignment and correction forms |
| `students[].preview` | `report.preview.students` for this student: the price S would charge, or why not | pricing display |
| `branches[].today`, `branches[].currentMonth` | `asOf` in the branch time zone (the `todayInAsDbDate` / `currentMonthIn` rules) | baseline timing, month limits |
| `branches[].baselineHelpsS` | `today < 1st of S` | baseline dialog (§3.1) |
| `branches[].plans` | the branch's `active` plans that are **not** packages (no terms with `monthsCovered > 1`, the `isPackagePlan` rule in `package-plans.ts:23`), each with its terms effective for S (price and currency) or "no terms for S" | assignment form |
| `baseline` | the number of students with zero status rows, per branch and in total, and how many are ACTIVE | baseline panel |

**Not added:**
- a second fingerprint computation; the bindings use the report's own fingerprints;
- withdrawn or superseded draft history (stays out of scope, as in 8d-1);
- anything that would let a form name an organization, an actor or a fingerprint.

`readiness-view.tsx`'s read-only parts stay server components. **Historical review wording is unchanged:** "At that review:
…", as merged in PR #150.

## 3. The forms

**All forms:**
- are client components in the readiness folder (§6);
- receive actions bound on the server as `action.bind(null, context.organizationId)`, the `dues-config-forms.tsx:169`
  pattern;
- receive every id and binding from the server-rendered read model;
- use client attributes (`required`, `maxLength`, `inputMode`, `pattern`) only as a convenience. The server's refusal is
  authoritative and always rendered.

### 3.1 Before S: status baseline (one panel)

- **Shows:**
  - checks 1 and 2 by name;
  - the zero-row count (M2), split into active and other students;
  - per branch, whether a baseline taken today can help S (`baselineHelpsS`).
- **Button:** "Take status baseline". It opens an **AlertDialog** that states exactly:
  - one row dated today in each student's branch time zone, for every student with no status history, in every branch;
  - nothing else changes, and it can be run again safely;
  - it makes the affected students' reviews stale;
  - for each branch where today is on or after the 1st of S: "This cannot fix check 1 for {S} in {branch}. Choose a later
    start month." (brief scenario 2).
- **When it cannot help in any branch, the button stays available** (it is still correct history). The dialog leads with
  that statement. **See decision D2.**
- **Result:** "Status history recorded for {count} students." `count = 0` is shown as "Nothing to record: every student
  already has status history."

### 3.2 Before S: plan assignments

**Who:** check 4's students. Also, behind "Show all active students", every ACTIVE student, so a wrong plan can be seen.
**See decision D4.** Each listed student shows:
- the assignment effective for S: plan name, "No plan (chosen)", or "No plan assigned";
- the strictly future assignments.

**"Assign a plan" form** (`assignPlan`):
- **Month:** `effectiveYear` / `effectiveMonth`, defaulting to S, bounded below by the branch's current month (the action
  refuses `pastMonth` anyway).
- **Plan:** a **required radio group with no preselection.** It lists the branch's offerable plans, each with its terms for
  S (for example "Monthly — ₡ 25,000 from {S}" or "no price for {S}"), plus "No plan (explicitly unassigned)".
- **Choosing "No plan"** opens a confirmation dialog: "From {month}, {name} will have no monthly plan. If {month} is the
  current month this cannot be changed later."
- **Missing choice:** the server cannot tell a blank from an explicit "no plan" (§1.3, decision D1). The UI never submits
  without an explicit choice. This is a convenience only. **See D1.**

**"Change" on a strictly future assignment** (`correctAssignment`):
- the plan radio group, prefilled;
- the hidden `expectedRevision` from M2;
- refusals: `stale` (§4.3) and `notFuture` ("This month has started and can no longer be changed").

**Order hint (text, not enforced):** "Do this before reviewing opening debt; changes here require reviews to be done
again."

### 3.3 Per student: opening-debt drafts

Each active draft shows its content, exactly as merged, plus two actions.

**Replace** (a `<details>` form, prefilled from the draft):
- the month (`coverageYear` / `coverageMonth`, month select plus year field, `MonthFields`);
- the amount, a text field with no separators, for example `1234.50`, sent as typed;
- the currency, a required radio with **no default**;
- the note (required, ≤ 500);
- the legacy link: a select of **this student's** legacy rows, labelled month, translated status and exact amount. Paid
  months are flagged; "none" is allowed.
- The hidden `draftId`.

**Withdraw:**
- an AlertDialog with a **required** reason (≤ 500);
- the text "The draft stays in history as withdrawn."

**"Add opening debt"** (`createOpeningDraft`): the same fields, empty.
- **Month limit:** the branch's current month. A later month is refused by the server as `future`.
- **Check 8:** the form also states that months from {S} on fail check 8.

**Exact amounts:**
- every amount is displayed with `formatExactMoney`;
- the typed amount is never parsed on the client into a number. The server's `parseMoney` decides.

**Immutable history:** replace and withdraw never edit in place. The UI says "Replaced" or "Withdrawn"; it never says
"edited" or "deleted".

### 3.4 Per student: opening review

**The control depends on the active drafts in the server-rendered content:**
- **zero drafts:** "Confirm: no opening debt before {S}" (`declaration=noOpeningDebt`);
- **one or more:** "Confirm: the opening debt before {S} is exactly these {n} items" (`itemsAsShown`).

**Every submission goes through an AlertDialog that restates what is attested:**
- the items (month, exact amount, note), or "no opening debt";
- the start month;
- "This review is recorded for {S} only. Any later change to this student makes it stale."

**The binding:**
- hidden `studentId`, `candidateYear`, `candidateMonth` and `binding`, all from M2;
- **never computed on the client.**

**State display:** the existing badge and the historical wording ("At that review: …") are unchanged.

### 3.5 Per student: pricing acknowledgement (promo/exempt students only)

**Shows:**
- the student's promo, exempt or recurring-promo legacy rows (month, status, promo name, exact amount);
- the effective plan;
- what S would charge (`preview`):
  - an exact price and currency, or
  - why not ("no plan assigned", "configuration gap", "not eligible").

**Button:** "Acknowledge pricing from {S}", behind an AlertDialog restating the above. The dialog says that a change to the
student, or to the branch's plans, prices or policy, makes the acknowledgement stale.

**Hidden fields:** `binding` (pricing) from M2.

## 4. Submission behaviour

### 4.1 One client hook

`useReadinessAction(action, { onSettled })` in `readiness/use-readiness-action.ts`.

**It follows `useDuesAction`** (`dues-config-forms.tsx:27-41`):
- `useTransition` plus `FormData`;
- the typed values are kept on a refusal;
- `aria-busy` while pending, and the submit button is disabled while pending.

**It adds:**
1. **A `try/catch` around the action call.** A thrown action becomes an **unknown outcome** (§4.4), never a rejection
   and never an assumed failure. This mirrors `payment-entry-section.tsx:417-428` (`settled.status === "rejected"` →
   "uncertain").
2. **An in-flight guard** (a ref). A second submit while one is pending is ignored on the client, in addition to the
   disabled button. Server-side duplicates are covered in §4.5.
3. **A result split by what the response proves, never by later observed data:**
   - **saved:** an explicit `{ ok: true }` response;
   - **rejected:** an explicit `ActionState` error. The action's documented result for that code is shown (§4.3). For
     these actions every returned error is decided before any write, or by a rolled-back unique violation, so the call
     wrote nothing (`opening-core.ts:140-166`, `assignment-actions.ts:84-110,135-168`);
   - **outcome unknown:** the action threw (lost response, network failure, timeout, 500). The request may have
     committed, may not have, or may still commit later (§4.4).

   Only the response decides "saved" or "rejected". Refreshed data never changes the outcome kind.

### 4.2 Success

- Reset the form, show `role="status"` text next to it ("Saved."), then `router.refresh()` (the `payments-table.tsx:160`
  pattern).
- The server component re-runs, so every check, total, badge and binding is recomputed from a **new** snapshot.
- **Refresh completion is detected by a new `asOf`** (it changes on every snapshot). Until it arrives, the card shows
  "Updating…", and its other forms are disabled (they would carry the old binding).

### 4.3 Stale, and other confirmed rejections

**`stale`** (review, acknowledgement, replace, withdraw, assignment correction):
- **Message:** "This changed after the page was loaded. Nothing was saved. The page has been refreshed: review the
  current content before confirming again."
- **Then:**
  - the hook calls `router.refresh()`. It **never resubmits**;
  - the submit stays disabled until the new `asOf` arrives;
  - the review and acknowledgement buttons require **reopening the dialog**, which now restates the **refreshed** items.
    That is the fresh review, followed by another explicit press;
  - a draft or assignment form keeps the owner's typed values, but **is not re-prefilled from the refreshed data and
    not resubmitted**. If its target is no longer active, the form closes and says so (as in §4.4 step 4).
- **If the refresh does not arrive** (offline), the card keeps the old content disabled and offers "Reload page". It
  offers no retry.

**`declaration: mismatch`:** the same as `stale`. The drafts changed between render and submit.

**`monthHasDraft`:** "There is already an opening item for that month. Replace that one instead." Then refresh.

**`monthAssigned`:** "That month already has an assignment." Then refresh.

**`notFound`:** "This is no longer available." Then refresh.

**`pastMonth`, `notFuture`, `invalid` with `fieldErrors`:**
- the message goes under the field, with `aria-invalid`;
- the typed values are kept;
- there is no refresh.

**Map:** one fixed map from code to message key (the `financial-corrections-section.tsx:119-142` style), with an
`unexpected` fallback for any unknown code.

### 4.4 Outcome unknown (lost response, connection failure, timeout, 500)

**What it proves:** nothing about the request. It may have committed, may not have, or may still commit after any
number of refreshes (a request can sit behind a lock and finish later).
- **Unchanged data after a refresh does not prove failure.**
- **Matching data does not prove success.** Another owner, another tab or an earlier request could have written it, and
  no row records which request wrote it (§1.1).
- So the screen makes **no inference from refreshed data**. There is no comparison marker and no inspector, and nothing
  is ever reported as "saved" or "not saved" for this request.

**The flow:**
1. **The form is locked.** Its submit and every other form on the same student card are disabled. The typed values stay
   in the form, untouched.
2. **An alert** (`role="alert"`, focused):
   > **Outcome unknown.** The connection failed before the server answered. This request may or may not have been saved,
   > and it could still be saved later. Reload the current data and inspect it before doing anything else.
   - The button: "Reload current data" (`router.refresh()`).
3. **After a new `asOf` arrives,** the alert stays and changes to:
   > **Outcome still unknown.** Below is what is currently recorded, as of {asOf}. It may or may not include this request.
   > Check it before doing anything else.
   - "Reload again" stays available.
   - The card's drafts, assignment, badges and checks are the server's current data, and the alert sits next to them.
     They are described as **currently recorded**, never as this request's result.
4. **Renewed review before any further action:** the button "I have checked the current data" closes the alert and
   unlocks the card.
   - **Nothing is resubmitted.**
   - **The typed values are not overwritten by refreshed data, and not sent again.** They remain visible in the
     (collapsed) form only as the owner's own input. Submitting them again needs a new, explicit press. For a review or an
     acknowledgement, that press reopens the dialog with the **current** items and binding.
   - **If the refreshed data no longer has the form's target** (a replaced or withdrawn draft, a corrected assignment),
     that form is not shown. Its typed values are discarded, and the alert says so: "This item is no longer active, so its
     form was closed."
5. **If the refresh itself fails,** the alert says "We could not load the current data." and offers only "Reload page"
   (a full navigation, which discards typed values; the alert says so).

**Why so little:** the actions have no request identity or idempotency key, and adding one is out of scope (no action or
schema change). Any conclusion drawn from the data would be a guess.

### 4.5 Server-side duplicates (what a repeated submission does, unchanged)

| Action | Second identical submission |
|---|---|
| create | `monthHasDraft` |
| replace | `stale` (the predecessor is no longer active) |
| withdraw | `stale` |
| assign | `monthAssigned` |
| correct | succeeds again with the same `planId`, writing an audit row; the revision is unchanged. Harmless |
| baseline | `count: 0` |
| review / acknowledgement, binding still valid | **a second row (sequence + 1, same binding)**. Harmless to validity, but it adds a row and an audit entry. Accepted, with no action change (decision D3) |

**What the client can and cannot prevent:**
- The in-flight guard (§4.1) and the disabled button **reduce** duplicates **within the mounted UI**.
- §4.4's lock-and-review step **reduces** the chance of an immediate resend after a lost response.
- Neither **guarantees exactly-once**:
  - a lost response can be followed by a deliberate new press after the review step;
  - a reload or a second tab has no memory of the earlier request;
  - the original request may commit later.
- The server-side table above is what actually bounds the effect of a duplicate.

## 5. Accessibility, dialogs and focus

- **Forms:**
  - every field has a visible `<label>`;
  - groups use `<fieldset>` and `<legend>`, for example the currency and plan radios;
  - errors are linked with `aria-describedby` and shown with `aria-invalid`;
  - the result region is `role="status"` for success and `role="alert"` for rejections and unknown outcomes.
- **Dialogs:** the existing `src/components/ui/alert-dialog.tsx`.
  - Focus is trapped inside. Escape cancels and returns focus to the trigger.
  - The initial focus is the **cancel** button for the review, acknowledgement, no-plan and baseline dialogs (they are
    attestations).
  - Withdraw focuses the reason field.
- **Focus after the outcome:**
  - **success, or a refresh after stale:** to the student card's heading (`tabIndex={-1}`), with the status message
    announced;
  - **a field error:** to the first invalid field;
  - **unknown outcome:** to the alert.
  - A form that unmounts because its draft was replaced never strands focus.
- **Disclosures:** forms sit in native `<details>`, collapsed by default, so 320 px stays scannable.
- **Targets:** at least 44 px under a coarse pointer (`touch-targets` method).
- **Language:** every string comes from `payments.readiness.forms.*`, EN and ES, with parity enforced.

## 6. Files (bounded)

| File | Change |
|---|---|
| `src/lib/dues/readiness/screen.ts` | M2 fields (read-only; same snapshot) |
| `src/app/[locale]/(staff)/payments/readiness/page.tsx` | bind the seven actions to `context.organizationId`; pass them to the panels |
| `…/readiness/readiness-view.tsx` | read-only parts unchanged, except mounting the client panels inside the existing cards |
| `…/readiness/use-readiness-action.ts` | **new**: the hook (§4) |
| `…/readiness/outcome-messages.ts` | **new**: the code → message-key map, and the response classifier (`saved` / `rejected` / `unknown`), pure and unit-tested. **No inspector** of refreshed data |
| `…/readiness/before-start-panel.tsx` | **new** (client): baseline and assignments |
| `…/readiness/draft-forms.tsx` | **new** (client): create, replace and withdraw |
| `…/readiness/confirmation-forms.tsx` | **new** (client): opening review and pricing acknowledgement |
| `…/payments/plans/dues-config-forms.tsx` | export `MonthFields` (no behaviour change) |
| `messages/en.json`, `messages/es.json` | `payments.readiness.forms.*` |
| `tests/unit/dues-readiness-not-exposed.test.ts` | allow exactly the named client files to import exactly `opening-actions`; the page and view still import only `screen`, `candidate` and `evaluate` from the readiness folder |
| `scripts/pending-callers.ts` | remove the five 8c action entries (they now have a caller). `getDuesReadinessForOwner` stays (still no caller) |
| tests | §7 |
| `design/matroom/verification/dues-stage8d2-forms/README.md` | evidence |
| `docs/dues/STAGE-8-READINESS-BRIEF.md`, `docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md` | status (the corrections already made in the working tree, then "8d complete in code only" once merged) |

**Not touched:**
- `opening-actions.ts`, `opening-core.ts`, `baseline-action.ts`, `assignment-actions.ts`, `assignment-core.ts`;
- `evaluate.ts`, `snapshot.ts`, `fingerprint.ts`, `index.ts`;
- the schema, migrations, every financial writer, the sidebar and the scheduler.

## 7. Tests

All against the isolated test database, with synthetic data.

### 7.1 Unit

- **`outcome-messages`:**
  - every known code maps to a message, and an unknown code → `unexpected`;
  - `{ ok: true }` → `saved`, an `ActionState` error → `rejected`, a thrown error → `unknown` (never `rejected`, never
    `saved`).
- **The hook, with React Testing Library and jsdom** (already installed):
  - pending disables the form and sets `aria-busy`;
  - a double click calls the action once;
  - a rejection keeps the typed values;
  - success resets the form and calls `router.refresh` (mocked);
  - `stale` calls `router.refresh` **and never calls the action again** (spy count stays 1);
  - the submit stays disabled until a new `asOf` prop arrives;
  - **a thrown action:**
    - the outcome is unknown, the card is locked and the alert is focused;
    - the action spy count stays 1 through any number of refreshes;
    - a new `asOf` changes only the alert's wording;
    - the typed values are unchanged and not re-prefilled;
    - the card unlocks only after "I have checked the current data";
    - the success message ("Saved.") never renders, in either locale. No message key exists that claims "not saved"
      (asserted on both message files).
- **Forms** (RTL):
  - the plan radio has no preselection;
  - "No plan" requires its dialog;
  - the currency has no default;
  - the review button label and `declaration` value follow the draft count;
  - the dialog restates the items;
  - focus returns to the trigger on cancel;
  - focus goes to the first invalid field.
- **Exposure guard:** the updated `dues-readiness-not-exposed` assertions above. No client file imports
  `opening-core`, `screen`, `snapshot` or `fingerprint`.

### 7.2 Integration (real actions, real database, mocked session)

**Through the rendered form fields:** render each client form server-side (`renderToStaticMarkup`, `next/navigation`
mocked), read its hidden and named fields from the HTML, build the `FormData` exactly as the browser would, and call the
real bound action. This proves the wiring and that **a binding from the screen is accepted unchanged.**

**Same snapshot:**
- with the loader's `afterFirstRead` hook, commit a draft mid-load;
- the rendered binding (from the earlier snapshot) is refused `stale`, and nothing is written;
- the next render's binding is accepted.

**Tampered references and bindings,** each with "nothing written" asserted by row and audit counts:
- another organization's `studentId`, `draftId`, `legacyPaymentPeriodId` or `assignmentId` → `notFound`;
- this organization's legacy row for another student or month → `invalid` (`mismatch`);
- another branch's plan, another organization's plan, or a package plan → `invalid` (`planId`);
- a binding altered by one hex digit → `stale`; a malformed binding → `invalid`;
- a tampered `candidateMonth` (another S) → `stale` (S is inside the binding);
- a flipped `declaration` → `invalid` (`mismatch`);
- a forged `expectedRevision` → `stale`.

**Stale tabs:** render tab A, then make a change as tab B through the real actions. Then tab A submits:
- review → `stale`;
- acknowledgement after a branch price correction → `stale`;
- replace or withdraw of a draft B already replaced → `stale`;
- create for a month B created → `monthHasDraft`;
- assign for a month B assigned → `monthAssigned`;
- correction with A's revision after B's → `stale`.

**Duplicate submissions** (the §4.5 table, asserted row by row). For the review: two rows (sequences 1 and 2), the same
binding, the state still valid, and no other table changed. That documents D3's accepted behaviour.

**Concurrent replace and withdraw on one draft:** with the 8c `afterLocks` pause hook, through the cores the bound
actions call:
- replace against withdraw: exactly one succeeds, the other is `stale`, and there is exactly one terminal marker;
- replace against replace: exactly one successor.

These complement the 8c tests (`dues-opening-actions.test.ts`) through the screen's own form fields; they do not duplicate
the lock proofs.

**Refresh behaviour, at the data level:** after each successful action, a new `getReadinessScreenForOwner` call shows
the changed check, badge, total and new binding. The old binding then returns `stale`.

**Authorization:** a Director's page is still a real 404 (8d-1 test kept). The bound actions called with a Director's
session:
- 8c actions → `notFound`;
- baseline and assignment → throw `FORBIDDEN`, the **existing** behaviour, asserted as is and not changed.

**No financial effect:** after a full scripted session of all seven actions, `DuesObligation`, `DuesCoverage`,
`PaymentPeriod` and ledger counts are unchanged.

### 7.3 Smoke

- **Routes:** `/en/payments/readiness` and `?s=` stay < 500 for ADMIN and a real 404 for DIRECTOR and INSTRUCTOR. These are
  the existing tests.
- **Cold run:** CI.

### 7.4 Deterministic recovery scenarios (no false saved / not-saved claim)

**Setup** (integration file with `@vitest-environment jsdom`, as `tests/integration/portal-ledger-queries.test.tsx`
does):
- **The client card** is rendered with RTL. Its props come from real `getReadinessScreenForOwner` calls on the isolated
  database.
- **The bound action** passed to the card is a wrapper. It rejects its own promise at once, so the client sees a lost
  response, while it runs the **real** server work independently, under a test gate.
- **Two deterministic timings:**
  - **delayed start:** the wrapper awaits a test gate, then calls the real bound action. Other sessions' writes run first
    and do not block on it;
  - **held inside the transaction:** the wrapper calls the 8c core the action calls (after the same owner authorization),
    with the existing `afterLocks` hook (`opening-core.ts:30-41`) paused. While it is held, the student lock blocks any
    other write to that student, so this timing is used only where nothing else must write that student meanwhile.
- **Each step re-renders the card** with the next real screen read (screen reads never wait on row locks).

**Every scenario asserts, at every step:**
- the success message never renders;
- no "not saved" claim exists;
- the alert stays "Outcome unknown / still unknown" until the owner acknowledges it;
- the action wrapper is called exactly once;
- the typed values are never changed by new props.

| # | Scenario | Steps | Additionally asserted |
|---|---|---|---|
| R1 | **The action commits after the first refresh returned unchanged data** | create a draft, **held inside the transaction**; the client gets a lost response; refresh 1 (unchanged); release; the server commits; refresh 2 shows the draft | after refresh 1 the alert does not say "not saved" and the form stays locked; after refresh 2 the draft is shown as currently recorded, with no "saved" claim |
| R2 | **Another owner creates a different draft during recovery** | create January for student X, **delayed start**; lost response; refresh 1; another owner session creates **February** for X through the real action; refresh 2 (February only); open the gate, and January commits; refresh 3 (both) | each refresh shows whatever is recorded; nothing attributes either draft to this request, including refresh 2's new draft, which is not this request's |
| R3 | **Another owner records a different review during recovery** | an opening review with binding B1, **delayed start**; lost response; another session adds a draft, then records a review with **B2**; refresh; open the gate: the real call returns `stale` server-side (B1 no longer matches) and writes nothing; refresh | the card shows a current review (B2's) as currently recorded; there is no "saved" claim although a newer, valid confirmation exists, and no "not saved" claim although this request wrote nothing |
| R4 | **The replacement changes the month** | replace a January draft with **March** content, **held inside the transaction**; lost response; refresh 1 (January still active); release; refresh 2 (January gone, March active) | after refresh 1, no "not saved" claim; after refresh 2, March is shown as currently recorded, the January replace form closes with "This item is no longer active, so its form was closed", and there is no claim either way |
| R5 | **A withdrawal races a replacement** | one draft; tab A withdraws (lost response) and tab B replaces it. Run twice: (a) A's withdrawal is **held inside the transaction** while B's replace waits on the student lock, then A is released; (b) B's replace is held while A's withdrawal waits, then B is released | (a) withdrawn and B gets `stale`; (b) replaced and A's call is `stale` server-side. Both: exactly one terminal marker on the draft; tab A never claims "withdrawn" or "not withdrawn", shows only the current state and closes its form |
| R6 | **An explicit response, for contrast** | the same create with the response delivered | `ok` → "Saved."; `monthHasDraft` → its documented message. The response alone decides |

**The rule these scenarios pin:** only an explicit response classifies the outcome. Refreshed data is displayed as current
data and never classifies anything.

## 8. Browser acceptance

The harness is Playwright-core (Chrome) against `next dev` on the isolated test database.

**The owner** is created **through the browser UI**:
1. the public registration form;
2. a platform super-admin approves it in `/platform/organizations/pending`;
3. the owner opens the invitation link and accepts it.

**Onboarding** is completed through the onboarding UI, not by SQL. If any step cannot be completed in a browser (for
example, the invitation link reachable only by email in that environment), that is recorded as a gap. It is not described
as a browser proof.

**Fixture data** — branches, plans, terms, students, status rows and legacy rows — is synthetic and inserted into the
isolated test database. Labelled as such.

**Checks** (each reported only after it runs):

| Area | Check |
|---|---|
| Every action, through the real form | create, replace and withdraw a draft; the opening review with and without drafts; the pricing acknowledgement; assign (a plan and an explicit no plan); correct a future assignment; the baseline. Each: the dialog, submit, "Saved", automatic refresh, and the checks, badges and totals updated without a manual reload |
| Stale, real | load the page, change the same student in a second tab, submit in the first → the stale message, a refresh, nothing saved; the dialog shows the new items; a new explicit press succeeds |
| Outcome unknown | the action request fails through Playwright routing, in two ways: aborted before sending (the server never sees it), and let through then failed on the response (the server committed). **Both runs must look identical:** "Outcome unknown", the card locked, "Reload current data", then "Outcome still unknown" over the currently recorded data, then unlocked only by "I have checked the current data". The typed values are unchanged, there is exactly one action request (network log), and the DOM never contains the success message or any "not saved" claim |
| Duplicate press | a double click → one request |
| Validation | bad amount, missing currency, a note over 500 code points, a future month → messages under the fields, values kept, focus on the first invalid field |
| EN / ES | the full flow in both; no untranslated keys |
| Light / dark | every state (missing, current, changed, rejection, outcome unknown, still unknown) in both themes |
| Keyboard | every form, radio group, `<details>` and dialog by keyboard alone; visible focus; focus return after cancel; focus to the heading after success |
| 1280 / 390 / 320 px | no horizontal page scroll with every form expanded |
| Long names | an 80-character student, branch and plan name, a 500-character note and reason |
| Exact amounts | ₡ 25,000.50, ₡ 0.51, $ 85.50, and totals above 99,999,999.99 entered and displayed exactly |
| Coarse pointer | targets of at least 44 px |
| No activation | no control or wording that activates; "Not ready" still shown |

**Evidence classes, stated in the README:**

| Class | What it proves |
|---|---|
| **Real browser interaction** | the rows above, at 1280 px in a real window |
| **Emulated viewport** | 390 and 320 px (a real Chrome window on this machine cannot go below about 500 px). Labelled emulated |
| **Rendered tests** | RTL component tests (§7.1) and server-rendered form fields (§7.2). Not a browser |
| **Synthetic fixtures** | all data except the owner's registration path |

## 9. Implementation sequence

Each step ends with its tests passing.

1. **Branch** `feat/dues-stage8d2-forms` from `main`. Carry over the uncommitted doc corrections.
2. M2 in `screen.ts`, with integration tests first: same-snapshot bindings, plan list, revisions, timing fields.
3. `outcome-messages.ts`, the response classifier (unit).
4. `use-readiness-action.ts`, with the lock and review flow of §4.4 (RTL).
5. Draft forms (create, replace, withdraw), with the integration tests through the form fields.
6. Opening review and pricing acknowledgement, with the stale and same-snapshot tests, and the §7.4 scenarios R1–R6.
7. The before-S panel: assignment, correction, baseline.
8. The exposure guard and `pending-callers` updates; messages in EN and ES.
9. The full suites, then the browser pass (§8), then the evidence README.
10. The PR, held unmerged.

## 10. Decisions (working design, revision 2)

The recommended choices are recorded as the working design. They are open to change in review.

**D1. The "explicit no plan" input contract: keep `assignPlan` unchanged.**
- **The limitation:** `resolvePlanId` treats an absent or empty `planId` as an explicit "no plan" (§1.3). A submission
  without the field, whether tampered or from a broken form, records "no plan". For the current month that row can never
  be corrected (`notFuture`).
- **The design:** the UI requires an explicit radio choice and a dialog for "No plan" (§3.2). Only the owner can submit.
  The server cannot tell omission from choice. That is accepted and documented.
- **Not done:** an explicit marker on `assignPlan`; that would change an existing action's contract, which this scope
  excludes.

**D2. The baseline button stays available when it cannot help S,** with the dialog leading with "This cannot fix check 1
for {S}" for each affected branch (§3.1). The action is correct history capture and idempotent.

**D3. Duplicate confirmation rows are accepted.**
- **Effect:** a repeated review or acknowledgement with a still-valid binding appends a second row with the same binding
  (§4.5). It is harmless to validity and recorded in audit.
- **What reduces it:** the in-flight guard and the disabled button, **within the mounted UI only**, and §4.4's lock and
  review step.
- **What does not hold:** **exactly-once.** A lost response followed by a deliberate new press, a reload, a second tab, or
  an original request that commits late can each produce a second row.
- **Not done:** an idempotency key; that would change the actions and probably the schema, which this scope excludes.

**D4. The assignment panel** lists check 4's students by default, and every ACTIVE student behind "Show all active
students" (§3.2).

Not open:
- O4 stays undecided;
- `ready` stays false;
- `router.refresh()` is the refresh mechanism (no action file changes);
- withdrawn and superseded draft history is not shown.
