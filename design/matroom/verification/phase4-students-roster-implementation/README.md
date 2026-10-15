# Phase 4 — Students roster (list) — correction implementation, verification

Real implementation of the corrected plan (`design/matroom/verification/phase4-students-roster-proposal/
README.md`). Verified against the actual running app (`pnpm dev`), not the static October reference — the
reference remains the approved direction this corrects toward, not evidence of this PR's own behavior.
Student-detail (`(staff)/students/[id]/*`) is untouched.

## Correction round 2 — targeted findings addressed

This round fixed three specific, verified gaps in the first implementation pass, without expanding roster
scope:

1. **Baseline-comparison test restored to real equivalence**, not loose presence checks (`§ Checks run` below).
2. **Ledger-active chips verified in a real browser**, not just as RSC-HTML markup — `has-[details[open]]`
   screenshots 09–15 below are real Chromium, real compiled CSS, real interaction.
3. **Expanded-form full-width fix**: `items-start` alone did not stretch `<details>` to the container's width
   (confirmed by direct measurement: 417px inside a 960px container) — `has-[details[open]]:items-stretch`
   added, re-measured, re-screenshotted (02/03/08 below are the corrected, re-verified captures).

Historical limitations carried unchanged from round 1 (real Android/iOS, the ADMIN smoke timeout) are preserved
below under "What was not verified," distinguished from the ledger-chip limitation this round resolved.

## What changed

`src/app/[locale]/(staff)/students/page.tsx` only:

1. **Header/CreateStudentForm regrouping.** The heading block and `<CreateStudentForm>` are wrapped in one
   `flex flex-wrap items-start justify-between gap-3 has-[details[open]]:flex-col
   has-[details[open]]:items-stretch` container. Collapsed, they sit side by side at desktop (`flex-row`,
   `items-start` — unaffected by this round's fix, which only adds a rule scoped to the `open` state). The
   instant the disclosure opens, `has-[details[open]]:flex-col` switches the container to a column stack, and
   `has-[details[open]]:items-stretch` (**added this round** — see "Expanded-form width" below) makes the
   `<details>` element itself stretch to the container's full cross-axis width, instead of shrink-wrapping its
   own content. `CreateStudentForm`'s own file is unchanged — zero lines.
2. **Belt sizing.** `BeltBar` (whose `className` reaches its wrapping `<span>`, not the `<svg>` it renders —
   confirmed by reading `belt-bar.tsx`) is replaced with a direct `BeltVisual` import (already exported,
   unchanged) plus the same aria-hidden-wrapper pattern `BeltBar` itself uses, now carrying an explicit
   `className="w-[140px]"` that reaches the `<svg>` directly — the same mechanism the landing page already uses
   (PR #123). Renders at 140px × ~15.6px (measured live, `9:1` ratio preserved — `belt-graphic.tsx`'s
   `VIEW_W`/`VIEW_H` constants are untouched). Rank colors and stripe geometry are the same `belt`/`stripes`
   props `BeltBar` itself passed through, unchanged.
3. **Ledger checkbox chips.** The `LEDGER_FILTER_KEYS` checkbox labels are restyled to a pill/chip visual using
   only native CSS (`has-[:checked]`, `has-[:focus-visible]`) and `sr-only` on the `<input>` itself — no client
   component, no React state, no `onClick`. Same `name`/`value`/`defaultChecked` contract as before.

No shared component is touched by any of the three changes above — all scoped to `page.tsx`'s own JSX/classes.

## Expanded-form width — a real gap, found, fixed, re-verified

**The finding**: `items-start` on the wrapper only stops the row from being *shared* with the heading — in a
`flex-direction: column` container, `align-items: flex-start` sizes a flex item to its own content on the
cross axis (here, width), it does not stretch it to the container's width. Measured directly, before any fix,
at 1280px: wrapper `960.67px` wide, `<details>` only `417.33px` wide (its own `rounded border p-4` box wrapped
tightly around the form's `max-w-sm` content, not the available row). The round-1 README's "full-width row"
language was imprecise — the cramping-by-row-sharing problem was genuinely solved, but the container itself was
never actually stretched.

**The fix**: added `has-[details[open]]:items-stretch` to the wrapper, scoped to the `open` state only (the
collapsed row's `items-start` cross-axis behavior is untouched — confirmed below). `CreateStudentForm`'s own
`<form className="mt-4 flex w-full max-w-sm flex-col gap-3">` (unchanged, its internal width limit preserved
exactly as instructed) still caps the form fields' own readability width; only the outer `<details>` container
now genuinely uses the full row.

**Re-measured live, before vs. after, 1280px:**

| | `<details>` width | Form width (unchanged cap) |
|---|---|---|
| Before this round's fix | 417.33px | 384px |
| After this round's fix | **960.67px** (= wrapper width) | 384px |

**Re-measured at narrow widths and in the error state:**

| State | Width | `<details>` width | Wrapper width | Match |
|---|---|---|---|---|
| Expanded | 1280px | 960.67px | 960.67px | **Yes** |
| Expanded | 390px | 342.67px | 342.67px | **Yes** |
| Expanded | 320px | 272.67px | 272.67px | **Yes** |
| Expanded, real validation error shown | 1280px | 960.67px | 960.67px | **Yes** |
| Collapsed (unaffected check) | 1280px | `flex-direction: row`, `align-items: flex-start` (unchanged) | — | — |

No page-level overflow was introduced by this change at any width (re-confirmed, see "Table scrolling vs. page
overflow" below, unchanged from round 1 since this fix only affects the open `<details>`'s own stretch
behavior, not page width).

## Belt sizing — disclosed as an intentional reuse adaptation, not an exact match

140px wide matches the October reference's `belt()` function (`w: 140`). The resulting height (~15.6px) does
**not** match the reference's `h: 26` — the shared `BeltVisual` component's own viewBox (`360×40`, a 9:1 ratio)
differs from the reference's own belt proportions (~5.4:1), and this PR does not change that shared viewBox
(doing so would affect every belt rendering app-wide, out of this bounded scope). This is recorded here
explicitly, per instruction, as a disclosed, intentional reuse adaptation — not claimed as a pixel match.

## Real-browser verification (isolated test-DB environment)

`pnpm dev`, `DATABASE_URL` redirected to the isolated test DB (`alliance_bjj_test`, port 5433 — never the dev
database), logged in through the real `/login` form with the seeded `admin@alliancecr.com` account (ADMIN),
real desktop Chromium (Playwright).

### Roster screens (ledger-inactive — the real, live production path)

| # | File | What it shows |
|---|---|---|
| 01 | `01-roster-1280-collapsed-light-en.png` | 1280px, light, EN, collapsed — heading and "Create student" side by side, 140px belts with correct rank-bar colors/stripe tapes, all filters present. |
| 02 | `02-roster-1280-expanded-light-en.png` | **Re-captured this round**, after the `items-stretch` fix — disclosure open, full form on its own row, `<details>` container confirmed to span the full row width (960.67px, measured — see "Expanded-form width" above), not just avoiding row-sharing. |
| 03 | `03-roster-1280-expanded-error-light-en.png` | **Re-captured this round** — a real server-side validation error (Kids student, DOB making them a minor, no guardian name/phone): "Guardian name and phone are required for students under 18." renders inline, plus "Please check the form for errors.", inside the now-genuinely-full-width stretched container. |
| 04 | `04-roster-1280-collapsed-dark-en.png` | Dark theme, live via the `dark` class — correct contrast/tokens throughout, header layout unaffected. |
| 05 | `05-roster-1280-collapsed-light-es.png` | Spanish locale — "Estudiantes"/column headers translated, belt labels correct, header layout unaffected. |
| 06 | `06-roster-390-collapsed-light-en.png` | 390px — header wraps to a stacked order, filters wrap, table's own `overflow-x-auto` scrolls horizontally (intentional, see below). |
| 07 | `07-roster-320-collapsed-light-en.png` | 320px — same, no page-level overflow. |
| 08 | `08-roster-320-expanded-light-en.png` | **Re-captured this round** — 320px, disclosure open, `<details>` confirmed to stretch to the full 272.67px wrapper width (measured), form fields readable, no cramping. |

A **real creation** was exercised in the isolated test DB during error/success verification in round 1 (visible
in screenshot 05 as "VerifyError RosterTest") and again this round (further `VerifyStretch*` test rows) —
harmless, isolated-test-DB-only data, left in place.

### Ledger-active chips — real browser, real build CSS, harness-tested evidence

**Per finding 2, this is browser-tested harness evidence, not live production-route verification** — stated
plainly, not claimed to make production unreachability "impossible to verify." Production activation remains
`false` for every real organization today (`src/lib/dues/ledger/activation.ts`: `inactiveLedgerActivation` is
"the only production implementation," and injecting an active stub from any caller outside a test is the exact
bug that file's own comment warns against) — so the chips cannot be reached by navigating any real production
route today. **That is a statement about the production route, not about whether the chips can be verified.**

**Method**: the real `StudentsPage` component was rendered through the established `vi.mock` test-only
activation seam (the same technique `students-page-ledger-render.test.ts` already used, extended here), via a
throwaway, uncommitted extraction script — producing the real, actual rendered `<main>` HTML for `ledgerActive:
true` with `?debt=1` pre-checked, for both EN and ES. That real markup was then loaded into a real, live
Chromium tab that had already navigated to the real, running `/students` page (so it has the real compiled
Tailwind CSS bundle, the real self-hosted fonts, the real theme-class mechanism, and the real sidebar/topbar
shell already loaded) — the page's own `<main>` element was replaced with the mock-rendered one via
`document.querySelector('main').outerHTML = ...`, preserving everything around it. Every check below ran
against that real, live DOM, under the real compiled stylesheet, not a hand-authored approximation.

| # | File | What it shows |
|---|---|---|
| 09 | `09-ledger-chips-harness-1280-light-en.png` | 1280px, light, EN — real build CSS: "Has outstanding debt" renders visibly checked (filled/bordered pill), the other 5 chips visibly unchecked (plain border) — real colors, not inferred from class names. |
| 10 | `10-ledger-chips-harness-1280-multi-checked-light-en.png` | After a real label click ("No outstanding debt") and a real `Space` key press on a focused checkbox ("Monthly past grace") — 3 chips now visibly checked, the focused one additionally shows a visible ring (real `box-shadow`, measured — see below). |
| 11 | `11-ledger-chips-harness-1280-coarse-pointer-light-en.png` | Genuine Chromium coarse-pointer emulation active (`Emulation.setTouchEmulationEnabled` + `setEmulatedMedia`, confirmed via `window.matchMedia('(pointer: coarse)').matches === true` before measuring) — chip touch target measured at exactly 44×126px. |
| 12 | `12-ledger-chips-harness-1280-dark-en.png` | Dark theme, live `dark` class — checked state and focus ring both remain clearly visible against the dark palette. |
| 13 | `13-ledger-chips-harness-1280-light-es.png` | Spanish locale — "Tiene saldo pendiente," "Sin saldo pendiente," etc., real translated chip labels, checked state renders identically to EN. |
| 14 | `14-ledger-chips-harness-390-light-es.png` | 390px, ES — chips wrap, no page overflow (measured: `scrollWidth 390 === innerWidth 390`). |
| 15 | `15-ledger-chips-harness-320-light-es.png` | 320px, ES — chips wrap to one per row, no page overflow (measured: `scrollWidth 320 === innerWidth 320`). |

**Checked/unchecked appearance** — real, not inferred: screenshot 09 (above).

**Real `Tab`/`Space` interaction and visible focus** — a real `Tab` walk from the search field reached every
checkbox in document order (`belt` select → `debt` → `noDebt` → `monthlyPastGrace` → `signupPastDue` →
`pendingConversion` → `configIssue` → `Filter` button); focusing the `debt` checkbox directly and reading its
**parent label's** computed style (not the invisible `sr-only` input's own style) showed a real `box-shadow`
ring: `rgba(255,255,255,1) 0 0 0 2px, rgb(29,57,43) 0 0 0 4px` — a real, visible offset ring, not assumed from
the `has-[:focus-visible]:ring-2` class string.

**Label click toggling** — real: clicking the visible `<label>` text "No outstanding debt" (not the hidden
input directly) toggled `document.querySelector('input[name="noDebt"]').checked` from `false` to `true`.

**Real `Space`-key toggling** — confirmed: focusing `monthlyPastGrace`'s checkbox and pressing a real `Space`
key toggled it checked.

**Coarse-pointer label target size** — measured only after confirming the emulation genuinely took effect
(`window.matchMedia('(pointer: coarse)').matches` was `false` on a first attempt using only
`page.emulateMedia`, which does not control the `pointer` feature in this Chromium version; corrected via CDP's
`Emulation.setTouchEmulationEnabled` + `Emulation.setEmulatedMedia`, re-confirmed `true` before measuring): the
"Signup past due" label measured **44.0px tall** (`min-height: 44px` computed) — the pre-existing global rule
(`globals.css`: `label:has(> input[type="checkbox"]) { min-height: 2.75rem }` under `@media (pointer: coarse)`)
applies automatically because the checkbox is a direct child of the label, confirmed by direct measurement, not
assumed from the selector alone.

**No `sr-only`-input page overflow** — measured at 390px and 320px (both EN at 1280 and ES at 390/320):
`document.documentElement.scrollWidth` exactly equals `window.innerWidth` at every width tested (390/390,
320/320) — the `sr-only` input (`position: absolute; width: 1px; height: 1px; overflow: hidden`, confirmed via
`getComputedStyle`) contributes no layout size.

**Submitted form names/values for multiple selected chips** — real `FormData` read from the live `<form>`
after checking 3 chips: `[["search",""],["belt",""],["debt","1"],["noDebt","1"],["monthlyPastGrace","1"]]` —
exactly the 3 checked boxes' `name`/`value` pairs, nothing from the 3 unchecked ones, confirming the native GET
form still submits correctly with multiple chips selected.

**EN/ES** — screenshots 09 and 13 (above), both real, both from the real `vi.mock`-rendered page for their
respective locale (the extraction script set `getLocale`/`getTranslations` per-render, not a single hardcoded
locale).

**Light/dark** — screenshots 09 (light) and 12 (dark), both real, via the same live `dark`-class toggle used
throughout this project's verification work.

**Narrow widths** — screenshots 14 (390, ES) and 15 (320, ES), both real, both confirmed overflow-free by
direct measurement, not just visual inspection.

### Table scrolling vs. page overflow — measured, not assumed

At every tested width, `document.documentElement.scrollWidth` was measured against `window.innerWidth`:

| Width | `innerWidth` | `scrollWidth` | Page-level overflow |
|---|---|---|---|
| 390px | 390 | 375 | **No** |
| 320px | 320 | 305 | **No** |
| 320px, expanded form | 320 | 305 | **No** |

The table's own horizontal scroll (its `min-width: 780px` inside an `overflow-x-auto` wrapper, unchanged by
this PR) is a separate, contained, intentional scroll region — confirmed distinct from page-level overflow by
the measurements above, not inferred from the screenshots alone.

### Belt SVG, measured live

```
width: 140, height: 15.552..., ratio: 9.00, viewBox: "0 0 360 40"
```
Confirms the `className="w-[140px]"` override reaches the `<svg>` (not just its wrapper), the aspect ratio
holds exactly (`9.00` = `360/40`), and no distortion occurred.

### Filter submission and bookmarked URL round-trips, real browser

- `GET /en/students?belt=BLUE&track=ADULT&status=ACTIVE` (direct navigation, simulating a bookmark): all three
  `<select>`s reflect the URL (`defaultValue` round-trip confirmed), 6 rows returned, every visible belt label
  reads "Blue · ...". Unchanged behavior, confirmed live, not just read from source.
- `GET /en/students?payment=OVERDUE`: the legacy payment `<select>` reflects `OVERDUE`, all 39 visible rows show
  the "Overdue" pill.
- Changing `belt` to `WHITE` in the UI and clicking "Filter" submitted
  `?search=&belt=WHITE&track=&status=ACTIVE&payment=OVERDUE&academyId=` — the **legacy payment filter the user
  never touched stayed in the request**, combining correctly with the new belt selection — the same AND-across-
  filter-types behavior as before this PR, confirmed live.

### Keyboard, real key presses

Focused the `<summary>` directly and pressed real `Enter`: `document.activeElement` was the `<summary>` element
itself, and the `<details>` element's `open` attribute toggled true, then false on a second `Enter` — native
disclosure keyboard behavior, unchanged, confirmed live (not assumed from the unmodified `<details>` markup
alone).

### A pre-existing hydration warning — confirmed NOT introduced by this PR

A dev-mode-only React hydration console warning (mismatched `useId()`-derived `id`/`clipPath` attributes on
`BeltVisual`'s `<defs>`, and unrelated `base-ui` dropdown-trigger IDs in the sidebar/topbar) appears on
`/students` in this environment. **Directly isolated before reporting**: the identical warning, with the same
`base-ui-` ID churn and the same `BeltBar`/`BeltVisual` `useId()` ID churn, was reproduced by stashing this
PR's changes and reloading `/students` against unmodified `main` — confirming it predates this PR entirely.
Not introduced, not worsened, not something this PR's scope covers.

## Checks run

- `pnpm typecheck` — clean (0 errors).
- `pnpm lint` — clean (0 errors; pre-existing unrelated warnings only).
- `pnpm test:unit` — 1707/1707 passed.
- `pnpm test:integration` — 153 files, **1964** tests, all passed, including:
  - `students-page-ledger-render.test.ts` — 4/4 (unchanged this round).
  - `students-pages-inactive-baseline-comparison.test.ts` — **12/12** (unchanged student-detail case, the
    corrected roster case, and 5 new guard tests, see below).
  - `students-roster.test.ts` — unaffected (tests `listStudents` query/academy-scoping logic only).

### Baseline-comparison test — restored to real equivalence, with guard tests proving it isn't vacuous

**Per finding 1, the round-1 "correction" was itself inadequate.** It replaced the original byte-identical
assertion with loose `.toContain("Paid")` / `.toContain(studentId)` presence checks — those do not prove a
student's name is actually paired with the *right* payment status, or that no *other*, unexpected markup
changed elsewhere; a student ID appearing anywhere in the HTML (even in an unrelated attribute) would have
satisfied them. **Withdrawn.**

**Restored this round**: a new `normalizeApprovedPhase4Diffs()` function strips *only* the two approved,
intentional diffs — via exact, anchored literal-string replacement (not a loose regex), confirmed against a
real render before writing:
1. The header-wrapper `<div class="flex flex-wrap items-start justify-between gap-3 has-[details[open]]:flex-col
   has-[details[open]]:items-stretch">` opening tag, anchored to its known-unique adjacency with `<header`
   (`CreateStudentForm` is mocked to `null` in this test, so the wrapper's only content is the header) and with
   `</header></div><div data-slot="card"` (its equally-unique closing adjacency).
2. The belt's `class="w-[140px] shrink-0"` (wrapping span) and `class="w-[140px]"` (the `<svg>` itself),
   anchored to their exact surrounding attribute strings.

Both baseline and current are then normalized and asserted **byte-identical** via `.toBe()` — real equivalence
restored, covering every student row, every column, every payment status, the filter bar, academy scope,
progress bars, eligibility pills, and role-gated controls, not "the same substrings exist somewhere."

**Proven non-vacuous, per finding 1's explicit requirement** — 5 new guard tests
(`normalizeApprovedPhase4Diffs — guard tests`, synthetic fixtures, no DB, fast) prove the normalization cannot
be satisfied by a wrong render:
- The two approved diffs alone *do* normalize to equal the baseline (the real, intended case).
- A **changed payment-status association** (`Paid` → `Pending` on the same row) still fails equality.
- A **missing row** still fails equality.
- An **unrelated, unexpected markup addition** elsewhere still fails equality.
- A **changed student name** still fails equality.

All 7 tests in this file (the 2 real-render cases plus the 5 guard tests) pass. The student-detail case is
completely untouched by this round (still its own independent `toBe()` byte-identity assertion, unaffected).

## What was not verified — reported honestly, distinguished by status

**Resolved this round** (was previously "unreachable," now verified via a labeled browser harness):
- Ledger-active chips' checked/unchecked appearance, `Tab`/`Space` interaction, visible focus, label-click
  toggling, coarse-pointer touch-target size, `sr-only` overflow, multi-chip form submission, EN/ES, light/dark,
  and narrow widths — see "Ledger-active chips — real browser" above. This is harness-tested evidence (a real
  render of the real component, loaded into a real browser with real compiled CSS) — explicitly not the same as
  navigating the real production route, which remains closed by the activation seam; that distinction is
  recorded, not glossed over.

**Still outstanding, unchanged from round 1 (historical, standing limitations):**
- **Real Android/iOS device verification remains unavailable in this environment.**
- Cross-browser testing (Firefox/Safari) was not done — Chromium only, consistent with this project's existing
  discipline.
- Screen-reader output was not captured directly (tree-structure/role/checked-state were confirmed via the
  accessibility-relevant HTML attributes, not a live screen-reader transcript).
- The "already created" (duplicate-resubmission) success variant was not separately re-triggered — it renders
  in the exact same container/position as the "new creation" success state and the validation-error state, both
  of which were directly confirmed to genuinely stretch to full width this round; its own content block is
  unchanged by this PR.
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed and unrelated to this
  screen.

## Explicitly out of scope

Student-detail, any other screen, tenant-branding changes, database writes/cleanup outside the isolated test
DB, migrations, deployment, activation, and any shared-component change (the belt viewBox, `BeltBar` itself,
`DataTableCell` padding) — all explicitly named and preserved, not touched.
