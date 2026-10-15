# Phase 4 — Student detail — bounded visual correction plan

**Correction round.** Revised in place per five targeted findings: (1) the two-flex-column approach reordered
Profile in the DOM/reading/keyboard order — replaced with a page-local CSS grid, flat children, explicit
desktop placement, DOM order untouched; (2) the gated action/form block's full-width placement and its
preserved conditions restated precisely; (3) the header-action "security" framing was wrong and is corrected —
this is a scope boundary, not an access concern; (4) desktop keyboard/focus sequence under explicit grid
placement is now worked out concretely, including one real tab-order jump found and designed around (not
patched with `tabindex` or a duplicate control); (5) breakpoint, column proportions, and per-section placement
are specified as a table, not prose.

**Planning only. No code changed, no commit, no PR, no database write, no migration, no deployment, no
activation.** Scope is `src/app/[locale]/(staff)/students/[id]/page.tsx` — the two-column desktop composition
and its narrow-screen stacking. Roster (list) is already corrected and merged (PR #124); not revisited here.

## Reference and evidence discipline

Reference: `BJJ Project\MATROOM-UI-proposal-2026-10\screens\Student-Detail.dc.html`, approved 2026-10-10 as
*direction* (`docs/MATROOM_UI_PROPOSAL_COMPARISON.md`). Read in full; every layout/section claim below is
quoted or computed directly from its inline styles and `renderVals()` data, not inferred from a thumbnail.

**Current app read directly from `main`** (post-merge of PR #124): `src/app/[locale]/(staff)/students/[id]/
page.tsx` in full, plus the top of `edit-student-form.tsx` and `promociones-card.tsx` to confirm two specific
structural facts (no `<details>` wrapper on the edit form; `PromocionesCard` is one self-contained `<Card>`).

**Source inspection proves composition, not rendered fit.** Everything below about section order, props, and
gating is a direct code-reading fact. Nothing below claims that reading the source proves how the proposed
grid will actually look or fit at any width, or that the row-height behavior described in §2 will render
exactly as reasoned — that is what live measurement (§8) is for.

**Existing evidence, used only where still valid, labeled historical.** Two pre-existing, untracked directories
already carry real screenshots of the *current, single-column* detail page:
`design/matroom/verification/phase4-roster-detail-implementation/README.md` (real-browser evidence, isolated
test DB, its own section-by-section reconciliation table) and `phase4-roster-detail-proposal/` (an earlier
round's prototype screenshots). Both predate this plan and show the current single-column layout, not the grid
proposed below — cited only as evidence of *current* behavior, never for the new layout, which has not been
built or screenshotted.

## 1. Current source-confirmed layout vs. actual remaining visual differences

Unchanged from the prior round — restated briefly; see that round's full detail for the per-section quoting.

**Current composition** (single column, `<main className="flex flex-col gap-6 p-6">`, confirmed top to bottom):
Header (name/academy/status badge, no inline actions) → `PromocionesCard` (belt, progress, award/correction/
track-change controls, full history table) → Profile card (read-only `<dl>`) → Attendance History card
(`AttendanceEntriesCard`, entries + void control) → Legacy Payment History card (full table, own
`overflow-x-auto`, empty state) → Ledger section, conditional on `ledgerActive` (`StudentBalanceSummary` +
`PaymentHistorySection`, explicitly never interleaved with the legacy table) → `RegenerateCodeButton`
(ungated) → `AddAdjustmentForm` (ungated) → `canEdit`-gated footer block (Approve if PENDING → `EditStudentForm`,
confirmed not collapsed → `RecordPaymentForm` in a `<details>`, only if `!ledgerActive` → Archived-actions or
Archive button).

**Reference** (`Student-Detail.dc.html`, read directly): header row with breadcrumb, avatar, name/subtitle,
status pill, inline "Edit student" button, "⋯ More actions" button; two-column body (`flex-wrap`, left
`flex: 3 1 420px`, right `flex: 2 1 280px`) — left: "Rank" (summary + bespoke rank-bar + progress + disabled
award button + "Correct rank…" link) and "Attendance" (recent entries + "Add a class manually"); right: "Dues"
(one simplified overdue-amount card + "Record payment") and "Profile" (`<dl>` + "Reset code").

**Genuine remaining differences** (unchanged from the prior round, still accurate): no two-column composition
exists today; the reference's "Dues" card has no ledger concept (both legacy and ledger stay, distinct, per
instruction); the reference's "Rank" section omits the history/credit/track-change richness current production
has (preserved, not trimmed); the reference's rank visual is bespoke, current production already uses the real,
previously-fixed `BeltGraphic` (unchanged, only its position moves); the reference models only one status and a
placeholder "⋯ More actions" button, not PENDING/ARCHIVED/role-gated real functionality (all preserved below).

## 2. Proposed desktop grouping — CSS grid, flat children, explicit placement, DOM order untouched

**The finding, confirmed:** the prior round's two independent column wrappers (`<div>` of left-column children,
`<div>` of right-column children) would have moved Profile from DOM position 2 to a position after Attendance/
Legacy/Ledger — a real, unapproved reading/keyboard-order change. **Withdrawn.**

**The fix:** `<main>` itself becomes the grid container. Every section stays a **direct, flat child** of
`<main>` — no intermediate column `<div>`s — in **exactly today's DOM order**:

```
Header → Promotions → Profile → Attendance → Legacy Payment History → Ledger (conditional) →
RegenerateCode → AddAdjustment → gated action/form block
```

At narrow widths (below the breakpoint, §5), `<main>` is a plain `flex flex-col` — identical to today, items
render top to bottom in DOM order, nothing about reading, scroll, or keyboard order changes from current `main`
at all. At the desktop breakpoint, `<main>` switches to `display: grid` with two column tracks, and **each
child independently receives its own explicit `grid-column`/`grid-row`** (Tailwind arbitrary values, e.g.
`lg:col-start-1 lg:row-start-2`) — a purely visual repositioning. CSS Grid placement does not read from or
alter the DOM; the element's position in the accessibility tree, in `document.body`'s child order, and in the
default (no-`tabindex`) keyboard sequence is governed entirely by DOM order, which is untouched.

**Why numeric `grid-column`/`grid-row`, not named `grid-template-areas`.** `grid-template-areas` requires every
named region to form a literal rectangle across the whole template string, including a placeholder for cells
with no content — awkward for the Ledger section, which **may not render at all** (`ledgerActive` is `false`
for every real organization today). Numeric placement handles this cleanly: when Ledger is absent, its assigned
cell simply has no content and contributes no height; nothing else needs to change. This is the concrete reason
for the technique choice, not a style preference.

### A real CSS limitation, named, not hidden: row-height coupling

CSS Grid auto-sizes each row track to the **tallest** item assigned to that row index, across every column —
if a short right-column item (e.g. Profile, a short `<dl>`) shares a row index with a tall left-column item
(e.g. Promotions, which carries a full history table), that row's height is forced to match the taller one,
leaving visible empty space beneath the shorter item before the next row begins. This is an inherent property
of the explicit-placement technique this task specifies (not multi-column `columns: N`, not JavaScript
masonry), and it is **not resolved by this plan** — it is named here as a real, expected characteristic that
**must be measured once rendered**, not assumed acceptable from source reading alone (consistent with this
plan's own evidence discipline, §0). If a specific row pairing produces an unacceptable gap once built, the
smallest available mitigations are adjusting which sections share a row index (re-pairing, not re-architecting)
or accepting a modest gap as a known, common two-column-dashboard characteristic — not a reason to reach for
JavaScript or to reintroduce DOM reordering.

### Column assignment, chosen to also minimize keyboard-order disruption (see §4)

**Left column** (wider): Promotions, Attendance, RegenerateCode, AddAdjustment.
**Right column** (narrower): Profile, Legacy Payment History, Ledger (conditional).

This differs from the prior round's grouping in one deliberate way: `RegenerateCodeButton` is grouped with the
left column's tail (beside `AddAdjustmentForm`, its DOM-adjacent neighbor) instead of with Profile on the
right. **Reason, not a default**: `RegenerateCodeButton` precedes `AddAdjustmentForm` in DOM order, and both
are ungated, single-control, "quick action" sections — keeping them in the same column keeps them keyboard-
adjacent as well as DOM-adjacent, avoiding a cross-column backward jump at the tail of the sequence (worked
through in full in §4). This costs the reference's own pairing of its check-in-code reset action with its
Profile section — a trade made explicitly for keyboard coherence, not an oversight.

## 3. Gated action/form block — full-width, conditions/fields/workflows unchanged

The `canEdit`-gated footer block stays **exactly as it is today**, full-width, below the grid (own row,
spanning both columns) — not squeezed into either column. Internal order, conditions, fields, and workflows are
**completely unchanged**:
- `ApproveStudentButton`, only if `student.status === "PENDING"` — same billing-active fork, same plan list.
- `EditStudentForm` — same fields (name, phone, email, belt, stripes, DOB, guardian name/phone, emergency
  contact, notes), same validation, same server action, confirmed still not collapsed.
- `RecordPaymentForm` in its existing `<details>` toggle, only if `!ledgerActive` — same fields, same plan
  list, same locked-student behavior.
- `ArchivedStudentActions` (if `ARCHIVED`) or `ArchiveStudentButton` (otherwise) — same trustworthy-archive-
  event resolution, same genuine-return-billing fork.

**`RegenerateCodeButton` and `AddAdjustmentForm` stay ungated**, exactly as today (no role check added, no role
check removed) — their move into the left column (§2) is a position change only. **This is not an authorization
redesign**: no `canEdit`/`canAct`/role condition anywhere in this plan is added, removed, or altered. Every gate
stays attached to the exact control it already guards, in the exact server action that already re-enforces it.

## 4. Desktop keyboard navigation — identified, not assumed, not patched with `tabindex`

**Starting fact:** CSS Grid placement (`grid-column`/`grid-row`) never changes the DOM, the accessibility tree
order, or the default (no explicit `tabindex`) keyboard sequence — only paint position. Because §2 preserves
DOM order exactly, **the default Tab sequence is identical to today's reading order**:
`Header → Promotions → Profile → Attendance → Legacy → Ledger → RegenerateCode → AddAdjustment → gated block`
(each section's own internal tab order, among its own interactive controls, is unchanged — no section's
internal markup is touched by this plan).

**What changes is where focus visually appears to move**, since DOM-sequential elements no longer sit in
visual top-to-bottom order once grid placement spreads them across two columns. Traced through the §2 column
assignment, row by row:

| Step | Section | Column | Row | Visual jump from the previous step |
|---|---|---|---|---|
| 1 | Promotions | left | 2 | — (first interactive content after the header) |
| 2 | Profile | right | 2 | Rightward, same row — natural, reads as "next column, same level." |
| 3 | Attendance | left | 3 | Down and left, back to the primary column — the same kind of return-to-left-edge a reader's eye already makes at the start of every new line of normal text. |
| 4 | Legacy Payment History | right | 3 | Rightward, same row — same pattern as step 2. |
| 5 | Ledger *(conditional)* | right | 4 | Downward, same column — no column switch, straightforward continuation. |
| 6 | RegenerateCode | left | 4 | Left, from the bottom of the right column's content to the left column's next row — the one genuine cross-column backward-ish jump in the sequence, named explicitly below. |
| 7 | AddAdjustment | left | 5 | Downward, same column — natural continuation from step 6. |
| 8 | Gated action/form block | full width | 6 | Downward, spans both columns — natural end-of-page landing, no ambiguity. |

**The one real jump (step 5 → step 6), named, not glossed over:** focus moves from Ledger (or Legacy, if Ledger
is absent — `ledgerActive` is `false` today) in the right column to RegenerateCode in the left column. Because
row-height coupling (above) means the left column's row 4 does not necessarily align with the right column's
row 4 in actual pixel position, this jump's real visual distance can only be measured once rendered — it is
flagged here as the step to specifically check during verification (§8), not assumed smooth.

**Why this is the best available ordering, not an accident:** the alternative considered (RegenerateCode grouped
with Profile in the right column, matching the reference's own pairing) would create a *worse* jump at the
same point in the sequence — from the bottom of a 4-item right column back up to a 3-item left column's much
earlier row, while *also* leaving AddAdjustment stranded as the sequence's sole remaining item. Grouping
RegenerateCode with its DOM-adjacent neighbor (AddAdjustment) instead keeps steps 6→7 jump-free and limits the
sequence to exactly one cross-column transition that cannot be eliminated without reordering DOM (out of scope,
§2) or adding `tabindex`/duplicate controls (explicitly excluded by instruction).

**No positive `tabindex`, no duplicate interactive components** are used anywhere in this plan to compensate —
the sequence above is the real, resulting sequence, accepted and verified as usable rather than overridden.

## 5. Breakpoint, column proportions, and exact placement of every section

**Breakpoint: `lg` (1024px)**, unchanged reasoning from the prior round — the reference's own `420px + 280px`
column-basis needs roughly 720px of combined content width before a side-by-side split stops cramping the
Payment-History table's five columns in the narrower side; `lg` avoids an awkward squeeze in the 720–1023px
range.

**Column proportions:** `grid-template-columns: 3fr 2fr` (a 60/40 split, matching the reference's own `flex: 3`
/ `flex: 2` ratio) at `lg` and above; `grid` itself is only applied at `lg` (`<main>` stays `flex flex-col` —
today's exact behavior — below it).

**Exact per-section grid placement:**

| Section | Column | Row | Notes |
|---|---|---|---|
| Header | 1–2 (spans both) | 1 | Unchanged content; gains a `lg:col-span-2 lg:row-start-1` class only. |
| Promotions (`PromocionesCard`) | 1 (left) | 2 | Unchanged component, unchanged props. |
| Profile card | 2 (right) | 2 | Unchanged. |
| Attendance History card | 1 (left) | 3 | Unchanged. |
| Legacy Payment History card | 2 (right) | 3 | Unchanged, keeps its own `overflow-x-auto` wrapper. |
| Ledger section *(conditional)* | 2 (right) | 4 | The only new structural element: `StudentBalanceSummary` and `PaymentHistorySection` are DOM-adjacent today inside one `<>...</>` fragment, which cannot carry a grid placement class — this plan wraps just those two (already-adjacent, already-grouped) elements in one `<div className="flex flex-col gap-6 lg:col-start-2 lg:row-start-4">`, replacing the fragment. This does **not** introduce the "two independent column wrapper" problem §2 withdrew — it wraps only two elements that are already DOM-neighbors and already conditionally grouped together, not an artificial grouping of otherwise-unrelated siblings. |
| RegenerateCode | 1 (left) | 4 | Moved from its prior-round right-column placement — see §2/§4. |
| AddAdjustment | 1 (left) | 5 | Unchanged content. |
| Gated action/form block | 1–2 (spans both) | 6 | Unchanged content/order (§3); gains a `lg:col-span-2 lg:row-start-6` class on its existing wrapping `<div>`. |

**Separate cards preserved, explicitly:** Legacy Payment History and Ledger remain two distinct components in
two distinct (though column-shared) grid rows, never merged or interleaved — same requirement as the prior
round, re-confirmed against the grid technique. `PromocionesCard`'s full history table, credit history, and
track-change form are untouched inside its own unmodified component — nothing about its internal content is
reduced to match the reference's simpler "Rank" section.

## 6. File scope

- `src/app/[locale]/(staff)/students/[id]/page.tsx` **only**:
  - `<main>`'s className gains the responsive grid utilities (`lg:grid lg:grid-cols-[3fr_2fr] lg:gap-6`,
    alongside its existing `flex flex-col gap-6 p-6` for the below-`lg` fallback).
  - Each of the 9 flat top-level sections gains its own `lg:col-start-N lg:row-start-N` (or `lg:col-span-2`)
    classes, per the table in §5 — no section is moved, wrapped in a new column container, or reordered in JSX
    source order.
  - The one structural change beyond classes: the Ledger section's `<>...</>` fragment becomes a `<div>` (see
    §5's Ledger row) so it can carry its own grid placement — its two children and their props are unchanged.
- **No change to:** `promociones-card.tsx`, `edit-student-form.tsx`, `attendance-entries-card.tsx`,
  `payment-history-section.tsx`, `student-balance-summary.tsx`, `add-adjustment-form.tsx`,
  `regenerate-code-button.tsx`, `approve-student-button.tsx`, `archive-student-button.tsx`,
  `archived-student-actions.tsx`, `record-payment-form.tsx` (shared, `src/components/payments/`), or any
  `src/lib/**` query/business-logic file — every one is reused exactly as it renders today, only its grid
  position changes.
- `messages/en.json`/`es.json` — no new keys (pure layout change).
- No `design/matroom/DESIGN.md` decision required — no new token, color, or component.

## 7. Correction: the header-action question was never a security question

The prior round's plan withdrew moving `EditStudentForm`/`ArchiveStudentButton`/`ApproveStudentButton` into the
header (to visually echo the reference's inline "Edit student" / "⋯ More actions") on the stated grounds that
doing so would be "a structural/security-adjacent change." **That framing was wrong and is withdrawn.**

Moving a gated control's *render location* does not change *who can act on it*, provided its existing gate
(the `canEdit` JSX condition, and — the real enforcement — the server action's own `requireTenantContext` +
`isAcademyInTenantScope` re-check) stays attached to that exact control wherever it is rendered. A `canEdit &&
<EditStudentForm .../>` in the header is exactly as gated as the same expression in the footer; the header
region renders per-request for whichever role loaded the page either way, so a gate already evaluated against
that request's role does not become less safe by changing where its *true* branch happens to paint.

**The real, correct reason this plan keeps the gated block below the grid, full-width, is the bounded-scope
choice stated in §3**: these are rich, multi-field forms (confirmed not collapsed for `EditStudentForm`), and
squeezing them into a header row or a narrow grid column would recreate exactly the cramping defect the roster
correction (PR #124) already found and fixed for `CreateStudentForm`. It is a layout decision made for
form-usability reasons, not a security requirement — and moving these controls into the header remains out of
this specific plan's scope because it would be a header-composition decision (new header content, new
responsive behavior for the header itself) independent of the two-column body grid this plan is bounded to, not
because it would be unsafe.

## 8. Concrete verification (for the implementation task, not run by this plan)

All checks against the real, running app (not source reading, not the static reference):

**Widths:** desktop (1280px, ≥ `lg`), a width just below `lg` (e.g. 960–1023px, to confirm the stacked
fallback engages cleanly at the exact breakpoint, not a half-collapsed in-between state), 390px, 320px.
**Locale:** EN, ES. **Theme:** light, dark.

**Grid-specific checks, new this round:**
- **Row-height coupling, measured per row** (§2): for each shared row index (2, 3, 4), measure both columns'
  rendered heights and the resulting gap (if any) beneath the shorter item — confirm it is a minor, acceptable
  gap, not a visually broken layout. Specifically check row 2 (Promotions, likely tall, vs. Profile, likely
  short) and row 3 (Attendance vs. Legacy Payment History, both potentially long depending on real data).
- **The step 5→6 keyboard jump** (§4): with a real `Tab` walk, confirm the Ledger/Legacy → RegenerateCode focus
  transition is visually traceable (the new focus ring appears somewhere a user could reasonably expect,
  even if not adjacent) — not confusing to the point of appearing to lose focus entirely.
- **Breakpoint transition**: resize across exactly 1024px and confirm `<main>` switches `flex` ↔ `grid` cleanly,
  with no flash of unstyled/overlapping content at the transition point.
- **Ledger absent (the real, common case today)**: confirm the right column's row 4 cell is simply empty (no
  phantom gap shaped like a missing Ledger section) and RegenerateCode's row 4 in the left column is unaffected.

**States, each checked at minimum at desktop + 390px (carried from the prior round, still required):**
- **Populated** (real promotion history, attendance entries, legacy payment rows): both columns render fully
  without clipping; Legacy Payment History's `overflow-x-auto` still engages correctly inside the narrower
  right column at desktop width; no page-level overflow (`document.documentElement.scrollWidth` vs.
  `window.innerWidth`, measured, not assumed from a screenshot).
- **Empty** (a new student with no promotions/attendance/payments yet): empty states render without leaving a
  grid cell looking broken (a card with only a heading) at every width.
- **Ledger unavailable** (`historyInitial.failed`/`balanceDisplay: null`): renders correctly in its assigned
  cell without breaking the grid.
- **Archived / pending**: `ArchivedStudentActions` with a real trustworthy-archive-event; `ApproveStudentButton`
  for a real `PENDING` student including its billing-active fork — both render correctly in the full-width
  gated block at every width.
- **Expanded form**: `RecordPaymentForm`'s `<details>` opened; `EditStudentForm`, always-expanded — both
  confirmed full-width and usable at desktop and 390/320px, applying the same `items-stretch`-class discipline
  PR #124 established if `RecordPaymentForm`'s own wrapper needs it (measured, not assumed reused
  automatically).
- **Validation error**: a real server-side rejection from `EditStudentForm` or `RecordPaymentForm` renders
  inline, full-width, legible at every width.
- **Role states**: ADMIN/DIRECTOR (full gated block visible), INSTRUCTOR (no Approve/Edit/Record-payment/
  Archive — RegenerateCode/AddAdjustment still visible, per their ungated status), and the STUDENT self-view
  path (read-only, confirms the header's lack of inline action affordances is correct for that role too).
- **No page-level overflow**, distinguished from Legacy Payment History's own intentional `overflow-x-auto`
  scroll — measured, not assumed, at every tested width.

## Standing limitations — tracked, not addressed by this plan

- Real Android/iOS device verification remains unavailable in this environment.
- The original main-CI ADMIN smoke-test timeout (run `38607144036`) remains unattributed and unrelated to this
  screen.

## Explicitly out of scope

Any other screen, tenant-branding changes, database writes/cleanup, migrations, deployment, activation, moving
any gated control into the header (§7 — a scope boundary, not withdrawn for a safety reason, and not proposed
here either), and any change to an existing role gate, field, validation rule, or workflow.
