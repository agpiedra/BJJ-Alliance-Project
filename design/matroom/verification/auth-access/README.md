# Auth & access-state phase — real implementation verification

Real running app (`pnpm dev`, Turbopack, dev database), real Chromium via Playwright MCP, real server actions — not the static prototype (`design/matroom/preview/auth-access-phase-prototype.html`, see `design/matroom/verification/auth-access-prototype/` for that earlier, separate round). Every screenshot below is a genuine render of the shipped code on this branch.

**This is round 1.** A side-by-side comparison against the prototype afterward found real layout discrepancies (branding placement, card spacing, the organization-selection row treatment) — corrected in `round-2-correction/`, which also finishes the verification this round left partial (onboarding step 1, valid-invitation states, a genuine multi-organization case) and records a first-pass font-rendering investigation. Read that folder's own README alongside this one; this round's own coverage table below is otherwise unchanged from when it was written, including the gaps round 2 closes.

**Round 3** (`round-3-reverification/`) resolves the font finding conclusively (production build, a genuinely fresh/isolated browser process, real elements — not round 2's hedged automation-session theory) and re-verifies the corrected layout at a real mobile viewport across both themes and languages, including a genuine multi-organization case with a long organization name that wraps instead of truncating. Round 1's and round 2's own mobile/desktop screenshots predate that layout and are not re-used as proof of it.

## Coverage by exact route (10 approved screens)

| # | Route (file) | Verified | Notes |
|---|---|---|---|
| 1 | `o/[orgSlug]/login/page.tsx` (via shared `login/login-form.tsx`) | ✅ a1–a4, focus-1/2 | Light + dark, EN + ES, desktop + mobile, real wrong-credential rejection, real keyboard focus |
| 2 | `o/[orgSlug]/signup/page.tsx` | ✅ c1–c2 | Dark/EN desktop, light/ES mobile, real academy data in the dropdown |
| 3 | `forgot-password/page.tsx` | ✅ b1 | Real action call (seeded email), real generic non-disclosure confirmation |
| 4 | `reset-password/page.tsx` | ✅ b2–b3 | Real valid token (minted by the real `requestPasswordReset` action, redeemed) **and** real invalid-token rejection, dark |
| 5 | `accept-invitation/page.tsx` | ✅ d1 | Real invalid-token state, dark. Valid-token ("join"/"setPassword") states not separately captured this round — same `AuthCard`/`Input` primitives already proven on every other screen |
| 6 | `onboarding/page.tsx` | ⚠️ partial | Real ADMIN session → real idempotent redirect to `/admin/branding` confirmed (unchanged logic). The step-1 form itself (`step1-form.tsx`, the only file touched here) was not reached — no seeded org in this dev DB has `onboardingCompletedAt: null`. The change there is a minimal, type-checked `Input` swap, identical in kind to the pattern already visually verified on 4 other screens |
| 7 | `no-access/page.tsx` | ✅ e2 | Real STUDENT session, light, EN |
| 8 | `no-organization-access/page.tsx` | ✅ e3 | Real STUDENT session, light, EN, mobile 390×844 |
| 9 | `organization-unavailable/page.tsx` | ✅ e4 | Dark, ES (this page has no auth check by design) |
| 10 | `select-organization/page.tsx` | ✅ e1 | Real STUDENT session, dark, EN |

**Bare `/login/page.tsx` is explicitly out of this phase's 10-screen scope** (not in `design/matroom/proposal/phase-auth-access-screens-proposal.md`'s list) and was not separately navigated to or screenshotted. It renders the exact same `login-form.tsx` component as screen #1 above — the only file that changed for that route — so its render is covered by extension, not by a direct screenshot of `/login` itself.

## Real flows exercised (not mocked)

- Wrong email/password on the real `login` action → real `CredentialsSignin` rejection, real localized error copy (`a4`).
- Real sign-in with a seeded account's actual password, through the real form — used to reach the session-gated screens (no-access, no-organization-access, select-organization, onboarding's redirect).
- `requestPasswordReset` called for real (`b1`) — the dev-only console-log delivery path logged a real single-use token, which was then redeemed through the real `resetPassword` action (`b2`). No email was sent (dev has no email provider configured — see that action's own code comment).
- A syntactically-invalid token through the same real `resetPassword` and `describeInvitation` code paths (`b3`, `d1`).

## Side effect disclosed

`student@test.com`'s **dev-database** password was changed (via the real reset flow above) from the seeded `TestPass123!` to a verification-only value. Attempting `pnpm db:seed` to restore it failed with a pre-existing `ColumnNotFound` error against the dev database — unrelated to this phase, a dev-DB/migration drift issue that predates this branch. The **test** database used by `pnpm test:integration` is unaffected (it reseeds automatically per run) and all 1909 integration tests pass against it.

## Keyboard focus (real Tab key, computed styles read back)

`focus-1`/`focus-2`: real `Tab`/`Shift+Tab` presses against the live login form, `document.activeElement` and `getComputedStyle(...).outline` read back after each press — not inferred from markup. Both the "Forgot your password?" link and the "Sign in" button receive a real `2px solid` ring in the theme's `--ring` color.

## Verification limits

This round proves real rendering, real locale switching, real light/dark token application, real keyboard-focus reachability, and exercises the real server actions for login/forgot-password/reset-password/accept-invitation/select-organization/no-access/no-organization-access/organization-unavailable. Automated coverage of the same logic (1642 unit + 1909 integration tests, all passing) is the system of record for correctness — these screenshots are visual evidence, not a substitute for that suite.
