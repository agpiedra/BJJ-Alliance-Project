# Phase 4 — Students roster (list) — correction implementation, verification

Real implementation of the corrected plan (`design/matroom/verification/phase4-students-roster-proposal/
README.md`). Verified against the actual running app (`pnpm dev`), not the static October reference — the
reference remains the approved direction this corrects toward, not evidence of this PR's own behavior.
Student-detail (`(staff)/students/[id]/*`) is untouched.

## What changed

`src/app/[locale]/(staff)/students/page.tsx` only:

1. **Header/CreateStudentForm regrouping.** The heading block and `<CreateStudentForm>` are now wrapped in one
   `flex flex-wrap items-start justify-between gap-3 has-[details[open]]:flex-col` container. Collapsed, they
   sit side by side at desktop; the `has-[details[open]]:flex-col` rule (plain CSS `:has()`, the same mechanism
   already used by `globals.css`'s checkbox touch-target rule) switches the container to a column stack the
   instant the disclosure opens, so the full form renders on its own full-width row. `CreateStudentForm`'s own
   file is unchanged — zero lines.
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

| # | File | What it shows |
|---|---|---|
| 01 | `01-roster-1280-collapsed-light-en.png` | 1280px, light, EN, collapsed — heading and "Create student" side by side, 140px belts with correct rank-bar colors/stripe tapes, all filters present, footer-free table. |
| 02 | `02-roster-1280-expanded-light-en.png` | Disclosure opened — full form (every field) on its own full-width row below the heading, not cramped into a half-width column. |
| 03 | `03-roster-1280-expanded-error-light-en.png` | A real server-side validation error (Kids student, DOB making them a minor, no guardian name/phone) — "Guardian name and phone are required for students under 18." renders inline next to its field, plus the form-level "Please check the form for errors." — both inside the same full-width expanded layout. |
| 04 | `04-roster-1280-collapsed-dark-en.png` | Dark theme, live via the `dark` class — correct contrast/tokens throughout, header layout unaffected. |
| 05 | `05-roster-1280-collapsed-light-es.png` | Spanish locale — "Estudiantes"/"Crear estudiante"/column headers all translated, belt labels (Gris, Blanco, Azul, etc.) correct, header layout unaffected. |
| 06 | `06-roster-390-collapsed-light-en.png` | 390px — header wraps to a stacked order (no overlap/clipping), filters wrap, table's own `overflow-x-auto` scrolls horizontally (see "Table scrolling vs. page overflow" below) — this is the intentional table scroll, not a page-level bug. |
| 07 | `07-roster-320-collapsed-light-en.png` | 320px — same, no page-level overflow. |
| 08 | `08-roster-320-expanded-light-en.png` | 320px, disclosure opened — full form fully usable, each field legible and tappable, no cramping. |

A **real creation** was exercised in the isolated test DB during error/success verification (visible in
screenshot 05 as "VerifyError RosterTest") — harmless, isolated-test-DB-only data, not dev/production, left in
place (no cleanup requested and the isolated DB already carries other fixture/seed students).

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
PR's changes and reloading `/students` against unmodified `main` — confirming it predates this PR entirely
(the same `useId()`-across-`renderToStaticMarkup`-calls behavior `students-pages-inactive-baseline-comparison
.test.ts`'s own existing code comment already documents as "nothing ledger-related"). Not introduced,
not worsened, not something this PR's scope covers.

## Ledger-active chip evidence — explicitly bounded, labeled

Per the established, pre-existing seam (`src/lib/dues/ledger/activation.ts`: `inactiveLedgerActivation` is
"the only production implementation... no organization is active," and injecting an active stub from any
caller outside a test is explicitly the bug that file's own comment warns against): **`ledgerActive` is `false`
for every real organization today, so the chip-styled checkboxes cannot be reached in any real, running browser
in this codebase right now** — the identical structural limitation the Payments phase's own verification
record (`phase5-payments-implementation/README.md`) already hit and disclosed for its own ledger-active cards.

What was verified instead, using the established actual-page render harness (`vi.mock` swapping
`inactiveLedgerActivation` for a test stub + `renderToStaticMarkup` of the real, unmodified page component —
the same technique `students-page-ledger-render.test.ts` already used before this PR, now extended, not
invented):

- The checkbox is still a real, functional `<input type="checkbox">` with the correct `name`/`value` contract.
- `defaultChecked={params[key] === "1"}` reaches the rendered `checked` attribute correctly (present when the
  URL requests it, absent when it doesn't).
- The native input carries `class="sr-only"` (present in the accessibility tree, not `display:none`/`hidden`).
- The chip's structural CSS hooks (`has-[:checked]:border-primary`, `has-[:focus-visible]:ring-2`) are present
  in the rendered label's class attribute.

**This is RSC-HTML evidence of the markup, explicitly not Chromium-pixel or real-interaction evidence** — it
cannot prove the CSS renders the intended colors/outline, or that a real `Tab`/`Space` press produces the
intended visual feedback, for this specific control. What IS true, and narrows the real gap: no new interaction
logic was added (no `onClick`, no React state) — native checkbox `Tab`/`Space`/focus semantics are
browser-native and unmodified, and the `:has()` CSS mechanism itself (Tailwind's `has-*` variant compiling to
the same selector) is the identical, already-shipping mechanism behind `globals.css`'s existing checkbox
touch-target rule, exercised live and working correctly elsewhere on this exact build (e.g. `/register-academy`'s
real `termsAccepted` checkbox, verified in an earlier PR this session). This is supporting evidence that the
underlying primitives work, not a substitute for direct evidence of this specific control, which remains
unreachable in a live browser today.

## Checks run

- `pnpm typecheck` — clean (0 errors).
- `pnpm lint` — clean (0 errors; pre-existing unrelated warnings only).
- `pnpm test:unit` — 1707/1707 passed.
- `pnpm test:integration` — 153 files, 1959 tests, all passed, including:
  - `students-page-ledger-render.test.ts` — 4/4 (the 3 pre-existing cases plus 1 new case for the chip markup,
    per "Ledger-active chip evidence" above).
  - `students-pages-inactive-baseline-comparison.test.ts` — both cases pass; the roster case's assertion was
    corrected (see below) and the student-detail case is byte-for-byte unchanged.
  - `students-roster.test.ts` — unaffected (tests `listStudents` query/academy-scoping logic only, not
    `page.tsx` rendering).

### A pre-existing test's assertion, corrected — not silently weakened

`students-pages-inactive-baseline-comparison.test.ts`'s roster case asserted **byte-identical** rendered HTML
against a frozen pre-PR2 baseline commit — true when written, because the only thing separating that baseline
from `main` was PR2's ledger-gating logic, which that test exists to prove made no visual change. This PR makes
an approved, intentional visual change to that same render path (header regrouping, belt width), so the literal
byte-identity claim is now correctly false. The assertion was replaced with two narrower, still-real claims:
(1) the actual financial/roster data content (payment status text, specific student IDs) is identical between
baseline and current — no silent data regression; (2) the diff between baseline and current is **exactly** the
two approved Phase 4 markers (`has-[details[open]]:flex-col`, `w-[140px]`) — present in current, absent from
the true baseline — not a surprise, broader divergence. The student-detail half of this same test file is
completely untouched (this PR does not touch that screen).

## What was not verified — reported honestly, not waived

- **Real Android/iOS device verification remains unavailable in this environment** — standing limitation.
- **The ledger-active chips' actual rendered CSS/interaction behavior in a real browser is unreachable today**
  (see "Ledger-active chip evidence" above) — not claimed verified beyond the RSC-HTML markup evidence.
- Cross-browser testing (Firefox/Safari) was not done — Chromium only, consistent with this project's existing
  discipline.
- Screen-reader output was not captured directly (tree-structure/role/checked-state were confirmed via the
  accessibility-relevant HTML attributes, not a live screen-reader transcript).
- The "already created" (duplicate-resubmission) success variant was not separately re-triggered — it renders
  in the exact same container/position as the "new creation" success state and the validation-error state, both
  of which were directly confirmed not cramped by the new layout; its own content block is unchanged by this PR.
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed and unrelated to this
  screen.

## Explicitly out of scope

Student-detail, any other screen, tenant-branding changes, database writes/cleanup outside the isolated test
DB, migrations, deployment, activation.
