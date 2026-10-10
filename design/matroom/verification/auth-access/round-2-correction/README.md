# Round 2 — correction pass against the approved prototype

Pass 1's PR (`b959b23`) implemented the 10 screens but drifted from the approved prototype in real, material ways. This round corrects those, investigates an unrelated font-rendering finding, and finishes the browser verification the first round left incomplete. The round-1 screenshots in the parent folder are preserved unchanged — this folder is additive.

## 1. Layout discrepancies found and corrected

Direct comparison against `design/matroom/preview/auth-access-phase-prototype.html` (not against round 1's own screenshots — the prototype is the standard) found three real gaps:

- **Branding placement.** The prototype's own closing assessment explicitly calls the brand mark part of "the outer card shell" — it renders *inside* the card, above the heading, in every one of its four sections. Round 1 kept the pre-existing `BrandBanner` as a separate full-width bar above the card, never looking at this. Corrected: `AuthCard` now renders `LogoMark` (the same real tenant-branding component `BrandBanner` used — `logoUrl`/`initials`/`initialsBackground`/`initialsForeground`/`alt`, unchanged) inside the card. `BrandBanner` is removed from all 10 screens; the two tenant-scoped screens (`/o/[orgSlug]/login`, `/o/[orgSlug]/signup`) thread the same real `resolveOrganizationLoginBranding` result through a new `brand` prop instead.
- **Card spacing.** The prototype's `.auth-card` uses 32px padding (24px/20px on mobile) and a ~19px heading; round 1 used the shadcn `Card` default (16px padding) and a 24px heading, never checked against the prototype's own CSS. Corrected via `Card`'s own `--card-spacing` custom property (`[--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(8)]`) and `text-xl` instead of `text-2xl`.
- **Organization-selection row treatment.** The prototype documents, explicitly, that this card needs a wider max-width (420px) and that each row is a mark badge + name + role — not a plain outlined button with just a name, which is what round 1 shipped (the existing pre-redesign `Button` markup, carried over unexamined). Corrected: new `OrgRow` component (`src/components/auth/org-row.tsx`) inside the real per-row `<form>`/`<button type="submit">` — same real `selectOrganization` action, same real redirect, richer visual content. The role now comes from a real `OrganizationMembership.role` select (previously unselected) and `staffShell.userMenu.role` translations (missing `STUDENT`, added to `en.json`/`es.json`).

See `b1`-`b3`, `a1`-`a2` here.

## 2. Font investigation (no code change)

Screenshots from round 1 showed serif-looking glyphs in some headings against the approved IBM Plex Sans design. Investigated before any shared-style change, per instruction:

- Vendored font files: SHA-256 verified **byte-identical** to `src/fonts/README.md`'s documented, approved IBM Plex Sans release.
- Served bytes (`_next/static/media/IBMPlexSans_Medium-*.woff2`): verified **byte-identical** to the vendored source.
- `@font-face` CSS Next.js generates: verified correct and non-conflicting (one rule per weight, no duplicates, consistent through the entire ancestor chain via `getComputedStyle`).
- `local("Arial")` (the `font-display: swap` fallback face) resolves correctly in this browser — not the cause.
- **Isolating test:** a `<div>` created fresh via script, given the identical `font-family: ibmPlexSans` declaration, and appended as a sibling in the *same already-loaded page*, rendered the real IBM Plex Sans correctly — while the pre-existing heading element right next to it kept rendering serif.

Conclusion: the font tokens, vendored files, and CSS are all correct and match the approved design — this is not a design or implementation defect in this phase's code. The evidence (correct resolution for a freshly-created element, incorrect for one present since initial paint, with identical computed CSS) points at a first-paint/font-swap rendering artifact specific to this long-running Playwright-automated browser session, not at the font pipeline itself. **Not independently confirmed in an unautomated desktop browser** — recommended as a follow-up if it's ever seen outside this kind of session. No shared-style change was made.

## 3. Real-browser verification completed (isolated test database, disposable accounts)

Everything below ran against the **test** database (`alliance_bjj_test`, port 5433 — `pnpm run-against-test-db next dev -p 3001`), never the dev database. Every account used was created through the app's own real flows in this session — none seeded, none hand-inserted.

- **A brand-new organization**, registered through the real `/register-academy` form, approved through the real `/platform/organizations/pending` UI (as the seeded `superadmin@alliancecr.com`, itself only used to *approve*, never as the subject of any screenshot). Email delivery isn't configured in this environment (`RESEND_API_KEY` invalid) — this project's own `scripts/approve-organization.ts` ("the CLI stand-in for Phase 6's not-yet-built admin UI," per its own doc comment) prints the real invitation link for exactly this situation; used as documented, not worked around.
- Accepted that invitation for real → a genuinely new ADMIN account, owning a genuinely new, not-yet-onboarded organization → **`onboarding` step 1 captured for real** (`c1`), the one screen round 1 couldn't reach.
- A **second real invitation**, to the same disposable email, into the seeded Alliance organization as Instructor — sent through the real `/admin/staff` UI (its own "email couldn't be sent, copy the link" fallback, not a script). Captured the real **valid-invitation "join" state** (`c3`) and, from the first invitation, the real **"setPassword" state** (`c2`).
- Accepting the second invitation gave this one disposable account two genuine, different-role organization memberships → **`select-organization` captured with a genuine multi-organization case** (`a2`): "Alliance Jiu-Jitsu Costa Rica / Instructor" and "QA Verification Gym .../ Owner", real initials, real roles, the real `selectOrganization` action confirmed to still redirect correctly.
- **Bare `/login` smoke-checked** (`d1`) since its shared `login-form.tsx` changed in this round, even though the route itself is outside Phase 1's 10-screen list — generic platform wordmark, no tenant leak, unchanged.
- Real keyboard-Tab order re-checked after the structural change: still lands on the email input first; the brand mark (a non-interactive `aria-hidden` SVG inside a plain `<span>`) is not a tab stop.

## 4. What this round does NOT claim

- Not every screen × theme × locale × viewport combination was re-shot in this round — the shared `AuthCard` primitive was verified across 9 structurally distinct real pages (with/without footer, with/without tenant branding, with/without a titled header, with the org-row list, with the form fields), which is the actual surface that changed. Round 1's light/dark/en/es/mobile/focus matrix (parent folder) still stands for what it covered.
- `onboarding`'s steps 2 and 3 (the embedded `LogoUploader`/`ThemePicker`) were not re-visited — they were never touched by this phase at all (see the reconciliation note below).
