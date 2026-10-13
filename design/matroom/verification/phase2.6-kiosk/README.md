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
- ~~The picker's bounded-scroll-with-overflow behavior at the 2-column breakpoint was confirmed structurally
  (`max-height`/`overflow-y: auto` present and measured) but not re-stress-tested with 5+ real cards in this
  round — see the Picker section above.~~ **Historical — superseded.** Discharged by the PR #118 correction
  round's real 6-card test (see the Picker section above and §5 below): the overflow, scroll-to-last-card,
  keyboard focus and real click-activation were all proven against the real component, not the prototype.
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
  functions, so a deadline computed from `Date.now()` would never have moved under `advanceTimersByTimeAsync`).
  **Correction (§6 below): the regression test added in this round did not actually prove the claim above** —
  `advanceTimersByTimeAsync` executes every intervening 250ms tick as it advances rather than skipping them, so a
  tick-counting implementation would have passed it too. Fixed in the PR #118 second correction round using
  `vi.setSystemTime` to jump the clock without firing the pending tick at all, then letting exactly one real tick
  fire — see §6.
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

## 6. PR #118 second correction round

Two further corrections, on top of §5:

- **Open-class boundary scheduling is now clock-skew-resilient.** The client previously scheduled its refetch as
  `new Date(refreshAt).getTime() - Date.now()` — correct only if the browser's clock agrees with the server's.
  `getOpenClassesNow` now also returns `serverNow` — the SAME `now` instant already used for
  `openOccurrences`/`nextBoundaryAfter`, round-tripped — and the client measures its own clock's offset from it
  once per response (`offset = Date.parse(serverNow) - Date.now()`), then schedules against `Date.now() + offset`
  rather than the raw browser clock. This is the SAME convention `src/lib/portal/todays-classes.ts` /
  `todays-classes-card.tsx`'s `useRefreshAtBoundary` already use for the portal's own boundary refresh — reused,
  not reinvented, down to the same `BOUNDARY_MARGIN_MS = 250` and the same self-rechecking schedule-then-verify
  loop (fire only once `serverTime() >= target`, otherwise reschedule). Not extracted into one shared helper: the
  portal's version is a hook driven by props and a `refresh` callback ref; the kiosk's lives inside a fetch effect
  that also owns sequential-fetch and loading-state concerns the hook doesn't have — the two don't factor into one
  shape without forcing an abstraction neither side needs, though the boundary math itself is identical.
  Sequential-only fetches, the `cancelled` teardown guard, and the "clear to loading before refetch" boundary
  invalidation from §5 are all preserved unchanged. Two new tests in `tests/unit/kiosk-redesign.test.tsx` prove a
  server clock 5s AHEAD and 5s BEHIND the browser's both still refetch at the TRUE server-relative delay (not the
  browser's naive, wrong one), with exactly one extra fetch call at the correct instant and none before it — no
  immediate-request loop in either direction. `tests/integration/kiosk-open-classes-route.test.ts` gained a test
  pinning `serverNow` to the fixture's own captured `now`.
- **The delayed-tick regression test from §5 is fixed, and its claim corrected.** As noted in §5, the original
  test's `advanceTimersByTimeAsync(3000)` executes every intervening 250ms tick rather than skipping any, so it
  never actually exercised a missed tick. Confirmed empirically (a scratch probe, deleted after use, never
  committed) that `vi.setSystemTime(...)` jumps the faked clock with ZERO timer callbacks firing, and that a
  subsequent small `advanceTimersByTimeAsync` then fires the one already-pending, now-overdue interval callback
  exactly ONCE, at the jumped clock position — a genuine skipped-tick scenario. The test now does exactly that:
  jump 3000ms via `setSystemTime`, then `advance(250)` to let that one tick fire, and asserts "3s". **Proved the
  test is meaningful before trusting it**: temporarily reverted only the countdown effect in `kiosk-client.tsx` to
  the old per-tick `remainingMs -= TICK_MS` logic (uncommitted, local only), ran just this one test, and confirmed
  it failed — the old logic showed "6s" (one decrement of 250ms against a 6000ms base still rounds up to 6),
  exactly as predicted, against the fixed test's "3s" expectation. Restored the real fix immediately after;
  `git diff --stat` before and after the experiment was byte-for-byte identical, confirming zero residue.

Full suites after this round: `pnpm test:unit` — 1707/1707 pass (120 files, +2 net from this round: 3 new, 1
rewritten in place). `pnpm test:integration` — 1947/1947 pass (152 files, +1 from this round). `tsc --noEmit` —
clean.
