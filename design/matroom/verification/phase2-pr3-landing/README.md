# Phase 2 PR 3 — Landing: D2 serif heading, D7 copy, footer, belt-progress fit — verification

Real implementation, not a proposal. Verified against the actual running app (`pnpm dev`), not the static
`design/matroom/preview/phase2-app/landing.html` prototype — that file is the approved reference this PR
implements against, not evidence of this PR's own behavior.

## Correction round (2026-10-14/15) — a stale pre-fix screenshot, found and fixed

The original capture pass took `01`–`04` (1280 light/dark EN, 1280 light ES, 390 dark ES) *before* the
320px-overflow bug below was found and fixed, then took the fixed `05` (320 light EN, re-captured after the
fix) and `06` (390 light EN, captured fresh after the fix). This left `04` showing the **pre-fix** belt layout
(wide, forced single-column — no `className` applied yet) side by side with `06`'s **post-fix** layout
(compact, two-column) at the same reported 390px viewport, for no code reason — flagged correctly: the
committed source applies one unconditional `className="w-40 sm:w-56 lg:w-80"` to every `<BeltGraphic>` call
regardless of theme/locale, so current code cannot produce that difference. `01`–`03` were also captured before
the fix, but are **not** affected by it: the fix's `lg:w-80` (320px) exactly matches the belt's previous
unconstrained default width, and 1280px is within the `lg` breakpoint, so those three are pixel-identical
whether captured before or after.

**Resolution:**
- The original pre-fix `04` PNG was recovered from the already-committed blob (`git show
  356842e:design/.../screenshots/04-landing-390-dark-es.png`) and preserved, unmodified, as
  `04-landing-390-dark-es-prefix-historical.png` — labeled accurately as historical, pre-fix evidence, not
  current behavior.
- `04-landing-390-dark-es.png` was **re-captured against the final committed head** (`356842e`, the only commit
  on this branch — no production code changed by this correction round) and now matches `06`'s layout.
- A new `07-landing-320-light-es.png` was captured (320px × ES was not previously covered; EN was, in `05`).
- No production code was changed in this correction round — the mismatch was a stale-screenshot artifact of
  capture order, not a defect in the committed `356842e` source, confirmed by direct measurement (next section).

## What changed

- `src/app/[locale]/page.tsx`:
  - Hero `<h1>` and the progress-section `<h2>` gain `font-display font-normal` — D2's self-hosted Noto Serif
    at Regular (400), same opt-in mechanism and weight override as the merged register-academy/Login PRs
    (`CardTitle`'s baked-in weight doesn't apply here — these are plain headings, not `AuthCard` titles — but
    the vendored font file is still a single static Regular instance, so `font-normal` is still needed over
    the previous `font-bold`/`font-semibold`).
  - A new `<footer>` with exactly two real links — sign in (`/${locale}/login`), register your academy
    (`/${locale}/register-academy`) — per D7's approved scope (`design/matroom/DESIGN.md` §D7: "a footer with
    real destinations only"). No invented About/Blog/social links.
  - `BELT_PROGRESSION`/`BeltGraphic` section: **unchanged in structure** — still the real woven-SVG component
    with real per-rank colors and `tBelt(code)` labels, not the prototype's flat colored chips (per the
    proposal's own explicit direction: "Keep `BeltGraphic`, do not replace it with flat chips"). One real fix
    found and applied during this PR's own 320px verification pass (see "Bug found and fixed" below): each
    `<BeltGraphic>` call gains a responsive `className="w-40 sm:w-56 lg:w-80"`, using the component's own
    existing, documented sizing mechanism — `lg:w-80` (320px) matches the previous unconstrained default
    exactly, so desktop is visually unaffected.
  - Everything else — `BrandBanner`, the 3 highlight `Card`s, the hero CTA button/link, section order,
    `locale` handling — byte-for-byte unchanged.
- `messages/en.json` / `messages/es.json` — revises existing `home.*` keys only (no new namespace):
  `home.heading`, `home.subheading`, `home.highlights.family/progress/schedule`, `home.belts.description`
  (near-identical wording only), plus one new key, `home.footer.signIn` (the footer's "Sign in" / "Iniciar
  sesión" label; the footer's "Register your academy" link reuses the existing `home.cta` key verbatim, since
  both strings are the same real action — no duplicate copy added for an identical meaning).

## Copy source — D7, approved 2026-10-13

Every EN/ES string above is copied verbatim from `design/matroom/verification/phase2-persuade-proposal/README.md`
§3's approved table (`design/matroom/DESIGN.md` D7: "Approved 2026-10-13"), not reworded in this PR. No
financial-reporting language, no "configure your own promotion criteria" claim, no specific multi-branch
pricing — the same deferred-scope exclusions the proposal itself documented.

## Bug found and fixed mid-implementation — disclosed, not glossed over

Verifying at 320px (never done for this screen before this PR — confirmed absent from the project's existing
verification matrices) surfaced a real pre-existing defect, unrelated to this PR's own copy/font/footer changes:
`BeltGraphic`'s default `lg` size renders a 320px-wide SVG with no responsive constraint, which overflows a
320px viewport's padded content area (272px available after `p-6`) and bleeds past the right edge instead of
wrapping. Fixed via the component's own existing, already-documented `className` prop (`belt-graphic.tsx`'s own
doc comment: "a caller's className sizes the belt itself... must reach the `<svg>`") — no change to the shared
`BeltGraphic`/`BeltVisual` component itself, so every other caller (student profile, kiosk/portal confirmation
screens) is unaffected.

## What was verified, and how

Against the isolated test database (`alliance_bjj_test`, port 5433 — never the dev database), real desktop
Chromium (Playwright), `pnpm dev` with `DATABASE_URL` overridden to the isolated test DB:

- `pnpm typecheck` — clean (0 errors).
- `pnpm lint` — clean (0 errors; 23 pre-existing warnings in unrelated test files, untouched by this PR).
- `pnpm test:unit` — 1707/1707 passed, including `tests/unit/messages-key-parity.test.ts` (confirms the new
  `home.footer.signIn` key and all revised `home.*` keys stay in parity between `en.json`/`es.json`).
- No existing test file covers `src/app/[locale]/page.tsx` directly (confirmed by search) — nothing to update,
  nothing broken by omission.
- **Font loading/weight, real browser, `getComputedStyle` on the actual rendered `<h1>`/`<h2>`** (not inferred
  from source): both resolve to `font-family: notoSerif, "notoSerif Fallback"`, `font-weight: 400` — confirms
  the vendored Noto Serif file at the correct weight, same as the merged register-academy/Login PRs.
- **Visual, real browser, full-page screenshots:**
  - `01-landing-1280-light-en.png` — 1280px, light, EN — serif hero/progress headings, revised highlight-card
    copy, real belt graphics with correct rank-bar/stripe semantics (white through brown show 4 white tapes on
    a black bar; black belt shows 0 tapes and its real red bar color, matching `BELT_PROGRESSION`'s own data),
    footer with both real links.
  - `02-landing-1280-dark-en.png` — 1280px, dark — correct dark-theme tokens throughout, footer border/links
    visible and legible.
  - `03-landing-1280-light-es.png` — 1280px, ES — revised copy fits without truncation or awkward wrapping;
    belt labels correctly localized (Blanco/Azul/Morado/Café/Negro).
  - `04-landing-390-dark-es.png` — 390px, dark, ES, **re-captured against final head `356842e`** (correction
    round): compact two-column belt layout, matching `06`'s layout at the same viewport. Measured directly
    (`getBoundingClientRect`/`window.innerWidth`), not estimated: `window.innerWidth` 390, `document.
    documentElement.scrollWidth` 375 (no horizontal overflow), all 5 belt `<svg>`s render at 160px width
    (the `w-40` base class, since 390px is below Tailwind's 640px `sm` breakpoint), rightmost belt edge at
    232px — well inside the viewport. No clipping, footer links fully visible.
  - `04-landing-390-dark-es-prefix-historical.png` — the **original, pre-fix** capture (recovered unmodified
    from the committed blob at `356842e`) — kept only as historical evidence of the capture-order artifact
    described above, not as current behavior. Do not treat this file as representing the shipped page.
  - `05-landing-320-light-en.png` — 320px, EN, **after the belt-overflow fix**: all 5 belts fully contained
    with no horizontal overflow (the pre-fix state — belts bleeding past the right edge — was observed directly
    in this session, not separately retained as a file; this screenshot is the current, corrected branch's
    output).
  - `06-landing-390-light-en.png` — 390px, EN — belts wrap 2-per-row, no overflow; the circular "N" badge
    visible in this and the 320px/dark screenshots is Next.js's own dev-mode build-activity indicator
    (bottom-left corner overlay), not part of the page — it does not render in a production build.
  - `07-landing-320-light-es.png` — 320px, ES, **final head `356842e`** (correction round — 320×ES was not
    previously captured; `05` covers 320×EN). Measured directly: `window.innerWidth` 320, `scrollWidth` 305
    (no overflow), belt `<svg>`s at 160px width, rightmost edge at 232px, `h1.scrollWidth` does not exceed
    `h1.clientWidth` (no text clipping). Heading/body copy wraps cleanly across 2–4 lines with no truncation.
- **Keyboard, real `Tab` key presses from a fresh page load (not simulated focus calls):** order confirmed
  `Register your academy (hero CTA) → Already have an account? Sign in (hero link) → Sign in (footer) →
  Register your academy (footer) → [Next.js dev-only portal, not page content]`. Every real link shows a
  visible `outline: solid 2px`/`2.66667px` focus ring — no custom focus removal anywhere in this diff.
- **Contrast, computed against real rendered colors (WCAG relative-luminance formula, not estimated):**
  subheading `rgb(89,103,93)` on `rgb(245,243,236)` → **5.37:1** (passes AA's 4.5:1 for body text); footer
  links `rgb(29,57,43)` on the same background → **11.31:1**. Both pre-existing `--muted-foreground`/`--ink`
  tokens, unchanged by this PR, confirmed to still pass with the new, longer copy.
- **Link destinations, real browser, read from the live DOM (not assumed from JSX):** footer EN —
  `/en/login`, `/en/register-academy`; footer ES — `/es/login`, `/es/register-academy`. Hero CTA/link
  destinations unchanged (`/${locale}/register-academy`, `/${locale}/login`).
- **Correction round, 390px dark/ES and 320px ES specifically — footer link visibility and keyboard access,
  real `Tab` presses from a fresh load:** both footer links (`Iniciar sesión` → `/es/login`, `Registra tu
  academia` → `/es/register-academy`) are `display`/`visibility` visible, fully within the viewport's bounds
  (`getBoundingClientRect`), reachable by real `Tab` presses in the same order as the EN pass, and show a
  visible `outline: solid 2px` focus ring, at both 390px and 320px.

## What was not verified — reported honestly, not waived

- **Real Android/iOS device/platform checks remain unavailable in this environment** — same standing
  limitation as D2's own record in `DESIGN.md` and every prior Persuade-surface PR's verification record. Not
  claimed resolved by this PR.
- Cross-browser testing (Firefox/Safari) was not done — Chromium only, consistent with this project's existing
  verification discipline.
- Screen-reader behavior was not tested directly (semantic `<h1>`/`<h2>`/`<footer>` structure is standard HTML,
  no custom ARIA added or removed by this PR).
- 960px width was not separately captured for this screen — the proposal's own matrix (§5) already notes this
  was never a required combination; 1280/390/320 plus the explicit light/dark/EN/ES combinations above were
  the requested matrix.
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed; unrelated to this
  change, tracked separately.

## Explicitly out of scope, per instruction

No Login/Landing *other* screen work, no tenant-branding changes, no database cleanup/migrations/deployment/
activation. The dev server used the isolated test database (`alliance_bjj_test`, port 5433) — no dev-database
writes.
