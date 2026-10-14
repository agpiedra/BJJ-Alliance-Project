# Dashboard v4 — visual correction: production implementation & verification

**Branch**: `feat/phase3-dashboard-reconciled-v4`, forked from `main`.
**Status**: implemented, verified, held unmerged per instruction. PR #119 untouched throughout.

Implements the bounded Dashboard-only plan (corrected per the user's final approval round) against
`MATROOM-UI-proposal-2026-10/screens/Dashboard-Proposed.dc.html`. Scope: layout/visual treatment
of the header, "Needs attention," and "This week" sections only. No query, authorization,
financial-state, pagination, promotion, dismissal, or navigation-destination change.

## What changed

- `src/app/[locale]/(staff)/dashboard/page.tsx`:
  - New local `AttentionCard` component (reuses `Card`/`CardContent`, not `StatRow`) — the
    reference's own "Needs attention" cards are independently bordered/rounded/spaced, not a
    joined strip. `StatRow`/`StatTile` are untouched for every other caller on this page and
    elsewhere in the app.
  - "Needs attention" moved to the first content section, cards in reference order (debt first,
    then Ready to grade, then Awaiting approval), each tone-conditional on its own count
    (`bad`/`accent`/neutral), zero always neutral.
  - The two ledger debt facts (`monthlyPastGrace`/`signupPastDue`) stay two independent cards,
    never merged — same data, same `unknownCount` disclosure, same role gate.
  - The pending-approvals control moved from a standalone text+link row into its own "Awaiting
    approval" card: same `pendingCount` query, same `/students?status=PENDING` destination, same
    link text, available at zero — the link is its own focusable element inside the card, the
    card itself is not a link, no nested interactive controls.
  - General-activity row collapsed into a 2-tile "This week" `StatRow` (unchanged component):
    kids/adults counts moved from two peer tiles into one note on "Active students"; Check-ins
    keeps its existing up/down delta unchanged.
  - Subtitle replaced: plain date + location (reusing the already-computed `eyebrowDate` +
    `academyLabel`), replacing the old count-restating sentence and the separate mono eyebrow line.
  - `BrandingReminderCard` moved from directly under the header to below every data section
    (before the ADMIN-only shortcuts card) — same `showBrandingReminder` gate, same dismiss action.
  - `/dashboard/analytics` link preserved, relocated next to the "Needs attention" heading, same
    `canViewOverduePayments` gate.
- `messages/en.json` / `messages/es.json`: added `panel.subtitle`, `panel.thisWeek.heading`,
  `panel.stats.activeStudents.breakdown` (ICU plural, EN & ES), `panel.stats.pendingApproval.label`;
  shortened `panel.stats.weeklyAttendance.label` to "Check-ins"/"Asistencias". The old
  `panel.sub`/`pendingApprovals` keys are **retained, unreferenced** by the current page —
  deleting them broke `dashboard-page-inactive-baseline-comparison.test.ts`'s pre-PR3 baseline
  render, which still calls them against this same shared messages file; removing them is a
  separate, later cleanup, not part of this visual-only change.
- `tests/integration/dashboard-page-ledger-render.test.ts`: the four `statTile*` helpers now
  resolve a card via `jsdom` (already an installed dependency) instead of regexing `StatTile`'s
  old markup — every call site and assertion is unchanged, only the markup the helpers read moved.
- `tests/integration/dashboard-page-inactive-baseline-comparison.test.ts`: added a second,
  additive comparison widening the "restructured by approval" region to the header/stat-tile area
  v4 touches, re-proving the same financial-content equivalence the original Phase 3 test proved
  (same tiles, same values, same notes) plus the new header/card changes — `after` the "Weekly
  attendance" marker stays genuinely byte-for-byte. The original Phase-3-only test is retired with
  an explanatory comment (its own boundary claim — nothing before the stat region moved — no
  longer holds, by design, not by regression); nothing it verified is left unverified.
- `package.json` / lockfile: added `@types/jsdom` (devDependency only — `jsdom` itself was already
  a runtime devDependency).

## What was verified, and how

**Typecheck/lint/build**: `tsc --noEmit`, `eslint` (changed files), `next build --turbopack` — all
clean.

**Unit tests**: `pnpm test:unit` — 1707/1707 passed, unaffected (dashboard page has no unit-test
coverage; its tests are integration-level).

**Integration tests, against the isolated test database (`localhost:5433`, never the dev
database)**: `pnpm test:integration` — **152/152 files, 1947/1947 tests passed**, including the
two reconciled dashboard files (20 tests total) and every other file in the suite, confirming no
unrelated regression. No dev-database writes, no migrations, no production activation.

**Live browser verification** (Playwright/Chromium, real dev server on port 3100 against the
isolated test database — `DATABASE_URL` overridden, dev database on 5432 never touched): a real
academy was registered through `/register-academy`, approved via the project's own
`scripts/approve-organization.ts` (run against the test DB only) as `superadmin@alliancecr.com`,
and its invitation accepted through `/accept-invitation` — a genuinely registered/approved/accepted
user, not a seeded login. Screenshots in `screenshots/`:

| # | File | What it shows |
|---|---|---|
| 01 | `01-dashboard-1280-light-en.png` | Full page, 1280px, system dark theme, EN |
| 02 | `02-dashboard-1280-light-en.png` | Full page, 1280px, light theme (toggled), EN |
| 03 | `03-dashboard-390-light-en.png` | Full page, 390px, light, EN — cards reflow to 1 column |
| 04 | `04-dashboard-320-light-en-top.png` | Viewport, 320px, light, EN — no clipping/overflow at the narrowest width |
| 05 | `05-dashboard-1280-light-es-top.png` | Viewport, 1280px, light, ES — "Panel de control," "Requiere atención," "Esta semana," correct date format |
| 06 | `06-dashboard-1280-dark-es.png` | Full page, 1280px, dark, ES |

Confirmed directly against the real rendered page (not assumed from code):
- Section order: header (plain date+location) → Needs attention (3 cards: Overdue monthly
  dues / Ready to grade / Awaiting approval, the latter with its preserved link) → This week (2
  cards) → charts/promotion/contact (unchanged) → branding reminder → Administration (ADMIN-only).
- Cards are independently bordered/rounded/spaced at every width tested; flex-wrap reflows to 1
  column at 390/320px with no forced 3/4-column layout and no text clipping.
- EN/ES both render correctly, including the ICU-pluralized "0 adults · 0 kids" / "0 adultos · 0
  niños" breakdown and the shortened "Check-ins"/"Asistencias" label.
- The "View pending students" link is a real, separately focusable `<a>` (confirmed via
  `document.activeElement` after `.focus()`) with a visible solid focus outline
  (`rgb(29, 57, 43)`), present at `pendingCount === 0` — not a whole-card link, no nested
  interactive controls (confirmed via the accessibility snapshot: the card itself has no
  interactive role).
- Token reuse confirmed pixel-exact against the reference: computed `bg-bad-soft` =
  `rgb(242, 229, 227)` / `border-bad-line` = `rgb(210, 61, 45)` match
  `Dashboard-Proposed.dc.html`'s own "Overdue dues" card (`#f2e5e3` / `#d23d2d`) exactly.
- Contrast (computed, WCAG relative-luminance formula, both themes): label-on-neutral-card
  5.91:1 (light) / 7.77:1 (dark); value-on-neutral-card 12.44:1 / 12.72:1; label-on-bad-soft
  7.31:1 (light) / 5.37:1 (dark); value-on-bad-soft 10.22:1 / 11.91:1 — all pass WCAG AA (4.5:1)
  comfortably in both themes.

**Side-by-side against the reference**: `design/matroom/verification/phase2-reconciliation/
october-renders/dashboard-proposed.png` (unmodified render from the prior reconciliation pass, same
source file, reused rather than re-rendered) remains the comparison baseline — card
independence/spacing, "Needs attention" position, "This week" heading, and setup-reminder position
now match it; tenant gold/navy branding (separate, undecided per the reconciliation's §3) is the
only remaining color difference, as already disclosed.

## Necessary adaptations from the reference

- **Debt cards**: the reference shows one "Overdue dues" card; this organization's ledger-inactive
  state shows "Overdue monthly dues," and a ledger-active organization shows two independent cards
  (Monthly past grace / Signup past due) in its place — required by this app's existing
  independent-debt-facts rule (not present in the reference), verified unchanged in the integration
  suite.
- **Awaiting approval's nonzero tone**: the reference has no nonzero render of this card to copy.
  Per the approved plan, it reuses the same accent/gold-soft treatment as "Ready to grade" (the
  nearest existing, already-approved convention) — a recommendation, not an invented policy.
- **Tenant branding**: unchanged, separate from this PR; no `OrganizationBranding`/schema/seed
  change made or proposed here.

## Disclosed limitations

- **Nonzero debt/action tones, live**: not captured live (this fresh test organization had no
  overdue/ready-to-grade/pending fixtures to produce a nonzero state without additional,
  out-of-scope fixture setup). The tone colors themselves were confirmed live via computed-style
  probing of the real rendered utility classes (table above); the nonzero *card with real data* is
  confirmed via the render-test harness instead — `dashboard-page-ledger-render.test.ts`'s
  `statTileHasFlag`/`statTileCount`/`statTileNote` assertions (15/15 passing), which render the
  actual page with real nonzero fixtures and assert the tone class and values directly. Disclosed
  as the task's own instructions anticipate, not presented as live-verified.
- **Ledger-active variant, DIRECTOR role, INSTRUCTOR role**: not captured live, for the same
  reason (this test organization is ADMIN, ledger-inactive by default). Verified instead via the
  same render-test harness, which exercises all three (ledger-active debt-pair cards, DIRECTOR
  branch-scoping, and — pre-existing, unchanged by this PR — INSTRUCTOR's narrower card set) with
  real fixture data and role-scoped sessions.
- **Mobile dark theme and ES at 320/390px specifically**: not separately screenshotted (light/EN
  and light/ES and dark/EN and dark/ES were each captured at least once, at complementary widths,
  per the table above) — the underlying CSS is width-independent of theme/locale (same Tailwind
  classes render regardless of `data-theme`/`lang`), so this is a reasoned inference from the
  combinations actually captured, not a live-verified cell of its own.
