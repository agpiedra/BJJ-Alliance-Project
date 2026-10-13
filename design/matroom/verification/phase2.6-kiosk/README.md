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
- **Not independently stress-tested with 5+ cards against the real component in this round** — the earlier
  planning-phase prototype already stress-tested the same CSS shape (8 cards, confirmed real scroll via
  `scrollHeight > clientHeight`, §8.4/§9.2 of the proposal); this round confirms the real component applies the
  same grid/bound/scroll rules with 3 real cards, which fit without triggering scroll. Treat the "many classes
  scroll, not clip" claim as inherited from the prototype's stress test, not re-proven here with >4 real cards —
  disclosed, not hidden.
- Real click activation of a picker card (not just programmatic): confirmed — selecting "Fundamentals" produced
  the real success screen with `matchedClass.name === "Fundamentals"`.

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
