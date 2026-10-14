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
