# Phase 2.6 PR 4 — Organization selection card restyle: verification

**Scope implemented:** `src/components/auth/org-row.tsx` restyled to the approved card-with-chevron
treatment (`design/matroom/preview/phase2.6-app/organization-selection.html`): mark badge grown from
34px to 44px (`size-11`), card given `rounded-lg border border-border`, `min-h-[72px]`, and a trailing
decorative `ChevronRight` (lucide-react, `aria-hidden="true"`). `select-organization/page.tsx` is
byte-for-byte unchanged — `OrgRow` remains pure presentation wrapped by the same real
`<button type="submit">`/`<form action={selectOrganization...}>` pair.

## What was verified, and how

**Real authenticated route, not an isolated render.** A genuinely fresh user was created the way a real
one would be — `approveOrganization` + `acceptInvitation` (the exact functions
`tests/integration/accept-invitation-existing-account.test.ts` exercises), never a seeded demo account
— and given **two real `OrganizationMembership` rows** across two real `Organization` rows (one with a
long name, to re-prove the existing no-truncation regression). A session for that real user was then
minted via the project's own sanctioned dev-only session-minting route
(`src/app/api/e2e-auth-bypass/route.ts`, the same mechanism `tests/helpers/smoke.ts` uses for the
smoke suite) and used to drive the actual `/[locale]/select-organization` page in a real Chromium
browser (chrome-devtools MCP) against a real `next dev` server and a real local Postgres (via
`docker-compose.yml`). The membership data, the page, the action, and the redirect are all real; only
the login *step itself* was minted rather than typed into a form, per this project's own sanctioned
exception for that one step.

### Matrix covered

| Width | Mode | Theme | Locale | File |
|---|---|---|---|---|
| 1280 (real window) | — | light | EN | `org-selection-1280-light-en.png` |
| 960 (real window) | — | light | EN | `org-selection-960-light-en.png` |
| 960 (real window) | — | dark | EN | `org-selection-960-dark-en.png` |
| 390 (real window, floored) | — | light | EN | `org-selection-390-light-en.png` |
| 320 (real window, floored) | — | light | EN | `org-selection-320-light-en.png` |
| 390 | **emulated** (CDP device viewport) | light | EN | `org-selection-390-light-en-emulated.png` |
| 320 | **emulated** (CDP device viewport) | light | EN | `org-selection-320-light-en-emulated.png` |
| 1280 (real window) | — | light | ES | `org-selection-1280-light-es.png` |
| 320 | **emulated** (CDP device viewport) | light | ES | `org-selection-320-light-es-emulated.png` |
| 1280 (real window) | — | light | EN | `org-selection-1280-keyboard-focus.png` (keyboard focus ring, first card) |

**Why both a "real window, floored" and an "emulated" capture at 390/320:** this platform's real-window
resize tool has an OS-level minimum window width (observed floor ~501px `innerWidth` on Windows) — the
exact class of problem this project's own `feedback_viewport_emulation` memory names. The 390/320
real-window screenshots are captured for completeness but their actual `window.innerWidth` is NOT 390
or 320 (confirmed via `window.innerWidth` read after resize — it stayed at 501). The CDP-emulated
captures (`*-emulated.png`) are the ones that actually measured a true 320/390px viewport and are the
evidence of record for the no-truncation and no-overflow claims below. This distinction is disclosed,
not hidden.

### No-truncation regression, re-verified with real measurement (not just screenshot inspection)

At the true 320px emulated viewport, the long organization name
("Verify Harbor Brazilian Jiu-Jitsu and Self-Defense Academy International") was measured directly:

- `scrollWidth === clientWidth` (115px both) — no horizontal clipping.
- Rendered height 120px at a 20px line-height — **6 wrapped lines**, confirming it wraps rather than
  truncating.
- `getComputedStyle(...).textOverflow === "clip"` (the default; not `"ellipsis"`).
- `document.documentElement.scrollWidth === window.innerWidth` (320 === 320) — no page-level horizontal
  overflow at 320px, EN or ES.

### Light/dark

Dark mode was checked by toggling the real app's own `<html class="dark">` mechanism
(`src/components/theme/theme-toggle.tsx`'s actual class, not a synthetic CSS override) at 960px —
`org-selection-960-dark-en.png`. Not re-checked at every other width/locale combination (one
representative sample, consistent with how prior Phase 2.6 PRs disclosed partial theme coverage).

### EN/ES

Both locales rendered with their real `next-intl` strings from `messages/en.json`/`messages/es.json`
(`auth.selectOrganization.*`, `staffShell.userMenu.role.ADMIN` → "Owner"/"Dueño") — not a text
substitution script. Confirmed via accessibility-tree snapshot (exact rendered text), not assumed.

### Keyboard focus and activation (real keyboard, not programmatic)

Real `Tab`/`Enter` key presses via CDP (`press_key`), not `.focus()` + a synthesized event:

1. First `Tab` from body focus landed on the first org card's button (confirmed via
   `document.activeElement.textContent`). Screenshot: `org-selection-1280-keyboard-focus.png` shows
   the visible focus ring.
2. Second `Tab` moved focus to the second org card's button.
3. `Enter` on the focused second card submitted the real form and triggered the real
   `selectOrganization` server action: the browser navigated to `/en/onboarding` — the exact redirect
   `accept-invitation/actions.ts` documents for a newly-approved Owner's first stop. This proves the
   restyled markup did not break the real action/redirect wiring, using the real keyboard-activation
   path end to end, not a bare click.

### Multiple real memberships

Both cards rendered from two real `OrganizationMembership` rows for one real user (confirmed via a
direct Prisma read before the browser check, and via the page's own accessibility-tree snapshot showing
both "AJ ... Owner" and "VH ... Owner" buttons) — matching the prototype's two-card example, with
correct spacing (`gap-2` on the `<ul>`-equivalent wrapper, unchanged from before this PR) between them.

## Honest limitations, disclosed not hidden

- **Both real memberships carry the same role ("Owner"/`ADMIN`).** The real product flow used to create
  a second real membership for an existing account (`acceptInvitation`'s own "existing account" branch)
  assigns the invited organization's owner role; there is no equally-fast real-product-flow path used
  here to give the second membership a different role (e.g. Student) without a separate staff-invite
  flow this PR's verification did not also exercise. The two cards still prove the layout/spacing/
  chevron/mark/role-label rendering with two distinct real orgs; they do not additionally prove a
  mixed-role row pair.
- **The 390/320 "real window" screenshots do not reflect a true 390/320px viewport** on this platform
  (see above) — the CDP-emulated captures are the ones to trust for those widths.
- **Dark mode was checked at one width (960) only**, not the full width matrix.
- **Docker Desktop and the local Postgres containers (`docker-compose.yml`) were started during this
  verification** (they were not running at session start) to reach a real database for the real
  register/approve/accept flow. Left running afterward.
- **No automated browser-level regression test was added** for the 320px wrap behavior — this project's
  jsdom unit tests (`tests/unit/org-row.test.tsx`) cannot lay out real text wrapping, and no existing
  `tests/browser/` suite already covers `/select-organization`; the real-measurement check above is the
  evidence of record for this PR, matching how this exact regression was first caught and verified in
  the Phase 2.6 planning round (`design/matroom/verification/phase2.6-proposal/README.md` §6).
