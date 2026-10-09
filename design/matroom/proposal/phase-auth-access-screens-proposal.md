# Proposal: Auth & access-state screens page phase

**Status: PROPOSED, awaiting owner approval. Nothing in this document has been implemented.**

Following the same convention as the approved student-portal and kiosk page phases (`design/matroom/DESIGN.md`'s own change log) — a named page phase, proposed and approved before implementation, verified against the matrix below before merge. This is the first redesign phase recommended in `docs/MATROOM_REDESIGN_EXECUTION_PLAN.md`.

## Scope — 10 screens, one shared pattern for four of them

`src/app/[locale]/o/[orgSlug]/login/page.tsx`, `o/[orgSlug]/signup/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`, `accept-invitation/page.tsx`, `onboarding/page.tsx` — six real forms/flows.

`no-access/page.tsx`, `no-organization-access/page.tsx`, `organization-unavailable/page.tsx`, `select-organization/page.tsx` — four access-state screens, near-identical in shape (a message, sometimes a choice between organizations, always a way out), proposed as **one shared pattern, applied four times**, not four independent layouts.

These are Operate-register surfaces (`design/matroom/DESIGN.md`'s own classification: Persuade is only landing/registration/platform-sign-in). **D2's serif gate does not apply here.** D6 (phone navigation) does not apply either — none of these 10 screens carries a navigation sidebar or menu; each is a standalone, single-purpose page.

## What changes

- **New shared component — a centered auth/message card.** No such component exists today (confirmed: none of these 10 pages shares a common centering pattern currently). One new component, built once, used by all 10 screens: centered, card-bounded (`Card` from `src/components/ui/card.tsx`), a consistent max-width, a consistent heading treatment, built on the already-approved tokens (ground/card/foreground/input-boundary) — no new color decisions, this phase only applies Phase 1 foundation's existing system.
- **The four access-state screens** (`no-access`, `no-organization-access`, `organization-unavailable`, `select-organization`) move onto that one new component, each supplying its own message/heading/action — the underlying redirect/session logic is unchanged.
- **The six form/flow screens** move onto the same card for their outer shell; their own internal form fields move onto `Input`/`Button` from the shared component library (already approved, already used elsewhere), replacing any page-local input/button class strings the way `DESIGN.md` §7.9 already calls for across other form-bearing pages.
- **Unchanged:** every redirect target, every session/token check, every validation rule and its trigger condition, the registration-race/stale-availability findings (`DESIGN.md` §10 — explicitly out of this phase), locale switching, and the underlying server actions these pages call.

## Shared components

Reused as-is: `Button`, `Input`, `Card`, `Toast` (`src/components/ui/`). New: the auth/message card wrapper named above — the one deliverable this phase adds to the shared component library, available to every later phase (several of which, per the execution plan, are themselves "centered form" or "settings form" shapes that could reuse it).

## Functionality and accessibility preserved

- Session/redirect/token-expiry behavior — layout and visual treatment only change.
- Form validation messages and exact trigger conditions.
- Locale switching (en/es) on every screen.
- Keyboard navigation and focus order, specifically: focus lands sensibly after a token redemption (`accept-invitation`, `reset-password`) rather than being lost when the page's content swaps.
- The registration-race/stale-availability findings stay untouched, not incidentally disturbed while restyling nearby forms.

## Verification plan (matching the portal/kiosk phases' own precedent)

- Real browser, desktop + phone, light + dark, English + Spanish, for all 10 screens.
- A genuinely created test account exercising whichever flow requires one (never a seeded account, per this project's established verification discipline).
- The four access-state screens specifically checked for correct rendering at the narrowest supported phone width and a representative desktop width, with no reflow surprises.
- Existing automated tests for these pages (if any currently exist) re-run and passing; any browser/mutation-style regression tests this phase's new component warrants, added following the same pattern the portal phase established (layout/size assertions under both a mouse and a coarse pointer, not class-name-only checks).

## Effort, dependencies, checkpoints

- **Effort estimate:** 3-5 days, MEDIUM confidence.
- **Dependencies:** none — can start immediately on approval.
- **Checkpoints:** (1) this proposal's approval, before any code; (2) the new shared card component reviewed once in isolation before it's applied to all 10 screens; (3) the full verification matrix above reviewed before merge.

## Not covered by this proposal

Phase 2's Persuade surfaces (landing, register-academy, login) — gated on D2/D7, a separate proposal once those resolve. Every other phase in the execution plan. The activation/monthly-generation engineering track (unrelated code area).
