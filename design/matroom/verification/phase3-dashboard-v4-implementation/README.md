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

## Harness repair round (this version) — finishing the ledger-active visual verification

Item 5 above (ledger-active screenshots 13–15) shipped with three real gaps, closed here. No
production code changed in this round — every fix is to the disposable render-harness script
itself (created, used, and deleted each time; never part of the shipped diff).

**1. Real app styles and fonts, applied correctly.** The harness previously linked only the
compiled stylesheet and relied on `prefers-color-scheme` emulation; neither the font classes nor a
real dark-mode trigger were present, so text fell back to the browser's default serif and
emulating `dark` had no visible effect. Fixed by:
- Mirroring `/_next/static/{chunks,media}/` under the harness's own static root (copied straight
  from `.next/`, read-only) so the CSS's own relative `url(../media/...)` `@font-face` references
  resolve exactly as they do in production — confirmed via `getComputedStyle(h1).fontFamily` →
  `"ibmPlexSans, \"ibmPlexSans Fallback\""`, not a system serif.
- Applying the exact `<html>` font classes `next/font/local` generates (read directly off a real
  prerendered page, `.next/server/app/en/login.html`), not guessed.
- Applying dark mode through the **actual app mechanism**: a plain `class="dark"` on `<html>` —
  confirmed in `src/lib/theme-preference.ts`'s `toggleTheme()` and the bootstrap script in
  `layout.tsx` (reads `localStorage`, falls back to `prefers-color-scheme`, then toggles exactly
  this class — never a `data-theme` attribute). Confirmed working: computed `background-color` on
  `<body>` in the dark render is `rgb(20, 29, 25)`, the exact `#141d19` `layout.tsx`'s own
  `themeColor` viewport metadata already declares for dark — not an approximation.

**2. Populated ledger-active cards recaptured — 320/390px × light/dark × EN/ES (screenshots
16–22).** Same fixtures as before (two independent debt cards, both long names, both a real
`unknownCount: 1` disclosure from the same §6.2 technique `dashboard-page-ledger-render.test.ts`
already uses) — now rendered with the repairs above. `document.documentElement.scrollWidth −
clientWidth` measured `0` at every one of the 7 captures (both widths, both themes, both locales).

**3. The screenshot-15 horizontal scrollbar — investigated, root-caused, confirmed harness-only.**
Measured directly (`documentElement.scrollWidth` 689 vs `clientWidth` 375 at 390px): `body`,
`<main>`, the Needs-attention container, and all 4 attention cards each measured `scrollWidth ===
clientWidth` — zero overflow at every real content level. The actual source, found by scanning
every element's `getBoundingClientRect()` for one extending past the viewport: an `sr-only`
(visually-hidden) `<span>` — the "Students to contact" table's `Actions` column header — inside
`DataTable`'s existing `overflow-x-auto` wrapper (confirmed correctly sized to 309px, correctly
scrolling its 748px table internally, not the bug). Because that wrapper has no CSS
`position` of its own, an absolutely-positioned descendant like that span is positioned against
the nearest ancestor that DOES establish a containing block — and the bare harness has none above
`<body>`. The real app always has one: `src/app/[locale]/(staff)/layout.tsx:205`'s own content
wrapper is `class="relative flex w-full min-w-0 flex-1 flex-col overflow-x-hidden ..."` —
`position: relative` gives the span a local containing block, and `overflow-x-hidden` is a second,
independent clip. Reproducing that exact wrapper class in the harness (not in `DashboardPage()`
itself — this is harness markup, not page markup) brought `documentElement.scrollWidth −
clientWidth` to `0`. **No component defect exists; no production file was touched.** This also
explains, after the fact, why the full-shell live screenshots (01–12) never showed this: they
always had the real wrapper.

**4. Confirmed on the repaired renders, all 7 captures:** the correct IBM Plex Sans font (not a
serif fallback) at every size; real computed dark colors matching `layout.tsx`'s own declared
dark theme color; both long names wrapping across lines with no clipping; zero horizontal overflow
at the document level (measured, not eyeballed).

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
| 13 | `13-ledger-active-harness-390-light-en-top.png` | Harness (superseded) | First harness attempt — real tone/content correct; font and dark mode were not (see item 16+ below, and "Harness repair round" above for the root cause and fix). Kept as historical evidence, not deleted. |
| 14 | `14-ledger-active-harness-390-dark-en-top.png` | Harness (superseded) | First attempt's dark-mode capture — colors did not actually change (`prefers-color-scheme` emulation, not the app's real `class="dark"` mechanism). Superseded by item 18. |
| 15 | `15-ledger-active-harness-390-light-es-top.png` | Harness (superseded) | First attempt's ES capture — also shows the harness-only horizontal-scrollbar artifact, root-caused and fixed this round. Superseded by item 20. |
| 16 | `16-ledger-active-harness2-390-light-en-top.png` | **Harness (repaired)** | 390px, light, EN — real IBM Plex Sans font, zero measured horizontal overflow, two independent debt cards with long names + `unknownCount` disclosures |
| 17 | `17-ledger-active-harness2-320-light-en-top.png` | **Harness (repaired)** | 320px, light, EN — same, narrowest width, zero measured overflow |
| 18 | `18-ledger-active-harness2-390-dark-en-top.png` | **Harness (repaired)** | 390px, **dark** (real `class="dark"` mechanism), EN — computed `body` background `rgb(20, 29, 25)`, matching `layout.tsx`'s own declared `#141d19` dark theme color exactly |
| 19 | `19-ledger-active-harness2-320-dark-en-top.png` | **Harness (repaired)** | 320px, dark, EN — zero measured overflow |
| 20 | `20-ledger-active-harness2-390-light-es-top.png` | **Harness (repaired)** | 390px, light, **ES** — "Mensualidad fuera de gracia," "Inscripción vencida," correct font, zero overflow, ES text measured directly |
| 21 | `21-ledger-active-harness2-390-dark-es-top.png` | **Harness (repaired)** | 390px, **dark + ES** together, zero measured overflow |
| 22 | `22-ledger-active-harness2-320-dark-es-top.png` | **Harness (repaired)** | 320px, dark + ES, narrowest width, zero measured overflow |

Items 13–22's data (long names, unknown-count) came from the same fixture technique
`dashboard-page-ledger-render.test.ts`'s own §6.2 test already uses (a real `createMonthlyObligation`
read, then `vi.spyOn(duesFactsModule, "listDuesFactsForStudents")` stripping one student's fact) —
not invented for this document.

### What was checked on the real rendered states (items 07–12, 16–22)

- **Wrapping/clipping**: every long name wraps across 2 lines inside its card at 320–390px, in
  both languages, with no horizontal overflow and no truncation — measured, not eyeballed: on the
  repaired harness captures (16–22), `document.documentElement.scrollWidth − clientWidth` was `0`
  at all 7.
- **Font**: `getComputedStyle(h1).fontFamily` resolves to the real vendored `ibmPlexSans` family
  on the repaired harness captures (it resolved to a system serif before the repair — see "Harness
  repair round" above).
- **Dark-mode color**: computed `body` background on the repaired dark captures is `rgb(20, 29,
  25)`, matching `layout.tsx`'s own declared dark `themeColor` (`#141d19`) exactly — applied via
  the app's real `class="dark"` mechanism, not a media-query guess.
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
  integration suite and shown with real data in items 16–22.
- **Awaiting approval's nonzero tone**: the reference has no nonzero render of this card to copy.
  Per the approved plan, it reuses the same accent/gold-soft treatment as "Ready to grade" (the
  nearest existing, already-approved convention) — a recommendation, not an invented policy.
- **Tenant branding**: unchanged, separate from this PR; no `OrganizationBranding`/schema/seed
  change made or proposed here.

## Disclosed limitations

- **Harness dark mode and font (items 13–15)**: resolved this round — see "Harness repair round"
  above and items 16–22. Kept 13–15 as historical evidence of the first attempt, now explained
  rather than open.
- **DIRECTOR role, populated, live**: not captured live or via a dedicated screenshot —
  DIRECTOR's branch-scoped Needs-attention behavior is verified in the integration suite
  (`dashboard-page-ledger-render.test.ts`'s existing tenant/branch-isolation tests), not visually
  re-confirmed here. INSTRUCTOR's card-set exclusion is newly covered by both a real render-test
  assertion (this round) and, structurally, the same live/harness screenshots' absence of debt
  cards for the roles actually captured.

## Historical evidence, preserved

Nothing from any prior round was deleted. Items 01–06 are the first pass's original screenshots,
still valid for what they showed (empty-org structure, section order, light/dark/EN/ES at the page
level). Items 07–12 added populated legacy-state evidence. Items 13–15 were the first ledger-active
harness attempt — real content, incomplete styling, explained rather than removed. Items 16–22 are
the repaired harness evidence that finishes the ledger-active verification this round's review
asked for.
