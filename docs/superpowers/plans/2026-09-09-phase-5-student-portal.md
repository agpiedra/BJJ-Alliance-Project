# Phase 5: Student Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a logged-in student their own authenticated view — belt progress, full attendance
history, promotion history, and a self check-in button that follows the exact same rules as the
kiosk — per spec §4.2.

**Architecture:** A student-facing analogue of the existing staff session guard
(`getStudentSession`/`requireStudentSession`, mirroring `getStaffSession`'s re-validate-against-
the-DB-on-every-call discipline), a new `/portal` route tree gated to `STUDENT` role only, and a
small, carefully-scoped extension to Phase 3's `performCheckIn` so an authenticated student can
check themselves in without re-typing the 4-digit code a kiosk visitor uses (they're already
identified by their session) — while every invariant that check-in function already enforces
(window, duplicate prevention, active-student-only) stays exactly as strict.

**Tech Stack:** Next.js 15 App Router, Prisma 7, Auth.js v5, Zod, Vitest, next-intl. No new
libraries.

**Spec:** `PROJECT_SPEC.md` (repo root) — §4.2 (student portal: login, belt graphic, progress bar,
lifetime total + full attendance history, payment status, promotion history, self check-in
button, "same rules and same check-in window as the kiosk"), §4.6 (signup already collects
email + password), §9 (Phase 5 scope: "Student portal — login, progress view, history, self
check-in"), §10 (no hard deletes; mobile-first — "students will use this on phones at the gym on
bad wifi").

## Global Constraints

- **Login and password reset already exist and already work for a `STUDENT`-role account.**
  Self-signup (`src/app/[locale]/signup/actions.ts`) already creates a `User` row with
  `role: Role.STUDENT` and a `passwordHash`, atomically linked to the new `Student` row via
  `Student.userId`. `/login`, `/forgot-password`, and `/reset-password` are already
  role-agnostic — nothing in any of those three files branches on `role`. **This phase does not
  build login or password reset** — it builds the portal those already-working credentials lead
  to, plus one real bug fix: `login`'s action (`src/app/[locale]/login/actions.ts`) currently
  redirects to a hardcoded `/${locale}/dashboard` when there's no `callbackUrl` — correct for
  staff, but a `STUDENT` landing there gets immediately bounced by `middleware.ts`'s existing
  staff-only gate on `/dashboard`. Task 1 fixes this to route by role.
- **Ruling: portal login itself is available to a `STUDENT` account regardless of their linked
  `Student.status`** (`PENDING` / `ACTIVE` / `INACTIVE` / `ARCHIVED`) — matching how a staff
  session's gate checks `User.active`, not some downstream business-status field. A `PENDING`
  student (awaiting staff approval) or an `ARCHIVED` one (who has left) can still log in and see
  an (empty or historical) portal; only two things need to actually stay gated on `ACTIVE`
  specifically: self check-in (already true — `performCheckIn` already refuses a non-`ACTIVE`
  student's code with `invalid_code`, and Task 3 extends this same check to the new studentId-based
  path rather than bypassing it) and confirmPromotion (already built, Phase 4). The portal itself
  should show a small, honest status indicator for a non-`ACTIVE` student rather than hiding the
  page — a blank/error page for a real, logged-in user is worse than a page that plainly says "your
  account is pending approval" or "this account is archived." Cost if wrong: a cosmetic UX gap for
  an edge case, not a security issue (every actual mutation stays gated on `ACTIVE`).
- **Ruling: "current payment status and which plan/promo they're on" (spec §4.2) is a Phase 6
  feature — this phase ships that section as a "coming in a later phase" placeholder**, matching
  the exact precedent already established on the staff student-detail page for
  attendance-history/payment-history before Phases 3/4 built them. Do not invent a payments UI
  ahead of Phase 6's actual data model.
- **Self check-in is a `"use server"` Server Action, not a REST route.** Unlike the kiosk
  (Phase 3), which deliberately used a REST route so a PWA's offline-queue replay would have a
  stable URL across deployments, the portal has no offline-queue requirement in this phase's scope
  — a student self-checking in needs a live connection to see their own updated progress anyway.
  A Server Action is simpler and matches this codebase's established convention for every other
  authenticated write.
- **Self check-in does NOT get the kiosk's rate-limiting/lockout machinery.** That machinery
  exists specifically to blunt PIN-guessing against an unauthenticated public device
  (`KioskAttempt`, `reserveKioskAttempt`/`finalizeKioskAttempt`). An authenticated student
  checking themselves in isn't guessing a PIN — there's no PIN in this path at all, only their own
  already-verified session identity. It DOES still get every one of `performCheckIn`'s existing
  invariants unchanged: the check-in window, the one-checkin-per-session-per-day DB constraint,
  and the active-student-only check.
- **`performCheckIn`'s extension must be behavior-neutral for the existing kiosk (code-based)
  path.** This codebase has a real history (Phase 3, Phase 4) of "extend/refactor a shared
  function" tasks accidentally changing behavior for existing callers. Task 3 must prove the
  kiosk's existing integration tests still pass completely UNMODIFIED after the extension — that
  is the acceptance bar, not "looks right."
- **No hard deletes; no new tables this phase.** Every model this phase reads (`Student`,
  `AttendanceRecord`, `ClassSession`, `Promotion`) already exists from earlier phases.
- **Feature-branch-only.** Push to `feat/phase-5-student-portal`, never `main`. One PR opens at
  the end for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys occasionally injected into
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this
  work — revert just those lines if `git status`/`git diff` shows them before committing.
- **`pnpm db:down && pnpm db:up` does NOT reset the local Postgres data** — this machine's
  docker-compose Postgres uses a persistent named volume. A genuine reset is
  `docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
  `pnpm exec prisma generate`, `pnpm db:seed`.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!.windsurf'
  ':!skills-lock.json'` (these three are untracked, pre-existing, not this project's files).

---

### Task 1: Student session guard + role-aware login redirect + route protection

**Files:**
- Modify: `src/lib/auth/session.ts`, `src/middleware.ts`, `src/app/[locale]/login/actions.ts`
- Test: `tests/integration/student-session.test.ts` (or add to an existing auth-adjacent
  integration test file if one better fits this codebase's actual layout — check first)

**Interfaces:**
- Produces:
  - `interface StudentSession { userId: string; studentId: string; status: StudentStatus }`
  - `function getStudentSession(): Promise<StudentSession | null>`
  - `function requireStudentSession(): Promise<StudentSession>` — redirects to `/login` if absent
    (mirrors `requireStaffSession`'s redirect-on-absence behavior exactly; there's no role-list
    parameter needed since there's only one student role).

- [ ] **Step 1: Write the failing integration test**

Cover: a real `STUDENT`-role session with a linked `ACTIVE` `Student` row resolves correctly
(`studentId`/`status` match); a `STUDENT` session whose linked `Student` row is `PENDING` /
`ARCHIVED` still resolves (per this plan's ruling — login isn't gated on status) with the correct
`status` value; a stale JWT claiming `STUDENT` for a `User` whose real DB role has changed, or
whose `active` is now `false`, resolves to `null` (same fail-closed discipline as
`getStaffSession`); a `STAFF`-role session (`ADMIN`/`DIRECTOR`/`INSTRUCTOR`) calling
`getStudentSession()` resolves to `null` (these are disjoint session types); `requireStudentSession()`
redirects when no session exists.

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm test:integration tests/integration/student-session.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `getStudentSession`/`requireStudentSession`**

Add to `src/lib/auth/session.ts`, following `getStaffSession`'s exact discipline: read the JWT via
`auth()`, check the claimed role is `"STUDENT"` (bail to `null` immediately if not — this function
is not for staff), then re-fetch `User` fresh (`select: { role: true, active: true }`) and fail
closed on a role mismatch or `active: false`, exactly like `getStaffSession` does. Once confirmed,
fetch the linked `Student` row (`prisma.student.findUnique({ where: { userId: session.user.id },
select: { id: true, status: true } })`) — if none exists (shouldn't happen given signup's atomic
transaction, but fail closed rather than throw), return `null`. Return
`{ userId, studentId: student.id, status: student.status }`.

`requireStudentSession()` mirrors `requireStaffSession()`'s shape minus the role-list parameter
(there's exactly one student role, so nothing to filter).

- [ ] **Step 4: Add `/portal` to the middleware's protected prefixes, gated to `STUDENT` only**

In `src/middleware.ts`: add `"/portal"` to `PROTECTED_PREFIXES`. The existing block only checks
"is this a staff role"; extend it so `/portal` specifically requires `role === "STUDENT"` while
`/dashboard`/`/students`/`/admin` continue requiring a staff role — a staff session hitting
`/portal` should also redirect to `/login` (or, your call, to their own `/dashboard` instead of
`/login` if you think that's a better staff UX for accidentally landing on the wrong route
tree — document whichever you choose). A `STUDENT` session hitting a staff-only prefix must
continue to redirect exactly as it does today (no regression here — read the current block fully
before changing it, this is real access-control code).

- [ ] **Step 5: Fix `login`'s default redirect to route by role**

In `src/app/[locale]/login/actions.ts`: after a successful `signIn`, the current code always
`redirect(safeCallbackUrl || `/${locale}/dashboard`)`. When there's no `callbackUrl`, this must
route a `STUDENT` to `/${locale}/portal` and everyone else to `/${locale}/dashboard`. You'll need
to know the just-signed-in user's role — `signIn("credentials", {..., redirect: false})` doesn't
directly hand you the role back; call `auth()` right after the successful `signIn` to read the
fresh session (or query `prisma.user.findUnique` by the submitted email — your call on which is
cleaner, but don't trust a client-submitted role, only what you just authenticated). Add a test
(or extend an existing login-action test if one exists) covering: a `STUDENT` login with no
`callbackUrl` lands on `/portal`; a staff login with no `callbackUrl` still lands on `/dashboard`
(no regression); an explicit `callbackUrl` still wins for both roles (unchanged from today).

- [ ] **Step 6: Run tests, verify, commit**

Run: `pnpm test:integration tests/integration/student-session.test.ts` and the login-action test
— all pass. Run: `pnpm build` — succeeds.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add student session guard, protect /portal, fix role-aware login redirect"
git push origin feat/phase-5-student-portal
```

---

### Task 2: Attendance-history query + the portal page shell

**Files:**
- Create: `src/lib/students/attendance-history.ts`, `src/app/[locale]/portal/page.tsx`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `requireStudentSession` (Task 1), `getAtBeltSummary` (Phase 3),
  `getPromotionHistory`-equivalent read pattern (Phase 4's `get-promotion-history.ts` — read it
  for the exact pattern, but that file is scoped under `students/[id]/`, a staff-only directory;
  write this task's own copy under a student-portal-appropriate location, since a `Promotion`
  query for "the current session's own student" has no staff-scope-check dependency the original
  didn't already lack either way, but keep the code physically separate from the staff route
  tree — your call on the exact path, document it), `BeltGraphic` (Phase 1).
- Produces:
  - `interface AttendanceHistoryEntry { id: string; date: Date; type: "CHECKIN" | "ADJUSTMENT";
    delta: number; className: string | null; reason: string | null }`
  - `function getAttendanceHistory(studentId: string, limit?: number): Promise<AttendanceHistoryEntry[]>`
    — ordered most-recent-first by `occurredAt`. `className` comes from the joined
    `ClassSession.name` when `classSessionId` is set, `null` for a manual adjustment (no
    class attached). Default `limit` to something reasonable for a mobile page (e.g. 50) — spec
    doesn't demand pagination in this phase, just don't unconditionally load an unbounded lifetime
    history onto one page for a long-tenured student.

- [ ] **Step 1: Implement `getAttendanceHistory`**

`prisma.attendanceRecord.findMany({ where: { studentId }, orderBy: { occurredAt: "desc" }, take:
limit ?? 50, include: { classSession: { select: { name: true } } } })`, mapped into the shape
above.

- [ ] **Step 2: Write the portal page**

`src/app/[locale]/portal/page.tsx`: `const session = await requireStudentSession();`. Fetch, in
parallel: `getAtBeltSummary(session.studentId)`, `getAttendanceHistory(session.studentId)`, this
task's promotion-history read, and the `Student` row's own `firstName`/`currentBelt`/
`currentStripes`/`status` for display (a lightweight `findUniqueOrThrow` by `session.studentId` —
this call is safe with no additional scope check, since `session.studentId` came from the
session guard itself, not a route param).

Render, mobile-first (spec §10: "students will use this on phones"):
- `BeltGraphic` with the student's current belt/stripes.
- A progress indicator using `summary.atBeltCount`/`summary.nextStripeAt`/
  `summary.remainingToNextStripe`/`summary.examEligible` (reuse the exact same figures the kiosk
  and staff student-detail page already show — don't invent new math).
- `summary.lifetimeCount`.
- The attendance history list (date in the academy's timezone — reuse
  `formatTimestampInAcademyZone`-equivalent logic; check whether that helper is exported anywhere
  shareable or is currently a private function inside the staff student-detail page — if private,
  either export it from a shared location or duplicate the small helper here, your call, document
  it either way).
- The promotion history list (same rendering shape as Phase 4's staff-facing one, adapted for a
  self-view — you don't need "awarded by" to be hidden, spec doesn't say to hide it, but you may
  omit it if you think it's not meaningful to a student viewing their own history — your call).
- A payment-status card showing a "coming in a later phase" placeholder (per this plan's Global
  Constraints ruling).
- If `session.status !== "ACTIVE"`, show a small, honest status notice (`"pending approval"` /
  `"archived"` — new message keys) rather than hiding any of the above.

- [ ] **Step 3: Add message keys**

Add a new `portal.*` top-level namespace to both `messages/en.json` and `messages/es.json`
covering every label/heading introduced above.

- [ ] **Step 4: Verify and commit**

Run: `pnpm build` — succeeds. Manually verify (via a throwaway seeded student + real login, or a
direct script confirming the query outputs match what the page would render) that a student with
real attendance/promotion history sees correct data.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add student portal page (progress, history, promotions)"
git push origin feat/phase-5-student-portal
```

---

### Task 3: Self check-in

**Files:**
- Modify: `src/lib/kiosk/perform-check-in.ts`
- Create: `src/app/[locale]/portal/self-check-in-action.ts`, `src/app/[locale]/portal/self-check-in-button.tsx`
- Modify: `messages/es.json`, `messages/en.json`
- Test: extend `tests/integration/perform-check-in.test.ts`; new
  `tests/integration/self-check-in-action.test.ts`

**Interfaces:**
- Consumes: `performCheckIn` (Phase 3, extended here), `requireStudentSession` (Task 1).
- Produces: `performCheckIn`'s input type widens to accept EITHER `code: string` OR
  `studentId: string` (a discriminated union or an optional-pair — your call on the exact TS
  shape, but the function must reject a call providing neither or both, and every existing kiosk
  call site keeps working unmodified by continuing to pass `code`).
  `selfCheckIn(_prevState: ActionState, formData: FormData): Promise<ActionState>` — `"use server"`.

- [ ] **Step 1: Write the failing test for `performCheckIn`'s new studentId path**

Read `src/lib/kiosk/perform-check-in.ts` in full first — this is the exact function whose
byte-for-byte behavior-equivalence for the EXISTING `code` path is this task's hard requirement.

Extend `tests/integration/perform-check-in.test.ts` with new cases for the `studentId` path,
mirroring the EXISTING code-path cases one-for-one (do not remove or weaken any existing case):
a valid `ACTIVE` student's `studentId`, in-window → `ok: true`; the same student checking in
again immediately → `already_checked_in`; a `PENDING`/`ARCHIVED` student's `studentId` →
`invalid_code` (same generic error the code path uses for these — don't invent a different error
taxonomy for the studentId path, since the caller-facing contract should stay uniform); a `now`
outside every window → `no_active_class`; a cross-academy (visitor) check-in via `studentId` →
`ok: true, isVisitor: true`; a nonexistent `studentId` → `invalid_code` (this should be
effectively unreachable in practice since only `requireStudentSession` ever supplies this value,
but the function itself must still handle it gracefully, not throw).

- [ ] **Step 2: Run to confirm the new cases fail**

Run: `pnpm test:integration tests/integration/perform-check-in.test.ts`
Expected: the new studentId-path cases FAIL (feature doesn't exist yet); all EXISTING code-path
cases still PASS unmodified (confirm this explicitly — it's your baseline).

- [ ] **Step 3: Extend `performCheckIn`**

The function currently starts by resolving `student` via
`prisma.student.findUnique({ where: { codeHash: digestLookupSecret(input.code, ...) } })`. Change
this resolution step to branch: if `input.code` is provided, resolve exactly as today (byte-
identical logic — do not touch this branch's internals beyond wrapping it in the conditional);
if `input.studentId` is provided instead, resolve via `prisma.student.findUnique({ where: { id:
input.studentId } })`. Everything AFTER student resolution (the `status !== ACTIVE` check, the
window check, the ledger write, the `already_checked_in`/`no_active_class` handling, the
`earnedStripe`/`isVisitor`/`homeAcademyName` computation) must be COMPLETELY UNCHANGED — this is
the shared core that must not diverge between the two entry paths. Update the `CheckInResult`/
input TypeScript types accordingly.

- [ ] **Step 4: Run to confirm all cases pass**

Run: `pnpm test:integration tests/integration/perform-check-in.test.ts`
Expected: PASS — every existing case AND every new case.

- [ ] **Step 5: Write `selfCheckIn` and the button**

`src/app/[locale]/portal/self-check-in-action.ts`: `"use server"`.
`const session = await requireStudentSession();`. Determine the student's `homeAcademyId` (a
lightweight, no-scope-check `findUnique` by `session.studentId` — this is a student acting on
their own row, not a staff member acting on someone else's, so none of the staff
"scope by id AND owner" ceremony applies; the session itself already IS the ownership proof).
Call `performCheckIn({ academyId: student.homeAcademyId, studentId: session.studentId, source:
AttendanceSource.PORTAL })`. Return the result mapped into a plain `ActionState`-compatible shape
(`{ok:true, ...result fields the UI needs}` or `{error: result.error}`).

`src/app/[locale]/portal/self-check-in-button.tsx` (`"use client"`): `useActionState` following
this codebase's established pattern (see Phase 2/3's button components), showing a clear success
state (belt/stripes/earnedStripe congratulation, matching the kiosk's own success display
conventions where reasonable for a portal context) or the relevant error message
(`no_active_class`/`already_checked_in`/`invalid_code` — the last one is realistically
unreachable here but handle it gracefully rather than assuming it can't happen).

Add message keys under `portal.selfCheckIn.*` to both locale files.

- [ ] **Step 6: Write the action-level integration test**

`tests/integration/self-check-in-action.test.ts`: a real `ACTIVE` student session self-checking
in during a real window → success, `AttendanceRecord.source === "PORTAL"`; the same student
self-checking in again immediately → `already_checked_in`; outside any window →
`no_active_class`.

- [ ] **Step 7: Verify, manual walk, commit**

Run: `pnpm test`, `pnpm build`, `pnpm lint`, `npx tsc --noEmit` — all pass/succeed.

Manually verify with `pnpm dev` to the extent tooling allows (no browser-automation tool has been
reliably available in this session — use direct `fetch`/`curl`/a script against a running dev
server plus direct DB checks if a browser tool isn't available, and clearly report what you
could/couldn't verify): log in as a real student during a real (or temporarily-adjusted-and-
restored) class window, self-check-in, confirm the resulting `AttendanceRecord` and the portal
page's updated progress figures.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add self check-in from the student portal"
git push origin feat/phase-5-student-portal
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

All must pass/succeed. No new migration is expected this phase (every model already exists) — if
`pnpm db:migrate` reports a pending migration, that's a signal something in this plan was
implemented incorrectly as a schema change when it shouldn't have been.

- [ ] **Step 2: Manual end-to-end walk**

Sign up a new student (or reuse one from earlier manual testing) → log in → land on `/portal` (not
`/dashboard`) → confirm belt/progress/history/promotion sections render correctly → self-check-in
during a real class window → confirm the portal reflects the new attendance immediately → confirm
a staff session hitting `/portal` and a student session hitting `/dashboard` both correctly
redirect away.

- [ ] **Step 3: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "test: full-suite verification for Phase 5"
git push origin feat/phase-5-student-portal
```

Phase 5 is complete once this task's full-suite verification passes. This plan's controller will
dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
