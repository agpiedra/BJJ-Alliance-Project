# Phase 2 PR 2 — D2 Login-only typography — verification

Real implementation, not a proposal. Verified against the actual running app (`npm run dev`), not a static
prototype.

## What changed

- `src/app/[locale]/login/login-form.tsx` — `LoginForm`/`LoginFormInner` gain an optional `titleClassName`
  prop, threaded straight through to `AuthCard`'s own existing `titleClassName` (merged in PR #119/#121, no
  new mechanism). All fields, the password show/hide toggle, validation, authentication, redirects, branding
  (`brand` prop), and footer links (forgot-password, register-academy) are byte-for-byte unchanged.
- `src/app/[locale]/login/page.tsx` — the only caller that passes `titleClassName="font-display font-normal"`
  (same value as the merged register-academy fix: `font-normal` because the vendored Noto Serif file is a
  single static Regular (400) instance, and `CardTitle`'s own `font-medium` would otherwise apply).
- `src/app/[locale]/o/[orgSlug]/login/page.tsx` — **not modified.** It calls `LoginForm` without the new prop,
  so it keeps `CardTitle`'s default sans heading.
- `CardTitle`/`AuthCard` defaults are untouched.

## Scope decision — why bare `/login` only

`LoginForm` is one shared component with a single `AuthCard` call site, used by both `/login` and
`/o/[orgSlug]/login`. D2 (`design/matroom/DESIGN.md` §D2) names the three approved Persuade surfaces as
"landing, registration, **platform sign-in**" — the generic, qualified phrase, not "organization sign-in" or
"tenant login." `/o/[orgSlug]/login` is an *existing member* completing a task on their own organization's
already-branded page — D3's Operate surfaces (`design/matroom/DESIGN.md` §D3: "portal, dashboard, kiosk"), not
D2's Persuade list, which conspicuously does not name it despite precisely qualifying the surface it does
name. The new `titleClassName` prop is therefore threaded so only bare `/login`'s own `page.tsx` passes it;
`/o/[orgSlug]/login`'s `page.tsx` was left untouched.

## What was verified, and how

Against the isolated test database (`alliance_bjj_test`, port 5433 — never the dev database), real desktop
Chromium:

- `pnpm typecheck` / `pnpm lint` — clean (0 errors).
- `tests/unit/login-form.test.tsx` — 9/9 passed.
- `tests/integration/login-actions.test.ts` + `tests/integration/e2e-auth-bypass-equals-real-login.test.ts` —
  9/9 passed (real server action, real isolated test database).
- **Font loading/weight, real browser, `getComputedStyle` on the actual rendered `<h1>`** (not inferred from
  source): bare `/login` EN — `font-weight: 400`, `font-family: notoSerif, "notoSerif Fallback"`, text
  "Sign in". ES — same, text "Iniciar sesión". Confirms the vendored Noto Serif face at the correct weight.
- **Scope confirmation, real browser:** `/o/alliance-cr/login` (a real seeded, ACTIVE organization) —
  `font-weight: 500`, `font-family: ibmPlexSans` — `CardTitle`'s default, confirming the org-branded login is
  genuinely unaffected. `06` shows its own real branding (initials badge "AJ") rendering correctly, unchanged.
- **Visual, real browser:** `01`/`02` — 1280px EN, light then dark — serif heading, single wordmark (no
  `BrandBanner` on this page, same pattern as register-academy). `03` — 1280px ES. `04`/`05` — 390px and
  320px — heading fits on one line at both widths, no clipping or wrapping; form layout unaffected.
- **Keyboard, real `Tab`/`Enter` key presses (not simulated focus calls):** order confirmed `email → password
  → password-toggle button → Sign in (submit) → Forgot your password? → Register your academy` — unchanged
  from before this PR.
- **Password toggle, real:** toggle button's `aria-label` starts `"Show password"`; pressing `Enter` on it
  toggles the password input's `type` from `password` to `text`; focus returns to the password field itself
  afterward (not the toggle button) — confirmed via `document.activeElement`, matching the component's own
  documented behavior, unchanged.

## What was not verified — reported honestly, not waived

- **Real Android/iOS device/platform checks remain unavailable in this environment** — same standing
  limitation as D2's own record in `DESIGN.md` and the register-academy PR's verification record. Not claimed
  resolved by this PR.
- Cross-browser testing (Firefox/Safari) was not done — Chromium only, consistent with this project's existing
  verification discipline.
- Screen-reader behavior was not tested directly.
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed; unrelated to this
  change, tracked separately.
