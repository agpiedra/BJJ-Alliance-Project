# Round 3 — font re-investigation + mobile/theme/locale re-verification on the corrected layout

Two items, both against the **isolated test database** (never dev), both on **round 2's corrected layout** (branding-inside-card, OrgRow, non-truncating names). Round 1 and round 2's screenshots predate this layout and are kept as their own rounds' record, not re-used as proof here.

## Item 1 — font finding, re-investigated properly

Round 2 concluded the serif rendering was "a first-paint/font-swap artifact specific to this session's long-running automated browser" — hedged, not independently confirmed. This round removes every variable that hedge depended on:

- **Genuinely fresh browser process**, not a reused Playwright session: `chrome-devtools` MCP (a separate tool, separate underlying Chrome process) with `isolatedContext` — a browser context that has never loaded this app before, sharing no cache, cookies, or renderer state with any earlier session in this conversation.
- **Production build**, not the Turbopack dev server: `next build` + `next start -p 3002`, pointed at the test database. No HMR, no dev-mode recompilation, the exact artifact production users get.
- **Real existing elements only** — `[data-slot="card-title"]` (the real heading), the real `<label>` text, the real "forgot password" `<a>`, the real submit `<button>`. Nothing was created or injected to "prove" a result; every value below comes from an element the page itself rendered.
- Waited for `await document.fonts.ready` before reading anything.

Result, on `/es/o/alliance-cr/login` (the exact route/theme/locale combination round 1's screenshot showed as serif):

| Element | Computed `font-family` | Computed `font-weight` |
|---|---|---|
| Heading ("Iniciar sesión") | `ibmPlexSans, "ibmPlexSans Fallback"` | 500 |
| Label ("Correo electrónico") | `ibmPlexSans, "ibmPlexSans Fallback"` | 400 |
| Link ("¿Olvidaste tu contraseña?") | `ibmPlexSans, "ibmPlexSans Fallback"` | 400 |
| Button ("Entrar") | `ibmPlexSans, "ibmPlexSans Fallback"` | 600 |

Visually confirmed in both themes and both languages (`font-01` through `font-04`) — every heading renders as genuine IBM Plex Sans: a plain vertical-stroke "I," no terminal serifs, no slab structure, matching the font exactly as it renders when loaded directly outside the app (round 2's isolation test).

**Corrected conclusion: the serif rendering in round 1's screenshots does not reproduce in a production build in a fresh browser process. It was specific to round 1/2's single long-running Turbopack dev-server session** (consistent with round 2's hedge, now confirmed rather than assumed) **— not a defect in the font files, the `@font-face` declarations, the design tokens, or this phase's code.** No shared CSS was touched; portal/kiosk need no regression check because nothing shared was changed.

**Residual, disclosed honestly:** this round did not reproduce the dev-server condition to directly confirm *that* is the trigger (doing so would mean deliberately leaving a dev server running for hours again). The production-build result is the one that matters for real users and CI (CI builds and serves production for its own smoke/browser steps), so it's treated as dispositive for this phase without that extra step.

## Item 2 — mobile / theme / locale re-verification on the corrected layout

All of round 1's and round 2's desktop/mobile screenshots predate the branding-inside-card and OrgRow changes. This round re-shoots the screens those changes actually touch, at a real mobile viewport (390×844, matching the project's own established testing width), against **genuinely new disposable accounts and organizations** created through real flows in the isolated test database.

### What was set up

- A **new organization with a deliberately long, genuinely distinguishing name** — "Northgate International Jiu-Jitsu and Mixed Martial Arts Academy" — registered through the real `/register-academy` form, approved through the real `/platform/organizations/pending` UI, invitation link obtained via `scripts/approve-organization.ts` (email delivery isn't configured in this environment; same documented CLI fallback round 2 used).
- The same disposable owner **also invited into the existing Alliance organization** (a different real role: Instructor) through the real `/admin/staff` UI's own "copy link" fallback — giving one real account two genuine, differently-named, differently-roled memberships.
- A **second, fresh disposable email** invited fresh (no prior account) to capture the "setPassword" invitation state separately from the "join" state.
- One registration attempt hit this environment's real rate limiter ("Too many attempts") — reported honestly rather than worked around; the long-name coverage goal was met with the Northgate registration alone, paired against the existing Alliance org's own reasonably long real name.

### Coverage captured (exact)

| # | Screen | Viewport | Theme | Language | Notes |
|---|---|---|---|---|---|
| mobile-01 | `select-organization` | 390×844 | Dark | EN | Genuine 2-org list; long name wraps to 2 lines, **no truncation, no ellipsis** — matches the prototype's own `.org-meta .name` (which has no overflow rule) |
| mobile-02 | `select-organization` | 390×844 | Light | ES | Same genuine 2-org list; role translated ("Dueño"/"Instructor"); same clean wrap |
| mobile-03 | `o/[orgSlug]/login` | 390×844 | Dark | EN | Real tenant branding (AJ mark) inside the card, no clipping |
| mobile-04 | `o/[orgSlug]/login` | 390×844 | Light | ES | Same |
| mobile-05 | `accept-invitation` (join) | 390×844 | Dark | EN | Real `alreadySignedIn` join state, real org name |
| mobile-06 | `accept-invitation` (setPassword) | 390×844 | Dark | EN | Real never-before-seen email, real token |
| mobile-07 | `onboarding` step 1 | 390×844 | Dark | EN | Real long org name in the (deliberately non-wrapping, standard `<input>`) text fields |
| mobile-08 | `onboarding` step 1 | 390×844 | Light | EN | Same, light theme |

### What this does NOT claim

- The invitation states (`mobile-05`, `mobile-06`) and onboarding step 1 (`mobile-07`/`08`) were **not** captured in every theme × language combination — only the combinations above. `select-organization` and `o/[orgSlug]/login` (the two screens item 2 names explicitly alongside the multi-org case) **were** captured in both themes and both languages.
- Onboarding step 1's text `<input>` fields were not changed to wrap the long org name — that's standard single-line input behavior (the browser's own horizontal scroll/caret, not a layout defect) and is unrelated to `OrgRow`'s wrapping fix, which only applies to the `select-organization` list.
- No existing dev-database account was touched this round. All real flows ran against the test database only.
