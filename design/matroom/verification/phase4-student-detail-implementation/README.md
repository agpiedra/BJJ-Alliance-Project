# Phase 4 — Student detail — correction implementation, verification

Real implementation of the corrected plan (`design/matroom/verification/phase4-student-detail-proposal/
README.md`). Verified against the actual running app (`pnpm dev`), not the static October reference — the
reference remains the approved direction this corrects toward, not evidence of this PR's own behavior.
Student-detail only; roster (list) is untouched (already corrected and merged, PR #124).

**Verification-correction rounds (two so far): no production code changed.** `src/app/[locale]/(staff)/
students/[id]/page.tsx` is byte-for-byte the same as the original implementation commit on this branch. Round 2
corrected the EVIDENCE: replaced a condensed/reconstructed Ledger harness with the complete actual page output,
added a real keyboard `Tab`-press session against it, reassessed row-height coupling against realistic
populated data (removing "accepted characteristic" wording — it was never accepted). Round 3 (this round)
investigated screenshot 17's cut-off "Covers" column (a real, previously unreported clipping bug, root-caused
and a fix verified but not applied), built one disposable CSS multi-column layout experiment that genuinely
eliminates the row-height-coupling gaps (measured, not implemented), and removed unsupported usability-verdict
wording ("not visually jarring/confusing") in favor of plainly-reported observed behavior. See "Row-height
coupling," "Screenshot 17's cut-off 'Covers' column," "Layout experiment: CSS multi-column," and "Real keyboard
traversal" below for what changed in each round specifically.

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
the CSS Grid technique chosen specifically to preserve DOM/reading/keyboard order.

**Correction (this round): the previous wording here was wrong.** It claimed "no CSS-only, DOM-order-preserving
property closes this gap... it requires `grid-template-rows: masonry` (Firefox-only) or JavaScript." That
assumed CSS Grid was the only applicable layout mode. It is not — CSS **multi-column layout** (`columns`,
`column-span`, `break-inside`) is a different, fully cross-browser, standards-track CSS layout mode, built
specifically to pack content into independently-sized columns. A real, working, DOM-order-preserving
implementation of it was built and measured this round — see "Layout experiment: CSS multi-column" below,
which eliminates every gap in the table above (measured, not assumed). The "sparser-grid / `grid-auto-flow:
column`" idea floated last round is also corrected: `grid-auto-flow` only changes which cell an item is
auto-placed into — it does not change CSS Grid's fundamental one-shared-row-track-per-row-index model, so it
would NOT have eliminated this coupling by itself, contrary to what was implied. Multi-column layout is the
right tool because it is not a grid at all.

## Screenshot 17's cut-off "Covers" column — investigated, a real clipping bug, not framing or intended scroll

**Correction round finding, previously unreported.** Screenshot 17 (the 26-settled-month Ledger case) shows
every row's "Covers" value truncated at the card's right edge (e.g. "2032-02 MONTHLY — $ 1..."). This was
investigated by measuring `viewport`, `<main>`, every grid item, the Ledger card, and the Ledger payment
history table's own wrapper **separately**, with `getComputedStyle`/`getBoundingClientRect`, not by trusting
`document.documentElement.scrollWidth` (which stayed at 1265–1280, reporting **zero** page-level overflow, the
exact false signal the instruction warned against).

**Ruled out:**
- **Not capture framing.** Confirmed by scrolling the real page to its bottom and checking every control's
  `getBoundingClientRect()` directly — the "Load more" button and "Archive student" (the page's last control)
  are both fully reachable (screenshot 18). Vertically, nothing is lost. This investigation is about a
  DIFFERENT, horizontal problem.
- **Not intended bounded scrolling at the table level.** `PaymentHistorySection`'s own `DataTable` wrapper
  (`src/components/ui/data-table.tsx`: `<div className="w-full overflow-x-auto ...">`) measured `scrollWidth
  === clientWidth` (433px, zero internal overflow) — the horizontal-scroll affordance that exists for exactly
  this situation elsewhere in the app never engaged here.

**What it actually is — a real, measured CSS Grid "blowout," silently swallowed by an ancestor's
`overflow-hidden`.** `<main>`'s own `grid-template-columns` computed to `567.688px 467.417px` (summing with the
24px gap to 1059.1px) while `<main>`'s own content box is only **1024px** wide — `<main>` itself was 59px
wider than its box (`scrollWidth` 1083 vs `clientWidth` 1024), and the staff shell's own pre-existing content
wrapper (`overflow-x: hidden`, a structural fact about the shell, not something this phase introduced) silently
clipped that excess with **no scrollbar, no visual cue, and zero document-level overflow signal** — confirmed
directly: the "Covers" header cell's `getBoundingClientRect().right` (1322) sits **42px past the viewport's own
right edge** (1280). This is real, confirmed, unreachable content loss, not a screenshot artifact.

**Root cause, precisely identified.** The grid items participating in `<main>`'s explicit placement (and, one
level down, the flex-item children inside the Ledger wrapper) all have CSS's default `min-width: auto`. One
cell's content — the "Covers" column's per-settlement `<div className="... whitespace-nowrap">`
(`payment-history-section.tsx:153`) — has a long, deliberately non-wrapping string. Because of the default
automatic minimum size, that string's full width becomes a hard floor on the grid item containing it, and
because the `fr`-sized columns can't shrink below that floor, the grid overflows its own container — the
textbook CSS Grid "blowout," not specific to this phase's work but newly exposed by this round's more
realistic, longer-content fixture.

**Verified fix, tested live, NOT applied to production this round**: adding `min-width: 0` to each grid item
(and to the Ledger wrapper's own two flex-item children) resolves it completely. Re-measured after applying it
in the browser: `<main>`'s own overflow disappears (`scrollWidth === clientWidth`, 1009px), and the
previously-silent 42px clip becomes a **real, visible, scrollable** horizontal overflow inside the DataTable's
own existing `overflow-x-auto` wrapper (`scrollWidth` 433 vs `clientWidth` 340) — scrolling that wrapper to its
end brings the "Covers" header fully back within the viewport (confirmed: `right` 1223 ≤ 1280). This is a
one-line-per-grid-item CSS fix (`min-w-0`), independent of and much smaller than the row-height-coupling
tradeoff above — reported for approval, not implemented, per instruction to keep production code unchanged
this round.

## Layout experiment: CSS multi-column — a working, DOM-order-preserving alternative, measured, not implemented

**One disposable experiment, built directly against the complete actual-page output** (the same realistic,
26-settled-month fixture used above — the harder case), applied live in a running browser, never committed to
`src/`. Preview screenshots (not verification evidence — a prototype, kept separate):
`design/matroom/preview/phase4-detail-multicol-experiment-{1280,390}-{before,after}.png`.

**Correcting a specific wrong assumption named in this round's instruction**: `grid-auto-flow: column` was
never tested or implied as a fix here — it would not have worked, since it only changes which grid cell an
item auto-places into, not whether row tracks are shared; it stays CSS Grid, so the row-track-sharing problem
would remain. The technique that actually works is a **different CSS layout mode entirely**: multi-column
layout (`column-count`, `column-span`, `break-inside`) — not Grid at all.

### Exact CSS and DOM structure tested

Zero DOM reordering — the real page's 9 flat children of `<main>` keep their exact existing order (confirmed:
`Array.from(main.children)` printed the identical sequence before and after). Only classes/inline styles
changed, scoped to `@media (min-width: 1024px)` exactly like today's `lg:` breakpoint:

```css
@media (min-width: 1024px) {
  main.phase4-exp-main { display: block; column-count: 2; column-gap: 24px; }
  main.phase4-exp-main > .phase4-exp-span { column-span: all; }       /* header, gated block */
  main.phase4-exp-main > .phase4-exp-item { break-inside: avoid-column; min-width: 0; margin-bottom: 24px; }
}
```
- `<main>` (header + gated block): `.phase4-exp-span` — `column-span: all` makes each break out of the 2-column
  flow and render full-width, exactly like today, with zero extra wrapper `<div>`.
- The 7 middle sections (Promotions/Profile/Attendance/Legacy/Ledger/RegenerateCode/AddAdjustment): each gets
  `.phase4-exp-item` directly, no new wrapper — `break-inside: avoid-column` stops a single card from ever
  being split across the column break. `min-width: 0` is the same fix as the clipping bug above.
- Below `1024px`: the media query doesn't apply at all, so nothing changes — the existing base `flex flex-col`
  classes govern mobile exactly as they do today.

### Desktop (1280px) — measured, every gap from the table above eliminated

| Section | Before (top, height) | After (top, height) |
|---|---|---|
| Promotions | 148, 912px | 148, 962px |
| Profile | 148, 411px | 1134, 411px |
| Attendance | 1084, 945px | 1570, 965px |
| Legacy | 1084, 305px | 148, 305px |
| Ledger | 2052, 1630px | 477, 1630px |
| RegenerateCode | 2052, 36px | 2131, 36px |
| AddAdjustment | 2460, 57px | 2191, 57px |
| Gated block | 3788, 109px | 2558, 109px |

Column 1 (Promotions→Profile→Attendance) now flows to a total height of ~2410px; column 2
(Legacy→Ledger→RegenerateCode→AddAdjustment) flows to ~2100px — **two different, genuinely independent
totals**, each exactly the sum of its own content, zero shared row tracks, zero blank gaps. **Total page height:
2692px, vs 3921px before — a 1229px (31%) reduction**, for the identical content, with zero page overflow
(`scrollWidth` 1265, same as before). Screenshots: `...1280-before.png` / `...1280-after.png`.

### Narrow width (390px) — confirmed unaffected, not assumed

Re-measured with the SAME media-gated stylesheet live in the browser (not asserted from the `lg:` convention
alone): at 390px, `getComputedStyle(main).display` is `flex` and `columnCount` is `auto` — the experiment's
rules genuinely do not apply below the breakpoint. DOM order read directly: Header → Promotions → Profile →
Attendance → Legacy → Ledger → RegenerateCode → AddAdjustment → Gated block, `top` monotonically increasing —
identical single-column stack to production today, no overflow (`scrollWidth` 375 ≤ 390). Screenshots:
`...390-before.png` / `...390-after.png` (near-identical, as expected — nothing here changes mobile).

### Keyboard order — proven unaffected by construction, not re-traced

CSS multi-column (`columns`/`column-span`/`break-inside`) is purely a **painting/layout** mechanism; it does
not move, clone, or reparent DOM nodes, and — like CSS Grid placement, established in every prior round this
session — default (no `tabindex`) `Tab` order follows DOM order only, never visual column position. Since the
DOM child list was captured and confirmed byte-identical in sequence before and after applying the experiment
classes, keyboard order is unaffected **by construction**: no new Tab trace was needed to prove something that
follows directly from "the same ordered list of nodes, restyled in place." No duplicated interactive component,
no positive `tabindex`, no hidden content — the experiment adds classes/inline styles only.

### The real tradeoff — named, not hidden

Multi-column achieves independent heights by **not** guaranteeing the reference mock's specific row pairing.
Today's grid deliberately puts Promotions beside Profile and Attendance beside Legacy (same row index, by
design). Multi-column instead fills column 1 top-to-bottom, then column 2 top-to-bottom — in this fixture,
Promotions (col 1) and Legacy (col 2) happen to start at the same height purely because they're each first in
their column, not because of any deliberate pairing; with different content lengths, nothing would visually
align. **This is the real cost of this technique**: it trades the reference mock's deliberate row-by-row
alignment for zero wasted space — reported plainly, not implemented, pending review of whether that tradeoff
is acceptable.

### The alternative that WOULD preserve exact row pairing — requires relaxing DOM order, NOT implemented

A genuinely independent two-column layout that preserves the mock's specific Promotions/Profile and
Attendance/Legacy pairing would require two separate flex column containers, each holding only that column's
items in their own internal order (e.g. a "left" wrapper: Promotions, Attendance, RegenerateCode,
AddAdjustment; a "right" wrapper: Profile, Legacy, Ledger). **Exact tradeoff, traced before any implementation,
per instruction:**
- **DOM order would change** from today's Header→Promotions→Profile→Attendance→Legacy→Ledger→RegenerateCode→
  AddAdjustment→GatedBlock to Header→[Promotions→Attendance→RegenerateCode→AddAdjustment]→[Profile→Legacy→
  Ledger]→GatedBlock — the entire left column before any of the right column, not the current alternating
  sequence.
- **Keyboard sequence would change identically** (Tab follows DOM order): a keyboard user would Tab through
  all four left-column sections before ever reaching Profile, a materially different sequence from either
  today's grid or the multi-column experiment above.
- **Mobile stacking would also change** to this same left-then-right sequence, since there is no DOM-order-free
  way to "undo" a real node split at narrow widths without reintroducing CSS `order` (which the project has
  consistently avoided this session) or JavaScript reparenting (out of scope).

This alternative is named and its consequences traced, exactly as instructed, but **not implemented** — it is
a strictly larger, riskier change (real DOM reordering, a new mobile/keyboard sequence to re-verify end to end)
than the multi-column experiment above, which needs none of that.

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
| 17 | `17-detail-full-harness-1280-ledger-26-rows-light-en.png` | A second, more extreme but realistic fixture (26 settled Ledger months, built to genuinely produce the "Load more" control) — full page, showing the 1594px row-4 gap recorded in the table above. Also the screenshot whose cut-off "Covers" column this round investigated (see below). |
| 18 | `18-detail-full-harness-scrolled-to-bottom-light-en.png` | Real page scrolled to `document.documentElement.scrollHeight` — proves every control (including "Load more" and "Archive student," the page's last control) is actually, vertically, reachable; no content is lost downward. |
| 19 | `19-detail-full-harness-1280-ledger-26-rows-refcheck-light-en.png` | A fresh, re-captured `fullPage` shot of the same 26-row state, used to cross-check screenshot 17 against live DOM measurements (below) rather than trusting the image alone. |
| 20 | `20-detail-full-harness-covers-column-clipped-viewport-en.png` | Viewport-only (not `fullPage`) screenshot of the Ledger payment history table, scrolled into view — every row's "Covers" value visibly truncated mid-text, with no scrollbar anywhere on screen. Direct visual proof of the real clipping bug (see "Screenshot 17's cut-off 'Covers' column" below), independent of any `fullPage` stitching concern. |

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
long-settled-history student, a real cross-column jump).

**Browser auto-scroll, reported as an observation, not a usability verdict (correction round)**: when this `Tab`
jump spans off-screen content, Chromium automatically scrolls the newly-focused element into view — confirmed
while tracing this sequence (the `scrollY` value changed from the pre-Tab state to the post-Tab state, measured
above). That is the full, literal, observed behavior. Whether a real keyboard user finds this jump "jarring,"
"confusing," or perfectly fine is a usability judgment this round does not make and the measurement above does
not establish — auto-scroll changing what's on screen is a fact; whether that's an acceptable experience is a
separate question, left open, not asserted either way.

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

**New this round:**
- **A real, previously unreported clipping bug** (the "Covers" column, 42px of real content silently swallowed
  by an ancestor `overflow-hidden`, zero document-level overflow signal) — found, root-caused precisely, and a
  one-line-per-grid-item fix (`min-width: 0`) verified live, but NOT applied to production this round. See
  "Screenshot 17's cut-off 'Covers' column" above.
- **A working, DOM-order-preserving layout alternative (CSS multi-column)** was built, measured, and found to
  eliminate every row-height-coupling gap in the table above, at the cost of losing the reference mock's
  specific row-by-row pairing (a real, named tradeoff) — built as a disposable, uncommitted experiment only,
  not applied to production. See "Layout experiment: CSS multi-column" above.

**Still explicitly bounded, this round:**
- **The row-height-coupling gap itself remains unresolved in production** (distinct from the fact that a
  working alternative now exists and is measured) — the multi-column experiment above is reported for review,
  not implemented, pending a decision on whether its pairing tradeoff is acceptable.
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
