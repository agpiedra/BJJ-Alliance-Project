# Dues stage 8 PR 8d-1 — the owner's read-only readiness screen — verification

**Base:** main `157d594e88df8d863dd79a54c87467e3e0d6f50c` (8a, 8b, 8c and the MONTHLY-total fix merged).
**Contract:** `docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md` (decisions U1–U3 recorded in §11), `docs/dues/STAGE-8-READINESS-BRIEF.md`
(§14 updated).

**Not changed:** no schema or migration, server action, form, scheduler, ledger charge, activation or existing financial writer.
The report's semantics and fingerprints are unchanged (`fingerprint.ts` untouched, format stays `r2`); the screen's report is
pinned equal to `getDuesReadinessForOwner`'s. The 8c actions (`opening-actions.ts`) are not imported by the screen; their forms,
the baseline action's UI and plan assignment belong to 8d-2, which is **not started**. O4 stays undecided, check 13 stays
decision pending and `ready` stays false.

## Decisions (owner, recorded)

1. **Entry:** an owner-only card with a link on Payments › Plans. No sidebar item.
2. **Money on this screen:** CRC omits cents only when they are zero and keeps nonzero cents exactly; USD always shows two
   decimals. Amounts are formatted from their decimal strings, never through a JavaScript `number`.
3. **Two PRs:** this read-only screen (8d-1) now; the interactive forms (8d-2) later.

## What was built

- **`src/app/[locale]/(staff)/payments/readiness/page.tsx`:** `requireTenantContext(["ADMIN"])` runs first, before `?s=` is
  parsed or any readiness data is read. A Director or Instructor gets a real 404. A malformed `?s=` shows the month picker with an
  error and loads no report. `dynamic = "force-dynamic"`. **No `loading.tsx`** (see Finding 1).
- **`…/readiness/readiness-view.tsx`:** server components only, no client JavaScript of its own:
  - `MonthPicker`: one `GET` form with a single `<select name="s">` (−6…+12 months around the default, plus the selected month)
    and a submit button;
  - `StatusAndChecks`: a "Not ready" banner with the snapshot time (stated as the time of the snapshot, with no claim that later
    writes are prevented); the 13 checks, each with a translated title and a status pill: **pass**, **fail**, **not available
    yet** (10–12) and **owner decision pending** (13, O4), so failing, unavailable and undecided are distinct; the listed items
    with links to the student; the brief §12 warnings and the O3 note;
  - `Totals`: monthly charges and opening debt in **two separate tables**, each per currency, with per-branch lists in
    `<details>`. Below 640 px each table becomes a stacked list (Finding 2);
  - `Students`: one card for each active student, each student with an active draft and each promo/exempt student. Each card
    shows the opening-review and pricing-acknowledgement state (missing, current or changed since review) and the active drafts
    with exact amounts and their linked legacy rows (month, translated status, amount).
- **`src/lib/dues/readiness/screen.ts`:** `getReadinessScreenForOwner(organizationId, candidate)`:
  - an invalid explicit month is refused first; then `authorizeOwner` (the same owner check as `getDuesReadinessForOwner`,
    with the existing `organization.accessRefused` audit for a non-member and `notFound` for a Director);
  - **one** `runReadOnlySnapshot` (REPEATABLE READ, READ ONLY) reads the database time, the readiness snapshot, the student
    names and the branches. The report and every displayed detail come from it;
  - it returns only what this screen shows: the report, the default month, `branchesDisagree`, `asOf`, branch names, student
    rows, active drafts, and **only** the legacy rows that the drafts link to. No form payload, binding or fingerprint input
    is returned.
- **`src/lib/dues/readiness/candidate.ts`** (pure): `isCandidateMonth` (moved from `index.ts`), `parseCandidateParam`
  (`^YYYY-MM$` and 2000–2100), `defaultCandidateMonth`.
- **`src/lib/dues/readiness/index.ts`:** the owner check extracted as `authorizeOwner`, with unchanged behaviour.
  **`evaluate.ts`:** `promoStudentIds` extracted, with unchanged behaviour (check 6 uses it; the screen uses it to choose cards).
- **`src/lib/payments/format-money.ts`:** `formatExactMoney(amount, currency, locale)`. It accepts only canonical
  `^(0|[1-9]\d*)\.\d{2}$` strings and throws `RangeError` otherwise. The integer part is grouped by `Intl.NumberFormat` on a
  `BigInt`; the decimal separator comes from the same locale (`en-US` / `es-CR`, as `formatMoney`). `formatMoney` is unchanged.
- **Payments › Plans:** an owner-only card linking to the screen.
- **Messages:** `payments.plans.readinessLink` and `payments.readiness.*` in EN and ES (141 added lines each, 0 deleted; the
  parity test passes).

### The default start month (documented rule)

D15 says the start is the 1st of the **next** month. For each branch, `nextMonthIn(branch timezone, now)` is used (the existing
rule; never the server's zone). Branches disagree only around a month boundary (one still in M, another already in M+1). The
**latest** result is used, so the default is a month that has not begun in any branch, and the screen says that branches
disagree. With no branches, UTC is used. `now` is the snapshot's own database time.

## Verification

| Requirement | Evidence | Result |
|---|---|---|
| Owner check before any data | integration: the page gives a real 404 for a Director, with **0** snapshot calls; positive control for the owner. Mutation A2 | pass |
| Read model refuses on its own | integration: Director and another organization's owner → `notFound`, no snapshot; `organization.accessRefused` audit row written. Mutation A1 | pass |
| Exact 404 over HTTP | smoke: `/en/payments/readiness` is exactly 404 for DIRECTOR and INSTRUCTOR | pass |
| Organization isolation | integration: another organization's students, drafts and totals never appear | pass |
| One snapshot | integration: a rename and a new draft committed mid-load are both invisible; the next load shows both. Mutation S1 | pass |
| Report unchanged | integration: equals `getDuesReadinessForOwner` for the same month (checks, fingerprints, totals) | pass |
| Exact money | unit: cents kept; ES separators; `199,999,999.98`, `100,000,000.03`, `90,071,992,547,409.93` exact; bad input refused. Integration: opening total `100000000.49`, monthly `199999999.98`. Mutation F1 | pass |
| `?s=` validation and default | unit: format, range, branch-timezone default, boundary disagreement (latest), year rollover, UTC fallback. Integration: default from the snapshot. Mutations C1, C2 | pass |
| Confirmation states | integration: a review recorded through the real 8c core shows current, then changed after a later draft | pass |
| Writes nothing | integration: no financial, readiness or audit row changes on an authorized load | pass |
| Stale review worded historically (Finding 5) | integration, rendered: the real `Students` component over the real screen read model, with the real EN and ES messages. (1) review over a draft → the draft is replaced through `replaceOpeningDraftCore` → stale, only the replacement is shown, and the declaration line is the recorded time plus "At that review: opening debt declared." with no amount or note of any draft. (2) "no opening debt" review → a draft is added → stale, the new draft is shown, and the line says "At that review: no opening debt declared." The superseded wording appears in neither locale. Mutations W1–W3 | pass |
| Not exposed beyond the screen | unit (`dues-readiness-not-exposed`): only the page and view import from the folder; they import only `screen`, `candidate`, `evaluate`; no `opening-actions`, `method="post"`, `formAction` or `action={` | pass |
| Browser | 82/82 checks, `browser-results.json` (below) | pass |

### Mutations (each run, caught, then restored and verified with `cmp`)

| Id | Mutation | Caught by |
|---|---|---|
| C1 | default uses the earliest branch month | unit (boundary disagreement) |
| C2 | `?s=2026-1` accepted | unit (format) |
| F1 | `formatExactMoney` falls back to the number-based `formatMoney` | unit: 3 tests fail |
| A1 | the read model skips `authorizeOwner` | integration: refusal test fails |
| A2 | the page admits DIRECTOR | integration: page 404 test fails |
| S1 | student names read outside the snapshot transaction | integration: one-snapshot test fails |
| W1 | EN "opening debt declared" line also says "Declared: the items shown" | integration: replacement test fails |
| W2 | ES "no opening debt" line back to "Declarado: sin deuda inicial" | integration: no-debt test fails |
| W3 | the declaration line includes a current draft's amount | integration: replacement test fails |

### Browser (synthetic data, isolated test database)

The Playwright-core harness (Chrome channel, headless) ran against `next dev` on port 3100. It logged in through the real login
form as a fixture owner. Results are in `browser-results.json` (82 checks, 0 failed).

- **Matrix:** EN/ES × light/dark × 1280/390/320 px, on the populated organization. Each run checks:
  - no horizontal page scroll; the theme is applied; no activation control;
  - the expected text is present: exact amounts such as `₡ 199,999,999.98`, `₡ 25,000.50`, `₡ 0.51` and `$ 85.50`; the
    not-ready banner; the current and changed states; "not available yet"; "owner decision pending"; and a long name
    (`María de los Ángeles …`);
  - legacy payment statuses are translated;
  - the GET month form is the only form.
- **Keyboard:** Tab reaches the month select with a visible focus ring; the button follows it with a visible ring; Enter submits
  and changes `?s=`; the branch `<details>` opens with Enter.
- **States:** invalid `?s=2026-13` shows the error and no report; no `?s=` selects the default; Payments › Plans shows the owner
  link; the empty organization shows the empty states in EN and ES.
- **Screenshots:**
  - full pages: `populated-en-light-1280.png`, `populated-es-dark-1280.png`, `populated-en-dark-390.png`;
  - 320 px crops: `crop-status-en-light-320.png`, `crop-student-en-light-320.png`, `crop-totals-es-dark-320.png`,
    `crop-checks-es-dark-320.png`;
  - other states: `invalid-month-en-390.png`, `keyboard-after-submit-en-1280.png`, `empty-en-1280.png`, `empty-es-1280.png`.
- **Superseded wording in screenshots (Finding 5):** `crop-student-en-light-320.png`, `populated-en-light-1280.png`,
  `populated-es-dark-1280.png` and `populated-en-dark-390.png` were taken before the correction. They still show
  "Declared: the items shown" / "Declarado: los ítems mostrados" next to a stale review, and so display the defect itself. They
  were **not retaken**: the synthetic browser fixture was removed when the integration suite reseeded the test database. The
  corrected wording is proven by the rendered integration test only, not by a browser screenshot. The other screenshots show
  no student card.

### Commands

- `pnpm typecheck`: clean. `pnpm lint`: 0 errors; no warning in a changed file.
- `pnpm check:guard-usage`, `pnpm check:pending-callers`: pass.
- `pnpm test:unit`: 132 files, 1952 tests passed.
- `pnpm test:integration`: 170 files, 2260 tests passed at the first PR head (`87364dd`). After the Finding 5 correction:
  170 files, 2262 tests passed (the screen file now has 12).
- Smoke (`tests/smoke/page-routes.test.ts`): 23/23, run warm (see gaps).
- No schema change, so no drift run is relevant.

## Findings during implementation (found and fixed before the PR)

1. **`loading.tsx` broke the exact 404.** A route-level loading boundary made streaming commit a `200` before `notFound()` ran,
   so a Director got a 200 with a not-found body. The smoke status assertion caught it, and the file was removed. This
   assertion was added during this work, after the defect was first seen.
2. **At 320 px the Total column was hidden** inside the table's horizontal scroll. A stacked list now replaces the table below
   640 px.
3. **Raw `PENDING` / `PAID` codes** were shown for linked legacy rows. They are now translated through `students.paymentStatus`.
4. **The browser activation probe was vacuous for a time.** `/activ/i` matched "Iván Inactivo", and a later edit dropped the
   backslash from the corrected pattern. It is now `/\bactiva(te|tion|r|ción)/i` and was re-run.

5. **The opening-review declaration was worded as if it covered the drafts on screen** (found in review after the PR opened).
   "Declared: the items shown" was shown for both current and stale confirmations, while the drafts listed are the
   **current** active ones. After a replacement, it claimed the earlier review covered the replacement. The line now states
   only what the confirmation records: "At that review: opening debt declared." / "At that review: no opening debt declared."
   (ES: "En esa revisión: se declaró deuda inicial." / "En esa revisión: no se declaró deuda inicial."). The current/stale
   badge, recorded time and current drafts are unchanged. Historical draft contents are not reconstructed or displayed.
   Fingerprints, confirmation validity, actions, schema and financial behaviour are unchanged.

## Deviations from the plan

- **The default month uses the latest branch month, not the earliest.** With the earliest, the default could be a month already
  under way in another branch.
- **No `loading.tsx`** (Finding 1).
- **The month picker is a `<select name="s">`** in a GET form, not separate year and month fields, so there is no `MonthFields`
  export.
- **The planned view files (`readiness-checks.tsx` and others) are one file, `readiness-view.tsx`.**
- **The pure helpers live in `candidate.ts`,** so unit tests import them without a database.

## Gaps and labels (honest limits)

- **All screen data is synthetic,** in the isolated test database. No normal-dev or production data was read or written.
- **The fixture owners came from the real `registerOrganization` → `approveOrganization` → `acceptInvitation` functions,**
  called directly from a test script, not through the browser UI. The super-admin approver, branches, plans, students,
  history and legacy rows were inserted directly.
- **Onboarding was completed by SQL** for the fixture organizations (`onboardingCompletedAt` set), not through the onboarding UI.
  This is a shortcut, so the staff layout does not redirect the owners to `/onboarding`.
- **So this evidence does not prove the browser registration, approval, acceptance or onboarding workflow.** It proves only
  that an owner created by those server functions can log in through the real login form and use this screen.
- **Viewports are emulated** (`newContext({ viewport })`). A real Chrome window on this Windows machine cannot go below about
  500 px, so 390 and 320 px were not verified in a real window.
- **The screenshots show the Next.js dev indicator** ("N") at the bottom left.
- **Smoke was run warm.** A cold run timed out locally on first compilation, before the readiness routes moved into their own
  test. A cache clear was not done, so CI is the cold run.
- **Contrast is checked visually** in the screenshots, not measured.
- **The Finding 5 regression renders the `Students` component, not the whole page.** The page tree contains async server
  components that `react-dom/server` cannot render in a test. The component, read model and messages are the real ones; the
  page only passes the same `screen` and `locale` to it.
- **The fixture password is only in a scratch file outside the repository** and is not committed.
