# Phase 2.6 PR 3 — Login password show/hide toggle: implementation verification

Implements the approved Phase 2.6 proposal's PR 3
(`design/matroom/verification/phase2.6-proposal/README.md` §10, §8's v2 keyboard-order fix). On top of
merged PR #114 (portal nav) and PR #115 (portal content); independent of both, zero shared dependency.
No organization-selection or kiosk changes, no promotion-policy changes, no dev-account cleanup,
no database/migration/deployment/activation changes.

## What changed

- `src/app/[locale]/login/login-form.tsx`: a show/hide toggle button on the password field. Password
  starts concealed (`type="password"`). The toggle is `type="button"` (never submits the form), flips the
  input between `password`/`text`, and explicitly refocuses the password input after each click (not the
  toggle button itself) via `document.getElementById(passwordInputId)?.focus()`.
- `messages/en.json` / `messages/es.json`: new `auth.login.showPassword` / `auth.login.hidePassword` keys
  ("Show password"/"Hide password", "Mostrar contraseña"/"Ocultar contraseña"), consumed via `aria-label`
  and reflected in `aria-pressed`, so the toggle's accessible name/state genuinely changes with its state
  (not a static label).
- Toggle sits immediately after the password `<Input>` in DOM, before the submit button — the real,
  already-correct production Tab order (`email → password → toggle → submit → "Forgot it?"`) matches the
  approved proposal's v2 keyboard-order fix. No DOM reorder of the "Forgot it?" link was needed: unlike the
  static prototype the proposal describes, production's `login-form.tsx` already has it after the submit
  button, not before the password field.
- Reused existing components only: `Button` (`variant="ghost" size="icon-sm"`, inside a `relative` wrapper
  around the existing `Input`), and the `Eye`/`EyeOff` icons from `lucide-react` (already an installed
  dependency, already used elsewhere in this app; no new icon library, no shadcn MCP consultation needed —
  no gap existed). Focus ring is the project's existing global `:focus-visible` style; nothing
  toggle-specific was added or overridden.

## Login consumers — inventory, both confirmed working

`LoginForm` has exactly two consumers (`grep -rln "LoginForm" src`):

- `src/app/[locale]/login/page.tsx` — bare `/login`, generic platform wordmark, no `brand` prop.
- `src/app/[locale]/o/[orgSlug]/login/page.tsx` — `/o/[orgSlug]/login`, real per-org branding resolved
  server-side and passed through to `AuthCard`/`LogoMark`, `LoginForm` itself unmodified.

Both render the identical `LoginFormInner`; this PR's change is one component edit covering both routes.

## Preserved — verified live, not assumed

- **Authentication/redirect**: a real end-to-end login (`/en/login`, real credentials, password revealed
  via the toggle mid-fill to prove the submitted value matches what's visible) redirected to `/en/onboarding`
  — the correct landing path for a first-time owner. The submit handler, the `login` server action, and
  `useActionState` wiring were not touched.
- **Validation/error handling**: a deliberately wrong password on `/en/login` still renders
  "Incorrect email or password." (`state.error` branch unchanged).
- **Branding**: `/en/o/login-toggle-dojo/login` rendered the real org's "LT" logo mark; the bare `/en/login`
  rendered the generic wordmark — both unaffected by this change.
- **Password field itself**: `name="password"`, `required`, and the label association are all unchanged;
  only `type` and an added `id` (for the refocus call) were touched.

## Real-browser verification — real account, isolated test-DB environment

Per this project's standing rule, a genuinely registered account was used, not a seeded shortcut: registered
a new academy ("Login Toggle Dojo") via the real `/register-academy` form, approved it with
`scripts/run-against-test-db.ts tsx scripts/approve-organization.ts --slug=login-toggle-dojo
--approved-by=superadmin@alliancecr.com` (against the guarded `TEST_DATABASE_URL`, never the dev database —
confirmed by `scripts/lib/test-database-guard.ts`'s structural checks), and set a real password via the real
`/accept-invitation` flow (the invitation email itself fails in this environment — no `RESEND_API_KEY` — the
script prints the link/token directly, which is the documented fallback, not a workaround). Server: the
already-running `next dev` on port 3100, `DATABASE_URL` redirected to `TEST_DATABASE_URL` via
`scripts/run-against-test-db.ts` (same convention as PR #114/#115's verification), confirmed live via a
direct request before reuse.

Driven with real Chrome DevTools Protocol input (`click`, `fill`, `press_key`, never jsdom/synthesized
events) in a resized real browser window:

- **Toggle mechanics** (`/en/o/login-toggle-dojo/login`, desktop 1280×900): typed a real password, clicked
  the toggle — accessible name flipped "Show password" → "Hide password", `aria-pressed` flipped
  `false` → `true`, the input's accessible snapshot showed it as `focused` immediately after the click
  (proving focus returned to the input, not the toggle), and the typed value (`LoginToggle123!`) was
  unchanged throughout. Screenshots: `01-login-desktop-light-en-concealed.png`,
  `02-login-desktop-light-en-revealed.png`.
- **Real keyboard Tab order** (same page): focused the email field, then four real `Tab` presses, reading
  `document.activeElement` after each — confirmed `email → password → toggle (aria-label "Hide password") →
  Sign in (type=submit) → "Forgot your password?"`, exactly matching the approved proposal's v2 fix.
  Screenshot `03-login-desktop-toggle-focus-ring.png` shows the toggle's visible focus ring (the project's
  global 2px `:focus-visible` outline) under dark mode, confirmed un-suppressed.
- **Enter key on the focused toggle**: pressed `Enter` with the toggle focused — triggered the toggle's own
  click handler (native `<button>` behavior), value/URL unchanged (no navigation, no form submission),
  confirming the toggle genuinely never submits the form even via keyboard activation, not only via mouse
  click.
- **Narrow widths**: 390×844 light EN and 320×700 light ES (`04-login-390-light-en.png`,
  `05-login-320-light-es.png`) — the toggle icon sits fully inside the input with no overlap with the typed
  text or the input's border, no page-level or element-level overflow at either width. The longer Spanish
  accessible names ("Mostrar contraseña"/"Ocultar contraseña") render correctly via real `next-intl` lookup
  (confirmed in the accessibility snapshot, not a JS text-substitution spot-check as the original prototype
  evidence was) — being `aria-label`-only (never visible text), they carry no wrap/overflow risk at any
  width.
- **Light and dark**: light mode confirmed at 1280/390/320; dark mode confirmed at 1280 (the environment's
  default color scheme before an explicit `light` override), both with the global focus ring visible.
- **End-to-end real login, wrong-password case, and the org-branded route**: see "Preserved" above — all
  driven live, not inferred from reading the code.

## Honest limitations, disclosed not hidden

- **No real iOS device.** Narrow-width verification used Chrome DevTools viewport resizing (real browser
  window, not headless/jsdom), not an actual iOS Safari device. This is the same outstanding acceptance item
  carried from PR #114/#115 — still untouched by this PR, still tracked as outstanding.
- **Dark mode was spot-checked at desktop width only** (one screenshot), not independently re-verified at
  390/320 — the toggle button and icon use the same theme tokens (`Button`'s `ghost` variant, `lucide-react`
  `currentColor` icons) as every other control on this already-dark-mode-verified page from prior phases, so
  this is a reasonable gap, not a claimed-but-undone check.
- **Android/other mobile browsers were not checked** — only Chrome (desktop + DevTools-resized viewports).

## Correction round — password label markup

The password field was originally wrapped in a `<label>` that also enclosed the show/hide toggle button,
associating the label with an unrelated interactive control alongside the input. Fixed: the outer `<label>`
is now a plain `<div>`, and an explicit `<label htmlFor={passwordInputId}>` labels only the `<Input>`; the
toggle stays in the same `relative` wrapper, as a sibling of the label, not nested inside it. Purely a markup
restructuring — no change to visual layout, value retention, localization, non-submit behavior, or focus
handling. Re-verified live in the isolated test-DB browser environment: clicking the "Password" label text
focuses the password input (not the toggle), the field's visual layout/spacing is unchanged, and Tab order /
toggle operability are unchanged from the original real-browser evidence above.

The unit test previously named "the toggle is keyboard-reachable and operable via Tab" has been renamed to
accurately describe what it proves — DOM order and programmatic `.focus()`, not real Tab-key navigation.
Real Tab-order proof remains the real-browser evidence in this document, not that unit test.
