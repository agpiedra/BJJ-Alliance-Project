# Phase 4 — Student detail — correction implementation, verification

Real implementation of the corrected plan (`design/matroom/verification/phase4-student-detail-proposal/
README.md`). Verified against the actual running app (`pnpm dev`), not the static October reference — the
reference remains the approved direction this corrects toward, not evidence of this PR's own behavior.
Student-detail only; roster (list) is untouched (already corrected and merged, PR #124).

**Verification-correction round (this round): no production code changed.** `src/app/[locale]/(staff)/
students/[id]/page.tsx` is byte-for-byte the same as the prior commit on this branch. This round corrected
only the EVIDENCE: replaced a condensed/reconstructed Ledger harness with the complete actual page output,
added a real keyboard `Tab`-press session against it, reassessed row-height coupling against realistic
populated data (removing "accepted characteristic" wording — it was never accepted), and corrected this
document's own claims to match. See "Row-height coupling," "Real keyboard traversal," and "Ledger-active
verification" below for what changed in THIS round specifically.

## What changed

`src/app/[locale]/(staff)/students/[id]/page.tsx` only — every section stays a flat, DOM-order child of
`<main>`, nothing reordered:

1. `<main>` gains `lg:grid lg:grid-cols-[3fr_2fr] lg:items-start lg:gap-6` (below `lg`/1024px, unchanged
   `flex flex-col` single-column stacking).
2. Each of the 9 top-level sections gains an explicit `lg:col-start-N lg:row-start-N` (or `lg:col-span-2`),
   exactly per the plan's table. `PromocionesCard`, `RegenerateCodeButton`, and `AddAdjustmentForm` (which take
   no `className`) are each wrapped in a thin 1:1 positioning `<div>` — no subcomponent edited.
3. The Ledger section's `<>...</>` fragment (`StudentBalanceSummary` + `PaymentHistorySection`) becomes a
   `<div className="flex flex-col gap-6 lg:col-start-2 lg:row-start-4">` so it can carry a grid position — wraps
   only its own two already-DOM-adjacent children, not an artificial grouping of unrelated siblings.
4. **Added during verification, not in the original plan**: `lg:items-start` on `<main>`. See "Row-height
   coupling — reassessed with realistic populated data, not resolved, not accepted" below.

No subcomponent file is touched. No field, condition, role gate, branch restriction, financial state, or
workflow changed.

## Row-height coupling — reassessed with realistic populated data, not resolved, not accepted

**Correction round (this section rewritten)**: the previous wording called the residual gap below an "accepted
characteristic." That was wrong framing — it was never accepted, only disclosed as unfixed. This round
re-measured it against realistic populated data (not Patricia's original empty-Legacy/empty-Ledger case, and
not an invented extreme), using the complete real page output (see "Ledger-active verification" below) for a
student with: 9 attendance entries, 5 legacy payment-history rows, 3 promotion-history rows, and a real,
populated Ledger (3 settled months + 1 overdue). Full-page screenshots: 13 (light) / 14 (dark) at 1280px.

**Found live, measured in both directions — the gap is not confined to one row or one column**:

| Row | Left column (col 1) | Right column (col 2) | Row track height | Blank gap |
|---|---|---|---|---|
| 2 | Promotions — 912px | Profile — 411px | 912px | **501px** under Profile |
| 3 | Attendance — 945px | Legacy Payment History — 305px | 945px | **640px** under Legacy |
| 4 | RegenerateCode — 36px | Ledger (balance + 3 payment rows) — 384px | 384px | **348px** under RegenerateCode |

Every number above is `getBoundingClientRect().height` read directly from the live, real-CSS-rendered DOM, not
estimated. **This is materially poor**, not a minor cosmetic gap — in row 3 alone, 640px (more than half the
Attendance card's own height) renders as blank page background. A second, more extreme but realistic case (a
long-tenured student with 26 settled Ledger months, built specifically to produce the "Load more" control for
the keyboard test below) measured a **1594px** gap under RegenerateCode in row 4 (screenshot 17) — confirming
the coupling scales directly with how much content the taller column happens to carry, in either column,
unpredictably from one student to the next.

**`lg:items-start` (already applied, kept)** stops the literal stretching symptom: every card still renders at
its own natural height, top-aligned, never a broken-looking stretched empty box. Without it the numbers above
would be `align-items: stretch`'s default — e.g. Profile forced to 912px instead of its natural 411px. That
part of the original fix remains correct and necessary.

**What `items-start` does NOT fix — the row track itself**: CSS Grid sizes each row track to its tallest
member, by definition, whenever two unrelated columns of content share one explicit grid with per-child
`row-start` placement. This is not a bug in the implementation; it is the direct, structural consequence of
the technique chosen specifically to preserve DOM/reading/keyboard order. No CSS-only, single-grid,
DOM-order-preserving property closes this gap — it requires either letting one column's content flow
independently of the other's row boundaries (CSS `grid-template-rows: masonry`, currently Firefox-only
experimental, not viable here) or JavaScript-driven reflow/reordering (explicitly out of scope for this
layout-only phase).

**Smallest alternative identified, NOT implemented this round (reported per instruction, pending approval)**:
switch `<main>`'s row-pairing from "every section locked to an explicit `row-start`" to a sparser grid where
only the TWO always-present, always-comparable-size sections (header, gated block) keep explicit placement,
and the four content sections (Promotions/Profile/Attendance/Legacy+Ledger) move to two independent
`grid-auto-flow: column`-based sub-columns — i.e., accept that Profile may visually render adjacent to
Attendance instead of strictly beside Promotions. **Consequences, traced, not assumed**: this would still
preserve DOM order (no re-parenting, same flat children) and still require zero JavaScript, but it changes
which DOM-adjacent pairs end up visually side-by-side at `lg`, which changes the desktop keyboard-jump map
calculated in the plan (the "Keyboard-sequence analysis" table) and would need that table re-derived and
re-verified, not assumed to still hold. This is a real architecture change (a second grid axis), not a
one-line patch, so it is reported here, not implemented, pending explicit approval for a follow-up round.

## Expanded-form/collapsed-control correction — a plan inaccuracy found and corrected

**The original plan claimed** `EditStudentForm` was "confirmed not wrapped in a `<details>`," based on reading
only the first ~40 lines of `edit-student-form.tsx` (imports and the prop type, not its JSX return). **This was
wrong**, found live: `EditStudentForm` **is** a `<details>/<summary>Edit student</summary>` disclosure, same
pattern as `RecordPaymentForm`/`AddAdjustmentForm`. Confirmed via DOM query, not a screenshot artifact.

This does not affect the actual grid implementation at all — the gated block's outer `<div>` is full-width
(`lg:col-span-2`) regardless of what disclosure state its children default to, and that was verified directly
(§ below). It is disclosed here only because the plan's *stated reasoning* for keeping this block full-width
("a rich, always-expanded form") was factually inaccurate, and the correction standard this whole project has
followed all session requires naming that, not quietly leaving it uncorrected in the historical plan record.

## Real-browser verification (isolated test-DB environment)

`pnpm dev`, `DATABASE_URL` redirected to the isolated test DB (`alliance_bjj_test`, port 5433 — never the dev
database), logged in through the real `/login` form with the seeded `admin@alliancecr.com` (ADMIN) and
`instructor@test.com` (INSTRUCTOR) accounts, real desktop Chromium (Playwright).

| # | File | What it shows |
|---|---|---|
| 01 | `01-detail-1280-populated-light-en.png` | 1280px, light, EN, a real student (Patricia Elizondo, 20 attendance entries, 1 promotion) — grid structurally confirmed correct (see below); the row-height-coupling gap (above) is visible here, disclosed, not hidden. |
| 02 | `02-detail-390-populated-light-en.png` | 390px — single-column stack, DOM order preserved, no page overflow. |
| 03 | `03-detail-320-populated-light-en.png` | 320px — same, no page overflow. |
| 04 | `04-detail-1000-below-breakpoint-light-en.png` | 1000px (just below `lg`) — confirms the stacked fallback engages cleanly, no half-collapsed in-between state. |
| 05 | `05-detail-1280-expanded-edit-light-en.png` | `EditStudentForm` expanded — full-width (960.67px, measured, matching the full grid width), every field visible, not cramped. |
| 06 | `06-detail-1280-expanded-edit-error-light-en.png` | A real server-side validation error ("Guardian name and phone are required for students under 18.") — renders inline, full-width, legible. |
| 07 | `07-detail-1280-populated-dark-en.png` | Dark theme, live via the `dark` class — correct contrast/tokens, no stretched cards (confirms the `items-start` fix holds in dark theme too). |
| 08 | `08-detail-1280-populated-light-es.png` | Spanish locale — "Promociones"/"Historial de asistencia"/"Perfil"/etc. all translated, grid unaffected by locale. |
| 09 | `09-detail-1280-empty-light-en.png` | A genuinely new, empty student (real creation via the isolated test DB's own Create-student form) — "No promotions yet." / "No attendance recorded yet." / "No payment records yet." all render cleanly, no stretching (both columns naturally similar height when both are short). |
| 10 | `10-detail-1280-archived-light-en.png` | The same test student, real-archived via the real Archive action — "Archived" badge, `ArchivedStudentActions`' "Restore student" button, both in the full-width gated block. |
| 11 | `11-detail-1280-instructor-light-en.png` | INSTRUCTOR login, real session — no gated block at all (role gate intact); `RegenerateCodeButton`/`AddAdjustmentForm` still visible (ungated, as required). |
| 12 | `12-detail-ledger-harness-1280-light-en.HISTORICAL-condensed-reconstruction.png` | **Superseded this round, preserved as historical evidence, not deleted.** This was a condensed/reconstructed approximation of the Ledger wrapper's markup, not the complete actual page output — see the correction note in "Ledger-active verification" below. Replaced by 13–17. |
| 13 | `13-detail-full-harness-1280-populated-light-en.png` | **Complete actual `StudentDetailPage` output** (not reconstructed), `ledgerActive: true`, realistic populated data (9 attendance entries, 5 legacy payment rows, 3 promotions, a real 3-row Ledger history + overdue balance), injected into a live Chromium tab with real compiled CSS/fonts/theme/shell. Full page, 1280px, light. The row-height-coupling gaps (table above) are visible here, disclosed, not hidden. |
| 14 | `14-detail-full-harness-1280-populated-dark-en.png` | Same complete real extraction, dark theme. |
| 15 | `15-detail-full-harness-keyboard-ledger-to-regeneratecode-en.png` | Real `Tab` press from the Ledger section's "Load more" button (its one real focusable control) — lands on `RegenerateCode`, visible focus ring. See "Real keyboard traversal" below. |
| 16 | `16-detail-full-harness-keyboard-loadmore-focused-en.png` | The "before" state of the same real `Tab` press — "Load more" focused, visible focus ring, in the right column. |
| 17 | `17-detail-full-harness-1280-ledger-26-rows-light-en.png` | A second, more extreme but realistic fixture (26 settled Ledger months, built to genuinely produce the "Load more" control) — full page, showing the 1594px row-4 gap recorded in the table above. |

A real student creation and a real archive action were exercised in the isolated test DB during verification
(visible as "VerifyEmpty DetailTest" in screenshots 09–10) — harmless, isolated-test-DB-only data, left in
place.

### Grid structure, confirmed via computed style, not visual inspection alone

```
main: display: grid, grid-template-columns: 578.29px 373.71px (≈60/40, matching 3fr/2fr)
Header:      col span 2, row 1
Promotions:  col 1, row 2       Profile:              col 2, row 2
Attendance:  col 1, row 3       Legacy Payment Hist.:  col 2, row 3
RegenerateCode: col 1, row 4
AddAdjustment:  col 1, row 5
Gated block:    col span 2, row 6
```
Every value read directly from `getComputedStyle` on each of `<main>`'s real children — matches the plan's
table exactly, for every section.

### Breakpoint transition, measured exactly at 1024px

| Width | `display` | Page overflow |
|---|---|---|
| 1000px | `flex` | No (`scrollWidth` 985 ≤ `innerWidth` 1000) |
| 1024px | `grid` | No (`scrollWidth` 1009 ≤ `innerWidth` 1024) |
| 390px | `flex` | No (`scrollWidth` 375 ≤ `innerWidth` 390) |
| 320px | `flex` | No (`scrollWidth` 305 ≤ `innerWidth` 320) |

Clean switch exactly at the specified breakpoint, no overflow at any tested width, no half-collapsed state.

### DOM order, read directly, not assumed from the diff

```
["Patricia Elizondo...", "Promotions...", "Profile...", "Attendance history...",
 "Payment history...", "Regenerate code", "Add an attendance day...", "Edit student..."]
```
Exactly the required order: Header → Promotions → Profile → Attendance → Legacy → (Ledger, absent —
`ledgerActive=false`, the real production default) → RegenerateCode → AddAdjustment → gated block. Confirmed
identical at 1280px, 390px, and 320px — grid placement does not touch this.

### Real keyboard traversal — the actual desktop focus path, including the predicted jump

**Finding, better than the plan predicted**: for a student with an empty Legacy Payment History (the common
case — Patricia's legacy history is empty), Legacy contributes **zero focusable elements**, so `Tab` moves
directly from Attendance's last "Void this entry" control to `RegenerateCode` — both in the **same column**,
97px apart, no cross-column jump occurs at all in this common case. Measured via real `Tab` key presses, not
simulated focus:
```
Void this entry (y=428, x=309) → Tab → Regenerate code (y=525, x=280)
```
Continuing: `Regenerate code → Add an attendance day → Edit student → Record a payment → Archive student` — all
five steps monotonically increase in Y position, all left-aligned (x≈280–297) — a clean, straight-down sequence
through the collapsed-by-default disclosures, no jump, no ambiguity. Every stop showed a real, visible
`outline: solid 2px` focus ring (measured via `getComputedStyle`, not assumed).

**The plan's predicted "worst case" jump, now independently re-measured with real `Tab` presses (correction
round)**: the Ledger section's ONLY focusable control, ever, is `PaymentHistorySection`'s conditional "Load
more" button (`{cursor && <Button>Load more</Button>}` — it only renders when more than one page of ledger
payment history exists). With a real, realistic 3-row Ledger history (the common case for most students), that
button never renders, and the predicted jump does not occur — `Tab` from Attendance's last void control still
goes straight to `RegenerateCode`, same column, confirmed via DOM query (zero focusable elements inside the
Ledger wrapper). To genuinely exercise the predicted jump rather than report it as untestable, a second fixture
was built with 26 settled Ledger months (real data, same `recordDuesPayment` engine call used everywhere else
in this codebase — not simulated), which does render "Load more". Focused it directly, pressed a real `Tab`
key, and read `document.activeElement`:
```
Load more (x=888, y=813) → Tab → Regenerate code (x=280, y=532, after a real browser auto-scroll)
```
**Confirmed**: the jump is real — right column (x=888) to left column (x=280) — and it has a real, visible
`outline: solid 2px` focus ring on BOTH ends (screenshots 16 then 15). This is no longer a residual gap; it is
measured, both for the common case (no jump, Ledger has nothing focusable) and the less-common case (a
long-settled-history student, a real jump that Chromium's auto-scroll keeps from being visually confusing).

**Browser auto-scroll, a relevant observation**: when a Tab jump spans off-screen content, Chromium
automatically scrolls the newly-focused element into view — confirmed while tracing this sequence. This means
even a theoretically "distant" cross-column jump is not visually jarring to a real keyboard user the way raw
pixel-distance numbers alone might suggest; the browser's native behavior already mitigates it.

**No positive `tabindex`, no duplicate interactive components** — confirmed by reading the diff (§ "What
changed" above): the only additions are `className` values and plain positioning `<div>`s.

### Ledger-active verification — complete actual-page rendering, browser-tested harness evidence, explicitly separated from live-route evidence

**Correction round (this section rewritten)**: the previous round's screenshot 12 was a *condensed
reconstruction* — the Ledger wrapper's markup re-typed by hand with internal form fields abbreviated, not the
real page's own byte output. That was a correction gap, not a disclosed limitation — it is fixed this round.
Screenshot 12 is preserved, renamed `...HISTORICAL-condensed-reconstruction.png`, and superseded by 13–17 below.

**Labeled explicitly, per instruction — not claimed as live-route verification.** Production activation remains
`false` for every real organization today (`src/lib/dues/ledger/activation.ts`'s own documented seam, the same
structural limit the roster correction (PR #124) and the Payments phase both already hit and disclosed) — the
Ledger section cannot be reached by navigating any real production route in this codebase today. This does
**not** make the section unverifiable — it is verified below via the established harness technique, just not
via a live production URL.

**Method, this round**: the real `StudentDetailPage` component was rendered through the same `vi.mock`-swapped
`inactiveLedgerActivation` seam `student-detail-page-ledger-form-gating.test.ts` already established, via a
throwaway, uncommitted extraction script (`tests/integration/__scratch_full_detail_harness.test.ts` — never
committed, deleted before this PR's final commit), for a student with realistic populated data in every
section (9 attendance entries, 5 legacy payment-history rows, 3 promotion-history rows, and a real Ledger: 3
settled months via the real `createMonthlyObligation`/`recordDuesPayment` engine functions, plus 1 overdue
month). The **complete, real, unmodified HTML string** `renderToStaticMarkup` produced (52–68KB depending on
fixture size) was written to disk, copied into the running dev server's own `public/` directory (a temporary
file, removed immediately after use — never committed), fetched by the live browser tab's own `fetch()`, and
used to replace `document.querySelector('main').outerHTML` on a real, already-navigated `/students/[id]` page
— so every class, every real field value, every real history row, and every real control is exactly what
production would render, under the real compiled Tailwind CSS/fonts/theme/staff shell. Nothing was retyped,
abbreviated, or condensed.

Confirmed directly against the live DOM: the legacy "Record a payment" toggle is absent (`ledgerActive: true`
gates it off, matching the existing gating test); "Payment history" (legacy, 5 real rows) and "Current
balance" + "Ledger payment history" (3 real settled rows, real `$ 100.00` current balance) render as **three
separate, distinct cards**, never merged or interleaved, inside the Ledger wrapper's `lg:col-start-2
lg:row-start-4` cell, visually distinct, correctly positioned (screenshots 13 light / 14 dark).

**What this is**: real Chromium rendering of the complete, real `StudentDetailPage` output — every field,
control, and history length exactly as production would emit them — under real compiled CSS, PLUS a real
interactive `Tab`-key session against that same real markup (see "Real keyboard traversal" above, screenshots
15–16). **What this is still not**: a live production-route render (`ledgerActive` is hardcoded `false` for
every real organization today, by design — this is a structural fact about this codebase, not a verification
gap this PR can close) or a hydrated React session (no client-side event handler fired; every interaction
checked here — Tab order, focus-visible rendering, native `<details>`/checkbox semantics — is native browser
behavior that does not depend on React hydration, and is exactly what this round verified; a click-driven
state change, e.g. "Load more" actually fetching page 2, was not exercised and is not claimed). This
distinction is stated explicitly, not glossed over.

**Production billing was never activated** — both fixtures' obligations/payments were created via the same
test-only `activation: { isActive: async () => true }` dependency injection the existing, pre-merge
`student-detail-page-ledger-form-gating.test.ts` already uses, against the isolated test database only.

## Checks run

**Re-run this round** (no production code changed — see the note at the top of this document — so these
confirm nothing regressed, not that anything new needed covering):

- `pnpm typecheck` — clean (0 errors).
- `pnpm lint` — clean (0 errors; the same 23 pre-existing unrelated warnings as before this round).
- `pnpm test:unit` — 1707/1707 passed.
- `pnpm test:integration` — same counts as before this round, all passed, including:
  - `student-detail-page-ledger-form-gating.test.ts` — 2/2 unaffected (gating logic untouched).
  - `students-pages-inactive-baseline-comparison.test.ts` — **12/12**: the roster case (unchanged this round),
    the student-detail case restored to real byte-identity (below), and 10 guard tests (5 roster + 5 new
    detail) proving neither normalization can pass vacuously.

### The detail page's baseline-comparison test — reconciled narrowly, same discipline as the roster correction

`students-pages-inactive-baseline-comparison.test.ts`'s student-detail case previously asserted literal
byte-identity against the pre-PR2 baseline — true until this PR's approved, intentional grid-placement classes
and wrapper `<div>`s. A new `normalizeApprovedPhase4DetailDiffs()` function — anchored literal-string removal,
confirmed against this PR's own real rendered output (`pnpm exec vitest run`, inspecting the actual failure
diff before writing the normalization, not guessed) — strips exactly: `<main>`'s grid utility classes; the
header row's grid placement; `PromocionesCard`'s positioning wrapper (opening tag, and its closing tag anchored
to the unique string that always immediately follows it — the Profile `<Card>`'s own opening tag); the
Profile/Attendance/Legacy `<Card>`s' own grid-placement suffixes; the Ledger wrapper (defined by direct source
reading — not exercised by this file's always-inactive fixture, included for completeness, a safe no-op either
way); `RegenerateCodeButton`'s and `AddAdjustmentForm`'s positioning wrappers (same anchored-adjacency
technique); and the gated block's own grid-placement suffix. Both renders are then asserted byte-identical via
`.toBe()` — real equivalence restored over every field, every history row, every role-gated control.

**5 new guard tests** (`normalizeApprovedPhase4DetailDiffs — guard tests`, synthetic fixtures, no DB, fast)
prove this cannot pass vacuously: the approved diffs alone normalize to equal the baseline (the real, intended
case); a changed field value, a missing section, an unrelated markup addition, and a changed student name all
still fail equality after normalization. All pass.

## What was not verified — reported honestly, distinguished by status

**Resolved this round (previously listed here, now verified — kept for the record, not deleted):**
- ~~The row-height-coupling gap was an "accepted characteristic"~~ — corrected: it was never accepted. It is
  now measured precisely, in both directions, under realistic populated data (table in "Row-height coupling"
  above), with a named smallest alternative reported for approval, not silently left as "disclosed and done."
- ~~The keyboard jump from a populated Ledger section to RegenerateCode was not independently re-measured~~ —
  corrected: now measured with real `Tab` presses against a real focusable Ledger control (screenshots 15–16,
  "Real keyboard traversal" above).
- ~~The ledger-active harness was condensed/reconstructed markup, not the complete actual page output~~ —
  corrected: this round's harness is the complete, real `renderToStaticMarkup` output, unmodified.

**Still explicitly bounded, this round:**
- **The row-height-coupling gap itself remains unresolved** (distinct from the measurement above, which IS
  complete) — the smallest alternative identified requires a second grid axis and a re-derived keyboard map,
  reported for approval, not implemented this round.
- **The Approve-flow (PENDING student) layout was not independently re-verified live** — no PENDING student
  exists in the seed data without running the full registration-and-approval workflow, judged disproportionate
  for a layout-only check. It shares the exact same full-width gated-block container already confirmed working
  for Edit/RecordPayment/Archive — same code path, no additional risk identified, but not independently shown.
- **The "Load more" button's own click behavior (fetching page 2 of Ledger payment history) was not exercised**
  — this round's harness is static (non-hydrated) markup; Tab order and focus-visible rendering are native
  browser behavior proven by it, but `onClick`-driven state changes require React hydration, which this
  harness technique does not provide. Not claimed.

**Unchanged from every prior phase this session:**
- Real Android/iOS device verification remains unavailable in this environment.
- Cross-browser testing (Firefox/Safari) was not done — Chromium only.
- Screen-reader output was not captured directly (role/focus state confirmed via the accessibility-relevant DOM
  attributes and computed styles, not a live screen-reader transcript).
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed — no cause has been
  identified. It is reported here only because it is still open, not because it has been shown to be unrelated
  to this screen; no evidence either way has been gathered this round.

## Explicitly out of scope

Any other screen, shared-component changes (the `Card`/`PromocionesCard`/`EditStudentForm`/etc. source files are
all byte-for-byte unchanged), tenant-branding changes, database writes/cleanup outside the isolated test DB,
migrations, deployment, activation.
