# Portal Schedule — visual reconciliation + bounded plan

**Status:** implemented in a separate branch/PR, held unmerged for review. See "Implementation
(shipped)" below for what actually exists in the codebase today.

**Correction (this version):** the first pass's proposed preview (`img/12`, `img/13`) rendered with
the colored bars and has-classes dots invisible — not a design problem, a harness bug (see "Why the
first preview was invisible, and the fix" below). Repaired and re-captured as `img/14`-`img/16`,
kept alongside the originals for the record. This version also: (1) explicitly reaffirms the existing
56px horizontally-scrollable day-tabs as a SETTLED, Phase 2.6-approved decision, not reopened (§4's
"recommend deciding" framing from the first pass is withdrawn); (2) adds a full lifecycle diagnosis of
the selected-day-visibility defect, demonstrated against all four requested scenarios, plus a proposed
fix validated live (not just described) via a non-committed harness patch; (3) drops the previously-
proposed duplicate `hasClasses` field in favor of reusing `WeekCalendarDay.isOff` directly.

## Scope

Reconcile the Portal Schedule panel (`src/app/[locale]/portal/page.tsx`'s `schedule` block, built
from `src/components/ui/week-calendar.tsx` for desktop and `src/app/[locale]/portal/schedule-day-
list.tsx` for phone) against the October reference
(`MATROOM-UI-proposal-2026-10/screens/Portal-Schedule.dc.html`) and the findings already recorded in
`design/matroom/verification/phase2-reconciliation/export/RECONCILIATION-REPORT.md` (v3, line 628 and
its surrounding corrections at lines 29-33 and 705-726).

## Implementation (shipped)

Scoped exactly as approved: `src/app/[locale]/portal/schedule-day-list.tsx` (the row/dot/scroll-fix
markup and logic), one additive `meta?: string` field on `WeekCalendarBlock`
(`src/components/ui/week-calendar.tsx`), the one line in `src/app/[locale]/portal/page.tsx` that
populates it (`meta: tClassType(s.type)`, reusing the translator the legend already uses — hoisted
earlier in the file so it's in scope there), a minimal shared `ResizeObserver` jsdom stub
(`tests/setup.ts`, needed because jsdom implements none at all and a second, unrelated test file also
renders this component), and `tests/unit/schedule-day-list.test.tsx`. No desktop file touched, no new
query, no authorization change, no shared-component redesign.

**Visual scope, as shipped:**
- Phone class rows: `rounded-md border border-border bg-card`, a colored left bar
  (`block.colorClassName` on a `w-1.5 shrink-0` span — a real compiled utility now that it's written
  directly in committed source, not injected at runtime; see the preview-diagnosis correction below),
  name + time on one row, the existing localized type label (`block.meta`) on a line below.
- Has-classes dots on day-tabs: `!day.isOff`, reading the existing `WeekCalendarDay.isOff` field
  directly — no new `hasClasses` state anywhere.
- The 56px horizontally-scrollable day-tabs and the desktop time-grid are both byte-for-byte
  unchanged (confirmed: `week-calendar.tsx`'s own rendering logic has no diff in this PR; only its
  type declaration gained one optional field it doesn't read).
- No eligibility wording invented: the meta line is the plain type label only, never the reference's
  "not on your track" annotation — no field in the data model expresses that, and none was added.

**Correcting the preview-diagnosis wording (the planning pass overclaimed):** the planning pass's
`getComputedStyle` check found `w-1.5` unresolved and concluded "no width utility exists anywhere in
this project's compiled stylesheet" — overstated. The repository does use width utilities elsewhere
(e.g. this very file's own `min-w-14`, `w-24` in the Attendance panel's row layout from the prior
PR). The narrower, correct fact: `w-1.5` specifically had never appeared in the source tree before,
so Tailwind's scanner had never generated a rule for it — a class assembled only in a browser-
injected runtime string is invisible to a build-time scanner regardless of category. Once `w-1.5`
was written directly into this file's own JSX (normal, source-defined styling, not a runtime string
or an inline-style workaround), the dev server's own file-watcher recompiled it immediately, and it
rendered correctly on the very first real-browser check (`img/implementation/02`) — confirmed with
the same `getComputedStyle` discipline: `width: 6px`, real class-color background, in place, before
trusting the screenshot.

**Selected-day visibility, as shipped — and a real bug the diagnosis prototype itself had:**
Implements the `ResizeObserver`-on-zero-to-nonzero-width approach from the diagnosis pass, with one
correction found only by testing the real build in a real browser: the diagnosis prototype computed
a tab's position via `tab.offsetLeft`, which is relative to the tab's nearest *positioned* ancestor —
not necessarily the tablist. This tablist has no `position` set, so `offsetLeft` silently resolved
against an unrelated ancestor, and the very first real-browser check of the shipped code showed the
newly-selected tab rendered half off-screen. Root-caused directly (not patched by trial and error):
measuring `getBoundingClientRect()` on both the tab and the tablist, confirming the coordinate
mismatch, then switching to `(tabRect.left - listRect.left) + tablist.scrollLeft` — the tab's true
position in the tablist's OWN scrollable-content space, independent of any ancestor's positioning.
Re-verified against all four scenarios after the correction (see "Verified in a real browser,"
below); the three unit tests exercising this math were updated to mock `getBoundingClientRect()`
instead of `offsetLeft`/`offsetWidth`, for the same reason — a jsdom test that mocks the wrong
property can "pass" while asserting nothing true about a real browser, exactly what happened here
until the real-browser check caught it.

**Verified in a real browser, against the isolated test DB** (`alliance_bjj_test`, port 5433, real
student session, never the dev DB), all four requested scenarios, each individually:

| Scenario | Method | Result |
|---|---|---|
| Direct `#schedule` navigation, 320px | fresh `page.goto` + `location.reload()` | `scrollLeft: 57.3`, selected tab (Thursday, today) fully visible |
| Home → Schedule (click), 320px | fresh load on Home, click Schedule | same correction, fully visible |
| Desktop (1280px) → phone (320px) resize | fresh load at 1280px, resized down | same correction, fully visible |
| Return to Schedule with a prior selection + manual scroll, page already vertically scrolled 150px, after a real `location.reload()` | selected Saturday (scrolled, `scrollLeft: 185.3`), switched to Home (`window.scrollTo(0,150)`, focused the Home tab), switched back to Schedule | Saturday remains selected and fully visible, `scrollLeft` unchanged, `window.scrollY` unchanged at `150`, `document.activeElement` is the Schedule tab button (the element the test itself just focused and clicked) — no extra, unexplained focus movement |

Every other confirmed finding from the planning pass — no page-level or element-level clipping at
1280/390/320px (including a real browser stress check with a deliberately long class name,
`img/implementation/05`), keyboard traversal (`ArrowRight`/`ArrowLeft`/`Home`/`End`, wrap-around,
clean `Tab`-exit) unaffected, EN/ES/light/dark rendering correct, the empty-Sunday state unaffected
and correctly showing no dot — re-verified against the shipped code, not assumed from the plan.

**Implementation evidence** (`img/implementation/`), all real sessions except the one labeled
synthetic:

| # | Capture | Evidence kind | File |
|---|---|---|---|
| 1 | Desktop 1280px, EN, dark — confirms the desktop grid is pixel-identical to the planning pass's own capture | Real session | `img/implementation/01-1280-en-dark-desktop-unchanged.png` |
| 2 | 390px, EN, light, Monday (4 classes) — bars/dots/meta all rendering from real compiled CSS | Real session | `img/implementation/02-390-en-light-monday-busy.png` |
| 3 | 390px, ES, light, Monday — full localization, including meta labels ("Gi", "No-Gi", "Niños") | Real session | `img/implementation/03-390-es-light-monday-busy.png` |
| 4 | 390px, EN, dark, Sunday (empty day) — confirms the has-classes dot is correctly ABSENT on the one `isOff` day while present on every other visible tab | Real session | `img/implementation/04-390-en-dark-sunday-empty.png` |
| 5 | 320px, dark, a deliberately long class name — wraps cleanly across 3 lines, no clipping (`scrollWidth === clientWidth` on the row, measured before the screenshot) | **Synthetic stress**, title text overridden on an otherwise real row | `img/implementation/05-320-en-dark-SYNTHETIC-stress-long-name.png` |

**Tests, as shipped** (`tests/unit/schedule-day-list.test.tsx`, 12 existing tests unmodified and
still passing against the new markup, 10 new focused tests):
- Dot presence on every day except the `isOff` one.
- The row is a bordered card with its own colored bar and meta line, never the old solid-colored
  block (`text-white` explicitly asserted absent).
- `ResizeObserver` lifecycle: observes the tablist on mount, disconnects on unmount — **mocked**
  (`MockResizeObserver`, a trackable stand-in jsdom has no native equivalent for).
- The scroll-adjustment math on a hidden→visible transition: scrolls an out-of-view tab to the
  nearest edge; does NOT move an already-visible tab (never recenters); never touches page scroll
  position or keyboard focus — all **mocked** (`setGeometry` stubs `getBoundingClientRect()`/
  `clientWidth`/`scrollLeft` directly, documented inline as proving the fix's own branching logic,
  not real browser layout).
- A `tests/setup.ts` doc comment and this section both say explicitly: the mocked tests prove the
  logic; the real-browser table above, not anything in the test file, proves it actually renders and
  scrolls correctly in a real browser.

---

## Planning pass (historical — superseded by the implementation above)

Everything from here down is the reconciliation, diagnosis, and bounded plan written BEFORE
implementation. Preserved for its reasoning and screenshots (`img/01`-`16`; `img/implementation/` is
new, added above); read it as the argument that led to the shipped code, not as a description of what
the code currently does. Two things changed between this plan and the shipped code: the preview's
own overclaimed diagnosis wording about compiled width utilities (corrected above), and the
diagnosis prototype's `offsetLeft`-based scroll math, which had a real coordinate-space bug the
shipped code's `getBoundingClientRect()`-based math corrects (also corrected above).

## What RECONCILIATION-REPORT.md v3 already established — not re-derived here

Quoted directly (line 628): *"Portal Schedule | `Portal-Schedule.dc.html` | **Implementation
present, confirmed against current main:** `ScheduleDayList` — day-tab row, keyboard nav,
aria-selected/controls, single-day tabpanel, shipped PR #115 | No confirmed structural mismatch;
**visual verification missing** (tab color/spacing/active-state) | `WeekCalendarBlock` data preserved;
`ScheduleDayList` is mobile-only (`md:hidden`) | No current-state capture this pass."* The report's
own corrections (lines 29-33) explicitly withdrew an earlier, wrong claim that this was unbuilt —
PR #115 already shipped the day-tab interaction, and "no current screenshot" was never meant to
imply "not matching" (line 725-726). This pass's job is exactly the gap the report names: the first
current-state screenshot, and the visual comparison that screenshot makes possible.

## What was already shipped (PR #115) — verified against current main, not re-proposed

Read `schedule-day-list.tsx` (129 lines) in full, plus `week-calendar.tsx` (338 lines) and the
`schedule` block in `page.tsx` (lines 422-450). All confirmed live, not just from source:

- **Accessible day-tabs (WAI-ARIA tabs pattern, automatic activation)**: a labelled `tablist`
  (`aria-label="Choose a day"`), `role="tab"` buttons with `aria-selected`/`aria-controls`, roving
  tabindex. Confirmed live with real keyboard input: `ArrowRight`/`ArrowLeft` move AND select in one
  step, `Home`/`End` jump to Sunday/Saturday, `ArrowRight` from Saturday wraps to Sunday, `Tab`
  correctly exits the whole tablist+panel (no stray focusable elements) once at the roving tab.
- **Single-day `tabpanel`**, labelled by its tab, holding a full day heading (`dateHeadings` — never
  abbreviated to just the tab's own short label) and a "Today" pill badge on the current day,
  confirmed live (`Thursday, October 15` + `Today` for the frozen session's real "today").
- **`WeekCalendarBlock` data preserved, exactly as the report expects**: the same `blocks`/`days`
  props feed both the desktop grid and the phone list — confirmed by reading both call sites in
  `page.tsx`, not assumed.
- **Desktop remains the existing time-grid** (`WeekCalendar`, `md:hidden` boundary on the phone list,
  confirmed via computed display at both breakpoints) — genuinely different from the reference's
  single flat day-list paradigm, but the reference is phone-width only (390×1200, confirmed from its
  own `$preview` metadata and consistent with every other October file) — there is no desktop
  reference to reconcile against, so desktop is captured for completeness only, not compared
  pixel-for-pixel to anything.

None of this is redone or re-estimated below.

## Evidence

Real student session (`student@test.com`), isolated test DB (`alliance_bjj_test`, port 5433 — dev
server started with `DATABASE_URL` pointed at the test container, never the dev DB on 5432), logged
in through the real `/en/login` and `/es/portal` forms. Representative real data, already present in
the seed, with no new fixture needed: this week (Oct 11-17) has 18 real class sessions across 6 days,
including a busy day (Monday, 4 sessions), an empty day (Sunday, 0 sessions, "No classes on Sunday"),
and several already-long real class names (`GI — Principiantes`, `NO-GI — Todos los niveles`,
`Competición`) that exercise the "long class name" check without any synthetic data.

| # | Capture | Evidence kind | File |
|---|---|---|---|
| 1 | Current, desktop 1280px, EN, light — full week grid | Real session | `img/01-current-1280-en-light-desktop-week.png` |
| 2 | Current, desktop 1280px, EN, dark | Real session | `img/02-current-1280-en-dark-desktop-week.png` |
| 3 | Current, 390px, EN, light — today (Thursday), 3 classes | Real session | `img/03-current-390-en-light-thursday.png` |
| 4 | Current, 390px, EN, light — Sunday, empty day | Real session | `img/04-current-390-en-light-sunday-empty.png` |
| 5 | Current, 390px, EN, light — Monday, 4 classes (busiest real day) | Real session | `img/05-current-390-en-light-monday-busy.png` |
| 6 | Current, 320px, EN, light — Monday, 4 classes | Real session | `img/06-current-320-en-light-monday-busy.png` |
| 7 | Current, 320px, EN, light — a synthetic very long class name, stress-only | **Synthetic harness**, not real session | `img/07-current-320-en-SYNTHETIC-stress-long-name.png` |
| 8 | Current, 320px, ES, light — see "selected-day visibility" finding below | Real session | `img/08-current-320-es-light-scroll-visibility-finding.png` |
| 9 | Current, 390px, EN, dark | Real session | `img/09-current-390-en-dark.png` |
| 10 | Reference, 390px, Friday (the mock's own "today"), 4 classes — rendered via a file-specific template polyfill extending the earlier Attendance-screen technique to this file's two loops + one conditional | Rendered reference | `img/10-reference-390-friday-busy.png` |
| 11 | Reference, 390px, Sunday, empty — same polyfill, `state.day` forced to 0 | Rendered reference | `img/11-reference-390-sunday-empty.png` |
| 12 | Proposed preview v1 (**superseded — bars/dots invisible**, see below) | Synthetic harness | `img/12-proposed-390-en-light-monday.png` |
| 13 | Proposed preview v1 (**superseded**, same defect) | Synthetic harness | `img/13-proposed-320-en-light-monday.png` |
| 14 | **Proposed preview v2 (current)**, 390px, EN, light — Monday (4 real classes), bars/dots fixed and verified via `getComputedStyle` before capture | **Synthetic harness** | `img/14-proposed-FIXED-390-en-light.png` |
| 15 | **Proposed preview v2**, 320px, EN, light — same | **Synthetic harness** | `img/15-proposed-FIXED-320-en-light.png` |
| 16 | **Proposed preview v2**, 390px, EN, dark — representative dark-mode check | **Synthetic harness** | `img/16-proposed-FIXED-390-en-dark.png` |

**The reference was fully rendered, not just read.** `Portal-Schedule.dc.html` has two `<sc-for>`
loops (day-tabs, classes) and one `<sc-if>` (empty-day message) — more than the single flat loop the
earlier Attendance-screen polyfill handled, but tractable with the same technique: extract the file's
own `<script data-dc-script>`, instantiate its real `Component` class (never polyfill-authored
logic), call `renderVals()` (optionally after forcing `instance.state.day` to pick a specific day,
e.g. `0` for Sunday), then expand each `sc-for` by string-substituting its template per item and
resolve the `sc-if` by keeping or removing its content based on the real `empty` flag. Both captures
(#10 Friday-busy, #11 Sunday-empty) are genuine rendered appearance, not source-inspection — confirmed
dot indicators, card/bar treatment, and meta lines are all visually verified, not inferred from the
HTML alone.

## 1. Confirmed visual differences proposed for correction

**(a) Class-row treatment.** The reference's phone list renders each class as a white card
(`#fffefa` background, `1px solid #d8ded3` border, rounded) with a 6px colored left bar, the class
name + time on one row, and a muted meta/description line below (e.g. "Gi", "No-Gi", "Kids class ·
not on your track"). The current phone list (`schedule-day-list.tsx:113-123`) renders each class as
a SOLID colored block (the whole `<li>` background is `block.colorClassName`, white text), with only
name + time — no second line, no card/bar distinction. Confirmed live at every width tested (#3-#9);
same difference, not a width-dependent artifact.

**(b) Has-classes "dot" indicator on day tabs.** The reference marks every day tab with a small dot
below the date number — visible (muted, or white when that tab is selected) when the day has
classes, transparent when it doesn't (confirmed live in rendered captures #10 and #11: every day
except the empty Sunday has a visible dot). The current phone day-tabs (`schedule-day-list.tsx:87-
96`) have no equivalent — a day with zero classes looks identical to a busy day until it's selected.
Both pieces of data already exist with no new query: `hasClassesByDay` is already computed in
`page.tsx` (used today only for the desktop grid's `isOff` diagonal-hatch and the Sunday legend
note) and `WeekCalendarDay` already has an `isOff` field the phone list doesn't currently read.

**Why the first preview was invisible, and the fix.** `img/12`/`img/13` used class names
(`w-1.5` for the bar's width, `size-1` was actually fine) typed directly into injected HTML at
runtime. Per the explicit instruction to verify rather than assume, every candidate class was tested
with `getComputedStyle` against freshly-created, isolated elements before writing anything further:

| Class | Compiled? | Measured |
|---|---|---|
| `size-1`, `size-2.5`, `rounded-full`, `rounded-sm` | Yes | real non-zero sizes/radii |
| `bg-muted-foreground`, `bg-background`, `bg-foreground`, `bg-class-gi` | Yes | real colors |
| `border`, `border-border`, `bg-card`, `text-foreground`, `text-xs`, `text-muted-foreground`, `font-medium`, `font-mono`, `tabular-nums` | Yes | real values |
| `w-1`, `w-1.5`, `w-2`, `min-w-1`, `min-w-1.5` | **No** | `width: 0px` for all of them |

This project's compiled Tailwind stylesheet is generated from the literal class-name strings that
appear in the TSX/JS source tree — a class name assembled only in a browser-injected string at
runtime was never scanned, so no rule exists for it and it renders as a no-op. Every fixed-width
`w-*`/`min-w-*` utility is absent from this project's entire compiled stylesheet (confirmed: no
component anywhere in `src/` uses one — width is universally done via flex/gap sizing here), so no
existing-class substitute was available either. **Fix:** the one 6px bar-width value uses an inline
`style="width:6px"` (real, unambiguous CSS, not a guessed utility) while every color/border/radius/
typography value reuses the already-compiled classes verified above, including the block's own real
`colorClassName` for the bar's color (guaranteed compiled — it is literally the current unmodified
row's own background class). Re-verified in place before capture: every injected bar measured
`width: 6px` with the correct real color per class type; every dot measured `6px × 6px` with the
correct real color (transparent for the one `isOff` day, muted-gray otherwise, cream/background when
that tab is selected) — `img/14`-`img/16`.

**Proposed preview for (a) and (b) together** (`img/14`-`img/16`): a DOM-injected harness on the
real live page, real data (Monday's 4 real classes), reusing:
- The exact existing per-type label text (`Gi`, `No-Gi`, `Competition`, `Striking`, `Kids`, `Open
  Mat`) already computed by `page.tsx`'s own legend construction (`tClassType(type)` via
  `CLASS_TYPE_LEGEND_ORDER`) — read from the real rendered legend in the same page, already
  localized (the same `t()` call every other portal string goes through), not invented copy. The
  reference's own eligibility annotation ("Kids class · not on your track") is deliberately NOT
  reproduced — no field in the current data model expresses "is this on the viewing student's
  track," and inventing one was explicitly out of scope; the meta line here is the plain type label
  only.
- The existing `Card`/border tokens (`rounded-md border border-border bg-card`) for the white-card
  treatment, and the block's own existing `colorClassName` for the left bar's color (width via inline
  style, per the repair above) — no new color system.
- A has-classes dot reading `WeekCalendarDay.isOff` directly — NOT a new `hasClasses` field. `isOff`
  already carries exactly the needed semantics (`page.tsx`: `isOff: !hasClassesByDay.get(dayOfWeek)`,
  itself derived from real `ClassSession` rows, the same value the desktop grid already uses for its
  hatch pattern) — the dot is simply `!day.isOff` with no new computation. `size-1.5 rounded-full`,
  `bg-muted-foreground` normally / `bg-background` when selected — small and subtle by design,
  deliberately not a copy of the reference's exact 5px/colors; the real implementation should tune
  size/contrast against this app's own token scale rather than this preview's placeholder values.

**Smallest file scope (for a future implementation pass, not done here):**
- `src/components/ui/week-calendar.tsx` — add an optional `meta?: string` to `WeekCalendarBlock`
  (additive, no existing field removed). No change to `WeekCalendarDay` — `isOff` already exists and
  already carries the needed semantics.
- `src/app/[locale]/portal/schedule-day-list.tsx` — the row markup (card/bar/meta, bar color via the
  existing `colorClassName`, width via inline style per the repair above since no compiled width
  utility exists in this project), and the day-tab markup (dot, reading the existing `day.isOff` the
  component already receives as a prop — no new prop to thread for this specifically).
- `src/app/[locale]/portal/page.tsx` — thread `meta: tClassType(s.type)` into each `WeekCalendarBlock`
  where blocks are built (the type label is already computed for the legend; this reuses it per-
  block, no new read). `hasClassesByDay`/`isOff` is already threaded into `calendarDays` today — no
  new wiring needed there.
- Desktop (`week-calendar.tsx`'s grid blocks) is explicitly OUT of this proposal's scope — no
  reference exists for it, and its existing `truncate` treatment is intentional (see §2 below), not
  a candidate for the same per-item meta line (grid cells are already tightly height/width
  constrained; adding a line would need its own separate layout decision).

**Concrete acceptance checks (for the implementation pass):**
- Real-session screenshots at 1280/390/320, EN/ES, light/dark, busy day + empty day + the existing
  long real class names — same bar this pass already cleared.
- `scrollWidth === clientWidth` on every row and every day-tab at 320px, including a deliberately
  long synthetic class name (per the stress check already run this pass, #7 — must be re-run against
  the new markup, not just the old one).
- Keyboard traversal (`ArrowRight`/`ArrowLeft`/`Home`/`End`, wrap-around, `Tab`-exits-cleanly) and
  focus-visible behavior unaffected — re-verify, don't assume, since this pass found no current
  keyboard defect.
- The dot's presence/absence must come from `day.isOff` exactly as the desktop grid already reads it
  — no new query, and no divergence between what desktop implies (hatch pattern) and what the phone
  tab's dot shows for the same day.
- Before writing any new class name into JSX, confirm with `getComputedStyle` (or by grepping for an
  existing, already-compiled usage) that it actually resolves — the exact mistake this pass made and
  caught only by checking, not assuming.

## 2. Intentional adaptations — preserving richer functionality, not corrected

**(a) Heading.** The reference shows a bare "Schedule" H1 with a date-range ("Sep 20 – 26") on the
same row. The current panel shows `CardTitle` "This week's schedule" +
`CardDescription` "{academyName} · N classes this week" (`page.tsx`'s `schedule` block,
`messages/en.json`'s `portal.schedule.heading`/`.description`). Same reasoning as the Attendance
panel's own heading finding in this project's prior reconciliation pass: the shared portal greeting
sits above the tab list (out of this task's scope per instruction), and the `CardTitle`-in-a-
bordered-card pattern is the same convention every portal panel uses. The current heading is also
RICHER than the reference's (shows the academy name and a real class count, not just a date range).
**Not proposed for correction.**

**(b) Desktop's `truncate` on long class names.** Confirmed live (`img/01`, `img/02`): "NO-GI — Todos
los niveles" renders as "NO-GI — Todos los ni…" in the narrow desktop grid cells. This is the
existing, deliberate `truncate` utility class in `week-calendar.tsx:301`, not an accidental clip —
confirmed by direct class inspection, not assumed. There is no desktop reference to compare it
against (see "What was already shipped," above), so this is preserved as the existing desktop
treatment, out of scope for correction here.

**(c) Panel-heading "Today" marker mechanism.** The reference prefixes the day label itself ("Today,
Friday, Sep 25"); the current implementation shows the full date heading plus a separate "Today" pill
badge (`schedule-day-list.tsx:106-109`). Different mechanism, equivalent information — not proposed
for correction.

**(d) Legend block on phone.** The current phone view shows the same color-type legend the desktop
grid uses (6 items + the Sunday note), which the reference's phone mock does not have at all. This is
additive, not a gap — it is PART of why the per-item meta line (§1a) matters: without it, color alone
(legend aside) is the only way to tell two blue "Gi" classes apart from a green "No-Gi" class on the
phone list today. Kept as-is; not proposed for removal.

## 3. Behavior changes excluded from this task

- No scheduling query, class-availability, or check-in logic is touched — every blocks/days read in
  `page.tsx` is unchanged (`listClassSessions`, the same function the ADMIN schedule page uses).
- Portal navigation (`portal-tabs.tsx`), the URL hash (`#schedule`), mounted-panel state (all three
  panels stay mounted, `hidden` toggling), and phone safe-area clearance are all confirmed untouched
  and out of scope, same as the prior Attendance task's own boundary.
- Tenant branding remains outside this task, as instructed.

## 4. Settled — not reopened

- **The horizontally-scrollable 56px day-tabs.** The first pass of this document raised the
  7-day-always-visible reference grid vs. the current scrollable-row layout as an open question to
  decide. It is not one: the current 56px, comfortably-sized, horizontally-scrollable day-tab row was
  already approved in Phase 2.6, and this task does not reopen that decision. It is preserved exactly
  as-is — not redesigned into seven compressed columns, not resized, not replaced. The internal
  horizontal scroll measured earlier (`scrollWidth` 440px vs. `clientWidth` 325px at 390px) remains
  true and is noted only as context for the selected-day-visibility diagnosis below, not as an open
  design question.
- **Real Android/iOS device verification** of the horizontal day-tab scroll and touch targets: still
  unavailable, as previously tracked.
- **Whether `isOff`'s exact boundary conditions (e.g. a day that becomes newly active mid-week) stay
  correct once read for a dot** — the proposed preview reuses the already-computed value as-is; a
  real implementation should add its own focused test rather than assume the preview's manual DOM
  read generalizes.

## Diagnosis: selected-day visibility, against the real portal lifecycle

A pre-existing defect in already-shipped functionality (PR #115), independent of the reference
comparison — not fixed here (this remains a read-only pass), but fully diagnosed against the real
component lifecycle and demonstrated across all four requested scenarios, with a proposed fix
validated live via a non-committed harness patch.

### The three lifecycle facts, confirmed directly (not assumed)

1. **Schedule remains mounted while its parent panel is hidden.** `PortalTabs` renders all three
   panels unconditionally and toggles only the `hidden` attribute (`portal-tabs.tsx`) — confirmed by
   reading a freshly-loaded `/en/portal` (no hash, so Home is active): `document.querySelector(
   '[data-testid="schedule-day-list"] [role="tablist"]')` already exists in the DOM, with
   `panel.hasAttribute('hidden') === true` and `tablist.clientWidth === 0`, `tablist.offsetParent ===
   null` — genuinely mounted, genuinely zero-size, genuinely not rendered.
2. **`ScheduleDayList`'s scroll effect depends only on `selected`** (`schedule-day-list.tsx:38-42`:
   `useEffect(() => { tabRefs.current[selected]?.scrollIntoView(...) }, [selected])`). It fires once
   on mount (when `selected` is first set) and again only when `selected` itself later changes (an
   explicit day click). Nothing in its dependency array reacts to the panel's `hidden` attribute
   changing, nor to the component's own `md:hidden` CSS boundary changing with viewport width.
3. **`PortalTabs` starts on Home and applies the URL hash after hydration** (`portal-tabs.tsx:36,
   40-46`: `useState<PortalTabId>("home")`, then a mount `useEffect` reads `window.location.hash` and
   calls `setActive`). Even a direct `#schedule` load renders Home-active first, then flips to
   Schedule-active one render later — Schedule's own mount effect (point 2) necessarily fires during
   or before that first, Schedule-still-hidden render, since React runs a child's effects before its
   parent's in the same commit.

### Each of the four requested scenarios, verified directly

| Scenario | Method | Result |
|---|---|---|
| Direct `#schedule` navigation, 320px | fresh `page.goto`, waited 1s | `scrollLeft` stays `0`; Thursday (today) measured outside the visible range |
| Home → Schedule (click), 320px | fresh load at `/en/portal` (Home default, confirmed `clientWidth: 0` while hidden), then click the Schedule tab | `clientWidth` becomes `255` (now visible) but `scrollLeft` stays `0` — confirms the effect never reran just because visibility changed |
| Returning to Schedule with a previously selected day | selected Saturday (explicit click → correctly scrolled, `scrollLeft: 185.33`), switched to Home, switched back to Schedule | `scrollLeft` unchanged at `185.33`, Saturday still fully visible — **no bug on this path**; the scrollable container's `scrollLeft` is simply preserved while hidden, as expected |
| Desktop → phone resize | fresh load at 1280px (confirmed `clientWidth: 0`, hidden by `md:hidden` CSS), then resized to 320px | `clientWidth` becomes `255` but `scrollLeft` stays `0` — same root cause as the click scenario, triggered by a CSS breakpoint change instead of a `hidden`-attribute change |

Three of the four scenarios fail for the exact same reason: the component becomes visible (via an
ancestor's `hidden` attribute clearing, or via its own `md:hidden` media query no longer applying)
without `selected` ever changing, so the effect that would correct the scroll position never runs.
The fourth (returning with a prior selection) was already correct and needs no fix.

### Proposed fix — smallest lifecycle-aware option, validated live

> **Superseded in two ways by the shipped fix** (see "Implementation (shipped)" above): (1) the
> shipped version never calls `scrollIntoView` at all — it computes and sets `scrollLeft` directly,
> per the explicit instruction not to assume `scrollIntoView` leaves page scroll untouched; (2) this
> prototype's own `offsetLeft`-based position math (further down, in the live-patch code actually
> run during diagnosis) had a real coordinate-space bug, found only when the shipped code was first
> checked in a real browser — `getBoundingClientRect()` is what actually shipped.

A `ResizeObserver` on the tablist container, reacting to a genuine zero→nonzero width transition
(which happens precisely when `display:none` — from either cause, ancestor `hidden` or the
component's own `md:hidden` — stops applying), re-running the exact same `scrollIntoView` call for
whichever tab is currently selected:

```ts
useEffect(() => {
  const el = tablistRef.current;
  if (!el) return;
  let lastWidth = el.clientWidth;
  const ro = new ResizeObserver(([entry]) => {
    const w = entry.contentRect.width;
    if (w > 0 && lastWidth === 0) {
      tabRefs.current[selectedRef.current]?.scrollIntoView({ block: "nearest", inline: "center" });
    }
    lastWidth = w;
  });
  ro.observe(el);
  return () => ro.disconnect();
}, []); // mount once; reads `selected` via a ref so this effect's own deps stay empty
```

This was not just described — it was attached live, as a `page.evaluate()` patch onto the real
unmodified running page (no file edited), and re-tested against all three broken scenarios:

- **Resize (desktop → 320px):** patch attached at 1280px (`clientWidth: 0`), resized to 320px →
  fired once, `scrollLeft` became `156.67`, Thursday measured fully visible.
- **Home → Schedule click:** patch attached on a fresh Home-default load (`clientWidth: 0`), clicked
  Schedule → fired once, same correction, Thursday fully visible.
- **Return-with-prior-selection, re-checked under the patch:** selected Saturday (scrolled to
  `185.33`), switched to Home then back to Schedule → the observer fires again on this second
  visibility transition too, but re-running `scrollIntoView` on an element already fully in view is a
  no-op in practice — `scrollLeft` stayed exactly `185.33`, Saturday remained correctly visible. The
  fix does not disturb the one path that already worked.
- Why `ResizeObserver` and not `IntersectionObserver`: an `IntersectionObserver` would also fire every
  time the user scrolled the PAGE enough to carry the tablist in and out of the vertical viewport —
  an unwanted re-scroll unrelated to this bug. `ResizeObserver` only reacts to the element's own
  rendered size changing (zero ↔ nonzero), which happens exactly on `display:none` transitions and
  is unaffected by ordinary page scrolling.

**Why this satisfies the stated constraints:**
- No arbitrary delay (`setTimeout`/`requestAnimationFrame` chains) — event-driven on a real layout
  signal.
- No polling — a single observer callback, fired only on an actual size change.
- No forced remounting — the same component instance, same effect-attachment pattern already in use.
- No resetting of `selected` — the fix reads whichever tab is currently selected and scrolls to it;
  it never changes selection.
- Preserves portal hash/state, keyboard focus, and page scroll position — `scrollIntoView({block:
  "nearest", ...})` only moves the tablist's own horizontal scroll when the target isn't already
  visible, and never touches focus or the page's vertical scroll position (confirmed: the already-
  correct Saturday case above moved nothing).

**Smallest file scope (for a future implementation pass, not done here):** `src/app/[locale]/portal/
schedule-day-list.tsx` only — add a `tablistRef`, the effect above, and a ref mirroring `selected` for
the effect to read without adding it to the dependency array. No other file changes.

## Everything else re-confirmed, not changed

- No page-level or element-level clipping found anywhere tested:
  `document.documentElement.scrollWidth === clientWidth` at 1280/390/320px, and every row's/tab's own
  `scrollWidth === clientWidth`, including under the synthetic long-name stress (#7) — measured, not
  inferred from a zero document-level scrollWidth, per this project's standing caution.
  The day-tablist's own internal horizontal scroll (§4, settled/preserved) is the one deliberate,
  intentional exception, confirmed distinct from the document-level check above.
- Authorization, academy/branch scope, and timezone rules: unaffected — the exact same `blocks`/
  `days` props and the exact same `listClassSessions(context.organizationId, student.homeAcademy.id)`
  call that already existed are the only data path, confirmed by reading `page.tsx` end to end for
  this panel; nothing proposed here reads or writes anything new.
- Class availability / check-in behavior: this panel is read-only (no check-in action exists on
  Portal Schedule in current main or in the reference) — confirmed by reading both, nothing to
  preserve that isn't already preserved by not touching the data layer at all.

## Out of scope — tracked, not resolved here

- Real Android/iOS device verification: still unavailable.
- The original ADMIN smoke-test timeout (run `38607144036`): still unattributed, still tracked.
- Approved cream/green defaults for new academies and the current Alliance academy (tenant branding):
  queued separately, not part of this task.
- Platform-superadmin-only health/security/operations monitoring (Grafana or similar): queued
  separately, not part of this task.
