# Phase 2.6 PR 2 — Portal content (Home, Attendance, Schedule): implementation verification

Implements the approved Phase 2.6 proposal's PR 2 (`design/matroom/verification/phase2.6-proposal/README.md`
§10), on top of PR #114's merged portal navigation. No login/org-selection/kiosk changes, no promotion-policy
work, no database/migration/deployment/activation changes.

## What changed, per screen

- **Home**: belt hero (`home-hero.tsx`, new) replaces the bordered in-grid progress card; a top-of-page payment
  alert (legacy-overdue and ledger-active-debt branches, both independently gated on a positive known fact —
  never on `null`/unavailable, never on no-debt) replaces the payment card's inline overdue paragraph (moved,
  not duplicated).
- **Attendance**: new `getAttendanceMonthTotals` read (`src/lib/students/attendance-history.ts`) for accurate
  this-month/last-month totals, contract exactly as specified in the approved proposal (§9.3): session-derived
  identity only, `America/Costa_Rica` month boundaries, the same 3-way check-ins/staff-days/other-adjustments
  split as the existing whole-ledger `getAttendanceTotals`. Client-side month-grouping of the already-paginated
  list (cosmetic, no new read) renders a separate `<ul>` per month with a header shown only when more than one
  month is present.
- **Schedule**: `schedule-day-list.tsx` rewritten as a phone-only day-tab picker (desktop's `WeekCalendar` 7-day
  grid, `hidden md:block`, is completely untouched) — day-tabs measure 56×64px (confirmed live, below), a full
  weekday+month+day heading for the selected day, `scrollIntoView` on mount/selection change.

## Preserved from PR #114 — verified live, not assumed

- Bottom-phone/top-desktop tab bar position: confirmed live at both 320/390px (fixed, pinned to viewport
  bottom) and 1280px (static, day-tab picker `display:none`, desktop `WeekCalendar` visible instead).
- `<main>`'s safe-area content-clearance padding: confirmed live — scrolling Home's panel to its end at 320px
  height 700, the last child's bottom edge (643.8px) clears the fixed bar's top edge (655.3px).
- Real WAI-ARIA tabs mechanism (roving tabindex, arrow-key nav, hash sync) on the outer Home/Attendance/Schedule
  tabs: unchanged, untouched by this PR.

## Real-browser verification — real account, real data, isolated test-DB environment

Per this project's standing rule, verification used a genuinely registered account, not a seeded shortcut:
registered a new academy via the real `/register-academy` form, approved it with `scripts/approve-organization.ts`,
accepted the owner invitation via the real `/accept-invitation` flow, then created a real student through the
real staff "Create student" form and linked it to a freshly created `User` with a real password (student
portal accounts have no self-service or staff-invite UI in this codebase today — this is disclosed as a gap,
not glossed over), and logged in as that student via the real `/login` form. Two real class sessions (Monday,
Wednesday) were created via the real admin Schedule UI; five real `AttendanceRecord` rows spanning three real
calendar months (August/September/October 2026) were added directly to exercise cross-month behavior.

**Home** (real overdue payment on file): the top alert rendered live —
*"Your payment for this month is overdue. Please contact your academy."* — confirming the legacy-overdue
branch fires correctly end to end. Hero and alert both render with zero page-level overflow and zero
element-level clipping at 320×700 (`document.documentElement.scrollWidth === window.innerWidth`, no element
under `main` with `scrollWidth > clientWidth`), in both light and dark (`01-home-320-light.png`,
`02-home-320-dark.png`), and at 1280px desktop (`03-home-desktop-light.png`).

**Attendance** (real cross-month data, EN and ES): the stat row read **"2 attendances this month" / "2
attendances last month"** — correct against the seeded August(1)/September(2)/October(2) split — confirming
the server read, not a client-side undercounted guess from loaded rows. The list grouped into three real
`<ul>`s headed "OCTOBER 2026" / "SEPTEMBER 2026" / "AUGUST 2026", newest-first, each entry's kind label correct
("Class attendance · Evening GI", "Attendance (no class matched)", "Added by staff"). Re-verified in Spanish at
`/es/portal#attendance`: **"2 asistencias este mes" / "2 asistencias el mes pasado"**, month headers "OCTUBRE
DE 2026" / "SEPTIEMBRE DE 2026" / "AGOSTO DE 2026", DD/MM/YYYY date formatting — all correct, zero page overflow
at 320px with the longer Spanish strings.

**Schedule**: day-tabs measured **56×64px** live (`getBoundingClientRect()`), confirmed ≥44px in both
dimensions. Clicking Wednesday showed the real "No-Gi" class and updated the full-date heading; clicking the
empty Tuesday showed "No classes that day."; clicking Sunday showed the preserved "No classes on Sunday" note.
Re-verified in Spanish: "Dom 11"/"Lun 12"/"Mar 13"/"Mié 14"/"Jue 15"/"Vie 16"/"Sáb 17" tabs, full heading "lunes,
12 de octubre", zero page overflow. The day-tab row itself scrolls internally (`scrollWidth 440 > clientWidth
255`) — bounded, not page-level — so all 7 tabs stay reachable without the page itself overflowing. At 1280px
desktop, confirmed `display:none` on the day-tab picker and the real `WeekCalendar` grid visible instead
(`04-schedule-desktop-light.png`).

**Keyboard**: the day-tabs are real `<button>` elements - focused the "Tue 13" tab programmatically, pressed a
real `Enter` key, and confirmed the selection moved and the panel updated (not a click event substituted for a
key press).

## Honest limitations, disclosed not hidden

- **No student self-service or staff-invite flow exists in this codebase today** for granting a new student
  portal login — `create-student-core.ts` creates only the `Student` row, no `User`. The real browser
  verification above used a directly-created, uniquely-generated `User` (never a shared seeded fixture like
  `student@test.com`) linked to a real staff-created `Student` record, consistent with the project's own
  integration-test pattern (`tests/integration/portal-attendance-actions.test.ts`'s `studentUser()` helper) —
  not a shortcut around the "verify as a registered user" rule, but this codebase's only available path to a
  real student login today. Flagged here as a real product gap, separate from this PR's own scope.
- **CDP-emulated nonzero safe-area inset** (PR #114's own technique) was not re-run for this PR — the shell
  code itself (`PortalTabs`'s `env(safe-area-inset-bottom)` rule) is unchanged by PR 2, so PR #114's own
  verification of that mechanism still applies; this PR only re-confirmed content clearance at the 0px value
  this environment produces by default.
- Dark theme and ES were checked on Home/Attendance/Schedule as covered above; a full light+dark × EN+ES ×
  every-width matrix was not exhaustively captured for every combination.

## Correction round (this PR, same branch) — fixes to the above

A prior reviewer flagged three gaps in the original round above, now addressed:

1. **Day-tabs now implement the same accessible-tabs pattern as the outer Home/Attendance/Schedule tabs**
   (`schedule-day-list.tsx`): roving tabindex, ArrowLeft/ArrowRight wrap, Home/End jump, `aria-controls`/
   `aria-labelledby` id-linking to a real `role="tabpanel"`. The "not implemented" note above is no longer
   accurate and is superseded by this section. Verified LIVE with real keyboard events (CDP, not jsdom) at
   390px in a fresh registered org/student with real class sessions: ArrowRight moved focus+selection with a
   visible focus ring and updated panel content correctly across a populated day, an empty weekday, and the
   preserved "No classes on Sunday" day; Home/End correctly jumped to the first/last day-tab; `display:none`
   at desktop width was re-confirmed unchanged. New behavioral tests in `tests/unit/schedule-day-list.test.tsx`
   (10 tests) cover the same mechanics in jsdom. See `tests/unit/portal-tabs.test.tsx` for the convention this
   follows.
2. **The baseline-comparison test's disclosure was incomplete.** It only named `PortalTabs` as a
   current-on-both-sides import; `AttendanceHistorySection` and `ScheduleDayList` are equally current-on-both-
   sides (confirmed directly against the git-extracted baseline source, which already names all three by the
   same relative import paths) and the test's own description of what it proves about the Attendance/Schedule
   panels overclaimed ("unchanged") what a shared-current-import comparison can actually show. Both the
   file-level comment and the specific test description in
   `tests/integration/portal-page-inactive-baseline-comparison.test.tsx` now name this precisely, and the test
   now also states explicitly that its empty-attendance fixture exercises neither the new monthly-stats feature
   nor populated month-grouping — that proof is `tests/integration/attendance-month-totals.test.ts` and this
   PR's own real-browser evidence (above), never that file.
3. **The test claimed "plan name ... is still shown" in prose without ever asserting the literal plan-name
   string.** It now asserts the fixture's actual plan name (`` `PortalBaseline plan ${suffix}` ``) is present in
   both the baseline and current renders, not just the generic "Payment status"/"Paid" labels.
4. **The new monthly-stat read's failure path was untested through the real page.** New
   `tests/integration/portal-page-monthly-stat-failure.test.tsx` renders the actual `portal/page.tsx` with
   `getAttendanceMonthTotals` forced to reject (every other export of the same module left real, via
   `importOriginal` passthrough) and proves: the panel shows the exact "Couldn't load this month's totals."
   text (not a false "0", not an uncaught exception — console confirms `page.tsx`'s own try/catch genuinely
   fires) for both the this-month and last-month stats, and the rest of the page — payments, the schedule
   panel's heading, and the attendance history list's own real row — still renders correctly despite that one
   failed read. A control-case test (the same render with the read succeeding) proves the forced-failure case
   is a genuine difference, not a tautology.

## Checks

- [x] `tsc --noEmit` clean
- [x] ESLint clean on all changed files
- [x] Full unit suite: 119 files / 1683 tests passed (includes the new `tests/unit/schedule-day-list.test.tsx`)
- [x] Full integration suite: including `tests/integration/attendance-month-totals.test.ts`, the corrected
      `portal-page-inactive-baseline-comparison.test.tsx` (10/10 passing with the new plan-name and disclosure
      corrections), and the new `portal-page-monthly-stat-failure.test.tsx` (3/3 passing) — see each file's own
      comments for exactly what it does and does not prove
- [x] Real-browser verification as documented above, plus the correction round's live keyboard verification
