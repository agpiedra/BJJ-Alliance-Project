# Phase 6: Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Payment tracking (never processing) per spec §6 — one `PaymentPeriod` row per student per
month, a director/admin action to record it, an overdue view, and finally filling in every
placeholder this app has been carrying since Phase 1 waiting for this data to exist.

**Architecture:** `PaymentPlan`/`PaymentPeriod` and the `PaymentStatus` enum already exist and are
seeded (Phase 1) — this phase is pure business logic and UI on top of an existing schema, no
migration. A pure `isOverdue` function (mirroring Phase 4's `computeBeltProgress` extraction
pattern: testable in isolation, consumed by both the query layer and the UI) decides overdue
status from a period-or-null plus "today"; a `recordPayment` action (mirroring `confirmPromotion`'s
established shape) writes it, audited, DIRECTOR/ADMIN only per spec §3.

**Tech Stack:** Next.js 15 App Router, Prisma 7, Zod, Vitest, next-intl, Luxon (for "today" in the
academy's timezone — reuse Phase 3's `ZONE`/date helpers, don't reinvent). No new libraries.

**Spec:** `PROJECT_SPEC.md` (repo root) — §3 (roles: DIRECTOR manages payments; INSTRUCTOR "No
payments"), §4.3 ("Payments overdue" dashboard panel, director/admin only), §4.2 (portal shows
"current payment status and which plan/promo"), §4.4 (roster row shows a "payment badge"), §4.5
(student detail shows "payment history"), §6 (the full payments model), §9 (Phase 6 scope:
"periods, statuses, overdue view"), §10 ("all money and belt-affecting mutations are audited").

## Global Constraints

- **No schema changes this phase.** `PaymentPlan`, `PaymentPeriod`, `PaymentStatus` all already
  exist from Phase 1 and are already seeded (`Mensualidad`/`Promoción`/`Becado` per academy). If
  any task in this plan seems to need a migration, that's a signal something is being
  misunderstood — stop and re-read this section.
- **Payment status is visible but never blocking** (spec §6, verbatim) — an overdue or unpaid
  student can still check in, self-check-in, and be promoted. Nothing in this phase adds a
  payment-status check to `performCheckIn`, `confirmPromotion`, or any other write path. This
  phase is read/record only.
- **Ruling: the overdue cutoff day is a plain application constant (default the 5th, per spec's
  own example), not a DB-editable per-academy setting.** Spec explicitly mandates
  `BeltRequirement` be "editable by an admin in the UI" for belt thresholds — it uses no such
  language for the overdue cutoff, saying only "a configurable day of the month (default: the
  5th)" with no stated location for that configuration. Given no admin-UI requirement is stated,
  a named constant (easy to bump later if a real settings UI is ever asked for) is the appropriate
  scope for this phase — YAGNI, not a schema decision needing sign-off. Cost if wrong: a future
  phase adds a settings row for this one value; trivial to retrofit since the constant is
  centralized in one function's default parameter.
- **A payment recording write is a plain upsert, not a compare-and-swap.** Unlike Phase 4's
  `confirmPromotion` (which computed its "before" state from other data and therefore had a real
  staleness hazard), a payment status is a direct staff-entered value with no derived "current
  state" to race against — recording "PAID for September" always simply sets that value. Do not
  import Phase 4's `PromotionConflictError`-style guard here; it solves a problem this write
  doesn't have. The `@@unique([studentId, year, month])` constraint exists to enforce "one row per
  student per month," not to prevent a race — a plain `upsert` keyed on it is correct and
  sufficient.
- **`PaymentPeriod.planId` must belong to the SAME academy as the student being recorded for.**
  `PaymentPlan` is scoped to one academy (`@@unique([academyId, name])`); a director accidentally
  (or a malicious request deliberately) submitting a plan id from the other academy must be
  rejected server-side, not merely hidden from the UI's dropdown.
- **Money mutations are audited** (spec §10) — `recordPayment` writes an `AuditLog` row
  (`action: "payment.record"`, `entityType: "PaymentPeriod"`) in the same transaction as the
  upsert, following the exact established pattern from every prior phase's write actions.
- **Role gate: `requireStaffSession(["ADMIN", "DIRECTOR"])` for recording** — spec §3 excludes
  INSTRUCTOR from payments entirely. **Viewing** payment status/history, however, follows this
  project's established "any staff can view, only ADMIN/DIRECTOR can write" pattern (the same
  shape as Phase 4's promotion queue: INSTRUCTOR sees the read-only queue, no confirm button) —
  spec doesn't say to hide payment status from an INSTRUCTOR looking at a student's profile or the
  roster, only to bar them from recording it.
- **Feature-branch-only.** Push to `feat/phase-6-payments`, never `main`. One PR opens at the end
  for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys occasionally injected into
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this
  work — revert just those lines if `git status`/`git diff` shows them before committing.
- **`pnpm db:down && pnpm db:up` does NOT reset the local Postgres data** — this machine's
  docker-compose Postgres uses a persistent named volume. A genuine reset is
  `docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
  `pnpm exec prisma generate`, `pnpm db:seed`.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!.windsurf'
  ':!skills-lock.json'` (these three are untracked, pre-existing, not this project's files).
- **A known, unrelated, pre-existing TypeScript error exists in `src/auth.config.ts`** (confirmed
  during Phase 5 to already exist on `main`, dating to Phase 2, unconnected to any recent work).
  `npx tsc --noEmit` will report it regardless of what this phase does — do not attempt to fix it
  as part of this plan (out of scope), and do not treat its presence as a sign your own changes
  broke something; confirm via `git diff main -- src/auth.config.ts` that you haven't touched it.

---

### Task 1: Overdue-status engine + `recordPayment` action

**Files:**
- Create: `src/lib/payments/overdue.ts`, `tests/unit/overdue.test.ts`,
  `src/app/[locale]/students/[id]/payment-actions.ts`, `tests/integration/payment-actions.test.ts`

**Interfaces:**
- Produces:
  - `const DEFAULT_OVERDUE_CUTOFF_DAY = 5`
  - `function isOverdue(period: { status: PaymentStatus } | null, today: { day: number }, cutoffDay?: number): boolean`
    — `today.day` is the day-of-month in the academy's timezone (a plain `{ day: number }` shape,
    not a full `DateTime`, so the function stays trivially pure and testable — the caller resolves
    the real "today" via Luxon's CR zone before calling this).
  - `recordPayment(_prevState: ActionState, formData: FormData): Promise<ActionState>` —
    `"use server"`.

- [ ] **Step 1: Write the failing unit tests for `isOverdue`**

Create `tests/unit/overdue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isOverdue, DEFAULT_OVERDUE_CUTOFF_DAY } from "@/lib/payments/overdue";

describe("isOverdue", () => {
  it("is never overdue on or before the cutoff day, even with no row", () => {
    expect(isOverdue(null, { day: 1 })).toBe(false);
    expect(isOverdue(null, { day: DEFAULT_OVERDUE_CUTOFF_DAY })).toBe(false);
  });

  it("no row + past cutoff = overdue", () => {
    expect(isOverdue(null, { day: DEFAULT_OVERDUE_CUTOFF_DAY + 1 })).toBe(true);
  });

  it("PENDING row + past cutoff = overdue", () => {
    expect(isOverdue({ status: "PENDING" }, { day: 10 })).toBe(true);
  });

  it("PENDING row + on/before cutoff = not yet overdue", () => {
    expect(isOverdue({ status: "PENDING" }, { day: 3 })).toBe(false);
  });

  it("PAID row is never overdue, any day", () => {
    expect(isOverdue({ status: "PAID" }, { day: 28 })).toBe(false);
  });

  it("PROMO row is never overdue", () => {
    expect(isOverdue({ status: "PROMO" }, { day: 28 })).toBe(false);
  });

  it("EXEMPT row is never overdue", () => {
    expect(isOverdue({ status: "EXEMPT" }, { day: 28 })).toBe(false);
  });

  it("respects a custom cutoff day", () => {
    expect(isOverdue(null, { day: 12 }, 15)).toBe(false);
    expect(isOverdue(null, { day: 16 }, 15)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement `isOverdue`**

Run: `pnpm test:unit tests/unit/overdue.test.ts` — FAIL (module doesn't exist). Implement
`src/lib/payments/overdue.ts` with `DEFAULT_OVERDUE_CUTOFF_DAY = 5` and `isOverdue` per the test
cases above (a straightforward `today.day > cutoffDay && (!period || period.status === "PENDING")`
— write it to make the tests pass, don't just copy this line blindly, confirm it against every
case above). Run again — PASS.

- [ ] **Step 3: Write the failing integration test for `recordPayment`**

Create `tests/integration/payment-actions.test.ts`, following `promotion-actions.test.ts`'s
established pattern (a cookie-bound staff action, mocked `@/auth`, real Postgres). Cover:
- An ADMIN or DIRECTOR recording a payment for the first time for a student/month: creates a
  `PaymentPeriod` row with the correct `status`/`planId`/`amount`/`notes`, `recordedById` =
  the session's user, `academyId` = the student's `homeAcademyId` (never client-submitted), and
  writes an `AuditLog` row (`action: "payment.record"`).
- Recording AGAIN for the same student/month (e.g. correcting a mistake, or PENDING → PAID):
  updates the SAME row (via the `@@unique` constraint) rather than creating a second one — assert
  `PaymentPeriod` count stays 1 for that student/year/month, and the `AuditLog`'s `before`
  reflects the prior status.
- A `planId` belonging to the OTHER academy is rejected (`{error: "invalidPlan"}` or similar) —
  no write.
- An INSTRUCTOR session is rejected (role gate).
- A DIRECTOR whose `StaffAssignment` doesn't cover the target student's academy is rejected with
  `notFound` (out-of-scope check, same house rule as every prior write action).
- An invalid `year`/`month` (e.g. `month: 13`, `month: 0`) is rejected by zod validation before
  any DB write.

- [ ] **Step 4: Run to confirm failure, then implement `recordPayment`**

`"use server"`. `requireStaffSession(["ADMIN", "DIRECTOR"])`. Validate via zod: `studentId`
(`z.string().min(1)`), `year` (`z.coerce.number().int().min(2020).max(2100)`), `month`
(`z.coerce.number().int().min(1).max(12)`), `planId` (`z.string().min(1)`), `status`
(`z.nativeEnum(PaymentStatus)`), `amount` (`z.coerce.number().min(0).optional()`), `notes`
(`z.string().optional()`). Re-fetch the student (`homeAcademyId`), re-check
`isAcademyInScope(session, student.homeAcademyId)` → `{error: "notFound"}` if out of scope.
Re-fetch the `PaymentPlan` by `planId`, verify `plan.academyId === student.homeAcademyId` →
`{error: "invalidPlan"}` if not. In one `prisma.$transaction`:
1. Read the existing `PaymentPeriod` (if any) for `{studentId, year, month}` — this is your audit
   `before` snapshot (`null` if none exists yet).
2. `tx.paymentPeriod.upsert({ where: { studentId_year_month: { studentId, year, month } },
   create: { studentId, academyId: student.homeAcademyId, year, month, planId, status, amount,
   notes, recordedById: session.userId }, update: { planId, status, amount, notes, recordedById:
   session.userId, recordedAt: new Date() } })`.
3. `tx.auditLog.create({ data: { actorId: session.userId, academyId: student.homeAcademyId,
   action: "payment.record", entityType: "PaymentPeriod", entityId: <the upserted row's id>,
   before: <the prior row's {status, planId, amount} or null>, after: {status, planId, amount} }
   })`.

Return `{ok: true}`.

Run: `pnpm test:integration tests/integration/payment-actions.test.ts` — PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payments/overdue.ts tests/unit/overdue.test.ts src/app/[locale]/students/[id]/payment-actions.ts tests/integration/payment-actions.test.ts
git commit -m "feat: add overdue-status engine and payment recording action"
git push origin feat/phase-6-payments
```

---

### Task 2: Fill in every existing payment/attendance placeholder

**Files:**
- Modify: `src/app/[locale]/students/page.tsx` (roster), `src/app/[locale]/students/actions.ts`,
  `src/app/[locale]/students/[id]/page.tsx` (staff detail), `src/app/[locale]/portal/page.tsx`
  (student portal)
- Create: `src/lib/payments/get-current-period.ts` (or similar — a small helper resolving "this
  student's PaymentPeriod for the current CR calendar month, or null")
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `isOverdue`/`DEFAULT_OVERDUE_CUTOFF_DAY` (Task 1), `getAtBeltSummary` (Phase 3),
  Luxon's CR-zone helpers (Phase 3, `src/lib/scheduling/zone.ts` or wherever "today in CR" is
  already derivable from — check first rather than reinventing "what day is it in Costa Rica").

- [ ] **Step 1: Fill in the roster's THREE placeholder columns, not just payment**

Read `src/app/[locale]/students/page.tsx` in full — it currently renders `atBeltCount`,
`lastAttendance`, AND `payment` all as a literal `—`, with a single comment explaining all three
are blocked ("Not computable yet without the attendance ledger (Phase 3) / payment tracking
(Phase 6)"). **Two of those three reasons are now stale** — Phase 3/4 shipped the attendance
ledger and `getAtBeltSummary` months ago, but nobody went back and wired the roster page up to
them. Since you're already touching this exact table row for the payment column, fix all three in
the same pass:
- `atBeltCount`: `summary.atBeltCount` via `getAtBeltSummary(student.id)`.
- `lastAttendance`: the student's most recent `AttendanceRecord.occurredAt` (a simple
  `findFirst({ where: { studentId }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true
  } })`), formatted in the academy's timezone (reuse `src/lib/format-date.ts` from Phase 5), or an
  "never" / em-dash if none exists.
- `payment`: a `Badge` showing the current month's `PaymentStatus` (via this task's new
  `get-current-period.ts` helper + `isOverdue`), or an "Overdue" badge (distinct visual treatment
  — reuse this app's existing status-badge color-token conventions, check
  `globals.css`/`--status-*` tokens from Phase 3's dashboard-page-content redesign) when
  `isOverdue` returns true.

Do this per-row via `Promise.all` across the fetched student list (same batching shape as Phase
4's `classifyActiveStudents`) — this app's established precedent already accepts this
per-row-query pattern at current scale (a single gym's roster), flagged but not blocking in Phase
4's final review. Don't attempt to eliminate it here; that's a separate, later hardening pass.

- [ ] **Step 2: Wire real data into the staff student-detail page's payment-history placeholder**

In `src/app/[locale]/students/[id]/page.tsx`, replace the `paymentHistory` card's
`{tDetail("comingLater")}` body with a real list: `prisma.paymentPeriod.findMany({ where:
{studentId}, orderBy: [{year: "desc"}, {month: "desc"}] })`, joined to `plan` for its name. One
row per period: year/month (localized month name via `Intl.DateTimeFormat`), plan name, status
badge, amount if present, notes if present. Empty list → a new "no payment records yet" message
key (not `comingLater` — same reasoning as Phase 4's promotion-history task: that phrase means
"not built," which is no longer true). Add a "record a payment" form/button on this page (ADMIN/
DIRECTOR only, gated the same way `canEdit` gates other staff-only actions on this page) that
posts to `recordPayment` — this is the actual UI most directors will use to record a payment.

- [ ] **Step 3: Wire real data into the student portal's payment-status placeholder**

In `src/app/[locale]/portal/page.tsx`, replace the payment placeholder card (added in Phase 5,
explicitly deferred to this phase) with the student's OWN current-month status: plan name, status
badge, and an overdue notice if applicable — read-only, no recording UI here (spec §4.2 shows
status to the student, it doesn't give them a record-a-payment action). Scope this read to
`session.studentId` exactly like every other portal query (Phase 5's established pattern) — no
route param, no way to see another student's payment status.

- [ ] **Step 4: Add message keys**

Add keys for: roster's payment badge/overdue text, the staff detail page's payment-history
list/empty-state/record-form, and the portal's payment-status card — to both `messages/en.json`
and `messages/es.json`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm build` — succeeds. Manually verify (via a throwaway seeded student + `recordPayment`
call, or direct script) that recording a payment updates all three surfaces (roster badge, staff
detail history, portal status) correctly.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: show real payment/attendance data on the roster, student detail, and portal pages"
git push origin feat/phase-6-payments
```

---

### Task 3: Dashboard "Payments overdue" panel

**Files:**
- Modify: `src/app/[locale]/dashboard/page.tsx`, `messages/es.json`, `messages/en.json`
- Create: `src/lib/payments/list-overdue.ts`

**Interfaces:**
- Produces: `interface OverdueStudent { studentId: string; firstName: string; lastName: string;
  homeAcademyName: string; lastPaidMonth: string | null }`,
  `function listOverdueStudents(session: StaffSession): Promise<OverdueStudent[]>` — ADMIN/
  DIRECTOR only per spec §4.3 ("Payments overdue (director/admin only)"); scoped by
  `academyScopeWhere` exactly like Phase 4's `listPromotionQueue`.

- [ ] **Step 1: Write the failing integration test**

Create/extend an integration test covering: an `ACTIVE` student with no `PaymentPeriod` row for
the current month, past the cutoff day → appears in the list; one with a `PENDING` row past the
cutoff → appears; one `PAID`/`PROMO`/`EXEMPT` → does not appear; before the cutoff day, nobody
appears regardless of status (use an injectable "now"/"today" parameter the same way `perform-
check-in.ts` and `getAtBeltSummary`'s callers already do, so the test isn't fighting the real
wall clock); an `ARCHIVED`/`PENDING`-status **student** (not to be confused with `PaymentStatus`)
never appears regardless of payment state (mirrors Phase 4's promotion-queue `status: "ACTIVE"`
filter); DIRECTOR/INSTRUCTOR scoping matches the established pattern (a DIRECTOR never sees the
other academy's overdue students; **INSTRUCTOR gets rejected entirely** at the session-guard
level, since this whole feature is ADMIN/DIRECTOR-only per spec, unlike the promotion queue which
INSTRUCTOR could view read-only).

- [ ] **Step 2: Implement `listOverdueStudents`**

Scope active students the same way `promotion-queue.ts`'s `classifyActiveStudents` does
(`status: "ACTIVE"`, `academyScopeWhere`), then per student resolve the current month's
`PaymentPeriod` (or `null`) and apply `isOverdue` (Task 1). This function should itself enforce
the ADMIN/DIRECTOR-only gate (don't rely solely on the caller/UI to restrict it — check
`session.role` directly, matching how `confirmPromotion` gates itself rather than trusting the
button's visibility).

- [ ] **Step 3: Add the dashboard panel**

In `page.tsx`, call `listOverdueStudents` for ADMIN/DIRECTOR sessions only (skip the call entirely
for INSTRUCTOR — don't run a query whose result you'll then hide). Render a simple list: name,
academy (ADMIN view), last-paid month if known. No confirm/action button needed here — spec's
overdue panel is informational, the actual recording happens on the student detail page (Task 2).

- [ ] **Step 4: Add message keys, verify, commit**

Add `dashboard.overduePayments.*` keys to both locale files.

Run: `pnpm build` — succeeds.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add payments-overdue dashboard panel"
git push origin feat/phase-6-payments
```

---

### Task 4: Full-suite verification and PR prep

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

All must pass/succeed except the one PRE-EXISTING, known, unrelated `auth.config.ts` error this
plan's Global Constraints already called out — confirm via `git diff main -- src/auth.config.ts`
that this phase didn't touch that file, and note the error's presence in your final report rather
than treating it as a regression. No new migration is expected this phase (`PaymentPlan`/
`PaymentPeriod` both already exist from Phase 1) — if `pnpm db:migrate` reports a pending
migration, that's a signal something in this plan was implemented incorrectly as a schema change.

- [ ] **Step 2: Manual end-to-end walk**

Record a payment for a real seeded student as DIRECTOR → confirm the roster badge updates →
confirm the staff detail page's payment history shows the new row → confirm the student's own
portal reflects it → confirm a DIFFERENT unpaid student, past the cutoff day, appears in the
dashboard's overdue panel → confirm an INSTRUCTOR session cannot record a payment (button absent
AND the action itself rejects a direct call) but CAN still see payment status on the roster/
detail page (view-only, not hidden entirely) → confirm the overdue payment status never blocks a
check-in or self-check-in (spec's explicit "visible but never blocking" rule).

- [ ] **Step 3: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "test: full-suite verification for Phase 6"
git push origin feat/phase-6-payments
```

Phase 6 is complete once this task's full-suite verification passes. This plan's controller will
dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
