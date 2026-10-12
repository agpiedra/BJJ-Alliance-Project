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
- **Day-tabs are Tab/Enter/Space-operable native buttons, not a roving-tabindex arrow-key widget** — unlike the
  outer Home/Attendance/Schedule tabs (which do implement that pattern and are unchanged). Arrow-key roving
  between day-tabs was not implemented; this is a simplification, not an oversight, and is named here rather
  than silently assumed equivalent.
- Dark theme and ES were checked on Home/Attendance/Schedule as covered above; a full light+dark × EN+ES ×
  every-width matrix was not exhaustively captured for every combination.

## Checks

- [x] `tsc --noEmit` clean
- [x] ESLint clean on all changed files
- [x] Full unit suite: 118 files / 1673 tests passed
- [x] Full integration suite: 150 files / 1936 tests passed (including the new
      `tests/integration/attendance-month-totals.test.ts` and the baseline-comparison test reconciled for
      Home's approved restructure — see that file's own comments for how)
- [x] Real-browser verification as documented above
