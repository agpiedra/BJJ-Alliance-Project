# Phase 6 — Branch/organization administration: implementation verification

**Status: implemented, held unmerged.** Branch `feat/phase6-admin-screens-redesign`, from main at `58dca60`.
This is the production implementation of the Phase 6 proposal (`design/matroom/verification/phase6-proposal/`,
v3 approved) — that proposal, its prototypes, and all prior rounds (`v1/`) are untouched by this round.

## Reconciliation finding, confirmed against current main before any change

Per the approved proposal's own reconciliation table, re-verified here against the real components on main
(not stale from when the prototype was built):

| Screen | Finding | Production change |
|---|---|---|
| **Branding** | No layout delta — `LogoUploader`/`ThemePicker` already match. One real, separate stale-comment bug confirmed: `branding/page.tsx:16-17` said the logo actions are "ADMIN-only," but the actual enforcement (`actions.ts:165,262`, `resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"])`) was widened to ADMIN **or** DIRECTOR in PR 1. | **Comment-only fix.** No authorization check touched — `["ADMIN", "DIRECTOR"]` was already the real enforcement before and after this change; the doc comment now says so. |
| **Kiosk Administration** | The proposal's "real, deliberate divergence" — production's reveal-once token mechanism vs. the reference's persistent-link-list idea — is kept as-is, not changed. Confirmed again this round: `kiosk-tokens/page.tsx` never stores or displays a viewable plaintext token outside `RegenerateKioskTokenButton`'s own one-time reveal. | **None.** |
| **Locations** | Owner approved **Option B (reference card grid)**. | **Implemented.** `locations/page.tsx`'s `<table>` replaced with a responsive card grid (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`), same fields (name, address-or-`noAddress`, status `Badge`, added date), same `Badge` component and variant, same data query — no new capability, no new translation key. |
| **Schedule** | No layout delta — `ScheduleCalendarView`'s week grid, Week/List/Day toggle, and "New class" sheet already match. | **None.** |
| **Staff** | No layout delta — member table, invitation table, invite form, and role cards already match. | **None.** |

**Total production diff: 2 files.** `src/app/[locale]/(staff)/admin/locations/page.tsx` (table → card grid) and
`src/app/[locale]/(staff)/admin/branding/page.tsx` (comment-only authorization-doc fix, zero behavior change).
No new translation keys were needed — Locations' card grid reuses the same `adminLocations.*` keys the table
already used (`columns.name` no longer rendered as a column header since the card shows the name directly, same
pattern as the approved reference; `columns.added` reused as a label prefix instead of a column header).

**Promotion-policy configuration**: not implemented. `promotion-policy-requirement-mapping.md` (the proposal's
planning document) was read for context only — no transition rules, branch overrides, or launch placement were
decided here, and no promotion-policy UI exists in this diff.

## Verification — real rendering, isolated test environment

`next dev` on port 3100, `DATABASE_URL` redirected to `TEST_DATABASE_URL` via `scripts/run-against-test-db.ts`
(guard-verified: `postgresql://.../alliance_bjj_test`, confirmed distinct from the dev DB), logged in through
the real `/login` form as the seeded `admin@alliancecr.com` (ADMIN) account. Stopped before running the
integration suite, so the two never ran concurrently against the same test database.

- **Locations, the one screen with a real markup change** — verified at all 4 widths:
  - Desktop (1280px): card grid renders 3 columns, same fields as the former table (`01-locations-desktop.png`).
  - 960px: reflows to 2 columns (`sm:grid-cols-2`, confirmed — 960px falls between Tailwind's `sm` (640) and `lg`
    (1024) breakpoints). Page-level overflow (`document.documentElement.scrollWidth - window.innerWidth`): `0`.
  - 390px: single column. Page-level overflow: `-15` (no overflow, more conservative than 0 — same measurement
    convention established in the proposal round).
  - 320px: single column, full content present (name, status badge, address, added date, plus the full add-location
    form below) — no fields dropped at the narrow width (`02-locations-320.png`). Page-level overflow: `-15`.
  - **Keyboard**: tabbed through for real at 320px — menu button (real shipped mobile toggle, visible focus ring)
    → top-bar icons → account menu → Name input → Address input, each with a real `outline: solid 2px` focus
    ring. The card grid's cards themselves contain no interactive elements (same as the table rows they replaced),
    confirmed by the Tab sequence skipping straight from the last top-bar control to the form fields below the grid.
  - **Spanish** (`04-locations-es.png`, desktop): nav label ("Sedes"), eyebrow, heading, subtitle, card section
    heading, status badges ("Activa"), "Agregada" date prefix, and the add-location form all render real
    `messages/es.json` strings — no prototype/English leakage.
  - **Theme note** (`03-locations-theme-note.png`): this organization's seeded branding uses a dark sidebar/panel
    palette regardless of the `data-theme` attribute (confirmed: setting `data-theme="light"` directly on
    `<html>` produced no visible change) — this is the organization's own configured branding color, not a
    light/dark mode toggle, and is unrelated to and unaffected by this round's change. Not a regression; disclosed
    so the capture isn't mistaken for a broken theme toggle.
- **Branding, Schedule, Staff, Kiosk Administration** — each loaded once at desktop width to confirm no
  regression from the branding comment-only change and to reconfirm the "no layout delta" finding against the
  live app, not just the prototype (`05`–`08`). All four render identically to what the proposal's reconciliation
  predicted: Branding's logo/theme cards, Schedule's populated week grid with the type-color legend, Staff's
  team table (including the Owner's own row showing "You can't change your own access" with no action buttons,
  confirmed live), and Kiosk's two-academy layout with the real reveal-once `Regenerate token` buttons and empty
  check-in/queued-review sections.
- **Console**: no errors on any page beyond the pre-existing, unrelated `favicon.ico` 404.

## Disclosed limitations

- Only Locations was verified at all 4 widths with the full width/theme/locale/keyboard matrix — the other 4
  screens received one desktop-width confirmation pass each, since this round made no code change to them and
  the proposal's own prototype-level verification already covered their responsive behavior; a full real-app
  pass on all 4 widths for those 4 screens was judged unnecessary given zero production diff.
- DIRECTOR/INSTRUCTOR role logins were not re-exercised this round (ADMIN-only verification) — all 5 screens'
  role gates are unchanged from main, and were already source-verified in the proposal round
  (`phase6-proposal/README.md`'s Inventory table, file:line cited there).
- Dark/light theme toggle itself was not exercised beyond the one disclosed note above (this org's branding masks
  it) — not a regression introduced by this change.

## Checks

- `tsc --noEmit`: clean.
- ESLint on both changed files: clean.
- `pnpm test:unit`: 117 files / 1658 tests passed.
- `pnpm test:integration`: 149 files / 1922 tests passed — run after the isolated dev server used for browser
  verification was stopped, to avoid running concurrently against the same test database.
- `git status --porcelain src/ prisma/`: confirmed scoped to exactly the two files above, both before and after
  commit.

## Preserved

`design/matroom/preview/phase6-app/`, `design/matroom/preview/phase5-app/`, `design/matroom/preview/phase4-*`,
and `design/matroom/verification/phase6-proposal/` (including `v1/` and the promotion-policy mapping document)
are untouched by this round — this document and its screenshots live in a new, separate directory.

The unresolved `tests/browser/shell-navigation.test.ts:227` CI failure and PR #111's diagnostics capture are
untouched — nothing in this round modified that test, that PR, or any CI configuration.

No dev-DB changes, migrations, activation, or deployment accompany this round. Held unmerged for review.
