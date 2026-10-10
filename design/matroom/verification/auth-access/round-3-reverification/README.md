# Round 3 — font re-investigation + mobile/theme/locale re-verification on the corrected layout

Two items, both against the **isolated test database** (never dev), both on **round 2's corrected layout** (branding-inside-card, OrgRow, non-truncating names). Round 1 and round 2's screenshots predate this layout and are kept as their own rounds' record, not re-used as proof here.

## Item 1 — font finding, properly substantiated (corrected)

**This section replaces the original Item 1 above the line below.** The first pass at this item used `getComputedStyle` (the declared CSS value, not what actually rasterized the pixels) and 1x-resolution screenshots, then concluded the serif appearance was a session-specific artifact. On review, the saved screenshots (`font-03-light-es-full.png`, `mobile-06-accept-invitation-setpassword-dark-en.png`) did not clearly show clean sans-serif glyphs at normal viewing size — the claim outran its own evidence. This section redoes the check with the right tool and keeps both the old and new evidence so the discrepancy is visible, not hidden.

**Method — `CSS.getPlatformFontsForNode`, the real "Rendered Fonts" data**, not `getComputedStyle`:

- A standalone script (`scripts/tmp-rendered-fonts.ts`, `tmp-rendered-fonts-2.ts` — not committed, this project's own `playwright-core` + system-Chrome pattern from `tests/browser/*.test.ts`) launched a genuinely fresh Chrome process against the production build (`next build && next start -p 3002`, test database), waited for `document.fonts.ready`, then called the Chrome DevTools Protocol command behind the DevTools "Rendered Fonts" panel — `CSS.getPlatformFontsForNode` — against five real, already-rendered text nodes: the heading, a label, a link, a submit button, and a plain paragraph (`accept-invitation`'s invalid-token message). This reports the font that **actually drew the glyphs**, with an `isCustomFont` flag and the font's own PostScript name — not the CSS cascade value.
- Full raw result: `rendered-fonts-addendum/platform-fonts-cdp-result.json`. Summary:

| Element | Real text | `CSS.getPlatformFontsForNode` | `isCustomFont` | Computed weight |
|---|---|---|---|---|
| Heading | "Iniciar sesión" | **IBM Plex Sans Medm** (`IBMPlexSans-Medm`) | true | 500 |
| Label | "Correo electrónico" | **IBM Plex Sans** (`IBMPlexSans`) | true | 400 |
| Link | "¿Olvidaste tu contraseña?" | **IBM Plex Sans** (`IBMPlexSans`) | true | 400 |
| Button | "Entrar" | **IBM Plex Sans SmBld** (`IBMPlexSans-SmBld`) | true | 600 |
| Paragraph | "This invitation link is invalid or has expired." | **IBM Plex Sans** (`IBMPlexSans`) | true | 400 |
| Paragraph (2nd check) | "You've been invited to Alliance Jiu-Jitsu Costa Rica as Instructor." (the exact text in the disputed `mobile-06` screenshot) | **IBM Plex Sans** (`IBMPlexSans`) | true | 400 |

Every one of the five categories the instruction named — heading, label, link, button, paragraph — is confirmed, by the browser's own authoritative font-matching report, to be drawn by the real, correctly-weighted IBM Plex Sans static instance. `isCustomFont: true` rules out a system-font substitution; the exact PostScript names (`IBMPlexSans`, `-Medm`, `-SmBld`) rule out a generic/fallback face standing in silently.

**Corrected screenshots that actually substantiate this**, replacing reliance on the ambiguous ones: `rendered-fonts-addendum/01` through `05` (tight element crops at 2x device scale) and `06`/`07` (full re-shoots of the exact two disputed scenarios — `/es/o/alliance-cr/login` light theme, and a fresh real `setPassword` invitation at 390×844 dark — both at 2x instead of 1x). At 2x these are unambiguous: no terminal serifs, no slab structure, on every element.

**Determined cause of the dispute: capture provenance, not a font/rendering defect.** The CDP ground truth and the 2x screenshots agree the production build genuinely renders IBM Plex Sans everywhere checked. The original `font-03`/`mobile-06` screenshots were captured at **1x device scale factor** — small, `text-muted-foreground`-colored text at 1x anti-aliases roughly enough to be legitimately misread as serif by eye, even though the underlying glyph program is sans-serif. That is a real limitation of those specific screenshots, not a rendering bug; it is corrected here by re-capturing at 2x and by using API-level ground truth instead of eyeballing a screenshot.

**Round 1's original screenshot is a separate, still-open question.** This round confirms the *current production build* renders correctly, with authoritative evidence. It does not re-examine round 1's own screenshot with CDP (that session is gone), so round 2's specific claim that round 1's appearance was caused by "a long-running dev-server session" is **withdrawn as unconfirmed** rather than repeated — it was never checked with this tool either, only inferred from a fresh-element-vs-old-element comparison that, per this same lesson, is not strong enough evidence on its own. What's confirmed: the shipped code, as it actually renders in production today, uses the correct font throughout. No shared CSS, token, or font-pipeline change was made (none was warranted), so portal and kiosk need no regression check.

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
