# Phase 2 PR 1 — D2 font integration + register-academy restyle — verification

Real implementation, not a proposal. Verified against the actual running app (`npm run dev`), not a static
prototype.

## What changed

- `src/fonts/noto-serif/` — vendored Noto Serif (static Regular instance built from the upstream variable font;
  full provenance in `src/fonts/README.md`).
- `src/app/[locale]/layout.tsx` — loads it via `next/font/local` as `--font-display`, alongside the existing IBM
  Plex families. No runtime third-party font request (same discipline as the existing IBM Plex vendoring).
- `src/app/globals.css` — `--font-display` now resolves to the vendored font's CSS variable instead of a hardcoded
  Georgia system stack.
- `src/components/auth/auth-card.tsx` — new optional `titleClassName` prop, unset by default (opt-in; the other
  10 `AuthCard` callers are unaffected).
- `src/app/[locale]/register-academy/registration-form.tsx` — restyled: wrapped in `AuthCard`
  (`widthClassName="max-w-xl"`, `titleClassName="font-display"`), raw inputs replaced with `Input`, native
  `<select>`s get `FIELD_CLASS`, native checkbox kept as-is (already globally styled). Every field, validation
  rule, the slug race guard, the honeypot, and the server action (`actions.ts`) are byte-for-byte unchanged.
  Field order, `name` attributes, and `required` attributes are identical to before.

## What was verified, and how

- **Build:** `npm run build` — clean, no errors, both before and after the font change and the component restyle
  (run separately at each step).
- **Lint:** `npx eslint` on every changed `.tsx` file — clean.
- **Typecheck:** `npx tsc --noEmit` (whole project) — clean.
- **Unit tests:** `tests/unit/registration-form.test.tsx` + `tests/unit/login-form.test.tsx` — 29/29 passed.
- **Integration test:** `tests/integration/organization-registration.test.ts` — 15/15 passed (real server action,
  real seeded test database).
- **Font loading, real:** the dev server's response headers for `/en/register-academy` preload
  `NotoSerif_Regular-s.p.cf28dda1.woff2` alongside the IBM Plex files — confirms Next's font pipeline actually
  processed the vendored file, not just that the code compiles.
- **Visual, real browser (Playwright/Chromium against the live dev server, not a static mock):**
  - `01`/`02` — 1280px, EN, dark then light theme — serif heading renders distinctly from the sans body/labels in
    both themes.
  - `03` — 1280px, ES — real `next-intl` translation, including `Colones (₡)`.
  - `04`/`05` — 390px and 320px — the `sm:grid-cols-2` paired fields correctly collapse to one column; no overlap
    or clipping down to 320px.
- **Keyboard, real `Tab`/`Space`/`Enter` key presses (not simulated focus calls):** full order confirmed
  field-by-field: `organizationName → desiredSlug → country → city → contactName → contactEmail → contactPhone →
  studentCountBand(select) → referralSource → preferredLocale(select) → currency(select) →
  termsAccepted(checkbox) → Submit`. The honeypot (`tabIndex={-1}`) is correctly skipped throughout. `06`/`07`
  show a visible focus ring on the select and the checkbox. `Space` toggled the checkbox (confirmed via
  `.checked`).
- **Validation, real:** submitting with required fields empty is blocked by native HTML5 validation, which
  focuses `organizationName` with `"Please fill out this field."` — confirmed via `document.activeElement`, not
  assumed.
- **Submission, real, end to end:** `08` shows a fully filled form, including a live "Available" slug-check
  response from the real server action; `09` shows the real "Request received" success state after a real submit
  — the actual `registerOrganization` server action ran against the real seeded dev database, not a mock.

## What was not verified — reported honestly, not waived

- **Real device/platform checks remain unavailable in this environment** — same standing limitation as D2's own
  record in `DESIGN.md` and the project's long-standing real-iOS acceptance item. No Android or iOS device, and
  no Android emulator, was available here. This PR's font-loading and layout were verified in a real desktop
  Chromium browser only.
- Cross-browser testing (Firefox/Safari engine differences in `@font-face`/native-`<select>` rendering) was not
  done — Chromium only, consistent with this project's existing verification discipline elsewhere.
- Screen-reader behavior was not tested directly; the honeypot's `aria-hidden`/`tabIndex=-1` and the checkbox's
  native semantics are unchanged from before, so no new a11y surface was introduced, but this is inference, not a
  screen-reader pass.

## Fix round — duplicate MATROOM wordmark

`src/app/[locale]/register-academy/page.tsx` (not part of this PR's original diff — pre-existing on `main`)
rendered `<BrandBanner />` above `<RegistrationForm>`. `RegistrationForm` wraps in `<AuthCard>`, and `AuthCard`
already renders its own `LogoMark` inside the card. Neither component receives a `brand` prop on this
pre-tenant page, so both fall back to the platform's own `MatroomWordmark` — the same mark rendered twice on
one page: once in the top banner, once inside the card. The approved prototype
(`design/matroom/preview/auth-access-phase-prototype.html:441`) places the wordmark inside the card as part of
"the outer card shell," not a separate banner — and `/login` (`src/app/[locale]/login/page.tsx`) already
follows that pattern with no `BrandBanner` at all. Fix: removed the stray `<BrandBanner />` and its now-unused
import from `register-academy/page.tsx` — the smallest change, touching no field, validation rule, native
control, the slug-availability race guard, the honeypot, or the server action. `AuthCard`'s `titleClassName`
opt-in scoping (unset by default for the other 10 callers) is unchanged.

Re-verified against the isolated test database (`alliance_bjj_test`, port 5433 — never the dev database),
real desktop Chromium:

- `pnpm typecheck` / `pnpm lint` — clean (0 errors).
- `tests/unit/registration-form.test.tsx` + `tests/unit/login-form.test.tsx` — 29/29 passed.
- `tests/integration/organization-registration.test.ts` — 15/15 passed (real server action, real isolated test
  database).
- **Visual, real browser:** `fix-01`/`fix-02` — 1280px EN, light then dark — single wordmark, correctly themed.
  `fix-03` — 1280px ES — real translation, single wordmark. `fix-04`/`fix-05` — 390px and 320px — single
  wordmark, paired fields still collapse to one column, no clipping.
- **Keyboard, real `Tab`/`Space` key presses:** confirmed the exact same order as the original record —
  `organizationName → desiredSlug → country → city → contactName → contactEmail → contactPhone →
  studentCountBand(select) → referralSource → preferredLocale(select) → currency(select) →
  termsAccepted(checkbox) → Submit` — with `organizationName` as the very first `Tab` stop from page load
  (confirms removing `BrandBanner` added no new focusable element ahead of the form). The honeypot is absent
  from the captured order throughout. `fix-06` shows the visible focus ring on the select. `Space` toggled the
  checkbox (`false → true`, confirmed via `.checked`).
- **Validation, real:** submitting with every required field empty is still blocked by native HTML5 validation,
  focusing `organizationName` with `"Please fill out this field."` — unchanged.
- **Real device/platform checks remain unavailable in this environment** — same standing limitation as the
  original record above; not claimed resolved.

## Fix round — heading font-weight

`CardTitle` (`src/components/ui/card.tsx`) bakes in `font-medium` (500). The vendored Noto Serif file is a
single static Regular (400) instance — the approved D2 styling and `design/matroom/preview/preview.css`'s
`.display` rule are both 400 — so the registration heading was rendering the display face at the wrong weight
(a synthetic/matched 500, not the vendored file's real 400 glyphs). Fix: `registration-form.tsx`'s
`titleClassName` changed from `"font-display"` to `"font-display font-normal"`. `AuthCard` merges
`titleClassName` after `CardTitle`'s own base classes through `cn` (a tailwind-merge-based utility, confirmed
in `package.json`), so the later `font-normal` correctly deduplicates and overrides the earlier `font-medium`
— not a CSS-cascade assumption, a verified merge mechanism. `CardTitle`/`AuthCard` defaults and every other
caller (forgot-password, reset-password, accept-invitation, select-organization, the access-denied screens,
the per-org public signup form, `/login`) are untouched.

Re-verified against the isolated test database (never the dev database):

- `pnpm typecheck` / `pnpm lint` — clean (0 errors).
- `tests/unit/registration-form.test.tsx` + `tests/unit/login-form.test.tsx` — 29/29 passed.
- `tests/integration/organization-registration.test.ts` — 15/15 passed.
- **Computed style, real browser, `getComputedStyle` on the actual rendered `<h1>`** (not inferred from
  source): EN — `font-weight: 400`, `font-family: notoSerif, "notoSerif Fallback"`. ES — same, text
  `"Registra tu academia"`. Confirms the vendored Noto Serif face at the correct weight, not just that the
  class was added.
- **Heading fit, real browser:** `fw-01`/`fw-03` — 1280px, EN then ES — single wordmark preserved, heading
  renders Regular weight. `fw-02`/`fw-04` — 320px, EN then ES — heading still fits without wrapping or
  clipping at the narrowest supported width.
- **Scoping check, real browser:** `/login`'s heading computes to `font-weight: 500`, `font-family:
  ibmPlexSans` — confirms `CardTitle`'s default and every other `AuthCard` caller are unaffected.
- **Real device/platform checks remain unavailable in this environment** — same standing limitation as both
  records above; not claimed resolved.
