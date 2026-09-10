# Phase 7: Director Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/dashboard/analytics` view per spec §4.3b — headline business metrics, class
popularity, progression planning, per-location comparison, and retention, all behind one shared
date-range + academy filter, every panel exportable to CSV.

**Architecture:** One shared filter-resolution module (date range, default last 30 days; academy
scope, admin-only picker) and one shared CSV-export component, consumed by five independent panel
modules (headline tiles, class popularity, progression, locations, retention) — each panel owns
its own query function(s) and its own pure classification/projection math, unit-tested the same
way Phase 4's eligibility engine and Phase 6's overdue engine were. `recharts` is added as this
app's first and only charting library, per spec's explicit instruction.

**Tech Stack:** Next.js 15 App Router, Prisma 7, Recharts (new dependency), Luxon (date-range math,
matching this app's existing `America/Costa_Rica` zone convention — no new date library), Vitest,
next-intl.

**Spec:** `PROJECT_SPEC.md` (repo root) — §3 (roles: ADMIN/DIRECTOR only, matching the promotion
queue's and payments-overdue panel's established access pattern), §4.3b (the full analytics
spec — read it in full before starting; it is long and every bullet is a real requirement, not
illustrative), §9 (Phase 7 scope), §10 (mobile-first; a belt-affecting/money-adjacent view still
follows the "no hard deletes, audit money mutations" ethos even though this phase is read-only and
writes nothing new).

## Global Constraints

- **This phase is entirely read-only.** No new writes, no new mutations, no audit log entries —
  every panel queries already-existing data (`AttendanceRecord`, `Student`, `Promotion`,
  `PaymentPeriod`, `ClassSession`). If any task seems to need a write action, that's a sign of
  scope creep — stop and reconsider.
- **No schema changes.** Every model this phase reads already exists. If `pnpm db:migrate` ever
  reports a pending migration during this phase's work, something has gone wrong.
- **Access, self-enforced**: `requireStaffSession(["ADMIN", "DIRECTOR"])`-equivalent gating at the
  page level AND at each query function's own entry point (matching Task 3 of Phase 6's
  `listOverdueStudents` pattern: don't rely solely on the caller/UI to hide a query whose result
  you'd then discard) — INSTRUCTOR gets neither the nav link nor a working direct-URL visit.
- **Ruling: the date-range and academy filters are plain URL search params**
  (`?from=YYYY-MM-DD&to=YYYY-MM-DD&academy=escazu|escalante|ambas`) on `/dashboard/analytics`, read
  server-side by a single shared resolver — not client-side state, not a cookie, not a database
  row. This keeps every panel a plain Server Component reading the same resolved filter, makes the
  page shareable/bookmarkable/reload-safe, and needs no new client-state plumbing. Missing/invalid
  params fall back to the stated defaults (last 30 days; `ambas` for ADMIN, the DIRECTOR's own
  academy — not a picker — for DIRECTOR, since spec's "Locations (admin only)" line means only
  ADMIN gets the academy picker/comparison at all).
- **Ruling: "active-window threshold" (default 30 days, spec's own words) is a plain application
  constant, not a DB-editable setting** — identical reasoning and precedent to Phase 6's overdue-
  cutoff-day ruling: spec's admin-editable-in-UI language was explicit for `BeltRequirement` and
  absent here.
- **Ruling: "Payment health" uses the real, current calendar month (today, in CR time), not the
  selected date range.** A payment status is monthly by construction (`PaymentPeriod` is keyed
  `studentId/year/month`); it doesn't have a meaningful "average over an arbitrary N-day range."
  Every other headline tile respects the selected range; this one deliberately doesn't, and the UI
  should make that one exception legible (e.g., "this month" in its own label) rather than implying
  it's range-filtered like its neighbors.
- **Ruling: "projected date at current training rate" (Progression panel) uses a simple, named
  heuristic — recent attendance rate (attendances in the last 60 days, or since `beltAwardedAt` if
  that's more recent, divided into a per-week rate) projected forward against `remainingToNextStripe`.**
  Spec doesn't specify the exact rate-computation window; this is a display-only estimate with no
  correctness stakes (nothing is gated on it), so a documented, simple choice is appropriate rather
  than a stall. A student with zero recent attendance gets no projected date (an infinite/undefined
  projection is not a date) — show "—", not an error or a wildly-far future date.
- **CSV export is one shared client component, not five bespoke ones.** `src/lib/analytics/csv.ts`
  exports a pure `toCsv(rows: Record<string, string | number>[]): string`; a single
  `<ExportCsvButton rows={...} filename={...} />` client component (Blob + `<a download>` trigger,
  no server round-trip needed since the panel already computed the rows for display) is reused by
  every panel. Do not write a second CSV implementation.
- **Feature-branch-only.** Push to `feat/phase-7-director-analytics`, never `main`. One PR opens at
  the end for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys occasionally injected into
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this
  work — revert just those lines if `git status`/`git diff` shows them before committing.
- **`pnpm db:down && pnpm db:up` does NOT reset the local Postgres data** — this machine's
  docker-compose Postgres uses a persistent named volume. A genuine reset is
  `docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
  `pnpm exec prisma generate`, `pnpm db:seed`.
- **A known, pre-existing, unrelated TypeScript error exists in `src/auth.config.ts`** (confirmed
  since Phase 5 to already exist on `main`, dating to Phase 2). `npx tsc --noEmit` will report it
  regardless of this phase's work — not this phase's to fix; confirm via `git diff main --
  src/auth.config.ts` that any given task hasn't touched it, rather than treating its presence as
  a regression.
- **Two known, pre-existing, unrelated test-infrastructure issues** (surfaced during Phase 6,
  not this phase's to fix): `tests/integration/seed.test.ts` asserts a global academy count over
  shared mutable state that legitimately changes while `admin-schedule-actions.test.ts`'s own
  fixture exists mid-suite — a real flake under default parallelism, not a cleanup bug. Separately,
  default `vitest` parallelism can exhaust Postgres's `max_connections` on this machine. If either
  is hit, use `npx vitest run tests/integration --no-file-parallelism` for your own verification
  and note it in your report rather than trying to fix either issue.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!skills-lock.json'`
  (untracked, pre-existing, not this project's files).

---

### Task 1: Shared filter/CSV infrastructure + headline tiles

**Files:**
- Create: `src/lib/analytics/filters.ts`, `src/lib/analytics/csv.ts`,
  `src/app/[locale]/dashboard/analytics/export-csv-button.tsx`,
  `src/lib/analytics/headline-tiles.ts`, `src/app/[locale]/dashboard/analytics/page.tsx`,
  `tests/unit/analytics-filters.test.ts`, `tests/unit/headline-tiles.test.ts`,
  `tests/integration/headline-tiles.test.ts`
- Modify: `src/app/[locale]/dashboard/page.tsx` (add the nav link to the new tab),
  `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces:
  - `interface AnalyticsFilters { from: DateTime; to: DateTime; academyId: string | null }` —
    `academyId: null` means "all academies in the session's scope" (ADMIN with no `academy` param
    or `academy=ambas`; DIRECTOR always resolves to their own single academy regardless of any
    `academy` param they might pass, since they never get the picker).
  - `function resolveAnalyticsFilters(session: StaffSession, searchParams: { from?: string; to?:
    string; academy?: string }): AnalyticsFilters` — pure given its inputs (no `new Date()`/DB call
    inside; the "now" for the default range comes from a caller-supplied `today` parameter with a
    real-clock default, same pattern as Phase 6's `isOverdue`/`currentCrDateParts()` split, so the
    30-day-default logic is unit-testable without fighting the wall clock).
  - `function toCsv(rows: Record<string, string | number>[]): string`
  - `interface HeadlineTiles { enrolled: number; active: number; inactive: number; newThisMonth:
    number; lost: number; totalAttendances: number; avgAttendancesPerActive: number;
    paymentHealthPercent: number }`
  - `function getHeadlineTiles(session: StaffSession, filters: AnalyticsFilters): Promise<HeadlineTiles>`
    — self-enforces `ADMIN`/`DIRECTOR` only.

- [ ] **Step 1: Add `recharts`**

```bash
pnpm add recharts
```

- [ ] **Step 2: Write the failing unit tests for `resolveAnalyticsFilters`**

Cover: no params → last 30 days ending "today" (caller-supplied), academy `null` for an ADMIN
session; a DIRECTOR session with an `academy=escalante` param still resolves to the DIRECTOR's
OWN academy (the param is silently ignored for non-ADMIN, matching the roster's existing
`filters.academyId`-ignored-for-non-ADMIN precedent from Phase 2); a malformed `from`/`to` (not a
real date) falls back to the 30-day default rather than throwing; a valid `from`/`to` range is
used verbatim; `academy=ambas` for ADMIN resolves to `academyId: null`.

- [ ] **Step 3: Run to confirm failure, then implement `resolveAnalyticsFilters`**

Run: `pnpm test:unit tests/unit/analytics-filters.test.ts` — FAIL. Implement. Run again — PASS.

- [ ] **Step 4: Implement `toCsv` (no test-first ceremony needed for something this small, but
  add a quick unit test anyway since it's exactly the kind of "obviously right" pure function that
  still benefits from one)**

Handle: header row from the first object's keys, proper quoting/escaping of values containing
commas/quotes/newlines, an empty `rows` array producing just a header-less empty string (or your
call on the exact empty-input contract — document it).

- [ ] **Step 5: Write the failing unit tests for the headline tiles' pure classification logic**

Extract the "is this student active in the range" / "is this student newly enrolled this month" /
"was this student active last period but not this one" logic into small, named, pure functions
(mirroring Phase 4's `classifyEligibility` extraction) rather than inlining boolean expressions
into the query function — this is the part of the panel most worth unit-testing in isolation.
Cover: a student with an attendance inside the range → active; outside → not active; a student who
joined inside the range → new; a student with ≥1 attendance in the PREVIOUS equivalent-length
period but zero in the current one → lost; a student active in both periods → not lost.

- [ ] **Step 6: Run to confirm failure, then implement the pure classifiers + `getHeadlineTiles`**

`getHeadlineTiles` scopes students via `academyScopeWhere`-equivalent translated to
`homeAcademyId` (same translation Phase 2/4/6 already established) plus `filters.academyId` when
set, self-enforces the role gate, and computes each tile using the pure classifiers above plus
direct aggregates for `totalAttendances`/`avgAttendancesPerActive`. `paymentHealthPercent` uses
the CURRENT calendar month (this plan's ruling above), reusing Phase 6's `getCurrentPaymentPeriod`
+ `isOverdue`-adjacent logic (a student counts toward "healthy" if their current-month period is
`PAID` or `PROMO` — reuse, don't reimplement, the existing per-student current-period resolution).

Run: `pnpm test:unit tests/unit/headline-tiles.test.ts` — PASS.

- [ ] **Step 7: Write the failing integration test for `getHeadlineTiles`**

Cover: a small scoped scenario with a handful of seeded students exercising each tile
(active/inactive/new/lost/payment-health) against the real DB; DIRECTOR/ADMIN academy scoping;
INSTRUCTOR rejected (self-enforced gate, verified by calling the function directly with a forged
INSTRUCTOR session, not just checking the UI).

Run: `pnpm test:integration tests/integration/headline-tiles.test.ts` — PASS.

- [ ] **Step 8: Build the page shell**

`src/app/[locale]/dashboard/analytics/page.tsx`: `requireStaffSession(["ADMIN", "DIRECTOR"])`,
read `searchParams`, call `resolveAnalyticsFilters`, render a simple filter control bar (a
`<form>` with date inputs and, ADMIN-only, an academy `<select>`, submitting via GET so it's
plain URL navigation — no client JS needed for the filter itself) and the headline tiles section
with an `ExportCsvButton`. Add a nav link/tab to `src/app/[locale]/dashboard/page.tsx` pointing
here, ADMIN/DIRECTOR-only (same `canViewOverduePayments`-style conditional Phase 6 already
established), and a reciprocal link back from the analytics page to the main dashboard.

- [ ] **Step 9: Add message keys, verify, commit**

Add `dashboard.analytics.*` keys to both locale files.

Run: `pnpm build` — succeeds. `pnpm test` — all pass.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add director analytics page shell, shared filters/CSV, headline tiles"
git push origin feat/phase-7-director-analytics
```

---

### Task 2: Class popularity panel

**Files:**
- Create: `src/lib/analytics/class-popularity.ts`,
  `src/app/[locale]/dashboard/analytics/class-popularity-panel.tsx`,
  `tests/unit/class-popularity.test.ts`, `tests/integration/class-popularity.test.ts`
- Modify: `src/app/[locale]/dashboard/analytics/page.tsx`, `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `AnalyticsFilters`, `toCsv`/`ExportCsvButton` (Task 1).
- Produces: `interface ClassPopularityRow { classSessionId: string; label: string; dayOfWeek:
  DayOfWeek; startTime: string; attendances: number; previousAttendances: number; trend: "up" |
  "down" | "flat" }`, `function getClassPopularity(session, filters): Promise<ClassPopularityRow[]>`
  (ranked descending by `attendances`), plus a pure `computeTrend(current: number, previous:
  number): "up" | "down" | "flat"` (equal → `"flat"`, with a documented tolerance if you think
  exact equality is too strict for real-world noise — your call, document it).

- [ ] **Step 1: Write the failing unit test for `computeTrend`**

Cover: current > previous → `"up"`; current < previous → `"down"`; equal → `"flat"`; previous `0`,
current > 0 → `"up"` (not a divide-by-zero situation, since this is a simple comparison, not a
percentage).

- [ ] **Step 2: Implement `computeTrend`, run to confirm pass**

- [ ] **Step 3: Write the failing integration test for `getClassPopularity`**

Seed a small set of `ClassSession`s with differing attendance counts in the current range and the
immediately-preceding equivalent-length range (e.g., a 30-day range means comparing to the prior
30 days). Cover: ranking is correct (highest first); the lowest-attended slot is present and
identifiable (not filtered out — spec explicitly wants the low end surfaced, not just top-N); a
class with zero attendances in the current range still appears (with `attendances: 0`), not
silently omitted; trend arrows match `computeTrend`'s logic; academy scoping (a DIRECTOR never
sees the other academy's classes).

- [ ] **Step 4: Implement `getClassPopularity`, run to confirm pass**

`label` should match this app's existing class-display convention (check how the admin schedule
page or kiosk renders a class name — likely `"{dayOfWeek} {startTime} {name}"` or similar; use
whatever convention already exists rather than inventing a new format).

- [ ] **Step 5: Build the panel**

Bar chart (Recharts `BarChart`, ranked, x-axis labels rotated/truncated for mobile per spec's
"readable on a phone" requirement — don't let 18 class-slot labels overlap into an unreadable
mess; Recharts has documented patterns for angled/truncated tick labels, use one) plus the
day-of-week × time-of-day heatmap. The heatmap is NOT a Recharts component (Recharts has no
first-class heatmap) — build it as a simple CSS grid: rows = the 7 days, columns = the distinct
`startTime` values present in the filtered data, cell background-color intensity scaled to that
slot's attendance count (a simple linear or bucketed scale against the max value in the grid is
fine — keep it simple, this is exactly the kind of visualization spec asks to stay simple). Each
cell must have a text label (the count) in addition to color, per spec's "never rely on color
alone." Add the trend arrows (↑/↓/→ or equivalent, with a text `sr-only` label, not just a
colored glyph) next to each bar-chart entry. Wire `ExportCsvButton` with the ranked rows.

- [ ] **Step 6: Add message keys, verify, commit**

Run: `pnpm build`, `pnpm test` — all pass/succeed.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add class popularity panel (bar chart, heatmap, trend)"
git push origin feat/phase-7-director-analytics
```

---

### Task 3: Progression panel

**Files:**
- Create: `src/lib/analytics/progression.ts`,
  `src/app/[locale]/dashboard/analytics/progression-panel.tsx`,
  `tests/unit/progression-projection.test.ts`, `tests/integration/progression-analytics.test.ts`
- Modify: `src/app/[locale]/dashboard/analytics/page.tsx`, `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `AnalyticsFilters` (Task 1), `getAtBeltSummary`/`computeBeltProgress` (Phase 3/4),
  `listApproachingStudents`-adjacent logic (Phase 4's `promotion-queue.ts` — reuse its
  `classifyEligibility`/scoping pattern rather than reimplementing "who's near a threshold").
- Produces: `function projectThresholdDate(remainingToNextStripe: number | null,
  recentAttendancesPerWeek: number, today: DateTime): DateTime | null` (pure — returns `null` for
  no-remaining-threshold or a zero/undefined rate, per this plan's ruling), a
  `getProgressionPlanningList`/`getBeltDistribution`/`getPromotionsInRange` set of query
  functions (your call whether these are one combined function or three — document your choice).

- [ ] **Step 1: Write the failing unit test for `projectThresholdDate`**

Cover: a real positive rate + remaining count → a real future date at the expected week-count out;
zero rate → `null`; `remainingToNextStripe: null` (already past every threshold / exam-eligible) →
`null` (nothing to project toward — exam-eligible students belong in the promotion queue, not a
"projected date," since they're already there).

- [ ] **Step 2: Implement, run to confirm pass**

- [ ] **Step 3: Write the failing integration test for the three query functions**

Planning list: reuses Phase 4's stripe/exam-eligible-or-approaching classification (this is
deliberately similar to, but distinct from, the dashboard's existing promotion queue — this
panel's job is a broader "who's approaching," not just the immediately-actionable queue; check
spec's wording again — "students near the next stripe or exam" — and decide whether "near" here
means the SAME approaching-threshold definition Phase 4 already built, reused as-is, or a
report-specific window; reusing Phase 4's existing `listApproachingStudents` (already built,
tested, and self-gated) directly is almost certainly correct and avoids a third near-duplicate
implementation of the same classification — do this unless you find a concrete reason spec wants
something different). Belt distribution: a simple `groupBy(currentBelt)` count, academy-scoped.
Promotions in range: `Promotion.findMany` filtered by `awardedAt` in the selected range,
academy-scoped.

- [ ] **Step 4: Implement, run to confirm pass**

- [ ] **Step 5: Build the panel**

Planning list as a simple table (name, belt, current count, remaining, projected date or "—").
Belt distribution as a Recharts bar or pie chart (your call — spec doesn't specify the chart type
here, just "belt distribution," and either is defensible; document your choice). Promotions-in-
range as a simple list. `ExportCsvButton` for the planning list at minimum (the other two
sub-panels may also get one — your call on granularity, but at least one meaningful CSV export
must exist on this panel per spec's "every panel... exports to CSV").

- [ ] **Step 6: Add message keys, verify, commit**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add progression panel (planning list, belt distribution, promotions)"
git push origin feat/phase-7-director-analytics
```

---

### Task 4: Locations panel (admin only)

**Files:**
- Create: `src/lib/analytics/locations.ts`,
  `src/app/[locale]/dashboard/analytics/locations-panel.tsx`,
  `tests/integration/locations-analytics.test.ts`
- Modify: `src/app/[locale]/dashboard/analytics/page.tsx`, `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `AnalyticsFilters`, `getHeadlineTiles`-adjacent per-academy metrics (Task 1 — you may
  need to call the same underlying logic once per academy rather than the combined-scope version;
  check whether `getHeadlineTiles` can be called once per specific `academyId` cleanly, or whether
  a small refactor is needed to support "compute this metric set for exactly one specific
  academy" as a reusable building block both the combined dashboard tile AND this per-location
  comparison call into).
- Produces: `interface LocationComparisonRow { academyId: string; academyName: string;
  activeStudents: number; totalAttendances: number; avgPerClass: number; paymentHealthPercent:
  number }`, `function getLocationComparison(session, filters): Promise<LocationComparisonRow[]>`
  — **self-enforces ADMIN-only** (not DIRECTOR — spec's heading is explicit: "Locations (admin
  only)"), `interface CrossTrainingEntry { studentId: string; studentName: string;
  homeAcademyName: string; visitedAcademyName: string; visitCount: number }`,
  `function getCrossTraining(session, filters): Promise<CrossTrainingEntry[]>` — same ADMIN-only
  gate.

- [ ] **Step 1: Write the failing integration tests**

Location comparison: two academies with different attendance/payment profiles, confirm both rows
are correct and independent; a DIRECTOR session is REJECTED (not just given a narrower view —
this whole panel is admin-only, unlike every other panel in this phase which DIRECTOR can see for
their own academy). Cross-training: a student whose `AttendanceRecord.academyId !==
homeAcademyId` within the filtered range appears with the correct visit count and correct
home/visited academy names; a student who only ever checked in at their own home academy never
appears; DIRECTOR rejected here too.

- [ ] **Step 2: Implement both functions, run to confirm pass**

- [ ] **Step 3: Build the panel**

Only rendered at all when `staffSession.role === "ADMIN"` (the page shell should skip fetching
this panel's data entirely for a DIRECTOR session, not fetch-and-hide, matching the established
pattern). Side-by-side comparison table/cards for the two academies (or however many exist — don't
hardcode "exactly two," query real `Academy` rows even though this app currently only has Escazú/
Escalante). Cross-training as a simple list. `ExportCsvButton` on both sub-panels.

- [ ] **Step 4: Add message keys, verify, commit**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add locations panel (admin-only comparison, cross-training)"
git push origin feat/phase-7-director-analytics
```

---

### Task 5: Retention panel

**Files:**
- Create: `src/lib/analytics/retention.ts`,
  `src/app/[locale]/dashboard/analytics/retention-panel.tsx`,
  `tests/unit/retention-buckets.test.ts`, `tests/integration/retention-analytics.test.ts`
- Modify: `src/app/[locale]/dashboard/analytics/page.tsx`, `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces: `function classifyRetentionBucket(daysSinceLastAttendance: number | null): "30" | "60"
  | "90" | null` (pure — `null` for a student attending within the last 30 days, i.e. not a
  retention concern; `daysSinceLastAttendance: null` for a student with NO attendance ever should
  bucket into `"90"` — document this choice, since "never attended" is at least as concerning as
  "hasn't attended in 90+ days"), `interface RetentionEntry { studentId: string; name: string;
  phone: string; lastSeenAt: Date | null; bucket: "30" | "60" | "90" }`,
  `function getRetentionList(session, filters): Promise<RetentionEntry[]>`,
  `function getWeeklyAttendanceTrend(session, filters): Promise<Array<{ weekStart: string; count:
  number }>>`.

- [ ] **Step 1: Write the failing unit test for `classifyRetentionBucket`**

Cover: 15 days → `null` (not a concern); 35 → `"30"`; 65 → `"60"`; 95 → `"90"`; exactly on a
boundary (30/60/90) → pick and document which side it falls on; `null` (never attended) → `"90"`.

- [ ] **Step 2: Implement, run to confirm pass**

- [ ] **Step 3: Write the failing integration tests**

Retention list: students in each of the three buckets appear correctly, with `phone` included
(spec explicitly asks for it "so the director can actually reach out") and correct `lastSeenAt`; a
recently-active student never appears; academy scoping; a `PENDING`/`ARCHIVED` **student status**
never appears (only `ACTIVE` students are retention concerns — an archived student leaving isn't
"retention risk," they're already gone). Weekly trend: attendances correctly bucketed into
CR-timezone weeks over the filtered range (reuse this app's existing week/day-boundary Luxon
conventions — do NOT bucket by a naive UTC week, this app has been bitten by exactly this class of
bug before).

- [ ] **Step 4: Implement, run to confirm pass**

- [ ] **Step 5: Build the panel**

Retention list as a simple table grouped or sorted by bucket (worst-first is probably most
useful — your call, document it), with phone numbers visible (this is the one panel in this
entire app that deliberately surfaces a phone number to staff for direct outreach — confirm no
role restriction beyond the existing ADMIN/DIRECTOR gate is needed, matching spec's plain
intent). Weekly trend as a Recharts `LineChart`. `ExportCsvButton` on the retention list.

- [ ] **Step 6: Add message keys, verify, commit**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add retention panel (30/60/90-day list, weekly trend)"
git push origin feat/phase-7-director-analytics
```

---

### Task 6: Full-suite verification and PR prep

**Files:** none (verification only).

- [ ] **Step 1: Full-suite verification**

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm exec prisma generate
pnpm db:seed
pnpm test
pnpm build
pnpm lint
npx tsc --noEmit
```

All must pass/succeed except the confirmed pre-existing, unrelated `auth.config.ts` error. No new
migration is expected this phase. If integration tests hit the known Postgres connection-exhaustion
issue under default parallelism, use `npx vitest run tests/integration --no-file-parallelism` and
note it — don't treat it as a regression this phase introduced.

- [ ] **Step 2: Manual end-to-end walk**

As ADMIN: visit `/dashboard/analytics`, change the date range and academy filter, confirm every
panel's numbers update accordingly; export CSV from at least two different panels and confirm the
downloaded file's contents match what's rendered. As DIRECTOR: confirm the Locations panel is
absent entirely, every other panel is scoped to their own academy only, and there's no way to see
the academy picker. As INSTRUCTOR: confirm no nav link exists and a direct visit to
`/dashboard/analytics` is rejected.

- [ ] **Step 3: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "test: full-suite verification for Phase 7"
git push origin feat/phase-7-director-analytics
```

Phase 7 is complete once this task's full-suite verification passes. This plan's controller will
dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
