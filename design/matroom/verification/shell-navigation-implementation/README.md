# Phase 2.5 (Shell & navigation) — real implementation verification

**This is the real, shipped implementation — not the prototype.** `design/matroom/verification/shell-navigation/` (a sibling folder) holds the earlier *prototype* review: static HTML mockup, `design/matroom/preview/shell-navigation-phase-prototype.html`, no application code. Everything in this folder was captured from the actual running app (`pnpm dev`, real Postgres, real auth, real seeded data) on the `feat/matroom-shell-navigation` branch, after the round-2 review-fix commit. The two folders are deliberately kept separate so neither is mistaken for the other.

## Real accounts and data used

The seeded dev accounts (`prisma/seed.ts`), not disposable ones — these are committed, stable fixtures meant for exactly this kind of manual verification, same convention `tests/browser/portal.test.ts`/`touch-targets.test.ts` already use:

- **`admin@alliancecr.com`** (ADMIN) — Alliance Jiu-Jitsu Costa Rica, **real custom branding** (`primaryColor: #FACC15`, `sidebarBackground: #111827`), **2 real academies** (Alliance Escazú, Alliance Escalante) — the multi-branch dropdown-switcher scenario.
- **`director@test.com`** (DIRECTOR) — same organization, `StaffAssignment`-scoped to Alliance Escazú only — the read-only-switcher, reduced-nav scenario.
- **`superadmin@alliancecr.com`** — platform shell.
- Password for all: `TestPass123!` (seed script's own `QA_PASSWORD`, printed by `pnpm db:seed` itself — not a secret).

## Index

| File | Scenario | Proves |
|---|---|---|
| `01-admin-desktop-branded.png` | ADMIN, desktop, real dashboard data (39 active students, real belt distribution, real promotion queue) | Desktop sidebar unchanged in substance; real tenant branding (gold/near-black) still renders correctly after `BrandingScope`'s client-component conversion |
| `02-admin-mobile-sheet-branded.png` | ADMIN, phone (390px), Menu sheet open | **§7.10 fix, live**: the mobile sheet renders in Alliance's real gold/near-black branding, not the default theme |
| `03-admin-switcher-dropdown-open.png` | ADMIN, phone, branch switcher dropdown open inside the sheet | Nested dropdown opens, positions correctly, offers both real academies |
| `04-director-mobile-sheet.png` | DIRECTOR, phone, Menu sheet open | Real role-visibility rules unchanged (6 items, no Schedule/Staff/Locations) + real read-only switcher (dot + "Alliance Escazú", no chevron) |
| `05-platform-desktop-active-nav.png` | superadmin, desktop, on `/platform/organizations` | **Review finding 1, live**: "Organizations" is bold/active, "Overview" is not — fixed from the real pathname, not hardcoded |
| `06-platform-mobile-sheet.png` | superadmin, phone, Menu sheet open | Platform's first-ever responsive treatment, live |
| `07-staff-dark-mode.png` | ADMIN, phone, dark theme, Menu sheet open | Dark mode unaffected by this phase's changes |
| `08-spanish-locale.png` | ADMIN, phone, `/es/dashboard`, Menu sheet open | Real `es.json` strings ("Menú", "Panel", "Alumnos", "Operación", etc.), `dialog "Navigation"` localizes to "Navegación" (verified via DOM, see below) |
| `09a-resize-before-sheet-open-mobile.png` / `09b-resize-after-sheet-closed-desktop.png` | ADMIN, same page, sheet opened at 390px then the **same page** resized to 1400px with no reload | **Review finding 3, live**: resizing past the breakpoint while the sheet is open closes it; confirmed via direct DOM check immediately after resize: `document.querySelectorAll('[role=dialog]').length === 0` and `getComputedStyle(document.body).overflow === "visible"` (not `"hidden"` — the scroll lock is released, not just visually hidden) |

## What was checked by direct DOM inspection, not only screenshots

A screenshot proves layout; it does not prove ARIA structure, CSS classes, or state after an interaction. These were checked directly in the live page (via `page.evaluate`) during this same session, against the real DOM, not inferred from appearance:

- The open staff sheet's accessible structure: `dialog "Navigation"` with a real `<h2>Navigation</h2>` + `<p>Browse staff sections, switch branches, and sign out.</p>` (review finding 2) — confirmed present in the accessibility tree, not just visually.
- The breadcrumb's real class list: `font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase` — **no `truncate`** (removed, per the approved owner decision to wrap instead of clip).
- The header's real class list: `flex min-h-12 items-center justify-between gap-3 border-b px-4` — **`min-h-12`, not a fixed `h-12`** (the header can genuinely grow).
- Post-resize: `[role=dialog]` count and `document.body`'s computed `overflow`, confirmed above.

No seeded organization's name is long enough to force a visible wrap at a realistic breakpoint, so the *visual* wrap/growing-header effect itself is demonstrated in the prototype folder (`design/matroom/verification/shell-navigation/e1-breadcrumb-growing-header.png`) and confirmed *mechanically* here (the real classes that make it possible are genuinely present in the shipped code, not just the mock).

## What this does NOT cover (explicit limits)

- **The nested-dropdown keyboard path and the Escape/focus-restoration path are not screenshotted here** — they are state transitions, not static states, and a screenshot of either endpoint proves little beyond what `02`/`03` already show. They are covered instead by `tests/browser/shell-navigation.test.ts` ("Escape closes the sheet and restores focus", "keyboard (arrows + Enter) also selects a branch"), which asserts the actual DOM/focus state after the real key presses, re-run on every CI build — a screenshot pair would only ever prove this one moment on this one machine.
- **INSTRUCTOR is not screenshotted in this folder** (only ADMIN and DIRECTOR) — its role-visibility behavior was already fully verified in the prototype-review round and is unchanged by this round's fixes; re-screenshotting it here would not exercise anything this round touched.
- **Platform short-screen footer reachability** (review finding 3's other half) has no screenshot here — it is a scroll-into-view behavior on a genuinely tight viewport (390×260, the first height that actually exceeds platform's real content height), better proven by the automated assertion in `shell-navigation.test.ts` than by a static image of a 44px button.
- This is still a development environment (`pnpm dev`, local Postgres, dev-only `e2e-auth-bypass` used by the automated suite though not by these specific screenshots — these were captured via real form sign-in). Production build behavior, real deployment, CDN caching, and production environment variables are untouched and unverified by this round, consistent with "no deployment, activation, or database changes."

## Round-3 verification note (accounts, persisted side effects, no cleanup)

This note accompanies the round-3 verification-quality corrections (strengthened short-screen footer test, isolated long-org-name `StaffTopBar` test, this reconciliation) and does not change anything about rounds 1–2 above.

- **Accounts, precisely:** the screenshots and manual checks in this README (rounds 1–2, everything above) used the **seeded dev accounts** as already stated — `admin@alliancecr.com`, `director@test.com`, `superadmin@alliancecr.com`. The **new** `StaffTopBar` long-org-name test added this round is the one piece of round-3 work that uses a **disposable** fixture: a fresh `Organization` + `User` + `Academy` created in the test's own `beforeAll` (randomized slug/email suffix) and deleted in its `afterAll`. Both statements are true at once about different parts of the verification; neither contradicts the other, and no seeded account's data was touched by the disposable fixture.
- **Persisted side effect, disclosed:** every real sign-in in this round (`mintSessionCookie()` for the automated suite, and any real-form sign-in) runs the shared `signInJwtCallback` (`src/lib/auth/sign-in-jwt-callback.ts`), which writes `User.lastActiveOrganizationId` (plus the implicit `updatedAt` bump) whenever it resolves a real organization for that user. This is pre-existing application behavior — the same function real NextAuth sign-in uses — not something introduced or changed by this round's testing. For the three seeded accounts used here it is behaviorally inert: `admin@alliancecr.com`/`director@test.com` each have exactly one organization membership (Alliance), so the write can only ever resolve to the same value; `superadmin@alliancecr.com` has zero memberships, so the write never fires. The disposable fixture's own user is deleted in its `afterAll`, taking any such write with it.
- **No cleanup performed on seeded data:** no dev-DB mutation, reset, or cleanup was performed against any seeded account or organization as part of this round — the only database writes this round made outside the pre-existing sign-in side effect above were the disposable fixture's own create/delete pair, scoped to its own randomized rows.
