# Portal Attendance — visual reconciliation + bounded plan

**Status:** proposal only. No production files changed. No commits. Nothing merged. Awaiting visual
approval before any implementation.

## Scope

Reconcile the Portal Attendance screen (`src/app/[locale]/portal/page.tsx`'s Attendance panel,
rendered by `src/app/[locale]/portal/attendance-history-section.tsx`) against the October reference
(`MATROOM-UI-proposal-2026-10/screens/Portal-Attendance.dc.html`) and the already-approved findings
in `design/matroom/verification/phase2-reconciliation/export/RECONCILIATION-REPORT.md` (v3, §8 and
the "Confirmed residual differences" section for this screen). This pass adds the first-ever
current-state screenshot of this screen (none existed before) and a labelled proposed-preview, built
from the same real data, for visual approval.

## What was already shipped (PR #115) — verified against current main, not re-proposed

Read `attendance-history-section.tsx` (198 lines) and `attendance-history.ts` (200 lines) in full.
Both match the reconciliation report's own citations exactly:

- **Month grouping**: `monthGroups` (`attendance-history-section.tsx:93-107`) groups the already-
  paginated rows client-side, newest first, one `<ul>` + a sibling heading per calendar month
  (Costa Rica zone). Confirmed live: current data renders "September 2026" / "August 2026" / "July
  2026" / "June 2026" / "May 2026" / "April 2026" headings.
- **Server-computed this-month/last-month stat row**: `attendance-history-section.tsx:125-128`
  renders `monthlyStats.thisMonth` / `.lastMonth`, sourced from `getAttendanceMonthTotals()`
  (`attendance-history.ts:169-199`) — a real date-ranged aggregate query over the WHOLE ledger for
  one calendar month in `ZONE` (America/Costa_Rica), never derived from loaded rows. Confirmed live:
  "0 attendances this month" / "1 attendance last month" matched the real seeded data, independent
  of how many rows had loaded.
- **Defined total / breakdown / showing**: `getAttendanceTotals()` (checkIns + staffDays +
  otherAdjustments, `attendance-history.ts:134-159`) backs the "20 attendances in total" / "20
  checked in, 0 days added by staff" / "Showing 20 of 20 entries" lines — a whole-ledger aggregate,
  never the length of what's loaded.
- **Cursor pagination / "Load more"**: `getAttendanceHistoryPage()` (`attendance-history.ts:69-116`)
  is a stable keyset cursor (`occurredAt DESC, id DESC`), wired to the "Show older attendance"
  button in the client component (`loadMoreAttendance` server action). With this fixture all 20 rows
  loaded on the first page (page size `ATTENDANCE_PAGE_SIZE`), so the UI correctly showed "That is
  the start of your attendance history." instead of a Load-more button — both states exist in the
  code and are unaffected by anything proposed here.

None of this is being redone. The reconciliation report's older "undone rework" / "new grouping
logic" framing (sourced from an outdated comparison doc) was already corrected to this in v3 and is
reconfirmed accurate against current main today.

## Correction (this version)

The first pass of this document claimed the stat-row chip styling was "the only" confirmed visual
difference. That claim was wrong — it came from comparing the two screens at a glance rather than
walking every region of both captures side by side. A full re-comparison of the saved screenshots
(`img/01`–`05` current vs. `img/08` reference) found three more confirmed visual differences, plus
one the first pass got partly right but under-specified (the month count). All four are addressed
together in the revised preview (`img/09`–`11`) below, split into the three categories the user
asked for: proposed corrections, intentional adaptations, and excluded behavior changes.

## 1. Visual differences proposed for correction

**(a) Stat-row chip styling.** The reference renders "This month / Last month / All-time" as three
equal cells inside one bordered card (muted 13px label over a bold number, divided by internal
`border-right`s). The current implementation renders this-month/last-month as two plain `<p
class="font-medium">` sentences (`attendance-history-section.tsx:125-128`), and the all-time number
appears further down as its own bolded sentence ("20 attendances in total",
`attendance-history-section.tsx:131`) ahead of the breakdown/showing lines. Same three numbers,
different container: chips vs. running text. This is exactly what RECONCILIATION-REPORT.md v3 §8
already flagged ("Portal Attendance: stat-row chip styling only (pagination/'Load more' unchanged)",
confirmed residual, 1–2h estimate) — reconfirmed here against live current main.

Each chip now preserves its own ok/unavailable state individually — this was NOT handled correctly
in the first preview (`img/06`-`07`), which derived the chip's number by regex-matching the leading
digit of the already-rendered sentence and would have silently shown "?" instead of the real
"Couldn't load this month's totals." copy on a failed read. The revised chip renderer branches on
whether the sentence starts with a digit: if not, it renders the exact existing
`monthStats.unavailable` string (muted, not bold, not a number) inside the cell instead — **never a
false zero**, matching the union type `MonthlyAttendanceStat = { ok: true, totals } | { ok: false }`
that already exists in the code (`attendance-history-section.tsx:15`). Verified in the stress capture
below (`img/12`/`13`): the "This month" cell shows the real unavailable sentence, not a number, not a
dash, not an invented short label.

The "All time" chip has **no unavailable state to preserve** — `getAttendanceTotals()` is awaited
directly in `page.tsx:139` with no try/catch (unlike the monthly stats, which are wrapped at
`page.tsx:157-169`); if it throws, the page itself errors. This asymmetry is pre-existing and
untouched by this proposal.

**(b) Per-month bordered cards.** The reference wraps each month's heading + entry list in its own
bordered box. The current implementation renders all months inside one enclosing `Card`, with only a
plain-text uppercase label between groups — no border, no visual separation beyond the label and the
divider rules between rows. The revised preview gives each month group its own
`rounded-lg border border-border p-3` box (reusing this project's own card border tokens, not a new
visual language), nested inside the existing outer `Card`'s `CardContent`.

**(c) Row layout — date beside details, not above.** The reference's row is a compact two-column
layout: a narrow leading date/day block beside the flowing class-name/meta text. The current
implementation stacks the full date/time string in its own row ABOVE the kind/class line
(`attendance-history-section.tsx:156-166`). The revised preview moves the `<time>` element into a
narrow leading column (`w-24 shrink-0`), with the kind/class/reason stack and the signed delta
sharing the remaining width to its right — same visual orientation as the reference.

**Exact timestamp format is intentionally NOT changed** (see §2(b) below) — this is a repositioning,
not a reformatting, of the same `<time>` element.

**(d) Month-level counts beside headings.** The reference shows a per-month class count next to each
month's heading. The first pass of this document said nothing about counts at all (an omission, not
a wrong claim). **Whether an exact count exists without a new query depends on which group it is:**

- Every month group EXCEPT the last (oldest) one currently rendered is **provably exact** with zero
  new reads: `getAttendanceHistoryPage` returns rows in strict `(occurredAt DESC, id DESC)` order
  (`attendance-history.ts:89`), so once the client-side grouping (`monthGroups`,
  `attendance-history-section.tsx:93-107`) moves past a month into an older one, no page loaded
  later can ever reveal more rows of that now-closed, newer month — all later rows are strictly
  older. The loaded row count for a closed group IS the true count.
- The current LAST (oldest) rendered group is exact only once `cursor === null` (confirmed via the
  existing "That is the start of your attendance history." state,
  `attendance-history-section.tsx:190`) — i.e., the whole ledger has been paged through. While a
  "Show older attendance" button is still present, the last group's count is **not yet determined**
  and must not be guessed from however many of that month happen to be loaded so far.

The revised preview implements exactly this rule (verified live: `cursorExhausted` computed from the
real "start of your history" state, `true` for this fixture since all 20 rows loaded on the first
page) — every group in the capture shows a real, exact count. **No new query is used or proposed**:
the count is `list.querySelectorAll('li').length` on data already in the DOM/state, gated by the
existing cursor flag. When a Load-more button IS present, the implementation must omit the count
on the open last group (the revised script marks this case with `data-count-omitted`, not rendered
in this fixture because it never applies here) rather than invent a partial number — directly
answering the instruction not to invent counts from partially loaded rows.

## 2. Intentional adaptations — preserving richer functionality, not corrected

**(a) Page/heading prominence.** The reference shows a plain, large "Attendance" page title. The
current screen shows the shared portal greeting ("Hi, {name}!") above the tab list — rendered once,
page-level, shared across Home/Attendance/Schedule (`page.tsx:471-472`) — plus the panel's own
`CardTitle` ("Attendance history") inside the bordered card. Per this task's own scope boundary
("Portal navigation and tenant branding remain outside this task"), the shared greeting is portal
chrome, not this panel's concern, and the `CardTitle`-inside-a-bordered-card pattern is the same
convention every other portal panel already uses (`ProgressCard`'s "Your progress", `Schedule`'s
"Schedule" heading) — restyling only the Attendance panel's heading would break that consistency.
**Not proposed for correction.**

**(b) Timestamp format and column width.** The reference's leading date column shows an abbreviated
day name + day number (its own synthetic mock data, not a real `Date`). The current implementation's
`<time>` already carries the full, locale-correct, already-tested date/time string. Reformatting it
into a day-abbreviation would be a new formatting decision this task doesn't authorize and isn't
required to achieve "day/date beside class details" — the revised preview repositions the existing
string instead of reformatting it, at the cost of a wider leading column (`w-24`, vs. the reference's
narrow one) and the date sometimes wrapping onto two lines at 390px/320px (seen in `img/09`,
`img/12`). This is a visible, deliberate trade-off for this review, not a hidden one.

**(c) "Show older attendance" / cursor pagination, in every capture.** Unchanged, by instruction —
see §3.

## 3. Behavior changes excluded from scope

- The reference's "Show August" button (reveal one additional calendar month on demand) is a
  **behavior difference, not styling** — it would replace cursor pagination with month-at-a-time
  reveal. Per the reconciliation report's own §8 entry and this task's explicit instruction, this
  stays unestimated and is **not** proposed here. Cursor pagination / "Load more" is preserved as-is
  — unchanged markup, unchanged `loadMoreAttendance` action, unchanged button/empty states — in every
  preview capture.
- Portal navigation/route mechanics (`portal-tabs.tsx`): all three views are server-rendered and stay
  mounted (`hidden` toggling, not unmount/remount), the active view mirrors the URL hash
  (`#attendance`), WAI-ARIA tabs with roving tabindex, and the bottom tab bar is `fixed` with
  `env(safe-area-inset-bottom)` padding below `sm` and static above it. Tenant branding (logo,
  academy badge, sidebar colors) is likewise untouched. Neither is touched by anything in this
  document — both live entirely outside `AttendanceHistorySection`.

## A defect the stress check actually found

Checking the proposed layout at 320px with long values (per instruction) surfaced a real, measured
clipping bug in the first draft of the revised chip markup: a 6-digit "All time" value ("12,345")
overflowed its cell at 320px. Measured, not eyeballed —
`p.scrollWidth (79) > p.clientWidth (55)`, confirmed via `getBoundingClientRect`/`scrollWidth` on the
actual cell, same discipline as the earlier clipping checks in this project. Root cause: a grouped
number like "12,345" has no natural line-break opportunity (no space or hyphen for the browser's
default `white-space: normal` wrapping to use), so it silently overflowed the `overflow-hidden`
chip row instead of wrapping. Fix: `break-all` (`overflow-wrap: anywhere` equivalent) on the value
`<p>` — re-measured after the fix: `scrollWidth === clientWidth`, text wraps onto a second line
instead of clipping (`img/12` before, `img/13` after). This fix is now part of the proposed
implementation for all three chips, not just the stressed one, since any organization's real
"all-time" total can eventually reach this length.

## Everything else re-confirmed, not changed

- Internal clipping and page overflow were measured separately (not inferred from a zero
  `scrollWidth`, per this project's own standing caution) at 390px and 320px, before the row/card
  changes: `document.documentElement.scrollWidth === clientWidth` at both widths, and every
  `data-slot="card"` element's own `scrollWidth === clientWidth` — no clipping, at any width tested.
- Desktop two-column layout (`lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]`,
  `page.tsx:408-419`): Attendance history (7fr) beside `ProgressCard` (5fr) — unaffected by the
  proposed changes, verified unaffected in the 1280px revised-preview capture (`img/10`).

## Evidence

Real student session, isolated test DB (`alliance_bjj_test`, port 5433 — dev server started with
`DATABASE_URL` pointed at the test container, never the dev DB on 5432), logged in through the real
`/en/login` form as the seeded QA student login (`student@test.com`, STUDENT role, Escazú academy),
not a direct DB query or an isolated component render. Representative data: the seeded student's
"light, ordinary attendance" fixture (`prisma/seed.ts:765-768`, weekly check-ins over ~20 weeks) —
20 real check-in rows spanning April–September 2026, giving a genuine multi-month grouping
(6 month headings) and a non-trivial this-month/last-month split (0 / 1) without any new fixture
data.

| # | Capture | File |
|---|---|---|
| 1 | Current, 1280px, EN, dark (the app's default theme — `localStorage.theme`) | `img/01-current-1280-en-dark.png` |
| 2 | Current, 390px, EN, light, scrolled to top (real `position:fixed` bottom nav, not a full-page stitching artifact) | `img/02-current-390-en-light.png` |
| 3 | Current, 320px, EN, light | `img/03-current-320-en-light.png` |
| 4 | Current, 390px, ES, light (`¡Hola, Estudiante!` / `Historial de asistencia` / `SEPTIEMBRE DE 2026`, DD/MM date order) | `img/04-current-390-es-light.png` |
| 5 | Current, 390px, EN, dark | `img/05-current-390-en-dark.png` |
| 6 | Proposed v1 (superseded — chip row only, no unavailable-state branch) | `img/06-proposed-390-en-light.png` |
| 7 | Proposed v1 (superseded) | `img/07-proposed-1280-en-light.png` |
| 8 | Reference, 390px (October `.dc.html`, rendered via a minimal file-specific template polyfill — this file has no nested loops/conditionals, so the polyfill fully succeeds) | `img/08-reference-390.png` |
| 9 | **Proposed v2 (current)**, 390px, EN, light — chip row (with real unavailable-state branch) + per-month bordered cards + date-beside-details row layout + exact month counts, same live page/real data, DOM-injected (harness evidence, not a merged change) | `img/09-proposed-v2-390-en-light.png` |
| 10 | **Proposed v2**, 1280px, EN, light — confirms the two-column layout and `ProgressCard` are unaffected | `img/10-proposed-v2-1280-en-light.png` |
| 11 | **Proposed v2**, 390px, EN, dark — representative dark-mode check | `img/11-proposed-v2-390-en-dark.png` |
| 12 | **Stress check**, 320px, ES, light — synthetic long value ("12,345") and a forced real unavailable sentence, BEFORE the `break-all` fix: the "All time" value visibly clips | `img/12-stress-320-es-CLIPPING-BUG-before-fix.png` |
| 13 | **Stress check**, 320px, ES, light — AFTER the `break-all` fix: value wraps onto a second line, no clipping, unavailable sentence renders in full | `img/13-stress-320-es-fixed.png` |

A full-page capture of #2 was also taken and shows the bottom tab bar re-rendered mid-page — a known
Chromium full-page-screenshot artifact for `position:fixed` elements (the viewport is temporarily
expanded to the full content height, so the bar's fixed offset is read against the enlarged
viewport). The viewport-top capture (#2 above) is the real, authoritative rendering; this is noted
so the artifact isn't mistaken for a layout bug in a future pass.

## Proposed correction (bounded change, four parts)

1. **Stat row**: replace the two plain `<p>` lines at `attendance-history-section.tsx:126-127` and
   the standalone `<p>{t("total", ...)}</p>` line at `:131` with one bordered 3-cell stat row —
   `rounded-lg border border-border`, `divide-x divide-border` between cells (existing `Card`
   tokens, no new design system). Each cell branches on its own ok/unavailable state (see §1(a)
   above); the value `<p>` carries `break-all` to prevent the measured clipping defect from
   recurring on a long "all-time" total.
2. **Per-month cards**: each `monthGroups` entry gets its own `rounded-lg border border-border p-3`
   wrapper, nested inside the existing outer `Card`.
3. **Row layout**: `<time>` moves into a leading `w-24 shrink-0` column; kind/class/reason and the
   signed delta share the remaining width to its right (see §2(b) for the deliberate format/width
   trade-off).
4. **Month counts**: a count is appended to each month heading only when exact per the rule in §1(d)
   — every closed group, and the last (oldest) group only once `cursor === null`.

Every other line in the stat block (`breakdown`, `otherAdjustments`, `credits`, `showing`) stays
exactly where it is, unchanged, directly below the new stat row. No field is removed; the
"all-time" number simply moves from its own sentence into the third chip — same number, same source
(`totals.total`), no new query anywhere in this proposal.

**Preserved, unconditionally:**
- Cursor pagination and the "Load more" / "That is the start of your attendance history." states —
  completely untouched; the reference's "Show August" reveal is not adopted.
- `creditedClasses` / `otherAdjustments` conditional lines (not present in this fixture, but the
  code paths are untouched).
- The empty state (`totals.entryCount === 0`), the live announcement region, and the failed-load
  alert.
- Every entry's timestamp (exact existing string, exact existing format — repositioned, not
  reformatted), signed delta, kind, class name, and reason.
- Every i18n key already in use (`monthStats.thisMonth`/`lastMonth`/`unavailable`, `total`,
  `kind.*`) — no new copy decision needed beyond three short chip-label strings ("This month" /
  "Last month" / "All time", EN + ES) and a short "N classes" / "N clases" count string, both of
  which can reuse an existing plural key shape already established elsewhere in `messages/*.json`.
- Shared portal greeting, panel `CardTitle` convention, desktop two-column grid, `ProgressCard`,
  portal navigation/hash/mounted-panel/safe-area mechanics, tenant branding — none of these files
  are touched (see §2(a) and §3).

**File scope (for the implementation pass, not done here):**
- `src/app/[locale]/portal/attendance-history-section.tsx` — the stat-row markup (~125-131 today),
  the `monthGroups.map(...)` render block (~145-172), and the per-row `<li>` markup (~150-168);
  exact lines will shift once implemented.
- `messages/en.json` / `messages/es.json` — three chip-label keys and one count-pluralization key,
  additive only; no existing key is removed or repurposed.
- Existing tests that snapshot or query this block (`tests/integration/**` covering
  `attendance-history-section` / the portal attendance panel) will need their assertions updated to
  match the new markup — scope to be confirmed at implementation time via `rg` for
  `attendance-month-stats`, the removed `"X attendances in total"` sentence text, and the current
  flat (non-nested) row markup.

**Acceptance checks (for the implementation pass):**
- Real student-session screenshots at 1280/390/320, EN/ES, light/dark — same bar this reconciliation
  pass already cleared for the current state.
- `document.documentElement.scrollWidth === clientWidth` and every stat-cell's/card's own
  `scrollWidth === clientWidth` at 320px and 390px, including a deliberately long synthetic
  "all-time" value (the exact check that caught the `break-all` defect in this pass — must stay in
  the implementation's own verification, not just this preview's).
- A fixture that still has a Load-more button present (cursor non-null): confirm the oldest
  rendered month's heading shows NO count, and that loading one more page either keeps it hidden
  (still not closed) or reveals the now-exact count (closed or newly exhausted) — never a number
  that later turns out to have been wrong.
- A fixture with `monthlyStats.thisMonth.ok === false` (simulate the existing failure path, e.g. by
  throwing in a test double for `getAttendanceMonthTotals`): confirm the chip shows the exact
  existing unavailable sentence, never "0" and never a dash standing in for it.
- Real Tab-key traversal through the new chip row and per-month cards confirms no new focusable
  element is introduced (all of it is static text, not a control) and the existing Load-more
  button's position in the tab order is undisturbed.
- `pnpm test:integration` green in isolation (this project's own standing caution: never trust a
  concurrent run against the shared test DB — see prior PR #125 rounds' "29 false failures"
  incident).

## Out of scope — tracked, not resolved here

- The reference's "Show August" one-month-at-a-time reveal: a genuine behavior change (would
  replace cursor pagination), not proposed or estimated without separate explicit approval.
- Real Android/iOS device verification: still unavailable this pass.
- The original ADMIN smoke-test timeout (run `38607144036`): still unattributed, still tracked.
