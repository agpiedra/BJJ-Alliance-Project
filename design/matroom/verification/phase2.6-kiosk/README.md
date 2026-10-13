# Phase 2.6 PR 5 — Kiosk: Entry open-now panel, Picker responsive grid, Success countdown/Done

Verification for the kiosk redesign's three approved pieces (`design/matroom/verification/phase2.6-proposal/README.md`
§9.1/§9.2/§10 PR 5): the Entry screen's "open for check-in now" panel (new pre-identification read), the Picker's
landscape ≥900px 2-column grid, and the Success screen's numeric countdown + Done button.

## 1. The new read

`src/lib/kiosk/open-classes.ts` (`getOpenClassesNow`) is a thin wrapper: `prisma.classSession.findMany({ academyId,
organizationId, active: true })` then the existing, unchanged `openOccurrences(sessions, now)` — the exact same
function `performCheckIn` itself evaluates against, so what the panel shows is exactly what the server will accept.
`src/app/api/kiosk/open-classes/route.ts` follows the same academy-lookup + token-verification gate as
`check-in/route.ts` and `reassign/route.ts`, plus the same org-ACTIVE gate `check-in/route.ts` applies. Deliberately
**not** behind `reserveKioskAttempt`: this endpoint accepts no PIN, only an already-verified device token — no
PIN-guessing surface exists for a rate limiter to defend (the same reasoning `reassign/route.ts`'s own comment
states for itself).

**Explicit scope boundary honored:** the prototype's "No-Gi opens at 5:31 PM" next-opening-time line was **not**
implemented — it needs a different computation (the next NOT-yet-open occurrence) not authorized by the execution
plan's "callable before identified" language, which is scoped to the open-now read only. The panel shows only
currently-open class names.

## 2. Tests

- `tests/integration/kiosk-open-classes-route.test.ts` (6 tests, new): academy/organization scoping (another
  academy's class and an inactive class never appear), the SAME midnight-crossing case
  `kiosk-window-rules.test.ts` already proves for check-in (reused, not re-derived), the empty-vs-unavailable
  distinction (200 + `[]` for "nothing open," 404/401 `invalid_token`, 403 `org_unavailable`).
- `tests/unit/kiosk-redesign.test.tsx` (+6 tests): the open-now panel shows joined class names once the background
  fetch resolves; a confirmed-empty response and a rejected fetch both omit the panel (tested as distinct
  scenarios, even though the rendered result coincides — never a false "nothing open" claim either way); the
  countdown ticks from the bar's own total duration and renders success-only; Done triggers the identical
  `resetToEntry` transition the timeout fires, with no extra network call; no Done button outside the success
  phase.
- `tests/unit/kiosk-class-picker.test.tsx` (+1 test): the picklist container's class names are present for both
  the default single-column state and the `min-[900px]:landscape:` 2-column/bounded-scroll state — jsdom can't lay
  out real CSS Grid, so this only pins the class names; the real layout is verified below.
- Existing kiosk unit tests (`kiosk-redesign`, `kiosk-class-picker`) needed one infrastructure fix, not a behavior
  change: both files' shared `fetchMock` is a strict call-order queue (`mockReturnValueOnce`), and the new Entry
  panel's background fetch on mount was consuming the first queued value meant for the check-in/reassign call
  under test. Fixed by routing `/api/kiosk/open-classes` calls to a separate, harmless default mock, leaving every
  existing `fetchMock` call-order/count assertion untouched.
- Full suites: `pnpm test:unit` — 1702/1702 pass (120 files). `pnpm test:integration` — 1945/1945 pass (152 files).

## 3. Real-browser verification

Seeded via a scratch script (deleted after use, never committed) directly against the **test** database
(`alliance_bjj_test`, port 5433 — already fully migrated; the separate dev database at port 5432 was 5 migrations
behind on unrelated dues/payment work and was left untouched, no migration run against it). A temporary `next dev`
instance was pointed at the test database via an inline `DATABASE_URL` override (never written to any `.env` file)
and stopped at the end of the session. Real academy, real class sessions, and a real student created the same way
`tests/helpers/class-fixtures.ts` creates fixtures — never a seeded demo account. All seeded rows (academy, class
sessions, student, attendance, kiosk rate-limit rows) were deleted again before finishing.

Driven with the Playwright MCP tools (navigate, click, keyboard, resize, evaluate, real `page.route`/`context().setOffline()`
network control) — this is genuine browser behavior, not a static prototype or code-inspection claim.

**Entry — "open for check-in now" panel:**
- Real open classes (3, overlapping at seed time): panel shows "Fundamentals · Advanced No-Gi · Kids Advanced" —
  `entry-1024x768-landscape-open-panel.png`.
- A second, session-less academy: panel correctly absent (confirmed-empty) — verified via DOM text search, not
  screenshotted separately (same visual as the dark-mode/320px captures, which also show no open classes left by
  that point in the session).
- 320px portrait: `entry-320-portrait-open-panel.png` — `scrollWidth === innerWidth` (320), no horizontal overflow.
- Dark theme at 1024×768: `entry-1024x768-dark.png`.
- EN and ES (real `next-intl` strings, not substituted): confirmed via accessibility snapshot — EN "Open for
  check-in now", ES "Abierto para registrar ahora", both with the real joined class names.
- **Unavailable path, forced with a real aborted network request** (`page.route(...).abort()`, not a mock): panel
  correctly omitted, keypad fully functional (`Enter your 4-digit code` still renders and the digit keys are
  present) — this is the "never a false nothing-open claim, never blocks the keypad" requirement proven against a
  genuine failed fetch, not jsdom.

**Picker — responsive grid:**
- Landscape 1024×768 with the real 3 open classes: `display: grid`, `grid-template-columns: 324px 324px` (2
  columns), `max-height: 548px`, `overflow-y: auto` — measured via `getComputedStyle`, not inferred from a
  screenshot. `picker-1024x768-landscape-3cards.png`.
- Portrait 390×844, same 3 classes: `display: flex`, `flex-direction: column` (single column, unchanged
  production behavior), no horizontal overflow (`scrollWidth === innerWidth === 390`).
  `picker-390-portrait-stacked.png`.
- Real click activation of a picker card (not just programmatic): confirmed — selecting "Fundamentals" produced
  the real success screen with `matchedClass.name === "Fundamentals"`.
- **PR #118 correction round — 6-card overflow, now stress-tested against the real component (the limitation
  above is discharged):** a real seeded academy with 6 real overlapping open classes, landscape 1024×768.
  `getComputedStyle` on the grid measured `display: grid`, `grid-template-columns: 316px 316px`, `max-height:
  548px`, `overflow-y: auto`, `scrollHeight: 597` vs `clientHeight: 548` — a real, measured overflow, not
  inferred (`picker-1024x768-landscape-6cards-before-scroll.png`). The last card ("Competition Team") was
  scrolled into view with `scrollIntoView`, confirmed fully inside the viewport afterward
  (`picker-1024x768-landscape-6cards-scrolled-to-last.png`), given real keyboard focus (`el.focus()` →
  `document.activeElement === el`), and activated with a real click — the resulting success screen showed
  `"Attendance saved to" / "Competition Team"`, the exact last card, not a nearer one. The same 6-card fixture
  was also run at 390×844 portrait: all 6 cards render single-column stacked (unchanged production behavior),
  `scrollWidth (375) <= innerWidth (390)`, no horizontal overflow
  (`picker-390-portrait-6cards-stacked.png`).

**Success — countdown + Done:**
- Real success screen after a real check-in: belt graphic, progress fraction, "Attendance saved to", "Not this
  class?", **and** the new "Done" button and "Ready for the next person in Ns" countdown text, all rendered
  together — `success-1024x768-landscape-countdown-done.png`.
- Clicked the real "Done" button (`page.locator('button:has-text("Done")').click()`) and confirmed the component
  returned to the keypad screen immediately (well before the 6-second timeout could have fired on its own) — the
  real `resetToEntry` transition, triggered manually, not just observed as the natural timeout (which was also
  separately observed once, earlier in the session, confirming both paths land on the same screen).
- Confirmed via a direct DB read that the check-in that preceded this Done click wrote exactly one
  `AttendanceRecord` and nothing else — no second write was produced by clicking Done.

**Offline-queue regression** (the Entry/Success edits touch the same component tree as the offline machinery):
real `page.context().setOffline(true)` + a real PIN submission produced the "queued offline" confirmation; coming
back online (`setOffline(false)` + a real `online` event) flushed the queue — confirmed via a direct DB read that
the queued check-in created a real `AttendanceRecord` with `source: "KIOSK"`.

## 4. Honest limitations

- **Real-iOS device verification remains outstanding** — unrelated to this PR (kiosk has no bottom tab bar, no
  safe-area change), and this PR does not discharge that Phase 2.6 acceptance item. CDP/Playwright emulation here
  is not claimed as a substitute for it.
- ES coverage for this PR is the Entry panel only (the one new copy); Picker/Success were not separately
  re-verified in Spanish in this round (their new copy — "Done", the countdown text — exists in both `en.json`
  and `es.json`, confirmed by direct file read, but not re-screenshotted in Spanish).
- Dark theme was checked on the Entry screen only, as a representative sample, matching this project's established
  per-round sampling convention — not across Picker/Success.
- The picker's bounded-scroll-with-overflow behavior at the 2-column breakpoint was confirmed structurally
  (`max-height`/`overflow-y: auto` present and measured) but not re-stress-tested with 5+ real cards in this
  round — see the Picker section above.
- No real test of the rate-limit/lockout path against the new `open-classes` route specifically — it has no rate
  limiting by design (see §1), so there is nothing to test there; this is a deliberate omission, not a gap.

## 5. PR #118 correction round

Three corrections made after the first review, on top of the work above:

- **Countdown is now deadline-derived, not tick-counted.** The original effect (§3 below is corrected to match)
  decremented a local `remainingMs` by 250ms every interval tick — a second, independent clock that could drift
  from the real `setTimeout(resetToEntry, ms)` and would under-correct after any delayed tick (a backgrounded
  tab, a slow render). It now captures `deadline = Date.now() + ms` once in `armReset`, and the interval only
  re-reads `deadline - Date.now()` on every tick — a display refresher, never a second clock, and never itself a
  reset trigger. `tests/unit/kiosk-redesign.test.tsx` now also fakes `Date` (it previously faked only the timer
  functions, so a deadline computed from `Date.now()` would never have moved under `advanceTimersByTimeAsync`)
  and adds a regression that jumps fake time by a single 3000ms step (skipping ~12 would-be 250ms ticks) and
  confirms the display still lands on the correct "3s", proving it reads elapsed time rather than counting ticks.
- **Open-classes freshness hardened.** `getOpenClassesNow` now also returns `refreshAt` —
  `nextBoundaryAfter(sessions, now)` over the SAME sessions/now already used for `openOccurrences`, no second
  query — and the Entry panel schedules its next refetch exactly there instead of a blind 60s poll, clearing to
  "loading" at that instant rather than keep showing the now-provably-stale list as confirmed. Same-instance
  response reordering cannot happen by construction (the next fetch is only ever scheduled from inside the
  previous one's own continuation); the one real race — a prop change tearing down an in-flight fetch — is
  covered by the pre-existing `cancelled` flag. Both are proven in `tests/unit/kiosk-redesign.test.tsx`'s new
  "PR #118 correction: open-classes freshness" block: a torn-down instance's stale, later-arriving response never
  overwrites what the new instance fetched, and a boundary crossing triggers a real automatic refetch while
  correctly hiding the expired list in between. `tests/integration/kiosk-open-classes-route.test.ts` gained a
  test pinning `refreshAt` to `nextBoundaryAfter` over the fixture's own sessions — not re-derived, reused.
- **Picker 6-card overflow, real-browser proven** — see §2 above; the prior round's disclosed "not independently
  stress-tested with 5+ cards" limitation is now discharged with the real component, not just the planning-phase
  prototype.

Full suites after this round: `pnpm test:unit` — 1705/1705 pass (120 files, +3 from this round). `pnpm
test:integration` — 1946/1946 pass (152 files, +1 from this round). `tsc --noEmit` — clean.
