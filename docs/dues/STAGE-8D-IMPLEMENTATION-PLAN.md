# Stage 8 PR 8d — implementation plan (the owner readiness screen)

**Status:** the owner decided U1–U3 (recorded in §11). **8d-1 (the read-only screen): PR #150, merged as `2bfd794`; complete in code only.** Stage 8d is incomplete until 8d-2
lands; its plan is `docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md`. Evidence and deviations: `design/matroom/verification/dues-stage8d-screen/README.md`. 8d-2 (the interactive forms) is
not started.
**Base:** `main` @ `157d594e88df8d863dd79a54c87467e3e0d6f50c`. 8a, 8b and 8c are merged, as is the MONTHLY-total fix. 8b's
migrations are applied only to isolated test databases.
**Contract:**
- `docs/dues/STAGE-8-READINESS-BRIEF.md` (§10–§15);
- the 8a–8c code in `src/lib/dues/readiness/`;
- the 8c action contracts (`docs/dues/STAGE-8C-IMPLEMENTATION-PLAN.md` rev 2).

**In scope:** one owner-only screen that shows the readiness report for a candidate start month S and drives the
existing actions:
- the status-history baseline;
- plan assignment;
- opening-debt drafts;
- opening reviews;
- pricing acknowledgements.

**Not in scope:**
- an activation button, an "activate" wording or any implication that readiness makes activation available;
- bulk assignment (8e);
- scheduling, ledger charges, schema or migration changes;
- any change to a financial writer, or to the meaning of any check.

**Stays fixed:**
- `ready` stays false: checks 10–12 are not implemented and 13 is decision pending;
- O4 stays undecided.

Every fact below about current code was checked on `157d594` (file:line).

---

## 1. What exists, and what is missing

| Capability | State on `157d594` |
|---|---|
| Owner page gate | `requireTenantContext(["ADMIN"])` (`src/lib/tenant/context.ts:242`). A staff member without the role gets a real `notFound()` (:263); a non-member is redirected to the tenant pages |
| Owner nav gate | `NAV_ITEMS` with `visible: (c) => c.organizationRole === "ADMIN"` (`src/components/staff-sidebar/nav-items.ts:78`); `tests/unit/nav-items.test.ts` pins every role's list |
| Readiness report | `getDuesReadinessForOwner(org, S)` (`readiness/index.ts:34`): owner-only, one REPEATABLE READ, READ ONLY snapshot. It returns **ids only**: checks, warnings, preview (students, branches, MONTHLY `wouldCreate`), fingerprints, confirmations, `openingDrafts` |
| The five 8c actions | `opening-actions.ts`: `(org, prev, FormData) → ActionState`. Error codes are `notFound`, `invalid` (+`fieldErrors`), `stale` and `monthHasDraft`. **No `revalidatePath`** |
| Baseline | `runStatusHistoryBaseline(org, prev, fd)` (`src/lib/students/baseline-action.ts:21`, `"use server"`): owner-only. It writes one `BASELINE` row dated **today in the branch timezone** (:45) for each student with no status row. **No UI and no `revalidatePath`** |
| Plan assignment | `assignPlan` / `correctAssignment` (`src/lib/dues/assignment-actions.ts:64,116`): owner-only. **No UI anywhere**: plans are picked only at student creation or approval. No `revalidatePath` |
| Form patterns | `useDuesAction` (`payments/plans/dues-config-forms.tsx:27-41`: keeps typed values on refusal), `Outcome` (`role="alert"` / `role="status"`, :124-140), `aria-invalid` from `fieldErrors` (:170), and a special `stale` recovery UI (`exchange-rate-forms.tsx:214-237`) |
| Month input | `MonthFields` (a month select plus a year field, `dues-config-forms.tsx:101`), **not exported**; `formatMonthYear` (`src/lib/format-month.ts:24`) |
| Money display | `formatMoney(amount: number, currency, locale)` (`src/lib/payments/format-money.ts:33`). **CRC is shown with 0 decimals** |
| Components | `src/components/ui/`: button, card, badge, pill, alert-dialog, data-table, empty-state, skeleton, input (`FIELD_CLASS`), tooltip. Native `<select>`; native `<details>` disclosures |
| Theme | class strategy, `.dark` on `<html>` (`globals.css:7`); tokens in `design/matroom/tokens.css` |
| i18n | `messages/en.json` and `es.json`; parity is enforced by `tests/unit/messages-key-parity.test.ts` |
| Smoke routes | hand-written list, `tests/smoke/page-routes.test.ts:194+` |
| Exposure guard | `tests/unit/dues-readiness-not-exposed.test.ts:24-30` forbids any importer of `dues/readiness` outside that folder "until the owner screen (PR 8d) deliberately updates this test" |
| `loading.tsx` | none exists in `src/app` today |

### Missing capability (explicit, not silently added)

**M1. A read model for the screen.** The report carries ids, not:
- student, branch or plan **names**;
- the **contents of active drafts**, which the replace and withdraw forms need;
- each student's **legacy rows**, which the link picker and the paid-month display need;
- the plans and terms that the assignment form may offer.

It also carries no per-student **bindings** ready to submit.

**Proposal:** one new read function, `getReadinessScreenForOwner(organizationId, S)`, in
`src/lib/dues/readiness/screen.ts`:
- **Not a server action:** it is not `"use server"`.
- **Same gate as the report:** owner-only, with `FORBIDDEN` mapped to `notFound`.
- **Inside one `runReadOnlySnapshot`:** it loads `loadReadinessSnapshot(tx, org)`, then **one** extra read in the same
  snapshot for display names (students' names, branch names, plan names).
- **What it returns:**
  - the unchanged `evaluateReadiness(snapshot, S)` report;
  - per student, `{ name, branchName, openingBinding, pricingBinding, activeDrafts (content), legacyRows (id, year, month,
    status, amount, currency) }`, built from **the same snapshot**;
  - per branch, the offerable monthly plans.

**Why the bindings come from that same snapshot:** a review submitted from the page attests exactly the content the
page showed. The 8c action recomputes the binding under the student lock and refuses with `stale` on any difference.

`getDuesReadinessForOwner` stays as it is.

No schema change, writer change or new dependency.

## 2. Route, navigation and access

- **Route:** `src/app/[locale]/(staff)/payments/readiness/page.tsx` (server component).
  - **First line:** `const context = await requireTenantContext(["ADMIN"])`. Directors and Instructors get `notFound()`,
    and a non-member is redirected, exactly as for `admin/staff`.
  - **Data:** then `getReadinessScreenForOwner(context.organizationId, S)`, which repeats the owner check.
- **Entry point:** an owner-only link from `payments/plans/page.tsx`, in its existing `isOwner` section (:133-175). This
  mirrors how Plans itself is reached from Payments. **No sidebar item** (decision U1).
- **Guards updated deliberately:**
  - `dues-readiness-not-exposed.test.ts` allows exactly the named 8d files (page plus client components) as importers;
  - `scripts/pending-callers.ts` drops the six readiness entries, because they now have callers;
  - `tests/unit/tenant-gate-has-no-default.test.ts` passes as is (explicit role array).

## 3. Candidate start month (S)

- **Carried in the URL:** `?s=YYYY-MM`. The page is linkable and reloadable, and each month change is a fresh server
  render.
- **Picker:** a GET `<form>` reusing `MonthFields`. One change exports it from `dues-config-forms.tsx`, with no behaviour
  change. It works without JavaScript.
- **Default when `s` is absent:** the month after the current month, in the timezone of each branch with active
  students. If branches disagree (only at a month boundary), the earliest is used and the screen says so. This is D15:
  start on the 1st of the next month.
- **Invalid `s`** (not a calendar month in 2000–2100): an inline error and the picker. The report is not loaded. This is
  the same rule as `isCandidateMonth`.
- **Every confirmation is for the selected S.** Changing S changes what is current. The screen states: "Reviews and
  acknowledgements are recorded for this start month only."

## 4. Layout

The screen has four sections, top to bottom. Every list is grouped by branch, then student.

1. **Status.**
   - **A permanent "Not ready" banner.** Its text: "This report never activates the ledger. Activation is a separate,
     later stage, not built yet."
   - **"As of" time.** "Showing data as of {time}. Changes made after this moment are not shown until you reload; a
     review you submit is checked again against the current data and refused if anything changed." This does **not**
     claim the snapshot prevents later changes.
   - **The 13 checks,** each with its status:
     - `pass`, `fail` with the affected rows named (student and branch names, linked to `/students/[id]`);
     - `notImplemented`, worded "Not available yet: {why}" (10–12);
     - `decisionPending`, worded "Waiting for an owner decision: prepaid-payment reversal (O4)" (13).
   - **Check wording:** translated by `check.key`, never from the English `detail` string.
   - **Warnings:** listed separately, as not blocking.
   - **Note O3:** "Pre-switch signup debt is excluded, not waived."
2. **Totals by branch and currency.** Two clearly separated tables, never added together and never summed across
   currencies:
   - "Monthly charges S would create": `preview.branches[].wouldCreate`, plus the lists of undecidable, not-eligible,
     explicit no-plan, unassigned and configuration-gap students;
   - "Opening debt drafted": `openingDrafts`. The label says these are drafts, not charges.
3. **Before S: status baseline and plan assignments.**
   - **Baseline:** shows checks 1 and 2 by name.
     - It offers "Take status baseline" (`runStatusHistoryBaseline`), behind an AlertDialog explaining that the baseline
       writes one row dated **today** for each student with no status row, and changes nothing else.
     - **When today is on or after the 1st of S:** the dialog says the baseline **cannot** fix check 1 for this S, and
       suggests a later S (brief scenario 2).
     - **Result:** `ok` reports `count` students.
   - **Assignments:** check 4's students, each with:
     - an "Assign plan" form (`assignPlan`): the student's branch's monthly plans, or an explicit "No plan", from an
       effective month defaulting to S;
     - for a strictly future assignment, "Correct" (`correctAssignment`) with its revision token computed server-side.
     - A past or current month refused by the action is shown as its error.
4. **Students** (one card per relevant student: U1 of 8c, so currently ACTIVE students plus anyone with a draft; plus
   promo/exempt students). Each card shows:
   - name, branch and current status;
   - the **opening review** state, and the **pricing acknowledgement** state for promo/exempt students: `missing`,
     `current` (valid) or `changed since review` (stale), with sequence and `confirmedAt` for display only;
   - **active drafts:** month, amount (exact; §6), currency, note, and the linked legacy row with its status. Each has
     **Replace** (prefilled form) and **Withdraw** (AlertDialog with a required reason);
   - **Add opening debt:** month, amount (text, `1234.50`, no separators), currency (**no default**: the owner must
     choose), note (required), and an optional legacy link (that student's legacy rows, labelled month, status, amount).
     Paid months are flagged; a draft over a PAID month without a link shows check 7's failure after saving;
   - **Opening review:**
     - with **zero** active drafts, one button: "Confirm: no opening debt before {S}" (`declaration=noOpeningDebt`);
     - otherwise, "Confirm: the opening debt is exactly the {n} items above" (`itemsAsShown`);
     - the hidden `binding` comes from the server.
   - **Pricing acknowledgement** (promo/exempt students only): the student's legacy promo or exempt rows, the plan, and
     the price and currency S would charge (from the preview), with "Acknowledge pricing from {S}". It explains that a
     price or policy change on the branch makes it stale.

## 5. Actions, refresh and stale submissions

- **One small client hook,** `useReadinessAction(action)`, in the readiness components. It follows `useDuesAction`:
  `useTransition` plus `FormData`, typed values kept on refusal, `aria-busy` and disabled while pending.
  - **On `ok`:** reset the form and call `router.refresh()`. The server component re-runs, so the whole report,
    including every confirmation state and total, is recomputed from a fresh snapshot.
  - **Why `router.refresh()`:** none of the reused actions calls `revalidatePath`. Refreshing from the client means
    **no action file changes**, including the baseline and assignment actions, which are outside readiness. This is an
    existing pattern (`payments-table.tsx:160`).
- **Errors:** mapped through a fixed map from code to message key, in the `financial-corrections-section.tsx:119-142`
  style, with an `unexpected` fallback. Each renders in `Outcome` (`role="alert"`) next to its form, and `fieldErrors`
  set `aria-invalid` on the fields.
- **`stale`:** the message is "This changed after the page was loaded (another change, or someone else). Nothing was
  saved. The page has been refreshed: review it again before confirming."
  - The hook calls `router.refresh()` and never resubmits automatically.
  - The new binding is in the refreshed page, so the owner must **look again and press again**. That is the renewed
    review. The same applies to a declaration mismatch (`invalid`, `declaration`).
- **`monthHasDraft`:** "There is already an opening item for that month. Replace it instead."
- **`notFound`:** "This item is no longer available." Then refresh.
- **Thrown errors** (a 500 from an action): a generic failure message, and nothing is assumed saved. A refresh shows the
  truth.
- **What the screen does not claim:** that the displayed data is current or locked. Every action is decided against the
  database at submit time, which is what 8c guarantees.

## 6. Money display (no rounding, no cross-currency sums)

- **Why not `formatMoney`:** report totals and draft amounts are exact decimal strings, and totals may exceed one
  column's range (the #149 fix). `formatMoney` takes a JavaScript `number` and shows **CRC with 0 decimals**, which would
  round ₡25,000.50 to ₡25,001 or hide cents.
- **Proposal:** a small string formatter, `formatExactMoney(decimalString, currency, locale)`, in `format-money.ts`. It
  groups the integer digits by string with the locale's group separator, keeps the decimals exactly as given, and uses
  the existing `currencySymbol`. No floating point is involved.
  - **CRC:** show the decimals only when they are not `.00`. This is decision U2.
  - **USD:** always 2 decimals.
- Used only by the readiness screen. Existing screens are unchanged.

## 7. States

| State | Behaviour |
|---|---|
| Loading | `payments/readiness/loading.tsx` with `Skeleton` blocks shaped like the four sections (the first `loading.tsx` in the app). The month form shows a pending state while navigating |
| Invalid `s` | inline error and picker; no report |
| No branches or students | `EmptyState`: "No students yet. Readiness is computed for active students." |
| No drafts, or no promo students | the respective section says so plainly ("No opening debt drafted for this student") |
| Validation | `fieldErrors` → `aria-invalid` and a message under the field; typed values are kept |
| Stale | §5 |
| Action failure | a generic message, with a refresh offered |
| Report failure (a thrown loader) | the route's error boundary (Next.js default) |
| Director or non-member | `notFound()` or the tenant redirect, before any data is read |

## 8. Files (bounded)

| File | Change |
|---|---|
| `src/lib/dues/readiness/screen.ts` | **new**: `getReadinessScreenForOwner` (M1). Read-only, owner-only, one snapshot |
| `src/app/[locale]/(staff)/payments/readiness/page.tsx` | **new**: server page |
| `…/payments/readiness/loading.tsx` | **new** |
| `…/payments/readiness/readiness-checks.tsx` | **new**: server component (status, checks, warnings, notes) |
| `…/payments/readiness/readiness-totals.tsx` | **new**: server component (both total tables) |
| `…/payments/readiness/student-readiness-card.tsx` | **new**: client (drafts, review, acknowledgement) |
| `…/payments/readiness/before-start-panel.tsx` | **new**: client (baseline, assignments) |
| `…/payments/readiness/use-readiness-action.ts` | **new**: client hook (§5) |
| `…/payments/plans/page.tsx` | owner-only link to the screen |
| `…/payments/plans/dues-config-forms.tsx` | `export` on `MonthFields` (no behaviour change) |
| `src/lib/payments/format-money.ts` | `formatExactMoney` (§6) |
| `messages/en.json`, `messages/es.json` | `payments.readiness.*` |
| `tests/unit/dues-readiness-not-exposed.test.ts` | allow exactly the 8d files as importers |
| `scripts/pending-callers.ts` | remove the six readiness entries |
| `tests/smoke/page-routes.test.ts` | add `/en/payments/readiness` and `?s=` variants to the ADMIN list; non-owner expectations |
| `tests/unit/…`, `tests/integration/…`, `tests/browser/…` | §10 |
| `docs/dues/STAGE-8-READINESS-BRIEF.md` | §14 status |
| `design/matroom/verification/dues-stage8d-screen/README.md` | evidence |

**Not touched:**
- every action file (`opening-actions.ts`, `opening-core.ts`, `baseline-action.ts`, `assignment-actions.ts`);
- `evaluate.ts`, `snapshot.ts`, `fingerprint.ts`;
- the schema and every financial writer;
- the sidebar.

## 9. Implementation sequence

Proposed as **two PRs** (decision U3), each independently reviewable:

**8d-1, read-only screen:**
1. Write the M1 tests (red), then `screen.ts`.
2. Page and gate.
3. Month picker.
4. Checks, warnings and notes.
5. Both total tables.
6. Student cards, showing states only, with no forms.
7. Loading, empty and invalid states.
8. Messages in EN and ES.
9. Smoke route and exposure-guard updates.
10. Browser pass.

**8d-2, interactive:**
1. The hook and the error map.
2. Draft create, replace and withdraw.
3. Opening review and pricing acknowledgement, with the stale flow.
4. Baseline and assignment panel.
5. The `pending-callers` cleanup.
6. Integration tests through the page's real form fields.
7. Browser pass with a registered owner.

If kept as one PR, the same order applies, as commits.

## 10. Acceptance matrix

**Evidence already obtained (8a–8c, on isolated test databases):**
- the report's computations;
- the action contracts (authorization, stale, atomicity, constrained pools);
- the exposure guards.

**Nothing in this table is obtained yet.** Every row is proposed.

| Area | Proposed check | Kind |
|---|---|---|
| Owner access | an owner sees the screen | integration (page component, `forged-claim-server-components` pattern) |
| Director / Instructor | `notFound` | integration |
| Non-member | the tenant redirect, no data read | integration |
| Other organization's ids in forms | `notFound` (the 8c contract, through the page's real fields) | integration |
| M1 read model | names and bindings come from the same snapshot; a binding from the screen is accepted by `recordOpeningReview` / `acknowledgePricing` unchanged; after any change the old binding returns `stale` | integration |
| No cross-currency sums | totals per branch and currency only; MONTHLY and opening tables separate | unit (formatter) plus browser |
| Large totals | 199,999,999.98 USD and ₡100,000,000.03 render exactly, with no overflow of the layout | unit plus browser |
| Exact amounts | ₡25,000.50 is not rounded; USD keeps 2 decimals | unit |
| `ready` false | the "Not ready" banner is always present; no activation control exists (DOM assertion: no button or link containing "activ") | integration plus browser |
| Unavailable checks | 10–12 "Not available yet", 13 "Waiting for an owner decision (O4)" | integration |
| Stale submission | change content after load (a real legacy edit) → submit → "changed" message, page refreshed, nothing saved, the new binding requires a new press | browser (real form) plus integration |
| Refresh after success | after each of the seven actions, the affected state, check and total update without a manual reload | browser |
| EN / ES | every string from `payments.readiness.*`; the parity test; ES screenshots | unit plus browser |
| Light / dark | contrast of the status colours (pass, fail, stale, missing) in both themes | browser screenshots |
| Keyboard | every form, dialog and disclosure reachable and operable by keyboard; focus returns after a dialog; visible focus ring | browser |
| Narrow screens | 390×844 with no horizontal page scroll (tables scroll inside their own container) | browser (real window, not emulated, per the viewport note) |
| Coarse pointer | targets of at least 44 px under a coarse pointer (`touch-targets` method) | browser |
| Long names | an 80-character student, branch and plan name wraps without overlap | browser |
| No financial effect | ledger and `PaymentPeriod` counts unchanged across a full screen session | integration |
| Smoke | `/en/payments/readiness` and `?s=` variants return < 500 for an owner | smoke |

**Browser evidence rule:** every browser row is run as an owner **created through register, approve and accept**, not a
seeded account, in a real window. Each is reported as obtained only after it runs.

## 11. Decisions

**U1. How the owner reaches the screen.**
- **Recommended:** a link from Payments › Plans (owner-only section). No sidebar change, because this is a pre-activation
  tool.
- **Alternative:** an owner-only sidebar item, which updates `nav-items.ts` and its test.

**U2. CRC display precision on this screen.**
- **The conflict:** the app shows CRC with 0 decimals (`formatMoney`), but opening amounts and totals can carry cents.
- **Recommended:** show CRC cents only when they are not zero, so nothing is rounded.
- **Alternative:** always show 2 decimals for both currencies on this screen.

**U3. One PR or two.**
- **Recommended:** two (8d-1 read-only, 8d-2 interactive).

**Owner decisions (recorded):**
- **U1:** as recommended. An owner-only link from Payments › Plans; no sidebar item.
- **U2:** as recommended. CRC omits cents only when they are zero and keeps nonzero cents exactly. USD always shows two
  decimals. Decimal strings are formatted without converting the amount to a JavaScript number.
- **U3:** two PRs. 8d-1 (the read-only screen) first; 8d-2 (the interactive forms) later.

Nothing else is open:
- M1 is a missing read capability, proposed explicitly in §1;
- refresh by `router.refresh()` is a technical choice, stated in §5;
- O4 stays undecided and check 13 stays decision pending.
