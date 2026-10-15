# Phase 4 — Student detail — correction implementation, verification

Real implementation of the corrected plan (`design/matroom/verification/phase4-student-detail-proposal/
README.md`). Verified against the actual running app (`pnpm dev`), not the static October reference — the
reference remains the approved direction this corrects toward, not evidence of this PR's own behavior.
Student-detail only; roster (list) is untouched (already corrected and merged, PR #124).

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
   coupling — a real, measured problem, fixed with the smallest alternative" below.

No subcomponent file is touched. No field, condition, role gate, branch restriction, financial state, or
workflow changed.

## Row-height coupling — a real, measured problem, fixed with the smallest alternative

**Found live, not assumed from source.** CSS Grid's default `align-items: stretch` made every item in a shared
row stretch to the row's tallest member. For Patricia Elizondo (a real seeded student with 20 attendance
entries and no payment history), this was severe, not a minor cosmetic gap: Promotions/Profile both measured
776px tall (Profile's actual content is ~431px — 345px of stretched empty card); Attendance/Legacy Payment
History both measured 2242px tall (Legacy's actual content is one line — ~91px — leaving **~2150px of
stretched, empty-looking card background**). This is exactly the "usable layout" failure the task anticipated.

**Smallest alternative applied**: `lg:items-start` on the grid container. Re-measured after the fix: Profile
now renders at its natural 431px (top-aligned in row 2); Legacy Payment History now renders at its natural 91px
(top-aligned in row 3). Neither card stretches into a broken-looking empty box anymore.

**What this does NOT fix, disclosed, not hidden**: the ROW TRACK itself is still exactly as tall as the
taller column's content (an inherent CSS Grid characteristic of explicit placement, not fixable by any single
property without reintroducing JavaScript masonry or DOM reordering — both out of scope). In Patricia's case,
this means a visible blank area of page background (not a stretched card — a real, disclosed difference) sits
to the right of her long attendance list, since the right column has no row-4/row-5 content to fill it. This is
reported as a measured, real, accepted characteristic of the chosen technique — not silently resolved, not
hidden. Confirmed, not merely asserted: screenshot 01 (below) shows exactly this.

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
| 12 | `12-detail-ledger-harness-1280-light-en.png` | **Ledger-active harness, not a live route** — see "Ledger-active verification" below. |

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

**The plan's predicted "worst case" jump** (Legacy/Ledger → RegenerateCode, right column to left column) would
only manifest when the right column *does* have focusable content at that row (e.g. a real Ledger section).
Not independently re-measured with a populated Ledger this round (the ledger-active harness below is RSC-HTML/
structural evidence, not an interactive real-browser session — see below) — flagged as a residual gap, not
claimed proven.

**Browser auto-scroll, a relevant observation**: when a Tab jump spans off-screen content, Chromium
automatically scrolls the newly-focused element into view — confirmed while tracing this sequence. This means
even a theoretically "distant" cross-column jump is not visually jarring to a real keyboard user the way raw
pixel-distance numbers alone might suggest; the browser's native behavior already mitigates it.

**No positive `tabindex`, no duplicate interactive components** — confirmed by reading the diff (§ "What
changed" above): the only additions are `className` values and plain positioning `<div>`s.

### Ledger-active verification — browser-tested harness evidence, explicitly separated from live-route evidence

**Labeled explicitly, per instruction — not claimed as live-route verification.** Production activation remains
`false` for every real organization today (`src/lib/dues/ledger/activation.ts`'s own documented seam, the same
structural limit the roster correction (PR #124) and the Payments phase both already hit and disclosed) — the
Ledger section cannot be reached by navigating any real production route in this codebase today.

**Method, the established actual-page browser harness**: the real `StudentDetailPage` component was rendered
through the `vi.mock`-swapped `inactiveLedgerActivation` seam (the same technique
`student-detail-page-ledger-form-gating.test.ts` already established, reused here via a throwaway, uncommitted
extraction script — never committed, deleted immediately after use) with `ledgerActive: true` and a real
overdue obligation. The real rendered markup was inspected directly (confirmed: the legacy "Record a payment"
toggle is correctly absent; "Payment history" — legacy, still showing "No payment records yet." — and the new
"Current balance" / "Ledger payment history" cards all render as **three separate, distinct cards**, never
merged or interleaved, exactly as required). That real markup's relevant structure was then reproduced
(condensed — long internal form fields replaced with short labels, grid-placement classes and card structure
kept byte-identical to the real extraction) and loaded into a live, running Chromium tab with the real compiled
CSS/fonts/theme/shell already loaded via a prior real navigation — `12-detail-ledger-harness-1280-light-en.png`
is the result: "Payment history" (legacy) stacks above "Current balance" (showing the real `$ 120.00 (includes
$ 20.00 late fee)` badge) and "Ledger payment history," all inside the Ledger wrapper's `lg:col-start-2
lg:row-start-4` cell, visually distinct, correctly positioned.

**What this is**: real Chromium rendering of the Ledger wrapper's grid placement and card stacking, under real
compiled CSS. **What this is not**: a live production-route render (unreachable today, by design) or an
interactive session (no real `Tab`/click interaction was exercised against this specific harness render — the
condensed reconstruction was for visual/structural confirmation only). This distinction is stated explicitly,
not glossed over.

**Production billing was never activated** — the fixture obligation was created via the same test-only
`activation: { isActive: async () => true }` dependency injection the existing, pre-merge
`student-detail-page-ledger-form-gating.test.ts` already uses, against the isolated test database only.

## Checks run

- `pnpm typecheck` — clean (0 errors).
- `pnpm lint` — clean (0 errors; pre-existing unrelated warnings only).
- `pnpm test:unit` — 1707/1707 passed.
- `pnpm test:integration` — 153 files, **1969** tests, all passed, including:
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

**New this round, explicitly bounded:**
- **The row-height-coupling gap beneath Legacy Payment History/Profile in extreme content-mismatch cases is a
  disclosed, accepted characteristic of the explicit-grid technique, not eliminated** — see "Row-height
  coupling" above. Reported as a measured problem with the smallest applied mitigation, per instruction, not
  silently resolved to perfection.
- **The keyboard jump from a *populated* Ledger section to RegenerateCode was not independently re-measured**
  live (only the empty/absent-Ledger case, the real common one, was traced with real `Tab` presses) — the
  ledger-active harness (above) is structural/visual evidence, not an interactive keyboard session. Flagged as
  a residual gap.
- **The Approve-flow (PENDING student) layout was not independently re-verified live** — no PENDING student
  exists in the seed data without running the full registration-and-approval workflow, judged disproportionate
  for a layout-only check. It shares the exact same full-width gated-block container already confirmed working
  for Edit/RecordPayment/Archive — same code path, no additional risk identified, but not independently shown.

**Unchanged from every prior phase this session:**
- Real Android/iOS device verification remains unavailable in this environment.
- Cross-browser testing (Firefox/Safari) was not done — Chromium only.
- Screen-reader output was not captured directly (role/focus state confirmed via the accessibility-relevant DOM
  attributes and computed styles, not a live screen-reader transcript).
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed and unrelated to this
  screen.

## Explicitly out of scope

Any other screen, shared-component changes (the `Card`/`PromocionesCard`/`EditStudentForm`/etc. source files are
all byte-for-byte unchanged), tenant-branding changes, database writes/cleanup outside the isolated test DB,
migrations, deployment, activation.
