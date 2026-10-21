# Dues stage 8 PR 8d-2 — the readiness screen's interactive forms — verification

**Base:** main `2bfd794da730526311fd131b2e583873cba6035b` (8a–8c and 8d-1 merged).
**Contract:** `docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md` (revision 2, D1–D4 as the working design).

**Not changed:** no schema, migration, server action, financial writer, fingerprint, check, scheduler, activation or sidebar change.
The existing actions are called unchanged: the five 8c actions, `runStatusHistoryBaseline`, `assignPlan` and `correctAssignment`.
`ready` stays false (checks 10–12 not implemented, 13 decision pending) and O4 stays undecided. Historical review wording ("At
that review: …") is unchanged.

## What was built

- **`src/lib/dues/readiness/screen.ts` (M2):** the forms' data, derived from the **same** REPEATABLE READ snapshot as everything
  displayed, with no new query:
  - per student: `openingBinding` and `pricingBinding` (from the report's own fingerprints), legacy rows, the assignment for
    S and the strictly future assignments with their `versionRevision` token, and the preview;
  - per branch: local today and current month (from the snapshot's database time), `baselineHelpsS`, and the offerable plans
    (active, not packages) with exact terms for S;
  - the baseline counts;
  - active drafts now carry `legacyPaymentPeriodId`, so the replace form can prefill the link.
- **`…/readiness/outcome-messages.ts`:** the response classifier. `{ ok: true }` → saved; an `ActionState` error → rejected
  (every such error is decided before any write, or by a rolled-back unique violation); a thrown call → **unknown**. There is
  no inspector of refreshed data.
- **`…/readiness/use-readiness-action.tsx`:**
  - `ReadinessClientRoot` holds one outcome scope per student (shared by the card and the assignment row) and one for the
    baseline;
  - `useScopedSubmit` has an in-flight guard and treats a thrown call as unknown;
  - `ScopeStatus` is the outcome region, focused on every outcome.
  - **Saved, or an out-of-date rejection:** `router.refresh()`; the scope stays locked until a new snapshot (`asOf`) arrives.
  - **Field rejection:** shown under the field, values kept, no refresh.
  - **Unknown:** the scope locks with the typed values untouched. "Reload current data" leads to "Outcome still unknown — this
    is what is currently recorded", and the scope unlocks only after "I have checked the current data". Nothing is resent.
  - **A refresh that never arrives (15 s):** "We could not load the current data" and only "Reload page".
- **`…/readiness/draft-forms.tsx`:**
  - create and replace forms: month, exact amount as text, currency with **no default** for a new draft, this student's
    legacy link, note;
  - withdraw: a dialog with a required reason, kept in state.
- **`…/readiness/confirmation-forms.tsx`:**
  - opening review: "no opening debt" or "exactly these N items";
  - pricing acknowledgement;
  - each submit goes through a dialog that restates the **current** props, and the dialog closes if a refresh brings a new
    binding.
- **`…/readiness/before-start-panel.tsx`:**
  - baseline (D2): the dialog states its scope and timing and leads with every branch where today cannot satisfy check 1 for
    S;
  - assign (D1): radios with no preselection, and "No plan" behind its own dialog;
  - correct a strictly future assignment.
- **`…/readiness/form-fields.tsx`:** the shared fields and `ConfirmDialog` (focus starts on Cancel; dismissal is blocked while
  pending).
- **`readiness-view.tsx` / `page.tsx`:** a new "Before {S}" section (checks 1–2, the baseline, assignments for check 4's
  students, and the other active students behind "Show the other active students" — D4; one list, see "Correction" below); the forms mounted in each student
  card. `page.tsx` wraps the sections in the client root.
- **Messages:** `payments.readiness.forms.*` in EN and ES (merged by script, additive; the parity test passes).
- **Guards:**
  - `dues-readiness-not-exposed`: the two form files are the only new importers, and each imports only `opening-actions`;
    the five actions now have a real caller and left the built-ahead registry;
  - `dues-ledger-not-exposed`: `screen.ts` is added for the pure `latestEffective`;
  - `scripts/pending-callers.ts`: the five 8c entries are removed (`getDuesReadinessForOwner` stays).

## Verification

### Unit (`tests/unit/dues-readiness-forms.test.tsx`, jsdom, actions mocked) — 11 tests

- **The classifier:** a thrown call is unknown, never saved or rejected.
- **Success:** one call; "Saved."; a refresh; locked until a new `asOf`, then unlocked and the form reset.
- **Double submit:** one call.
- **Field rejection:** the message is under the field, the values are kept, there is no refresh, and the scope is not locked.
- **Stale:** a refresh, never a second call, locked until the new snapshot, and the typed values are not overwritten.
- **Unknown (EN and ES):**
  - the alert is focused, with no automatic refresh or resend;
  - no "checked" button before a reload;
  - still unknown after any number of refreshes;
  - neither "Saved." nor any rejection message renders;
  - the typed values are unchanged;
  - the scope unlocks only on "I have checked the current data".
- **A refresh that never arrives:** only "Reload page".
- **Invariants:**
  - a new draft's currency has no default;
  - the review's label and `declaration` follow the drafts shown, the dialog restates them, opens on Cancel, and closes on
    a new binding, and the sent FormData equals the props;
  - assignment has no preselection, and "No plan" needs its dialog before any call.

### Integration (`tests/integration/dues-readiness-forms.test.ts`, real actions, isolated test database) — 13 tests

- **The screen's own ids, revisions and bindings drive the real actions unchanged.** The forms are rendered as the page renders
  them, and the ids are read from the hidden fields. Covered: add → replace → review, a promo acknowledgement, an assignment
  and a future correction (whose review then correctly becomes stale).
- **Same snapshot:** a draft committed mid-load (`afterFirstRead`) makes that load's binding `stale` with nothing written; the
  next load's binding is accepted.
- **Tampering:**
  - another organization's student, draft, legacy row or assignment → `notFound`;
  - this organization's legacy row for another student → `mismatch`;
  - another branch's or a package plan → `invalid`;
  - a forged revision → `stale`;
  - an older, flipped, malformed or wrong-kind binding, another S, or a flipped declaration → `stale` or `invalid`;
  - row and audit counts unchanged in both organizations.
- **Stale tabs:** each form submitted from an older page gets its documented refusal (`stale`, `monthHasDraft`, `monthAssigned`)
  and writes nothing. A pricing acknowledgement from before a branch price change is `stale`.
- **Duplicates (§4.5):**
  - create → `monthHasDraft`; replace and withdraw → `stale`;
  - assign → `monthAssigned`, rolled back with no second row and no audit row;
  - correct repeats harmlessly;
  - a review repeat appends sequence 2 with the same binding and the state stays valid (D3, documented).
- **Replace racing withdraw,** in both lock orders (the 8c `afterLocks` hook): exactly one terminal marker, the other `stale`.
- **Authorization:** a Director gets `notFound` from the 8c actions; the baseline and assignment actions keep their existing
  `FORBIDDEN` throw (asserted as is, not changed); nothing is written.
- **Correctable assignments** are only strictly future months relative to the branch's own current month.
- **Baseline:** the screen's count is what the action records; a rerun records 0; `baselineHelpsS` is true for a future S and
  false for a started one.
- **No financial effect:** no obligation or coverage rows in either organization; legacy rows are only the fixtures.

### Deterministic recovery scenarios R1–R6 (`tests/integration/dues-readiness-recovery.test.tsx`) — 7 tests

The real `Students` view, rendered from real screen reads in jsdom, is driven. The UI's action is a wrapper that loses the
response, while the real server work runs either after a test gate (delayed start) or paused inside its transaction by the
existing 8c `afterLocks` hook. **No production test hook was added.**

Every step asserts:
- no "Saved.";
- no rejection message;
- the alert still says unknown;
- exactly one call from the UI;
- the typed values unchanged.

| # | Scenario | Also asserted |
|---|---|---|
| R1 | the action commits **after** a refresh showed nothing | the refresh-1 data is unchanged and there is no "not saved"; refresh 2 shows the draft as currently recorded, with no "saved" |
| R2 | another owner creates a **different** draft during recovery | the new draft is shown, not attributed; then this request commits |
| R3 | another owner records a **different** review; this request is `stale` server-side | a current review is shown, but no "saved"; the request wrote nothing, but no "not saved" |
| R4 | the replacement **changes the month** | refresh 1: January still active, no claim; refresh 2: March active, the January form closed with "This item is no longer active, so its form was closed" |
| R5 ×2 | a withdrawal races a replacement, in both lock orders | exactly one wins; tab A shows only the current state and closes its form |
| R6 | contrast: the response delivered | `ok` → "Saved."; `monthHasDraft` → its documented message |

### Mutations (each run, caught, and restored with `cmp`)

| Id | Mutation | Caught by |
|---|---|---|
| U1 | a thrown call classified as saved | unit (4 tests) |
| U2 | unknown refreshes and unlocks like a save | unit (3) |
| U3 | "checked" offered before any reload | unit (2) |
| U4 | no in-flight guard | unit: double submit |
| U5 | a binding change leaves the review dialog open | unit |
| U6 | an unknown outcome clears the typed values | unit (2) |
| R7 | a reload that shows data is treated as saved | integration R1–R5 (6) |
| S1 | the review binding computed for another S | integration (4) |
| S3 | package plans offered | integration |
| S4 / S4b | the current or a past month listed as correctable | integration: the test added after S4 first survived |

**Honest notes:**
- **S2 was a no-op mutation** (it did not change the value) and is not counted.
- **S4 first survived,** which exposed a real test gap. The "strictly future" test was added, and S4 and S4b were then caught.

### Commands (isolated test database)

- `pnpm typecheck`: clean. `pnpm lint`: 0 errors (two `react/no-children-prop` errors in new test files were found and fixed).
- `pnpm check:guard-usage` and `check:pending-callers`: pass.
- `pnpm test:unit`: 133 files, 1965 tests passed.
- `pnpm test:integration`: 172 files, 2282 tests passed, on the final tree after the browser pass.
- Smoke `page-routes`: 12/12, warm, against the test-database dev server.

## Browser — 44/44 checks (`browser-results.json`; each result names its evidence class)

**Setup:** a Playwright-core harness (Chrome, **headed**) against `next dev` on port 3100 over the **isolated test database**.

**How the owner was created:**
1. **Registration:** through the real public form, in the browser.
2. **Approval:** a **direct `approveOrganization` call, NOT a browser step.** The platform UI deliberately never shows the
   invitation link, no email provider is configured locally, and configuring one is out of scope.
3. **Invitation acceptance:** in the browser, through the link that call returned.
4. **Onboarding:** all three steps in the browser UI. Unlike 8d-1, there was no SQL.

**Data:** branches, plans, terms, students, status rows, legacy rows and four starting drafts are a **synthetic fixture** inserted
into the test database. The drafts went through the real 8c core.

| Class | Count | What it covers |
|---|---|---|
| Real browser, 1280 px real window (`viewport: null`) | 35 | Every action through its real form (each with its dialog, saved state and automatic refresh):<ul><li>add, by keyboard alone;</li><li>replace, changing the month, with exact ₡ 0.51 and a legacy link;</li><li>withdraw, with a required reason;</li><li>review with drafts, and no-debt review;</li><li>pricing acknowledgement;</li><li>assign a plan, and an explicit "No plan" (its dialog first, no request before confirming);</li><li>future correction;</li><li>baseline ("recorded for 2 students").</li></ul>Also: validation (a bad amount stays under the field with focus on it; a future month is refused); a double click sends exactly one request; a 500-character note wraps; a **real stale** case (a second tab changes the student; the first tab's review is refused, the page refreshes, the reopened dialog restates the new items, and a new press records it); EN and ES; dark theme; no activation control; exact amounts; and **outcome unknown** four times (below) |
| Emulated viewport | 7 | 390 and 320 px with every form expanded (EN and ES): no horizontal page scroll, and the long-name card wraps. Coarse pointer: every visible button ≥ 44 px. A real Chrome window on this machine cannot go below about 500 px |
| Synthetic fixture | 1 | the fixture insert itself |
| Real browser + direct call | 1 | registration in the browser, approval by a direct call |

**Outcome unknown, for real:** the action request fails through Playwright routing in two ways.
- **Before the server:** the request is aborted before sending.
- **After commit:** the request is let through and the server commits, then the browser's response is failed.

Both show the same messages: "Outcome unknown", the card locked and no "I have checked" button; then, after "Reload current
data", "Outcome still unknown". There is no saved or rejection message, the typed values are kept, the card unlocks only on "I
have checked the current data", and exactly one action request is sent. **Only the currently recorded data differs:** the
after-commit draft appears in the list without being attributed to the request. This was run in EN (both modes), in ES, and in
dark mode.

**Screenshots** (full pages at 1280 px real window; 390 and 320 px emulated, labelled in the name):
- `03-loaded-en-light-1280`, `13-es-light-1280`, `14-dark-en-1280`;
- `16-expanded-{1280-real-window,390-emulated,320-emulated}-en` (every form open);
- cards: `10-stale-…`, `11-unknown-…`, `12-still-unknown-…`, `15-rejection-dark-…`;
- `01-registered…` and `02-after-onboarding…` (the owner path).

**Notes and limits:**
- Some **card** screenshots are cropped by a few pixels at their right edge. That is the element-screenshot crop: the full-page
  shots show the same cards whole, and the measured page overflow is 0 at every width.
- The Next.js dev indicator ("N") is visible.
- Contrast is judged visually, not measured.
- Smoke page-routes passed 12/12 warm against this server; CI is the cold run.

**Defects the browser found, fixed and re-run:**
1. **Focus after a field rejection** went to the outcome region instead of the refused field. `ScopeStatus` focused itself on
   every outcome, and the one-frame focus attempt raced the re-enabled fieldset.
   - **Fixed:** a field-level rejection no longer moves focus to the region, and `focusFirstInvalid` retries until the field is
     rendered and enabled.
   - **Gap:** jsdom runs effects in a different order, so the unit check passes even with the defect re-introduced (the mutation
     survives in jsdom). This browser check is the guard.
2. **Harness only:**
   - page-level `textContent` read script payloads (now `innerText`, plus a no-redirect assertion);
   - the "as of" time has minute resolution (refreshes are now detected by RSC responses, and the unknown case by its own
     expected state);
   - a `<summary>` click toggles (disclosures are now opened idempotently);
   - draft assertions now read only the drafts list (form options list legacy amounts).

## Correction: assignment rows across a check-4 transition (review of PR #151)

**Defect.** BeforeStart rendered check-4 students and the other active students under two different parent lists (the second
inside a collapsed `<details>`). An assignment that clears check 4 moves the student between them on refresh, so React
remounted the row and its forms.

**Reproduced first, through the real `BeforeStart` layout** (jsdom, real reads on the isolated test database, the real
`assignPlan` behind a test wrapper that loses the response after the commit), on the unfixed code. After "Reload current data",
both for a committed lost assignment and for another owner's assignment during recovery:
- the row was a different element (remounted) and sat behind the collapsed "Show the other active students": not reachable;
- the assign form was closed, the typed month back to the default (December), the chosen plan unchecked;
- "Outcome still unknown" and "I have checked the current data" were rendered but not reachable;
- still exactly one `assignPlan` call (nothing resubmitted).
The new tests failed on the unfixed code (all three, on the row-identity assertion).

**Fix (UI only; no action, financial, schema or activation change).**
- `BeforeStart` now renders every active student under ONE list (`AssignmentRows` in `before-start-panel.tsx`), keyed by
  student, in the screen's own order, never regrouped by check 4. A refresh only toggles a row's `hidden`; it never moves or
  remounts it, so typed values, open forms and the outcome region survive.
- The approved default filtering (D4) is kept: check-4 rows show; the others are hidden behind a button with `aria-expanded`
  ("Show the other active students (n)").
- A row whose student scope has a submission or outcome at the assignment place (pending, refreshing, saved/rejected, unknown)
  stays visible regardless of the filter (`useActiveAt` in `use-readiness-action.tsx`). The outcome is never reset,
  acknowledged or resubmitted by this: after "I have checked the current data" the scope is idle and the filter applies again.
  A saved row stays visible with "Saved." until the next load.

**Tests** (`tests/integration/dues-readiness-assignment-transition.test.tsx`, real BeforeStart, 3 tests):
1. a committed assignment with a lost response clearing check 4 — same element, still unknown, typed values and open form kept,
   acknowledgement reachable and focusable, one call, one assignment row; after acknowledging, hidden behind the toggle and
   shown again (same element) by it;
2. another owner's assignment clearing check 4 during recovery — same element, still unknown, typed values kept, one call, only
   the other owner's assignment recorded;
3. a normal successful assignment moving out of the default list — same element, "Saved." visible, form reset only on the
   explicit success; a fresh load hides it.

**Mutations** (both caught, file restored): rows not kept visible while their scope is active (3/3 fail); toggle not reporting
`aria-expanded` (1/3 fail).

**Checks:** typecheck clean; lint 0 errors (23 existing warnings); guard-usage and pending-callers pass; unit 133 files / 1965
tests; integration 173 files / 2285 tests (isolated test database).

**Browser — 44/44 (`transition/transition-results.json`).** Same setup and owner path as above (registration, invitation and
onboarding in the browser; approval a **direct call**); **synthetic fixture** (two more plan-less students). The lost response is
real: the action request is let through, the server commits, then the browser's response is failed.

| Class | Count | What it covers |
|---|---|---|
| Real browser, 1280 px real window | 30 | EN light: default view (others hidden, toggle collapsed); lost after commit → "Outcome still unknown", the row still visible after the student passes check 4, typed values kept (form open, November, plan), focus on the outcome, Tab reaches "Reload again" then "I have checked…", one request; Enter on "I have checked…" → row hidden, the keyboard toggle shows the same form with its values. Normal success: row stays with "Saved.", form reset, one request; a fresh load hides it. ES dark: the same lost-after-commit transition |
| Emulated viewport | 12 | 390 px: the same transition; 390 and 320 px: no horizontal page scroll, the recovery row stays visible |
| Synthetic fixture | 1 | the fixture insert |
| Real browser + direct call | 1 | registration in the browser, approval by a direct call |

Screenshots in `transition/`: `20-default…`, `21-still-unknown-{en-light-1280,es-dark-1280,en-390-emulated}-row`,
`22-acknowledged-expanded…`, `23-success…`, `24-still-unknown-en-320-emulated`, and `25-assignments-section-default…`
(headless, after the run: every check-4 student assigned, the empty message and the toggle). Same limits as above: the dev
indicator is visible, element shots can crop a few pixels at the right edge, and contrast is judged visually. "Another owner
during recovery" is covered by integration test 2, not repeated in the browser.

## Findings during implementation

1. **Body `textContent` gives false positives.** The serialized client message payload is inside `<script>` tags, so a page-level
   `textContent` check found "Not ready" on a page that had actually redirected to onboarding. Every page-level check now uses
   rendered `innerText`, and the harness asserts that the screen itself loaded (no redirect).
2. **The "as of" time has minute resolution.** It cannot tell two refreshes within a minute apart, so the harness counts this
   route's RSC refresh responses instead.
3. **A test gap,** found by mutation S4 (above).
4. **`react/no-children-prop`** in the new tests: fixed.
5. **The registration rate limit (5 per IP per hour) refused the 5th browser registration** during harness development. That is
   the real guard working. It was not bypassed: the run waited for the window to pass, and no integration reseed (which truncates
   every table, including the attempt counter) was run in between.
6. **Focus after a field rejection:** a product defect, found by the browser and fixed (see Browser).

## Deviations from the plan

- **`MonthFields` is not exported.** It hard-codes `effectiveYear` / `effectiveMonth`, while drafts need `coverageYear` /
  `coverageMonth`. A small `MonthYearFields` in `form-fields.tsx` takes the names, and `dues-config-forms.tsx` is untouched.
- **The hook lives in `use-readiness-action.tsx`,** together with the client root and `ScopeStatus`; shared fields are in
  `form-fields.tsx`.
- **Focus after success, or a refresh after stale,** goes to the scope's outcome region (announced; it lives outside any form,
  so it survives a form that closes), not to the card heading.
- **The review and pricing controls have no hidden fields:** their FormData is built from the server-provided props. Unit tests
  pin the sent fields, and integration uses the same read-model binding.
- **Rejection messages state the documented result,** "Nothing was saved", which rev 2 allows for explicit rejections. The plan's
  unit check "no message key claims not saved" became "an unknown outcome never renders the saved or any rejection message".
- **`screen.ts` imports `latestEffective`,** so `dues-ledger-not-exposed` lists it (justified in the test).
