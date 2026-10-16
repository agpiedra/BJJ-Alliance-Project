# Kiosk Visual Reconciliation — Entry / Picker / Success

> **Implementation (shipped) — see the bottom of this file.** Everything below the original scope/findings is the
> read-only planning pass this task started from (superseded where the implementation changed the plan). The
> Implementation section records what actually shipped, including where the planned "smallest correction" (plain
> `break-words`) turned out to be insufficient and was replaced.

## Planning pass (historical — superseded where noted below)

Read-only reconciliation against the approved October references and current `main` (at `dcf17d5`, merged PR #127). No production files were changed. No commits, no PR. Isolated test DB (`alliance_bjj_test`, port 5433) only — all fixtures disposed of after capture.

## Scope and method

- Live code read: `src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx`, `page.tsx`, `src/lib/kiosk/open-classes.ts`, `src/lib/kiosk/perform-check-in.ts`, `src/lib/scheduling/check-in-window.ts`.
- Disposable fixtures: 6 `ClassSession` rows at Escazú (Friday, 90 min each, staggered 5 min apart), created/updated/deleted via scripts that assert `DATABASE_URL` contains `alliance_bjj_test` + `5433` before touching anything. All 6 rows and the `AttendanceRecord`s they produced were deleted at the end of this session (confirmed 0 remaining).
- **Correction to the prior session's premise**: the earlier working assumption that it was "13:21 Costa Rica time" was stale. Fresh `date` + Node timezone check at the start of this task showed the actual current time is **07:3x AM, GMT‑0600** (Node resolves `Intl` timezone as `America/Guatemala`). Fixture start times were set to open relative to that real time, not the earlier (wrong) assumption.
- Real browser (Playwright), real dev server on an isolated port (3100) against the isolated test DB, real kiosk token obtained through the actual admin product flow (logged in as `admin@alliancecr.com`, `/en/admin/kiosk-tokens`, clicked Regenerate for Alliance Escazú, confirmed the `window.confirm` dialog, copied the displayed one-time URL+token).
- Real check-in: student code `9000` (seeded `student@test.com` / Escazú), submitted through the actual keypad UI — never a direct DB write of an `AttendanceRecord`.
- Viewports: 1280×800 (landscape, triggers the `min-[900px]:landscape` breakpoint), 390×844, 320×690. Locales: `en`, `es`. Theme: see finding below — kiosk has no light variant, so only one theme exists to capture.
- October reference renders already existed at `design/matroom/verification/phase2-reconciliation/october-renders/kiosk-{entry,picker,success}.png` and were reused rather than re-rendered.

All current-state screenshots are under `img/current/`. Historical/October references are untouched at their original locations (`design/matroom/verification/phase2-reconciliation/`).

| File | What it shows |
|---|---|
| `img/current/entry-1280-en-dark.png` | Entry, 1280px landscape, EN |
| `img/current/entry-390-en-dark.png` | Entry, 390px, EN |
| `img/current/entry-390-es-dark.png` | Entry, 390px, ES |
| `img/current/picker-1280-en-dark.png` | Picker, 1280px landscape (2-col grid), EN, 6 open classes — **live defect visible** |
| `img/current/picker-1280-en-dark-scrolled.png` | Same, after auto-reset/resubmit — kept for the scrollbar/bounded-scroll evidence |
| `img/current/picker-390-en-dark.png` | Picker, 390px (single column), EN, 6 open classes — **same defect, confirms it is not grid-specific** |
| `img/current/picker-320-en-dark.png` | Entry at 320px (picker had auto-reset by capture time — see Verification gaps) |
| `img/current/success-1280-en-dark.png` | **Genuine** success screen, real check-in, EN |
| `img/current/success-1280-es-dark.png` | **Genuine** success screen, real check-in, ES |

---

## 1. Confirmed visual gaps (demonstrated defects)

### 1.1 Picker: class-name/time-range text collision — **reproduces live, worse than the historical lead suggested**

The historical screenshot (treated as a lead, not proof, per instructions) showed text visibly overlapping. I reproduced this live, with a real populated picker (6 open classes, including a deliberately long name), at **both** 1280px (2-column grid) and 390px (single column) — so it is not confined to one breakpoint.

**Root cause (confirmed via computed styles, not guesswork):**

`ClassPicker`'s row (`kiosk-client.tsx:900-919`) lays out the name block and the time block as flex siblings in a row (`justify-between`):

```
<span className="flex min-w-0 flex-col gap-1">        {/* name + type */}
<span className="flex shrink-0 items-center gap-3">   {/* time range + chevron, never shrinks */}
```

Measured on the live page (390px viewport, button width 326.7px):
- time block: fixed **196px** wide (`shrink-0` — never gives up space)
- name block: squeezed to **70.7px** wide (the only flex-shrinkable child, so it absorbs 100% of the width deficit)

The name span has `whitespace-normal` (wraps at spaces) but **no `break-words`/`overflow-wrap`**. A run of letters with no space — e.g. a single word like "Fundamentals" — cannot wrap inside a 70px column, so it renders as one line **wider than its box** and visually bleeds into the adjacent time column 16px away. Multi-word names ("No-Gi Open Mat") do wrap, but each fragment is still too wide for the column and still overlaps the time text. This reproduces for every row in the fixture, at every width tested.

**Smallest correction, exact scope (superseded — see Implementation):** add `break-words` to the class-name `<span>` at line ~909. Tried first exactly as proposed; real-browser verification showed it stops the overlap but produces unreadably squeezed, letter-by-letter-wrapped cards even for ordinary short names ("Fundamentals" → "F/u/n/d/a/m.../s"). The actual shipped fix is `flex-wrap` on the row plus `break-words` as a safety net — see Implementation §1 for the measured reason and the final diff.

**Alternative worth flagging (not proposed as the fix — bigger, needs approval):** the October reference (`kiosk-picker.png`) never puts the name and time on the same row at all — it stacks pill badge → name → time → relative-time meta vertically, each getting the card's full width. That design sidesteps the whole width-competition problem structurally. Adopting it would be a real layout change (behavior/visual, not a 1-line fix), so it belongs in "behavior changes requiring approval," not here.

### 1.2 Entry/Success: clipping check

Checked per-element clipping (not just `document.scrollWidth`) on Entry and Success at every tested width. No clipping found on either screen. Noted here only to record the check was done, not skipped.

---

## 2. Intentional adaptations (not defects)

Comparing current implementation to the October references (`design/matroom/verification/phase2-reconciliation/october-renders/`):

- **Success layout**: reference is a single centered column; current implementation uses the `min-[900px]:landscape:grid-cols-2` split (checkmark/name/belt left, progress/class-info/Done right) that Entry and Picker already use. This is a deliberate, already-shipped design-system consistency choice (same breakpoint reused across all three screens), not a regression.
- **Belt graphic**: reference uses a custom hand-drawn stripe-tape graphic; current implementation reuses the shared `BeltGraphic` component (confirmed via real capture: horizontal belt-with-window style, "Blanco"/"White" label, correctly localized). Component reuse over a one-off custom SVG — reasonable adaptation.
- **Picker card styling**: reference uses a colored pill badge for the class type; current implementation uses a plain muted-text label. Minor, likely deliberate simplification — not flagged as a defect since it doesn't affect legibility or function.

---

## 3. Behavior changes that would require approval (not implemented)

- **Entry: missing "opens at" upcoming-class line.** The October reference's open-now panel shows both currently-open classes **and** an upcoming one ("No-Gi opens at 5:31 PM"). Current implementation (`kiosk-client.tsx` EntryView, ~line 810) shows only `openNow.classes.map(c => c.name).join(" · ")` — currently-open classes only, confirmed via live capture (6-class and 1-class fixtures both showed no "opens at" text). Restoring this would need a second query (next-upcoming class) and a decision on how far ahead to look — a real scope increase, not a smallest-fix candidate.
- **Entry: missing "Forgot your code? Ask at the front desk." footer.** Present in the reference, absent in current implementation and in both fixture captures this session. Small, but it's new copy/UI, not a one-line fix to existing code — flagging for approval rather than implementing.
- **Picker: reference's stacked (not side-by-side) card layout** — see 1.1's "alternative" note. Eliminates the squeeze structurally but is a visual redesign of the card, not a bugfix.

---

## 4. Reconfirmed already-shipped behavior (not rebuilt, spot-checked live)

- **Open-class freshness**: Entry's "Open for check-in now" panel is driven by the exact same `openOccurrences()` call the real check-in validates against (confirmed at the source level, `src/lib/kiosk/open-classes.ts`). Live capture: with the 6-class fixture open, the panel listed all 6 by name, joined by " · ", matching the fixture exactly; with only 1 class open, it showed exactly that 1. Live boundary-crossing refresh (waiting for a `refreshAt` tick without a reload) was **not** independently re-observed this session — see Verification gaps.
- **Portrait/landscape picker layout**: single-column stack at 390px/320px, 2-column grid at 1280px landscape — both confirmed present and functioning (modulo the 1.1 defect, which affects both).
- **Bounded scrolling**: at 1280px landscape, the 6-card grid scrolls within `max-h-[calc(100dvh-220px)]` rather than overflowing the viewport — confirmed via screenshot (scrollbar visible, 3rd row partially below the fold, reachable by scroll).
- **Deadline-derived countdown**: Success screen showed "Ready for the next person in 6s" → "...3s" → "...2s" across captures taken seconds apart — consistent with a deadline computation, not a frozen or client-decremented string.
- **Done / auto-expiry share the same reset path**: confirmed at the source level — `onDone={resetToEntry}` (line ~608) is the identical function reference the `SUCCESS_DISPLAY_MS` timeout calls. Live: auto-expiry was observed twice (both times during this session, faster than intended) and in both cases it landed on a correct, fresh Entry screen (0/4 digits, correct open-now panel) — functionally indistinguishable from what a manual Done click should produce. A live click-through on the Done button specifically raced the 6-second window twice and wasn't captured directly — see Verification gaps.
- **`canCorrect` / "Not this class" button**: confirmed absent when only one class is open (no alternate class to reassign to) — correct behavior per the code's own comment (line ~1003-1005: "Omitted entirely for an UNMATCHED save... there is no class to name"), not a bug. The ambiguous-match case (multiple candidates, `canCorrect: true`) was not separately re-exercised this session — see Verification gaps.

---

## 5. Verification gaps (explicitly not proved this session)

- **Real Android/iOS device verification** — still outstanding, carried over as instructed.
- **ADMIN smoke-test timeout, run `38607144036`** — still unresolved/unattributed, carried over as instructed.
- **Live `refreshAt` boundary crossing** for the open-now panel (confirmed at the source level only; not watched live across a real boundary tick without reload).
- **Live click on "Done"** specifically (vs. auto-expiry) — both attempts this session raced the 6-second `SUCCESS_DISPLAY_MS` window and auto-expiry fired first. Source-level confirmation (identical function reference) stands; a direct click-through wasn't captured.
- **Ambiguous-match / `canCorrect: true` correction flow** ("Wrong class?" / "Not this class" button and `openCorrection`/`applyCorrection` flow) — not exercised live this session. The 6-class fixture was used only for the picker (manual class selection, which is a different code path from automatic ambiguous-match-with-correction-offered); by the time a single-class fixture was used for Success, there was no ambiguity to correct. This is a real gap, not a "no defect" finding — the correction flow is unverified live, in either direction.
- **ES locale for Picker** — not captured (EN only, both widths). ES Entry and ES Success were both captured and clean.

---

## Summary (planning pass)

One demonstrated, live-reproduced defect (picker text collision — root-caused precisely, smallest fix is a single `break-words` utility class at `kiosk-client.tsx:909`). Two items that differ from the October reference but read as intentional, already-shipped adaptations. Two items that differ from the reference and look like real scope (missing "opens at" line, missing footer copy) — flagged for approval, not touched. Everything in "already-shipped behavior" reconfirmed live except the two items explicitly called out as gaps (refresh-boundary timing, Done click race, and the correction flow), which remain open questions rather than claimed passes.

No production changes made at the end of the planning pass. Implementation follows below.

---

## Implementation (shipped)

Branch `fix/kiosk-picker-text-collision`. Scope: the picker name/time overlap (planning §1.1) and closing the three verification gaps (planning §5). Explicitly **out of scope**, left untouched: the "opens at X" line and "Forgot your code?" footer (planning §3), any shared-component redesign, branding, monitoring, migrations, deployment, activation.

### 1. Picker fix: why plain `break-words` failed, and what actually shipped

The plan's proposed smallest correction (`break-words` alone) was applied first and verified against the real rendered page at 1280px, 390px, and 320px, EN and ES, with a realistic fixture set (`Fundamentals`, `Advanced`, `No-Gi Open Mat`, `Striking Fundamentals`, the long reference phrase, and a deliberately unbroken 56-character name).

**Result: `break-words` alone does not meet the bar.** It stops the glyph bleed (the box-overlap check reports no intersection — it already did even *before* the fix, which is exactly why box-overlap isn't the right test; see §4), but the name column's available width doesn't change, so `break-words` forces ordinary short words to wrap mid-word into a stack of near-single-character lines:

- 1280px (2-col grid): `"Fundamentals"` → `F / u / n / d / a / m / e / n / t / a / l / s`, card height ~496–2071px depending on name length.
- 390px (single column): `"Fundamentals"` → `Funda / ment / als`, `"Advanced"` → `Advan / ced` — ordinary short names wrapping clumsily with visible empty space to their right.
- 320px: same letter-by-letter collapse as 1280px.

This fails the stated bar ("no overlap, clipping, or unreadable squeezed text... every card remains usable") at **all three** required breakpoints — reported precisely rather than silently accepted.

**Root cause, precisely:** the time-range block (`shrink-0`, non-shrinking) has a fixed natural width (~196–228px depending on viewport/font breakpoint). The name column is the *only* flex-shrinkable sibling in the row, so it absorbs 100% of whatever width deficit exists at the actual rendered card width (~271–327px across the tested breakpoints) — regardless of `break-words`, which only changes how the (still near-zero) box wraps its content, not how much width it gets.

**Shipped fix — the smallest alternative that meets every stated criterion, not the reference's stacked layout:**
- File: `src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx`
- The `Button` row (was line 905): `justify-between gap-4` → `flex-wrap justify-between gap-x-4 gap-y-2`.
- The name span (line 909): kept `break-words` as a safety net for the pathological unbroken-name case.

This is **not** the reference's always-stacked layout: side-by-side on one line remains the default and common case (whenever the name and time both fit), identical to today's shipped look for short names. The row only drops the time block to its own line below the name when the name genuinely does not fit next to it — a conditional, content-driven degradation, not an unconditional redesign. Verified clean (no overlap, time fully visible and single-line, no clipping) at 1280px, 390px, 320px, EN and ES, for every name in the fixture set including the adversarial unbroken one (which now wraps into readable ~15–20 character chunks across the card's full width, not single letters).

Bounded scroll and last-card selection were exercised directly: scrolled a 6-card 2-column grid (`scrollHeight` 668 vs `clientHeight` 580) and selected the 6th (last, off-screen-until-scrolled) card — it produced a correct, real check-in for that exact class.

Evidence: `img/current/picker-fix-1280-en.png`, `picker-fix-390-en.png`, `picker-fix-320-en.png`, `picker-fix-1280-es.png`, `picker-fix-last-card-select-1280.png`.

### 2. Verification gaps closed

- **`refreshAt` boundary crossing** — engineered a disposable fixture pair sharing one boundary instant: one class's close window and a second class's open window both landing at the same minute. Watched the Entry open-now panel live across that instant with no page reload: it went from `"Closing Soon Class"` to `"Opens Next Class"` automatically (confirmed via changed DOM refs — a real re-render, not stale content — and `performance.getEntriesByType("navigation")` showing exactly one `navigate` entry, i.e. no reload). Evidence: `img/current/entry-refresh-boundary-after.png`. The transient sub-100ms `{kind:"loading"}` frame itself (hidden while the refetch is in flight) was not captured frame-by-frame — it's already confirmed at the source (`kiosk-client.tsx` ~line 308) and the observed end-to-end correctness (old list → correct new list, no reload) is the behavior that matters.
- **Done clicked before expiry** — real check-in, then `Done` clicked via a poll-and-click script that reacted the instant the success screen rendered (well inside the 6-second `SUCCESS_DISPLAY_MS` window). Result: immediate return to `"Enter your 4-digit code"`. DB check after: exactly 1 `AttendanceRecord` for that class (no duplicate write). Evidence: `img/current/entry-after-done-click.png`.
- **Ambiguous-match "Wrong class?" correction flow** — set up two simultaneously open classes, submitted the code (routed to the picker, confirming the ambiguous case), manually picked one, confirmed `"Not this class?"` appeared, clicked it, confirmed the correction picker listed the *other* open class, picked it, confirmed the success screen re-rendered with the new matched class name. DB check: still exactly 1 `AttendanceRecord` row, `classSessionId` updated in place to the new class (a true reassignment, not a second insert). The flow is intact.

### 3. Entry panel: a separate, out-of-scope overflow noticed in passing

While testing the deliberately unbroken 56-character name as a picker stress case, the **Entry screen's** own "Open for check-in now" line (joins names with `" · "`, no wrap handling for an unbroken word) overflowed horizontally, producing a page-level horizontal scrollbar. This is a different component (`EntryView`, not `ClassPicker`) and wasn't touched — noted here for visibility, not fixed, since it's outside this task's authorized scope (no new features / no scope creep) and the authorized fix was specifically the picker's name/time layout.

> **Superseded — fixed in a later, separately scoped PR.** See §7 below for the bounded correction, root cause, and evidence. This paragraph is left exactly as originally written for the record.

### 4. Regression test — and why the obvious version doesn't work

Added one test to `tests/browser/touch-targets.test.ts` (same real-Chrome suite already covering this screen, `pnpm test:browser`), run across all existing viewports/pointers (tablet landscape 1024×768, tablet portrait 768×1024, phone 390×844 — mouse and coarse pointer).

**First attempt, and why it was discarded:** a sibling bounding-box rectangle-intersection check (`getBoundingClientRect()` on the name span vs. the time span, asserting the two rectangles never intersect). This is a real-browser check, not jsdom — but it was verified to **pass even against the unfixed, overlapping code**, both pre- and post-fix, because `overflow: visible` text paints past its own layout box without the box itself growing to include that overflow. The box-rectangle math genuinely never intersects in either state; only the rendered ink does. This was caught before being kept, by deliberately reverting the fix and re-running the new test — it passed when it should have failed, so it was replaced rather than shipped.

**What actually detects the regression:** `nameSpan.scrollWidth > nameSpan.clientWidth` — true exactly when the element's own text content needs more width than the box it was actually given, independent of whether that excess paints visibly. Reverting the fix and re-running: fails at the 2-column landscape breakpoint and the phone breakpoint (`"Fundamentals" must not need more width than its own box (186 > 29)` and `(160 > 86)` respectively) — confirming the test is a real, working regression guard, not a placebo. Restoring the fix and re-running: all 74 tests in the file pass, including this one at every viewport/pointer combination.

The test also keeps the pre-existing single-line/no-clipping assertion on the time span (reusing the file's own `measure` helper), and uses two ordinary short realistic names (`"Fundamentals"`, `"Advanced"`) rather than a synthetic worst case, since those were exactly what demonstrated the regression.

### 5. Checks run

- `pnpm lint` (scoped to the two changed files): clean.
- `pnpm typecheck` (`tsc --noEmit`, whole project): clean.
- `pnpm test:unit` (1724 tests): all pass.
- `pnpm test:browser` (`tests/browser/touch-targets.test.ts`, 74 tests): all pass, including the new regression test, confirmed to fail against the unfixed code and pass against the fix.

### 6. Verified / unverified

| Item | Status | Evidence |
|---|---|---|
| Picker overlap fixed at 1280/390/320px, EN/ES | **Verified** | `img/current/picker-fix-*.png`, live `scrollWidth`/`clientWidth` measurements |
| Realistic long names (multi-word) render cleanly | **Verified** | same captures |
| Deliberately unbroken long name degrades readably (not letter-by-letter) | **Verified** | `picker-fix-1280-en.png` |
| Bounded scroll still works | **Verified** | `scrollHeight`/`clientHeight` measurement |
| Last (scrolled-to) card selectable, produces correct check-in | **Verified** | `picker-fix-last-card-select-1280.png` |
| `refreshAt` boundary crossing: old list replaced by the correct new list, no reload | **Verified (live)** | `entry-refresh-boundary-after.png`, `performance.getEntriesByType("navigation")` showing one `navigate` entry |
| `refreshAt` boundary crossing: expired list hidden while the refetch is in flight | **Source/test evidence only** — not independently observed live this session; confirmed at the source (`kiosk-client.tsx` ~line 308, `{kind:"loading"}` set before refetch) | — |
| Done click before expiry → immediate return, no duplicate write | **Verified** | `entry-after-done-click.png`, DB row count |
| Ambiguous-match "Wrong class?" correction flow intact | **Verified** | structured DOM assertions + DB row count (reassigned in place) |
| Regression test meaningfully detects the defect | **Verified** | fails against reverted code, passes against the fix |
| Lint / typecheck / unit / browser-test suites | **Verified** | all green |
| Entry panel overflow on an unbroken long name | **Fixed** — see §7 | `entry-overflow-after-*.png` |
| Real Android/iOS device verification | **Unverified — carried over** | — |
| ADMIN smoke-test timeout, run `38607144036` | **Unverified — carried over, unattributed** | — |
| "Opens at X" line / "Forgot your code?" footer | **Deliberately out of scope** | planning §3 |

No commits beyond this branch. PR opened against `main`, held unmerged for review.

---

## Implementation (shipped) — Entry open-now panel overflow

Separate branch `fix/kiosk-entry-open-now-overflow`, separate PR. Scope: only the Entry screen's "Open for check-in now" panel overflow flagged pending in §3/§6 above. Out of scope, untouched: the picker (already fixed in the prior PR), "opens at X" / "Forgot your code?" copy, any shared-component redesign, branding, monitoring, migrations, deployment, activation.

### Reproduction (before)

Disposable fixture: 3 classes open at once at Escazú — `"Fundamentals"`, `"Advanced"`, and a deliberately unbroken 56-character name (`"Superultraheavyweightdivisionintermediateclassforadults"`), so the panel joins three names including one with no internal space to wrap at.

Measured separately, as asked:
- **1280px**: `document.documentElement.scrollWidth` stayed within the viewport (no page-level scrollbar), but the panel's own text visibly painted past its bordered card into the surrounding page background — confirmed via `nameSpan.scrollWidth (432) > nameSpan.clientWidth (287)`.
- **390px**: `document.documentElement.scrollWidth (475) > innerWidth (390)` — a real, visible horizontal scrollbar, with the long name's tail word clipped at the viewport edge.
- **320px**: same horizontal scroll, worse (the unbroken word is cut off mid-word).

Evidence: `img/current/entry-overflow-before-1280-en.png`, `entry-overflow-before-390-en.png`.

### Root cause (two layers, both needed fixing)

1. **The name-list span itself** (`kiosk-client.tsx`, inside the `data-testid="kiosk-open-now"` panel): `whitespace-normal` behavior wraps at spaces, but the unbroken word has none, so it overflowed its own box — the exact same `overflow-wrap` gap the picker fix (prior PR) already addressed for the same reason. Fix: add `break-words`.
2. **A second, independent bug, found only because the first fix alone didn't fully resolve 320px**: the portrait (non-landscape) `grid` wrapping the whole Entry layout has no explicit `grid-template-columns`. Unlike the landscape variant two breakpoints over (`min-[900px]:landscape:grid-cols-[minmax(0,1fr)_auto]`, already correctly bounded), the implicit portrait track has no `minmax(0, …)` ceiling, so it grows to fit its content instead of being capped by the page's real available width. On top of that, the inner column (`flex flex-col items-center`) and the panel itself (`max-w-xs`, a flat 320px cap untied to real available space) are both `items-center`-aligned, shrink-to-fit flex items — under CSS's shrink-to-fit algorithm, an element with wrapping text and no explicit width prefers to use its full allowed upper bound before it will wrap, rather than first shrinking to whatever space is actually available. The combination let the panel claim its full `max-w-xs` (320px) even when only ~256–305px was actually available at 320–390px wide viewports.

Confirmed by elimination, live, before touching source: temporarily forcing `grid-template-columns: minmax(0, 1fr)` on the grid (DevTools-only, not committed) dropped `scrollWidth` from 344px to 313px at 320px — real, but not the full fix. Only after also tying the column and the panel to their real available width (not just an absolute cap) did `scrollWidth` match `clientWidth` exactly (no overflow at all).

### Fix, exact scope

File: `src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx`, `EntryView`, three one-utility-class changes, no structural/JSX changes:
- The outer grid: `grid-cols-[minmax(0,1fr)]` added to the base (portrait) classes, reusing the exact pattern the landscape variant already uses on the same element.
- The inner column (`flex flex-col items-center …`): `w-full` added, so it ties to its now-properly-bounded grid track instead of shrink-wrapping to its own content's preferred width.
- The open-now panel: `max-w-xs` → `max-w-[min(100%,20rem)]` (still caps at 20rem/320px for larger screens, but now also respects "100% of what's actually available" so it can't claim more than the real column width at narrow viewports) and `break-words` on the name-list span.

All complete class names, the `" · "` separator, the open-class data itself, the `refreshAt`/`serverNow` refresh timing, the loading/unavailable states, and every keypad interaction are unchanged — confirmed via the "keeps the snug, content-hugging panel for ordinary short names unchanged" regression test and a direct before/after comparison (ordinary two-name panel width: 226px, identical before and after the fix).

### Verification (after)

Real browser, same fixture (3 classes, including the unbroken name), real dev server against the isolated test DB:

| Viewport | Locale | `scrollWidth` vs `clientWidth` | Keypad reachable | Evidence |
|---|---|---|---|---|
| 320px portrait | EN | equal (305 = 305) | yes | `entry-overflow-after-320-en.png` |
| 390px portrait | EN | equal (390 = 390) | yes | `entry-overflow-after-390-en.png` |
| 390px portrait | ES | equal (390 = 390) | yes | `entry-overflow-after-390-es.png` |
| 1280px landscape | EN | equal (1280 = 1280) | yes | `entry-overflow-after-1280-en.png` |

Also confirmed: the ordinary-names case (`"Fundamentals · Advanced"`, no unbroken word) renders an unchanged, snug, content-hugging card — `img/current/entry-ordinary-names-390-en.png` — and the kiosk is still dark-only (no light variant exists anywhere on this screen, reconfirmed from the prior PR's finding).

Note: `document.documentElement.scrollWidth > window.innerWidth` is **not** a reliable "has horizontal scroll" check — `window.innerWidth` includes the vertical scrollbar's own gutter, so a real few-pixel overflow can hide underneath it (this happened mid-investigation: an early partial fix measured as "clean" by that comparison while a real horizontal scrollbar was still visible on screen). The correct comparison, used throughout this verification and in the regression test, is `scrollWidth` vs. `document.documentElement.clientWidth`, which excludes that gutter.

### Regression test

Added two tests to `tests/browser/touch-targets.test.ts` (same real-Chrome suite, no new test infrastructure), under a new `describe.each` for 320px/390px/1280px (the three widths this task specifically asked for, not the file's existing tablet/phone matrix):
- **"never pushes the page into horizontal scroll, even with an unbroken long class name among several open classes"** — mocks `/api/kiosk/open-classes` with the same 3-class fixture, asserts `scrollWidth <= clientWidth` (the correct comparison above), asserts the full un-truncated joined name text, and asserts the name span's own text still fits its own box (`measure().fits`).
- **"keeps the snug, content-hugging panel for ordinary short names unchanged"** — same mock with only the two ordinary names, asserts the panel's rendered width stays well under the 320px cap, proving the fix didn't force the panel to always stretch.

Confirmed meaningful the same way as the picker's regression test: reverted the three fix lines, re-ran — both new tests failed (`scrollWidth 473/484 > clientWidth 320/390` at 320px/390px, and `fits: false` at 1280px). Restored the fix, re-ran the whole file: all 80 tests pass.

### Checks run

- `pnpm lint` (scoped to the two changed files): clean.
- `pnpm typecheck`: clean.
- `pnpm test:unit` (1724 tests): all pass.
- `pnpm test:browser` (`tests/browser/touch-targets.test.ts`, 80 tests — 74 existing + 6 new): all pass, including both new tests, confirmed to fail against the unfixed code and pass against the fix.

### Remaining limitations

- Real Android/iOS device verification — still outstanding, carried over.
- ADMIN smoke-test timeout, run `38607144036` — still unresolved/unattributed, carried over.
- The "opens at X" upcoming-class line and "Forgot your code?" footer remain deliberately out of scope (planning §3).
- This fix addresses the Entry panel specifically; it does not touch or re-verify the picker (already fixed and merged in the prior PR).

No commits beyond this branch. Second PR opened against `main`, held unmerged for review.
