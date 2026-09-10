# Phase 8: Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the notification layer per spec §7 — an in-app bell with unread counts, plus
email (via Resend) for four triggers: a student reaching a stripe threshold, a student reaching
exam threshold, a new signup awaiting approval, and a weekly digest — all behind a
`NotificationChannel` interface so a WhatsApp channel could be added later without touching
business logic. WhatsApp itself (spec's separate Phase 9, §7b) is explicitly out of scope for
this phase and will not be built.

**Architecture:** One shared notification core (`src/lib/notifications/`) — recipient resolution
(ADMIN always, DIRECTOR/INSTRUCTOR scoped to the relevant academy), message rendering (one
render function per event type, reused as both the in-app row's content and the email body), and
a channel-dispatch loop that treats every channel as best-effort (a failed email must never break
the check-in/signup flow that triggered it). Two channels: `InAppChannel` (writes a `Notification`
row) and `EmailChannel` (sends via Resend). Three of the four triggers fire through BOTH channels;
the weekly digest is email-only (a summary has no single "read/unread" action, matching spec's own
in-app-vs-email split). The two eligibility triggers (stripe/exam) hook into `performCheckIn`'s
already-computed `earnedStripe`/`summaryAfter.examEligible` fields as a purely additive,
best-effort side effect — no change to its matching/resolution logic or returned shape.

**Tech Stack:** Next.js 15 App Router, Prisma 7 (one new model + one new enum — this phase, unlike
Phase 7, does need a real migration), Resend (new dependency, free tier / sandbox mode — real
domain verification is the user's own follow-up, not this phase's blocker), Vercel Cron
(`vercel.json`) for the weekly digest's schedule, Vitest, next-intl.

**Spec:** `PROJECT_SPEC.md` (repo root) — §3 (roles: ADMIN sees both academies and gets every
notification; DIRECTOR/INSTRUCTOR are academy-scoped), §7 (Notifications — read in full, this is
the only section with real detail for this phase), §9 (Phase 8 scope — note that "reports," "CSV
export," and "GymDesk import," also named in §9's Phase 8 bullet, are explicitly OUT of scope per
the user's own decision: Phase 7's per-panel CSV exports already satisfy "reports"/"CSV export,"
and GymDesk import is deferred until a real export file exists), §10 (mobile-first; audit money/
belt mutations — not directly applicable since this phase writes no money/belt data, but the
"never rely on hiding UI elements" server-side-enforcement ethos from §3 applies to every
recipient-resolution function here).

## Global Constraints

- **New `Notification` model and `NotificationType` enum — this phase DOES need a real Prisma
  migration**, unlike Phase 7. Run `pnpm exec prisma migrate dev` and commit the generated
  migration folder.
- **`Notification` schema:**
  ```prisma
  enum NotificationType {
    STRIPE_THRESHOLD
    EXAM_THRESHOLD
    NEW_SIGNUP
    WEEKLY_DIGEST
  }

  model Notification {
    id        String           @id @default(cuid())
    userId    String
    type      NotificationType
    title     String
    body      String
    readAt    DateTime?
    createdAt DateTime         @default(now())

    user User @relation(fields: [userId], references: [id])

    @@index([userId, readAt])
  }
  ```
  Add the reciprocal `notifications Notification[]` relation field to `User`. No `academyId`
  column on `Notification` — recipient resolution already filters by academy at send time (see
  below), so every row that exists for a given `userId` is already correctly scoped; a second
  scoping column would be redundant, unenforced-if-wrong denormalization.
- **Ruling: recipients for all four trigger types = every active ADMIN, plus every active
  DIRECTOR/INSTRUCTOR with a `StaffAssignment` to the relevant academy.** Spec's literal wording
  ("email to director and instructors") doesn't mention ADMIN, but every other ADMIN/DIRECTOR-
  gated feature in this app (promotion queue, overdue payments, director analytics) includes
  ADMIN by default — excluding them here would be the one inconsistent case with no stated reason.
  For a global event (new signup, stripe/exam threshold), "the relevant academy" is the student's
  `homeAcademyId`. For the weekly digest, send one digest per academy to that academy's
  DIRECTOR/INSTRUCTORs, plus ADMIN gets both academies' digests (two separate emails, not one
  combined one — matches this app's existing "administer combined view, but nothing forces a
  single-email format" precedent, and keeps each digest's content scoped/testable the same way
  regardless of recipient role).
- **Ruling: the weekly digest is EMAIL-ONLY, the other three triggers use BOTH channels
  (in-app + email).** Spec's §7 lists "Weekly digest" only under the email bullet list; a
  summary-style message has no natural single "action" the in-app bell's read/unread model fits,
  unlike an individual student crossing a threshold or a specific signup awaiting approval.
- **Ruling: opening the notification bell's dropdown marks every currently-listed notification as
  read.** No per-item read/unread toggle UI. This is the simplest correct behavior matching a
  "clear the badge by looking at it" convention common to bell-icon UIs, and avoids inventing a
  second interaction model spec never asked for.
- **Ruling: no live polling.** The bell's unread count is computed at render time (a Server
  Component read), refreshed on navigation/reload, matching this entire app's existing
  server-rendered-only architecture (nothing else in this app polls or uses websockets). A future
  phase can add polling if the director actually wants it; nothing here should be built to
  anticipate that.
- **Ruling: the two eligibility notifications (stripe/exam) hook into `performCheckIn`
  (`src/lib/kiosk/perform-check-in.ts`) as an ADDITIVE, best-effort side effect, never touching its
  existing matching/resolution logic.** That function already computes exactly the signal needed:
  `earnedStripe` (already returned) is true exactly when this check-in crossed either the
  next-stripe threshold OR the exam threshold; `summaryAfter.examEligible` (already computed,
  already in `AtBeltSummary`) distinguishes which one. Wrap the notification call in its own
  try/catch inside `performCheckIn`, called only when `earnedStripe` is true, and NEVER let a
  notification failure change `performCheckIn`'s returned `CheckInResult` or throw past this
  function — a lost notification is not worth a broken check-in, matching this app's existing
  `revalidatePath`-in-try/catch precedent (`self-check-in-action.ts`).
- **Ruling: new-signup notification fires from `src/app/[locale]/signup/actions.ts`** (which
  already has a stale `// dedicated Notification table yet (YAGNI...)` comment marking exactly
  this deferral — remove that comment as part of this phase, it is no longer true), fired after
  the student row is successfully created, scoped to the student's `homeAcademyId`.
- **Ruling: the weekly digest fires via Vercel Cron hitting a protected API route, not an
  in-app trigger.** Add `vercel.json` at the repo root:
  ```json
  {
    "crons": [{ "path": "/api/cron/weekly-digest", "schedule": "0 13 * * 1" }]
  }
  ```
  `13:00 UTC every Monday` = `07:00 America/Costa_Rica` (fixed UTC-6, no DST — this app's
  established timezone convention). The route at `src/app/api/cron/weekly-digest/route.ts` checks
  `request.headers.get("authorization") === \`Bearer ${requireEnv("CRON_SECRET")}\`` and returns
  401 if it doesn't match — this is the same shared-secret pattern Vercel's own cron docs recommend
  (Vercel automatically sends this header when `CRON_SECRET` is set in the project's environment
  variables; locally/in tests, invoke the route's exported handler function directly, never over
  HTTP, to test its logic without needing a real secret round-trip).
- **New environment variables** (add to whatever this project's local `.env`-loading convention
  is — check `src/lib/env.ts`'s existing `requireEnv` pattern and any `.env.example` file):
  `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `"Alliance BJJ <notifications@resend.dev>"` — a real
  verified sending domain is the user's own follow-up; Resend's sandbox mode only delivers to the
  Resend account's own verified email until then, which is expected and not a bug to work around),
  `CRON_SECRET` (any random string; document in the report how the user sets this in Vercel's
  project settings once deployed).
- **`resend` is a new dependency** — `pnpm add resend`.
- **Access, self-enforced**: the notification bell and its dismiss/mark-read action must verify
  `requireStaffSession()` (any staff role — a notification's `userId` already IS the recipient
  check; there's no additional role gate needed beyond "this is your own inbox," but never trust a
  client-submitted `userId` for which notifications to mark read — always scope the mutation to
  `session.userId` server-side).
- **Feature-branch-only.** Push to `feat/phase-8-notifications`, never `main`. One PR opens at the
  end for the user to merge themselves.
- **The pnpm environment anomaly** (stray `"0"`/`"true"` keys occasionally injected into
  `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` on this machine) is unrelated to this
  work — revert just those lines if `git status`/`git diff` shows them before committing.
- **`pnpm db:down && pnpm db:up` does NOT reset the local Postgres data** — this machine's
  docker-compose Postgres uses a persistent named volume. A genuine reset is
  `docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
  `pnpm exec prisma generate`, `pnpm db:seed`.
- **A previously-documented pre-existing TypeScript error in `src/auth.config.ts` is CONFIRMED NO
  LONGER PRESENT** (independently re-verified twice during Phase 7 via a fresh `npx tsc --noEmit`
  run — zero errors). Do not assume it still exists; if `tsc --noEmit` reports anything, treat it
  as a real, current issue to investigate, not a known pre-existing one to wave off.
- **One known, pre-existing, unrelated test-infrastructure issue**: `tests/integration/seed.test.ts`
  asserts a global academy count over shared mutable state that can race against other integration
  test files' fixtures under default vitest parallelism — a documented flake since Phase 6, not
  this phase's to fix. If hit, use `npx vitest run tests/integration --no-file-parallelism` for
  your own verification and note it rather than treating it as a regression.
- **A separate, newly-documented test-infrastructure gap** (found during Phase 7's manual QA,
  ruled out of scope there): running the integration suite against the local dev database can
  leave behind live test-fixture rows (extra academies/students) if a test file's cleanup doesn't
  fully run. If you do a manual browser walk for this phase, re-seed fresh
  (`docker compose down -v && up -d && migrate && generate && seed`) AFTER running the test suite
  and BEFORE the manual walk, not before-then-both — this is a workflow note for you, not
  something to fix in this phase's application code.
- **Targeted git-add pathspec** for every commit: `git add -A -- ':!.agents' ':!skills-lock.json'`
  (untracked, pre-existing, not this project's files).

---

### Task 1: Notification data model, core types, in-app channel, dashboard bell

**Files:**
- Modify: `prisma/schema.prisma` (add `Notification` model, `NotificationType` enum, `User`'s
  reciprocal relation field)
- Create: `src/lib/notifications/types.ts`, `src/lib/notifications/recipients.ts`,
  `src/lib/notifications/dispatch.ts`, `src/lib/notifications/in-app-channel.ts`,
  `src/lib/notifications/templates.ts`,
  `src/app/[locale]/dashboard/notification-bell.tsx`,
  `src/app/[locale]/dashboard/notification-actions.ts`,
  `tests/unit/notification-templates.test.ts`,
  `tests/integration/notification-recipients.test.ts`,
  `tests/integration/notification-dispatch.test.ts`
- Modify: `src/app/[locale]/dashboard/page.tsx` (render the bell in the existing header area),
  `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces:
  - `interface Recipient { userId: string; email: string; locale: string }`
  - `interface RenderedMessage { type: NotificationType; title: string; body: string }`
  - `interface DeliveryResult { success: boolean; error?: string }`
  - `interface NotificationChannel { send(to: Recipient, message: RenderedMessage):
    Promise<DeliveryResult>; supportsInboundReplies: boolean }`
  - `function resolveStaffRecipients(academyId: string): Promise<Recipient[]>` — every active
    ADMIN, plus every active DIRECTOR/INSTRUCTOR with a `StaffAssignment` to `academyId`.
    Deduplicated by `userId` (an ADMIN is never also a DIRECTOR, but be defensive: a `Map` keyed
    by `userId` is simpler than reasoning about whether duplicates are possible).
  - `function renderNotificationMessage(type: NotificationType, data: Record<string, unknown>,
    locale: string): RenderedMessage` — one `switch` covering all 4 `NotificationType` values;
    each case pulls the specific fields it needs out of `data` (document each type's expected
    `data` shape in a comment above its case, since this is the one place stringly-typed data
    enters the system — a future task adding a 5th type will need this contract legible).
  - `class InAppChannel implements NotificationChannel` — `send` creates a `Notification` row
    (`readAt: null`); `supportsInboundReplies = false`.
  - `function dispatchNotification(recipients: Recipient[], message: RenderedMessage,
    channels: NotificationChannel[]): Promise<void>` — for every recipient × every channel, calls
    `channel.send(recipient, message)`, catching and logging (not throwing) any individual
    failure, so one bad recipient/channel never blocks the rest. Returns once all attempts have
    settled (`Promise.allSettled`, not `Promise.all`).
- Consumes: `requireStaffSession` (`src/lib/auth/session.ts`), `StaffAssignment`/`Academy`/`User`
  models.

- [ ] **Step 1: Add the schema, migrate**

Add the `Notification` model and `NotificationType` enum exactly as specified in Global
Constraints, plus `User.notifications Notification[]`.

```bash
pnpm exec prisma migrate dev --name add_notifications
pnpm exec prisma generate
```

Run: `pnpm exec prisma migrate status` — confirms the new migration applied cleanly.

- [ ] **Step 2: Write the failing unit tests for `renderNotificationMessage`**

Cover all 4 types with representative `data` payloads (a student's name/belt for
stripe/exam-threshold; a student's name for new-signup; an academy name + digest counts for
weekly-digest), in both `"es"` and `"en"` locales — assert the title/body strings are non-empty,
locale-appropriate (spot-check a literal Spanish vs English word choice per type), and that the
returned `type` field echoes the input type unchanged.

- [ ] **Step 3: Run to confirm failure, then implement `renderNotificationMessage` +
  `types.ts`**

Add real, human-readable `messages/es.json`/`messages/en.json` keys under a new
`notifications.*` namespace for every piece of copy (do not hardcode strings in
`templates.ts` — read them via `next-intl`'s `createTranslator({ locale, messages, namespace:
"notifications" })`, the exact corrected pattern Phase 7's `class-popularity.ts` established
after its own hand-rolled-JSON-read mistake — never read the message JSON files by hand).

Run: `pnpm test:unit tests/unit/notification-templates.test.ts` — PASS.

- [ ] **Step 4: Write the failing integration test for `resolveStaffRecipients`**

Cover: an ADMIN is included regardless of academy; a DIRECTOR/INSTRUCTOR assigned to the target
academy is included; a DIRECTOR/INSTRUCTOR assigned to the OTHER academy only is excluded; an
inactive (`active: false`) user of any role is excluded; no duplicate `Recipient` for the same
`userId` even if (hypothetically) multiple `StaffAssignment` rows exist for them at that academy.

- [ ] **Step 5: Run to confirm failure, then implement `resolveStaffRecipients`**

Run: `pnpm test:integration tests/integration/notification-recipients.test.ts` — PASS.

- [ ] **Step 6: Write the failing integration test for `InAppChannel` + `dispatchNotification`**

Cover: `InAppChannel.send` creates a real `Notification` row with `readAt: null`, the right
`userId`/`type`/`title`/`body`; `dispatchNotification` calls every channel for every recipient;
one channel throwing for one recipient doesn't prevent other recipients/channels from being
attempted (use a deliberately-throwing fake second channel in the test to prove this).

- [ ] **Step 7: Run to confirm failure, then implement `InAppChannel` + `dispatchNotification`**

Run: `pnpm test:integration tests/integration/notification-dispatch.test.ts` — PASS.

- [ ] **Step 8: Build the bell UI**

`notification-actions.ts`: `getMyNotifications(): Promise<Notification[]>` (calls
`requireStaffSession()`, queries `Notification.findMany({ where: { userId: session.userId },
orderBy: { createdAt: "desc" }, take: 20 })`), `getUnreadCount(): Promise<number>` (same scoping,
`count({ where: { userId: session.userId, readAt: null } })`), `markAllRead(): Promise<void>`
(scoped `updateMany({ where: { userId: session.userId, readAt: null }, data: { readAt: new
Date() } })` — never accept a client-submitted `userId`).

`notification-bell.tsx`: a small client component — a bell icon button showing the unread count
as a badge (fetched via a server action call or passed down as an initial prop from the
server-rendered dashboard page, your call on the exact data-fetching wire-up, but the INITIAL
render must come from the server, not a client-side fetch-on-mount, to avoid a layout flash),
opening a dropdown listing the notifications and calling `markAllRead()` on open (this plan's
ruling above). Wire into `dashboard/page.tsx`'s existing header area (there is no shared
dashboard layout file — every dashboard page renders its own header; place the bell next to
the existing "Bienvenido, {email}" line or nav links, whichever reads better in context).

- [ ] **Step 9: Add message keys, verify, commit**

Run: `pnpm build` — succeeds. `pnpm test` — all pass.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add notification data model, core dispatch, in-app bell"
git push origin feat/phase-8-notifications
```

---

### Task 2: Email channel (Resend)

**Files:**
- Create: `src/lib/notifications/email-channel.ts`, `tests/unit/email-channel.test.ts`
- Modify: `.env.example` (if one exists — add `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET` with
  placeholder values and a comment explaining sandbox-mode delivery limits), `package.json`
  (add `resend`)

**Interfaces:**
- Consumes: `NotificationChannel`, `Recipient`, `RenderedMessage`, `DeliveryResult` (Task 1).
- Produces: `class EmailChannel implements NotificationChannel` — `send` calls Resend's
  `emails.send({ from: requireEnv("EMAIL_FROM"), to: recipient.email, subject: message.title,
  html: <a minimal wrapper around message.body, e.g. wrapping newlines in <p> tags> })`, returns
  `{ success: true }` on Resend's success response or `{ success: false, error: <message> }` on
  any thrown error or Resend-reported failure (never let this throw — `dispatchNotification`
  already catches, but `EmailChannel.send` itself should be the one place that translates a raw
  Resend/network exception into the `DeliveryResult` contract, not push that concern onto every
  caller). `supportsInboundReplies = false`.

- [ ] **Step 1: Add `resend`**

```bash
pnpm add resend
```

- [ ] **Step 2: Write the failing unit test for `EmailChannel`**

Mock Resend's client (do not make real network calls in tests — inject the Resend client instance
via the constructor, e.g. `new EmailChannel(resendClient)`, so a test can pass a fake with a
`emails.send` stub). Cover: a successful send returns `{ success: true }`; a thrown error (network
failure, invalid API key) is caught and returns `{ success: false, error: <the message> }` rather
than propagating; the `html` body correctly reflects `message.body`'s content (a simple
paragraph-wrap is fine — don't build a templating engine for this).

- [ ] **Step 3: Run to confirm failure, then implement `EmailChannel`**

Run: `pnpm test:unit tests/unit/email-channel.test.ts` — PASS.

- [ ] **Step 4: Wire `EmailChannel` into the two-channel triggers**

This step is mostly plumbing for Task 3/4 to consume — at minimum, export a small
`ALL_CHANNELS: NotificationChannel[] = [new InAppChannel(), new EmailChannel(new Resend(...))]`
constant (or an equivalent factory function if constructing a real `Resend` client at module load
time is awkward for testing — your call, document it) from a sensible shared location (e.g.
`src/lib/notifications/dispatch.ts` or a new `src/lib/notifications/channels.ts`) so Task 3/4
don't each reconstruct the channel list independently.

- [ ] **Step 5: Add env vars, verify, commit**

Run: `pnpm build`, `pnpm test` — all pass/succeed. Confirm `RESEND_API_KEY`/`EMAIL_FROM` are read
via `requireEnv` (matching this app's established pattern, e.g. `CODE_PEPPER`'s usage) — not a
bare `process.env.X` access.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add email notification channel via Resend"
git push origin feat/phase-8-notifications
```

---

### Task 3: Wire the three event-triggered notifications

**Files:**
- Create: `src/lib/notifications/notify-eligibility.ts`, `src/lib/notifications/notify-new-signup.ts`,
  `tests/integration/notify-eligibility.test.ts`, `tests/integration/notify-new-signup.test.ts`
- Modify: `src/lib/kiosk/perform-check-in.ts`, `src/app/[locale]/signup/actions.ts`,
  `messages/es.json`, `messages/en.json` (if any new copy fields are needed beyond Task 1's
  templates — check first, most copy should already exist from Task 1)

**Interfaces:**
- Consumes: `resolveStaffRecipients`, `renderNotificationMessage`, `dispatchNotification`,
  `ALL_CHANNELS` (Tasks 1-2); `AtBeltSummary` (`src/lib/students/attendance-summary.ts`,
  Phase 3/4 — already has `examEligible: boolean`, no changes needed to that file).
- Produces: `function notifyEligibilityReached(studentId: string, type: "STRIPE_THRESHOLD" |
  "EXAM_THRESHOLD"): Promise<void>` — loads the student's name/belt/homeAcademyId, resolves
  recipients for that academy, renders the message, dispatches to both channels. Best-effort:
  catches its own errors internally and never throws (this is what makes it safe to call from
  inside `performCheckIn`).
  `function notifyNewSignup(studentId: string): Promise<void>` — same shape, `NEW_SIGNUP` type.

- [ ] **Step 1: Write the failing integration test for `notifyEligibilityReached`**

Cover: calling it with `STRIPE_THRESHOLD` creates the right in-app `Notification` rows for the
right recipients (ADMIN + the student's academy's DIRECTOR/INSTRUCTOR, not the other academy's)
and (via a fake/injected email channel, matching Task 2's test-injection pattern) attempts an
email send for each; `EXAM_THRESHOLD` likewise with different copy; the function never throws even
if given a `studentId` that doesn't exist (a defensive case worth covering explicitly, since this
will eventually be called from inside a best-effort hook).

- [ ] **Step 2: Run to confirm failure, then implement `notifyEligibilityReached`**

Run: `pnpm test:integration tests/integration/notify-eligibility.test.ts` — PASS.

- [ ] **Step 3: Wire `performCheckIn`'s best-effort hook**

In `src/lib/kiosk/perform-check-in.ts`, immediately before the final `return` statement (after
`earnedStripe` is computed), add:

```ts
if (earnedStripe) {
  const type = summaryAfter.examEligible ? "EXAM_THRESHOLD" : "STRIPE_THRESHOLD";
  notifyEligibilityReached(student.id, type).catch((error) => {
    console.error("notifyEligibilityReached failed (non-fatal)", error);
  });
}
```

**Do not `await` this call** — fire-and-forget with its own `.catch`, so a slow or failing
notification never adds latency to (or breaks) the check-in response the kiosk/portal is waiting
on. Confirm via the existing kiosk/portal integration tests (Phase 3/5's, already in the suite)
that `performCheckIn`'s returned `CheckInResult` is completely unaffected — run those specific
files, not just the new ones, to prove no regression:

```bash
pnpm test:integration tests/integration/perform-check-in.test.ts
pnpm test:integration tests/integration/self-check-in-action.test.ts
```

(Adjust the exact file names to whatever this app's real Phase 3/5 test files are called — check
`tests/integration/` first.)

- [ ] **Step 4: Write the failing integration test for `notifyNewSignup`**

Cover: creates the right in-app rows for the right academy's recipients; doesn't throw on a
missing/invalid `studentId`.

- [ ] **Step 5: Run to confirm failure, then implement `notifyNewSignup`**

Run: `pnpm test:integration tests/integration/notify-new-signup.test.ts` — PASS.

- [ ] **Step 6: Wire the signup action's hook**

In `src/app/[locale]/signup/actions.ts`, after the student row is successfully created, call
`notifyNewSignup(student.id).catch((error) => console.error(...))` — same fire-and-forget,
non-blocking pattern as Step 3. Remove the stale `// dedicated Notification table yet (YAGNI...)`
comment this plan's Global Constraints flagged — it now names a feature this task just built.

- [ ] **Step 7: Verify, commit**

Run: `pnpm test`, `pnpm build` — all pass/succeed.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: wire stripe/exam-threshold and new-signup notifications"
git push origin feat/phase-8-notifications
```

---

### Task 4: Weekly digest

**Files:**
- Create: `src/lib/notifications/weekly-digest.ts`, `src/app/api/cron/weekly-digest/route.ts`,
  `vercel.json`, `tests/integration/weekly-digest.test.ts`
- Modify: `messages/es.json`, `messages/en.json`, `.env.example` (add `CRON_SECRET` if Task 2
  didn't already)

**Interfaces:**
- Consumes: `resolveStaffRecipients`, `renderNotificationMessage` (with `WEEKLY_DIGEST` type,
  Task 1), `EmailChannel`/`ALL_CHANNELS`-adjacent (Task 2 — but recall this trigger is EMAIL-ONLY
  per this plan's ruling, so use `new EmailChannel(...)` directly, not the full `ALL_CHANNELS`
  list); `listOverdueStudents`-adjacent logic (`src/lib/payments/list-overdue.ts`, Phase 6) and
  the retention/attendance-summary logic Phase 7 already built
  (`src/lib/analytics/retention.ts`'s `classifyRetentionBucket`-adjacent "inactive student"
  concept, and `src/lib/analytics/headline-tiles.ts`'s attendance-count logic) — reuse these
  rather than re-deriving "who's overdue" or "who's inactive" a third time; `requireEnv`
  (`src/lib/env.ts`).
- Produces: `function sendWeeklyDigestForAcademy(academyId: string): Promise<void>` — computes:
  attendance count for the last 7 real days (reuse Phase 7's date-range-based attendance query
  pattern with a fixed 7-day window, not the analytics page's user-selectable range), a list of
  students inactive 30+ days (reuse Phase 7's retention classification's underlying "days since
  last attendance" computation — do not reimplement the bucket math, just the "who qualifies"
  query, since the digest needs the QUERY not the analytics UI's presentation), and overdue
  payment count (reuse `listOverdueStudents` from Phase 6). Renders one `WEEKLY_DIGEST` message
  per academy and sends it via `EmailChannel` only, to that academy's resolved recipients (which,
  per this plan's ruling, includes ADMIN on every academy's digest — so ADMIN gets 2 emails if
  there are 2 academies, not 1 combined one).

- [ ] **Step 1: Write the failing integration test for `sendWeeklyDigestForAcademy`**

Cover: correct attendance count for the trailing 7 days (seed attendance both inside and outside
that window, assert only the in-window ones count); correct inactive-student list (30+ days,
reusing whatever exact threshold/query Phase 7's retention logic uses — don't invent a new number);
correct overdue count (reusing Phase 6's existing `isOverdue`/`listOverdueStudents`); only the
EMAIL channel is invoked (assert via an injected fake channel set that no in-app `Notification` row
is created for `WEEKLY_DIGEST` — this is the one place this plan's "email-only" ruling has a
concrete, testable consequence); recipients scoped correctly to the one academy plus ADMIN.

- [ ] **Step 2: Run to confirm failure, then implement `sendWeeklyDigestForAcademy`**

Run: `pnpm test:integration tests/integration/weekly-digest.test.ts` — PASS.

- [ ] **Step 3: Build the cron route**

`src/app/api/cron/weekly-digest/route.ts`: exports `GET` (Vercel Cron issues GET requests by
default — confirm this against Vercel's actual current cron documentation if you have doubt, but
GET is the documented default), checks the `Authorization: Bearer ${CRON_SECRET}` header, returns
`401` if it doesn't match, otherwise calls `sendWeeklyDigestForAcademy` for every real `Academy`
row (query them, don't hardcode Escazú/Escalante by slug — matching Phase 7's locations-panel
precedent), and returns `200` with a small JSON summary (academies processed, any per-academy
errors — a single academy's digest failing must not prevent the others from sending, matching
this whole phase's best-effort ethos).

- [ ] **Step 4: Add `vercel.json`**

Exactly as specified in this plan's Global Constraints.

- [ ] **Step 5: Add message keys, verify, commit**

Run: `pnpm test`, `pnpm build` — all pass/succeed.

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "feat: add weekly digest email via Vercel Cron"
git push origin feat/phase-8-notifications
```

---

### Task 5: Full-suite verification and PR prep

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

All must pass/succeed. Unlike Phase 7, a new migration IS expected this phase (the `Notification`
table) — confirm it applied cleanly on a genuinely fresh database, not just on a database that
already had it from local iteration. If integration tests hit the known Postgres
connection-exhaustion or `seed.test.ts` parallelism issues, use
`npx vitest run tests/integration --no-file-parallelism` and note it — don't treat either as a
regression this phase introduced.

- [ ] **Step 2: Manual end-to-end walk**

Re-seed fresh (`docker compose down -v && up -d && migrate && generate && seed`) AFTER running the
test suite and BEFORE this walk, per this plan's Global Constraints note. As ADMIN or DIRECTOR:
sign up a new test student, confirm a `NEW_SIGNUP` notification appears in the bell AND (check
server logs/a Resend sandbox inbox, since real delivery is sandbox-limited) an email attempt was
made; check in a seeded student enough times to cross a stripe threshold (or manually adjust their
`atBeltCount` via the existing staff-adjustment flow from Phase 3/4 to get close, then one more
check-in) and confirm the same for `STRIPE_THRESHOLD`; open the bell dropdown and confirm the
unread badge clears. Manually invoke the cron route's exported handler (or hit it locally with the
correct `Authorization` header) and confirm a digest email attempt fires for each real academy.

- [ ] **Step 3: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!skills-lock.json'
git commit -m "test: full-suite verification for Phase 8"
git push origin feat/phase-8-notifications
```

Phase 8 is complete once this task's full-suite verification passes. This plan's controller will
dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
