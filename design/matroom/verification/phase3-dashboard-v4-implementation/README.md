# Dashboard v4 — visual correction: production implementation & verification

**Branch**: `feat/phase3-dashboard-reconciled-v4`, forked from `main`.
**Status**: implemented, verified, held unmerged per instruction. PR #119 untouched throughout.

Implements the bounded Dashboard-only plan against
`MATROOM-UI-proposal-2026-10/screens/Dashboard-Proposed.dc.html`. Scope: layout/visual treatment
of the header, "Needs attention," and "This week" sections only. No query, authorization,
financial-state, pagination, promotion, dismissal, or navigation-destination change.

## Correction round (this version) — what changed since the first verification pass

The original verification pass (git history below) made six claims that didn't hold up to closer
review. Each is corrected here, in code and in this document; nothing from the first pass is
deleted — see "Historical evidence, preserved" at the bottom.

1. **Baseline-comparison region boundary now guarded.** The test used to call `.indexOf()` on the
   `">Weekly attendance<"` marker directly — a missing or duplicated marker would have silently
   picked the wrong split point instead of failing. `uniqueMarkerIndex()` now throws explicitly on
   0 or 2+ occurrences, with its own 3 dedicated tests proving both failure modes and the normal
   case.
2. **Adults/kids breakdown now asserted exactly, with distinct counts.** The fixture used to have
   two equal counts (1 adult, 0 kids elsewhere), so a category swap couldn't have been caught by a
   `.toContain()` check on each number. The fixture now seeds 2 adults and 1 kid (unequal, and
   non-vacuously checked as unequal), and the assertion is `toBe("2 adults · 1 kid")` — exact
   string equality, not two independent substring checks.
3. **Baseline-comparison claims reconciled to what the test's own mocks can prove.** The comment
   claimed "everything downstream is byte-identical" without noting that `BrandingReminderCard` is
   mocked to `() => null` in that file — so the reminder's real content and v4's approved move
   (below the data sections) were never actually exercised there, on either side. The comment now
   says so explicitly, and names where the real gate/position IS covered (next point). The
   "second, additive comparison" wording is also gone — the diff replaced the original Phase-3
   version of this test with the current one; it was never kept alongside it.
4. **Real coverage added for what wasn't covered**, confirmed absent by grep before writing each:
   - `tests/integration/dashboard-page-branding-reminder-placement.test.ts` (new file) — the real
     (unmocked) `BrandingReminderCard`, its ADMIN/DIRECTOR + no-logo + not-dismissed gate, its new
     position (after every data section, before Administration), and that INSTRUCTOR/logo-set/
     dismissed all still hide it.
   - `dashboard-page-ledger-render.test.ts`: an INSTRUCTOR fixture (none existed before — only
     ADMIN and DIRECTOR did) proving the Needs-attention card set excludes every debt/ledger card
     and the analytics link, in both ledger modes, while keeping Ready-to-grade/Awaiting-approval
     and the pending-students link.
   - Same file: two new tests with **real nonzero** Ready-to-grade and Awaiting-approval data (a
     genuinely stripe-eligible student at WHITE's 30-attendance threshold; a real `PENDING`
     student) — the prior claim that "all action tones are covered" rested on tests that only
     exercised debt tiles and the zero case for action tiles, never a real nonzero action card.
5. **New visual evidence for populated cards** — long names, an `unknown` disclosure, narrow
   widths, Spanish, dark mode — see the evidence table below, each row labeled live or harness.
6. **This document and the PR description rewritten** to match exactly what's demonstrated: the
   "pixel-exact token reuse" claim is narrowed to what it actually proves (matching *color token*
   values, not full visual equivalence — that's the screenshots' job); live keyboard-focus
   evidence is now explicitly real `Tab` traversal, distinguished from the first pass's
   programmatic `.focus()` call.

## What changed (code)

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
- `tests/integration/dashboard-page-ledger-render.test.ts`:
  - The four `statTile*` helpers resolve a card via `jsdom` instead of regexing `StatTile`'s old
    markup — every pre-existing call site/assertion unchanged, only the markup they read moved.
  - **This round**: added an `instructor` fixture + 2 tests (legacy and ledger-active) proving the
    INSTRUCTOR card set; added a dedicated `actionOrg` fixture + 2 tests proving real nonzero
    Ready-to-grade and Awaiting-approval cards (tone, value, link).
- `tests/integration/dashboard-page-inactive-baseline-comparison.test.ts`:
  - Replaced Phase 3's own version of this comparison with one that re-proves the same
    financial-content equivalence (same tiles, same values, same notes) plus v4's header/card
    changes, while keeping byte-for-byte proof for everything from "Weekly attendance" onward.
  - **This round**: `uniqueMarkerIndex()` guard (+ 3 tests) replaces raw `.indexOf()`; the fixture
    now seeds a KIDS-track student alongside the two existing ADULT ones (2 adults, 1 kid); the
    breakdown assertion is now exact-string, not two substring checks; the comment documents this
    file's `BrandingReminderCard` mock and points to the file that covers the real component.
- `tests/integration/dashboard-page-branding-reminder-placement.test.ts` (**new, this round**): the
  real `BrandingReminderCard`, its gate, and its v4 position — see item 4 above.
- `package.json` / lockfile: added `@types/jsdom` (devDependency only — `jsdom` itself was already
  a runtime devDependency).

## What was verified, and how

**Typecheck/lint/build**: `tsc --noEmit`, `eslint` (changed files), `next build --turbopack` — all
clean, re-run after this round's changes.

**Unit tests**: `pnpm test:unit` — 1707/1707 passed, unaffected.

**Integration tests, against the isolated test database (`localhost:5433`, never the dev
database)**: `pnpm test:integration` — **153/153 files, 1958/1958 tests passed** (up from
152/1947 in the first pass — +1 file, +11 tests this round), confirming no unrelated regression.
No dev-database writes, no migrations, no production activation.

**Live browser verification** (Playwright/Chromium, two separate real dev-server sessions on port
3100 against the isolated test database — `DATABASE_URL` overridden, dev database on 5432 never
touched): two real academies were each registered through `/register-academy`, approved via the
project's own `scripts/approve-organization.ts` (run against the test DB only) as
`superadmin@alliancecr.com`, and had their invitation accepted through `/accept-invitation` — a
genuinely registered/approved/accepted user each time, not a seeded login.

**Render-harness verification** (this round, for what is architecturally unreachable live): the
exact same `DashboardPage()` function the integration tests import, called directly with real DB
fixtures and a real ledger-active mock, its output written to a static HTML file and opened in a
real browser with the project's actual compiled CSS. This is necessary, not a shortcut:
`src/lib/dues/ledger/activation.ts`'s own doc comment states `inactiveLedgerActivation` is
hardcoded `isActive: async () => false` in production — "no activation infrastructure is built
here" — so a ledger-active dashboard cannot be reached by any currently-running server, dev
included, only by this same mock technique the integration tests already use.

### Evidence table — every screenshot, source labeled

| # | File | Source | What it shows |
|---|---|---|---|
| 01 | `01-dashboard-1280-light-en.png` | Live | Full page, 1280px, system dark theme, EN, empty org |
| 02 | `02-dashboard-1280-light-en.png` | Live | Full page, 1280px, light theme (toggled), EN, empty org |
| 03 | `03-dashboard-390-light-en.png` | Live | Full page, 390px, light, EN — cards reflow to 1 column |
| 04 | `04-dashboard-320-light-en-top.png` | Live | Viewport, 320px, light, EN — no clipping/overflow at the narrowest width |
| 05 | `05-dashboard-1280-light-es-top.png` | Live | Viewport, 1280px, light, ES — "Panel de control," "Requiere atención," "Esta semana," correct date format |
| 06 | `06-dashboard-1280-dark-es.png` | Live | Full page, 1280px, dark, ES |
| 07 | `07-populated-390-light-en-top.png` | **Live** | 390px, system dark theme, EN — **real nonzero** "Overdue monthly dues" (1, long name "Alejandro Sebastian Jimenez-Villalobos") and "Awaiting approval" (1, link present) |
| 08 | `08-populated-320-dark-en-top.png` | **Live** | 320px, dark, EN — same populated cards, narrowest width, long name wraps cleanly, no clipping |
| 09 | `09-populated-390-light-en-top.png` | **Live** | 390px, light theme, EN — same populated cards |
| 10 | `10-populated-390-light-es-top.png` | **Live** | 390px, light, **ES** — "Mensualidad atrasada," "Pendientes de aprobación," the same real long name, ES text measured directly, not inferred from the EN screenshots |
| 11 | `11-populated-390-dark-es-top.png` | **Live** | 390px, **dark + ES** together, same populated cards |
| 12 | `12-populated-pending-link-real-tab-focus-dark-es.png` | **Live** | The "Ver estudiantes pendientes" link focused via **6 real sequential `Tab` key presses** (not `.focus()`) from a blurred start state — visible 2px solid outline, confirmed via `document.activeElement` matching the exact link |
| 13 | `13-ledger-active-harness-390-light-en-top.png` | **Harness** | 390px, light, EN — ledger-active, two independent debt cards, each with a long name AND a real `unknownCount` disclosure (`· 1 unknown`) |
| 14 | `14-ledger-active-harness-390-dark-en-top.png` | **Harness, limited** | Same render; dark-mode color-scheme emulation did not visibly change colors — the single extracted CSS chunk used for this harness doesn't reliably carry the dark-mode block (see Disclosed limitations) |
| 15 | `15-ledger-active-harness-390-light-es-top.png` | **Harness** | 390px, light, **ES** — "Mensualidad fuera de gracia," "Inscripción vencida," both long names, both "1 sin confirmar" |

Items 13–15's data (long names, unknown-count) came from the same fixture technique
`dashboard-page-ledger-render.test.ts`'s own §6.2 test already uses (a real `createMonthlyObligation`
read, then `vi.spyOn(duesFactsModule, "listDuesFactsForStudents")` stripping one student's fact) —
not invented for this document.

### What was checked on the real rendered states (items 07–15)

- **Wrapping/clipping**: every long name wraps across 2 lines inside its card at 320–390px, in
  both languages, with no horizontal overflow and no truncation.
- **Card spacing**: independent border/radius/gap preserved at every width and in the populated
  (nonzero) state, not just the empty-org renders from the first pass.
- **Link focus**: real `Tab` traversal (item 12) reaches the preserved link as its own stop, with
  a visible outline, confirmed by `document.activeElement` — not inferred from a programmatic
  `.focus()` call (that technique was used in the first pass's screenshots and is superseded here
  for this specific claim).
- **Contrast**: computed directly against the SAME tone classes the populated cards use
  (`bg-bad-soft`/`border-bad-line`/`bg-brand-gold`/`border-brand-gold`), both themes — see the
  numbers below. This is evidence about the color tokens, not a substitute for looking at the
  populated screenshots themselves for layout/spacing/typography.

Computed (WCAG relative-luminance formula), both themes: label-on-neutral-card 5.91:1 (light) /
7.77:1 (dark); value-on-neutral-card 12.44:1 / 12.72:1; label-on-bad-soft 7.31:1 (light) / 5.37:1
(dark); value-on-bad-soft 10.22:1 / 11.91:1 — all pass WCAG AA (4.5:1) comfortably. **This proves
the color tokens are individually accessible — it does not by itself prove full visual
equivalence with the reference; that claim rests on the screenshots, compared side-by-side with
`design/matroom/verification/phase2-reconciliation/october-renders/dashboard-proposed.png`, not on
token-value equality alone.** Separately, computed `bg-bad-soft` = `rgb(242, 229, 227)` /
`border-bad-line` = `rgb(210, 61, 45)` do match the reference's own "Overdue dues" card
(`#f2e5e3` / `#d23d2d`) exactly — stated here as a fact about those two specific color tokens, not
as a claim that the whole card is visually identical to the reference.

## Necessary adaptations from the reference

- **Debt cards**: the reference shows one "Overdue dues" card; this app's ledger-inactive state
  shows "Overdue monthly dues," and a ledger-active organization shows two independent cards
  (Monthly past grace / Signup past due) in its place — required by this app's existing
  independent-debt-facts rule (not present in the reference), verified unchanged in the
  integration suite and shown with real data in items 13/15.
- **Awaiting approval's nonzero tone**: the reference has no nonzero render of this card to copy.
  Per the approved plan, it reuses the same accent/gold-soft treatment as "Ready to grade" (the
  nearest existing, already-approved convention) — a recommendation, not an invented policy.
- **Tenant branding**: unchanged, separate from this PR; no `OrganizationBranding`/schema/seed
  change made or proposed here.

## Disclosed limitations

- **Harness dark mode (item 14)**: the CSS chunk extracted from the production build for the
  render-harness screenshots doesn't visibly apply dark-mode colors under emulated
  `prefers-color-scheme: dark` — likely split across more than one build chunk, not fully isolated
  by this ad-hoc extraction. This is a limitation of this verification technique, not a claim
  about production: the SAME tone classes (`bg-bad-soft` etc.) were already confirmed to render
  correctly in dark mode, live, in the first pass's contrast measurements, against the real app.
- **Harness font**: the harness screenshots (13–15) show a generic serif fallback instead of IBM
  Plex Sans — the vendored font files live under a separate `/_next/static/media/` path not copied
  into this harness. Cosmetic only; typography itself is not part of what items 13–15 are meant to
  prove (card structure, tone, wrapping, unknown-count disclosure are).
- **DIRECTOR role, populated, live**: not captured live or via a dedicated screenshot this round —
  DIRECTOR's branch-scoped Needs-attention behavior is verified in the integration suite
  (`dashboard-page-ledger-render.test.ts`'s existing tenant/branch-isolation tests), not visually
  re-confirmed here. INSTRUCTOR's card-set exclusion is newly covered by both a real render-test
  assertion (this round) and, structurally, the same live/harness screenshots' absence of debt
  cards for the roles actually captured.

## Historical evidence, preserved

Nothing from the first verification pass was deleted. Items 01–06 above are that pass's original
screenshots, still valid for what they showed (empty-org structure, section order, light/dark/EN/ES
at the page level) — items 07–15 extend, not replace, that evidence with populated states this
round's review asked for specifically.
