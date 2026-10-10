# Auth & access-state phase — prototype review screenshots

**Prototype-stage review material, not final implementation verification** — matching the status of `design/matroom/preview/auth-access-phase-prototype.html`, which these images are captured from. Not an approved design; captured for the owner's visual decision only. Real browser (Chromium via Playwright), served locally over HTTP (file:// is blocked by the browser tooling used), real token CSS, no mock data beyond what the prototype file itself defines.

## Index

| File | Scenario | Frame width | Theme | Language |
|---|---|---|---|---|
| `a1-login-normal-en.png` | A — org login, normal state | Simulated 760px (desktop) + 375px (mobile), side by side | Light | EN |
| `a2-login-error-dark-en.png` | A — org login, validation-error state + normal state | Simulated 760px | Light (error) / Dark (normal) | EN |
| `a3-login-es.png` | A — org login, normal state | Simulated 760px | Light | ES |
| `b1-invite-reset-valid-en.png` | B — set-new-password, valid-token state | Simulated 760px (desktop) + 375px (mobile) | Light | EN |
| `b2-invite-reset-expired-light-dark-en.png` | B — expired-token state | Simulated 760px | Light + Dark (both shown) | EN |
| `c1-org-select-en.png` | C — organization selection, 3 orgs | Simulated 760px (desktop) + 375px (mobile) | Light | EN |
| `c2-org-select-dark-es.png` | C — organization selection, 3 orgs | Simulated 760px | Dark | ES |
| `d1-access-denied-en.png` | D — no-organization-access state | Simulated 760px (desktop) + 375px (mobile) | Light | EN |
| `d2-org-unavailable-dark-en.png` | D — organization-unavailable state | Simulated 760px | Dark | EN |
| `focus-1-button-light.png` | Keyboard focus: "Sign in" button, real Tab key | Simulated 760px | Light | EN |
| `focus-2-button-dark.png` | Keyboard focus: "Sign in" button, real Tab key | Simulated 760px | Dark | EN |
| `focus-3-link-dark.png` | Keyboard focus: "Forgot your password?" link, real Tab key | Simulated 760px | Dark | EN |
| `focus-4-link-light.png` | Keyboard focus: "Forgot your password?" link, real Tab key | Simulated 760px | Light | EN |
| `real-viewport-390x844.png` | Section A, top of page | **Real browser viewport, 390×844** (not a simulated frame) | Light | EN |

## Simulated frame width vs. real browser viewport — what the difference actually is

Every screenshot except the last one was captured at a real desktop browser viewport (1440×1050) — the "760PX"/"375PX" labels visible in each image are **simulated mock-up frames**: plain fixed-width `<div>`s inside that one real viewport, standing in for what a phone or desktop window would show, laid out side by side so light/dark/EN/ES/desktop/mobile variants can be compared on one screen. They are not the result of actually resizing the browser.

`real-viewport-390x844.png` is different: the **actual browser window** was resized to 390×844 (a real phone's viewport size) and the page was loaded fresh at that size — this tests how the comparison page itself behaves on a genuinely narrow screen, not how the proposed login screen would look on one. Finding from that test, stated precisely: the browser's default flex-shrink behavior compresses the 760px-labeled frame to fit the real 390px viewport rather than clipping it or forcing horizontal scroll — the comparison page stays readable at a real phone width, but the "760PX" label should not be read as an unshrinkable hard width in every viewing context.

## Keyboard-focus verification — what was actually tested, not merely described

A real `Tab` key was pressed in the browser and `document.activeElement` was read back after each press to confirm which element actually received focus, before each `focus-*.png` screenshot was taken. This caught two real, now-fixed issues during this review round:

1. **Buttons/links had no visible focus-visible treatment** — confirmed via a screenshot showing focus landed on the "Sign in" button (`document.activeElement` matched it) while the rendered image showed no visible ring. Fixed by adding an explicit `.btn:focus-visible, .btn-link:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }` rule to the prototype's CSS, matching the token already used correctly by the input fields. Re-verified in both light and dark (`focus-1`, `focus-2`) — now clearly visible, no clipping against either the card or the frame's rounded-corner `overflow: hidden`.
2. **The prototype's own link markup had no `href`**, so real keyboard navigation skipped past it entirely (an `<a>` without `href` is not a native tab stop) — not a CSS issue, a markup gap in the prototype itself. Fixed by giving each `.btn-link` a real `href="#"` with a no-op click handler (prototype-only; a real implementation's links already have real destinations). Re-verified the link is now a genuine tab stop with a visible focus ring in both themes (`focus-3`, `focus-4`).

## Verification limits — what this prototype review does and does not prove

This is static markup with no application logic. What was verified: visual rendering (no clipping/overflow in the mock content), text readability across both themes and both languages, and that keyboard Tab order reaches every real interactive element with a visible focus indicator.

**What this does NOT prove, and no amount of screenshots can:** real authentication, real credential validation, real session/redirect behavior, real token expiry/validity checking, or real server-side error handling. Every "error," "expired," and "valid-token" state shown here is a hand-authored static mock of what that outcome should look like — not a test of the real screens' actual logic, which this phase's proposal explicitly preserves unchanged (see the proposal document). Functional verification of the real screens happens when this phase is actually implemented, against the real auth/session code, the same way every prior MATROOM phase's own verification worked.
