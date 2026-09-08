# Alliance Jiu-Jitsu — Attendance & Belt Progression App

> **How to use this file:** create an empty folder, save this file inside it as `PROJECT_SPEC.md`,
> then start Claude Code in that folder and say:
>
> `Read PROJECT_SPEC.md and build it. Start with Phase 1 only. Ask me before making any schema decision that isn't specified.`
>
> Building phase by phase from a spec file on disk is much cheaper than describing the app
> conversationally, because the spec is read once instead of being re-sent every turn.

---

## 1. What this is

A web app that replaces **GymDesk** for Alliance Jiu-Jitsu Costa Rica. It tracks class
attendance, derives belt/stripe progression from attendance counts, alerts staff when a
student is near a promotion, and records (but never processes) monthly payment status.

It serves **two academies under one Alliance Costa Rica brand: Escazú and Escalante.**
This is not a "maybe later" requirement — see §1b. Build it into the first migration.

**Stack (fixed — do not substitute):**

- Next.js 15, App Router, TypeScript, React Server Components where sensible
- PostgreSQL via Prisma (target: Neon free tier)
- Tailwind CSS + shadcn/ui
- Auth: Auth.js (NextAuth) with credentials provider for staff and students
- Deploy target: Vercel free tier
- Timezone: `America/Costa_Rica` (UTC-6, no DST) — store UTC, render local
- i18n: `next-intl`, **Spanish is the default locale**, English available via toggle.
  No hardcoded user-facing strings anywhere.

---

## 1b. Two academies — the tenancy model

Alliance Costa Rica has two locations: **Escazú** (the primary one for this build) and
**Escalante**. Both are the same brand and follow the same Alliance belt standard.

**Add `academyId` from the very first migration.** Retrofitting tenancy into a schema that
already holds real student data is the single most expensive mistake this project can make.
Every location-owned row carries it, and every query filters on it.

The rules:

- **One student record, one belt progression.** A student has a `homeAcademyId`, but can
  check in at *either* location. Attendance from both counts toward the same belt and stripe
  progression. There is no such thing as an "Escazú count" and an "Escalante count" for
  promotion purposes.
- Each `AttendanceRecord` still stores **where** it happened (`academyId`), so the director
  can see cross-training and each location can measure its own mat traffic.
- **4-digit codes are unique across the whole system**, not per academy. A student walking
  into the other location must be recognized by the same code, and a shared code space is
  the only way that works. Enforce with a global unique constraint.
- **Class schedules are per academy.** The schedule in §5 is Escazú's. Escalante's is
  different and must be entered separately — do not copy Escazú's as a placeholder that
  someone later mistakes for real data. Seed Escalante with the academy record and an empty
  schedule.
- **Belt requirements are global** (Alliance standard, shared by both), but keep the table
  keyed so a per-academy override could be added later without a migration.
- **Payments are per academy.** Each location's director collects their own money, so
  `PaymentPeriod` records which academy the payment belongs to.

### Staff scoping

- `ADMIN` (you) is **global**: sees and manages both academies, plus a combined
  Alliance Costa Rica view.
- `DIRECTOR` and `INSTRUCTOR` are **scoped to their academy** via a `StaffAssignment` table
  (`userId`, `academyId`, `role`) — a join table, not a single `user.academyId` column, so
  one person can staff both locations without duplicate accounts.
- Scoping is enforced **server-side in a single shared helper** that every query and action
  goes through. Do not scatter `where: { academyId }` across the codebase by hand; one
  forgotten filter leaks the other academy's roster.
- Write an integration test that asserts an Escalante instructor cannot read, edit, or
  promote an Escazú student — through the API, not just the UI.

Every list, dashboard, and report gets an academy filter: *Escazú / Escalante / Ambas*.
Non-admins see only their own, with no switcher.

---

## 2. Domain rules — get these exactly right

### 2.1 Belts and stripes

Belts, in order: `WHITE → BLUE → PURPLE → BROWN → BLACK`

Each belt holds **0 to 4 stripes**. Attendance required per stripe:

| Belt   | Attendances per stripe | Stripes | Total to become exam-eligible |
| ------ | ---------------------- | ------- | ----------------------------- |
| White  | 30                     | 4       | 150 (4 stripes + 30 more)     |
| Blue   | 65                     | 4       | 325                           |
| Purple | 75                     | 4       | 375                           |
| Brown  | 85                     | 4       | 425                           |
| Black  | n/a — terminal in this system, no stripe tracking | — | — |

The rule in words: a student earns a stripe every *N* attendances at their current belt.
After the 4th stripe, they must complete *N* more attendances before being **called for the
belt exam**. Reaching the exam threshold does **not** promote anyone — it only flags them.

**These numbers must live in a `BeltRequirement` database table, seeded with the values
above, and be editable by an admin in the UI. Do not hardcode them in application code.**

### 2.2 The attendance counter is a ledger, not an integer

This is the single most important architectural decision in the app.

Never store `student.attendanceCount` as a mutable number. Store an append-only
`AttendanceRecord` table, and derive counts by aggregation. Manual corrections by staff are
**adjustment rows** (`type: ADJUSTMENT`, positive or negative `delta`, required `reason`),
not edits to a counter.

Why: promotions depend on these numbers. If a counter can be silently overwritten, nobody
can ever answer "why does this student have 62 and not 65?" A ledger makes every number
explainable and every correction attributable.

Attendance "at current belt" = sum of records with `occurredAt >= currentBeltAwardedAt`.
Keep the lifetime total separately for the student's own profile.

### 2.3 Promotions are never automatic

The app computes eligibility and surfaces it. A director or admin confirms it with a click.
Confirming writes a `Promotion` row (`studentId`, `fromBelt/Stripes`, `toBelt/Stripes`,
`awardedById`, `awardedAt`, optional `notes`) and resets the at-belt attendance baseline.

Promotion history is permanent and visible on the student profile.

---

## 3. Roles

| Role       | Scope        | Can do                                                     |
| ---------- | ------------ | ---------------------------------------------------------- |
| ADMIN      | Both academies | Everything, including belt requirement settings, academy settings and user management. Gets the combined Alliance Costa Rica view. |
| DIRECTOR   | Own academy  | Everything except system settings; confirms promotions; manages payments |
| INSTRUCTOR | Own academy  | View rosters, mark/correct attendance, view eligibility. No payments, no promotions |
| STUDENT    | —            | Own portal only                                             |

Enforce authorization **server-side** in every action and route handler, and enforce academy
scoping in the same place (§1b). Never rely on hiding UI elements.

One exception to scoping: when a student from the other academy checks in at a kiosk, the
local instructor may see that student's name, belt and stripes for the roll call — nothing
else. Cross-training must not be blocked by a permissions boundary.

---

## 4. Screens

### 4.1 Kiosk / attendance panel (`/kiosk`) — public, unauthenticated

A tablet or phone sitting at the academy entrance.

**Each kiosk is bound to one academy.** Use a per-academy kiosk URL with a device token
(`/kiosk/[academySlug]?token=…`) set up once by an admin, so the tablet never has to be told
where it is and a student can't accidentally record attendance at the wrong location. The
academy name is displayed on screen at all times.

If a student whose home academy is the *other* location checks in, accept it normally and
show a small "Visitante de Escalante" style badge — the attendance counts toward their belt
and is recorded against the academy where they actually trained.

- Big numeric keypad, student enters their **4-digit code**
- On success, show for ~6 seconds then reset:
  - Student name
  - **Belt rendered as a visual belt graphic** — correct belt color, black bar, and the
    earned stripes drawn on the bar (white stripes on the black bar; use the standard
    IBJJF look)
  - Attendances at current belt, and how many remain to the next stripe or to the exam
  - A short congratulation state when this check-in *earned* a stripe threshold
- The class being checked into is auto-selected from the schedule based on current time
  (see §5). If no class is within its check-in window, show "No hay clase activa" and
  refuse the check-in.

**Security requirements for the kiosk (do not skip):**

- 4-digit codes are only 10,000 possibilities. Enforce: unique codes per academy,
  rate limiting per IP (e.g. 10 attempts/minute), a 60-second lockout after 5 failures,
  and log every failed attempt.
- The kiosk grants **attendance marking only**. It must never display phone, email,
  payment status, or any other PII, and never grant a session.
- Codes are stored hashed, and staff can regenerate a student's code.

### 4.2 Student portal (`/portal`) — authenticated

Login with **email + password** (set during signup), *not* the 4-digit code — this page
shows payment information, so it needs real authentication. Include password reset.

Shows:

- Belt graphic with stripes, same component as the kiosk
- Progress bar: attendances at current belt vs. next threshold
- Lifetime attendance total and full attendance history (date, class, type)
- Current payment status and which plan/promo they're on
- Promotion history
- **Self check-in button** — same rules and same check-in window as the kiosk, so a student
  can mark the class from their own phone

### 4.3 Staff dashboard (`/dashboard`) — ADMIN / DIRECTOR / INSTRUCTOR

Landing view answers "what needs my attention today":

- **Promotion queue** — students at a stripe threshold, and students at exam threshold,
  each with a "Confirmar promoción" action (director/admin only)
- **Approaching** — students within 5 attendances of a threshold, so the professor can
  plan the ceremony
- **Today's classes** — who checked in, live
- **Inactive students** — no attendance in 30+ days (retention signal)
- **Payments overdue** — students whose current period is unpaid (director/admin only)

### 4.3b Director analytics (`/dashboard/analytics`) — ADMIN / DIRECTOR only

A second tab on the dashboard, built for the person running the academy as a business.
Every panel accepts a date-range filter (default: last 30 days) and exports to CSV.

**Headline tiles**

- **Active students** — distinct students with ≥1 attendance in the selected range.
  Show alongside *total enrolled* and *inactive*, because "active" and "enrolled" drifting
  apart is the number that actually matters. Make the active-window threshold configurable
  (default 30 days).
- **New students this month** and **students lost** (were active last period, not this one)
- **Total attendances** in range, and average attendances per active student
- **Payment health** — % of enrolled students with the current month marked paid or promo

**Class popularity**

- Bar chart: total attendances per class slot (e.g. "Lunes 19:00 GI — Avanzados"), ranked
- Heatmap: day of week × time of day, colored by average attendance — this is the view that
  answers "which classes should we keep, move, or split"
- Average attendance per class and trend arrow vs. the previous equivalent period
- Explicitly surface the **lowest-attended slots**, not just the highest. An empty 6am class
  costs the academy an instructor's morning.

**Progression**

- Students near the next stripe or exam (same data as the promotion queue, presented as a
  planning list: name, belt, current count, remaining, projected date at their current
  training rate)
- Belt distribution across the academy (how many white/blue/purple/brown/black)
- Promotions awarded in range

**Locations** (admin only)

- Every panel above accepts an academy filter: *Escazú / Escalante / Ambas*
- Side-by-side comparison when "Ambas" is selected: active students, total attendances,
  average per class, payment health — per location
- **Cross-training panel**: how many check-ins happened at an academy that isn't the
  student's home location, and who. Useful for spotting students who have effectively
  migrated and should have their home academy updated.

**Retention**

- Students with no attendance in 30+ / 60+ / 90+ days, with last-seen date and phone,
  so the director can actually reach out
- Attendance trend line by week

Keep every chart simple and readable on a phone. Use a single charting library (Recharts),
label axes in the active locale, and never rely on color alone to carry meaning.

### 4.4 Student roster (`/students`)

Searchable, filterable by belt, status (active/inactive/archived), payment status.
Row shows name, belt graphic, at-belt count, last attendance, payment badge.

### 4.5 Student detail (`/students/[id]`)

Full profile, attendance ledger with every adjustment and its reason and author,
promotion history, payment history, code regeneration, archive action.

### 4.6 Public signup (`/signup`)

Fields: first name, last name, phone, email, current belt, current stripes, password.
Optional: date of birth, emergency contact, guardian name + phone (required if under 18).

On submit:

- Creates the student in `PENDING` status
- Generates and displays a unique 4-digit code **once**, prominently, with a "save this"
  warning
- Notifies staff that a new student is awaiting approval

Staff can also create students manually from the dashboard and hand over the generated code.

---

## 5. Class schedule

Class schedules are **per academy**. The table below is **Escazú's** confirmed schedule —
seed it against the Escazú academy record. All times `America/Costa_Rica`.

**Escalante's schedule is not yet known.** Create the Escalante academy record with an empty
schedule and an admin UI to enter it. Do not duplicate Escazú's times as a placeholder —
placeholder schedule data will silently become wrong attendance windows.

| Day       | Time     | Class                        |
| --------- | -------- | ---------------------------- |
| Monday    | 06:00    | GI                           |
| Monday    | 12:00    | NO-GI                        |
| Monday    | 18:00    | GI — Principiantes           |
| Monday    | 19:00    | GI — Avanzados               |
| Tuesday   | 12:00    | GI                           |
| Tuesday   | 18:00    | NO-GI — Todos los niveles    |
| Tuesday   | 19:00    | GI — Todos los niveles       |
| Wednesday | 06:00    | GI                           |
| Wednesday | 12:00    | NO-GI                        |
| Wednesday | 18:30    | Competición                  |
| Thursday  | 12:00    | GI                           |
| Thursday  | 18:00    | NO-GI — Todos los niveles    |
| Thursday  | 19:00    | GI — Todos los niveles       |
| Friday    | 12:00    | NO-GI                        |
| Friday    | 18:30    | GI — Todos los niveles       |
| Saturday  | 09:00    | Striking                     |
| Saturday  | 10:00    | Kids                         |
| Saturday  | 11:00    | Open Mat                     |

Rules:

- Each class has a `countsTowardPromotion` boolean. Default **true** for all GI, NO-GI,
  Competición, Open Mat and Kids; default **false** for Striking (it isn't jiu-jitsu) —
  admin-editable, since this is an academy policy call, not a technical one.
- Check-in window: from 30 minutes before start to 30 minutes after start.
- One check-in per student per class session per day (enforce with a unique DB constraint on
  `(studentId, classSessionId, date)`, not just application logic).
- The schedule must be editable in the admin UI — schedules change.

---

## 6. Payments (tracking only, no processing)

- `PaymentPlan`: name, description, active. Seed with `Mensualidad`, `Promoción`, `Becado`.
- `PaymentPeriod`: `studentId`, `year`, `month`, `planId`, `status`
  (`PAID | PENDING | PROMO | EXEMPT`), `amount` (nullable), `notes`, `recordedById`,
  `recordedAt`.
- Payment plans and periods belong to an academy — each location's director collects and
  records their own. A student's payment lives at their **home** academy regardless of where
  they trained that month.
- One row per student per month. A student is "overdue" when the current month's row is
  missing or `PENDING` past a configurable day of the month (default: the 5th).
- Payment status is **visible but never blocking** — an unpaid student can still check in.
  Flag it for the director; do not lock anyone out of class.

---

## 7. Notifications

Phase 1: in-app only — the dashboard promotion queue plus a bell icon with unread counts.

Phase 2: email to director and instructors via Resend free tier, for:

- Student reached a stripe threshold
- Student reached exam threshold
- New student signup awaiting approval
- Weekly digest: attendance summary, inactive students, overdue payments

Design the notification layer behind a `NotificationChannel` interface so a WhatsApp channel
can be added later without touching business logic:

```ts
interface NotificationChannel {
  send(to: Recipient, message: RenderedMessage): Promise<DeliveryResult>
  supportsInboundReplies: boolean
}
```

Phase 3: **WhatsApp attendance confirmation** — see §7b.

---

## 7b. WhatsApp integration

### The goal

Before each class, ask students whether they're coming; collect the answers; show the
instructor a live "confirmed for tonight" list on the dashboard. Confirmations are
*intent*, not attendance — they never create `AttendanceRecord` rows. Only a real check-in
does that.

### Choosing the transport — read this before building anything

**Do not use `dashiz91/claude-code-whatsapp` for this.** It is a bridge that lets a person
drive the Claude Code CLI from their own WhatsApp self-chat. It only reacts to messages you
send yourself, explicitly ignores everything else, has no group support, and requires a
local Claude Code process plus a QR rescan roughly every 20 days. It solves a different
problem.

Three real options, in order of preference:

**1. WhatsApp Cloud API — per-student template messages (recommended).**
Official Meta API, works with a normal WhatsApp Business number, no risk of a ban.
Send each student an individual **utility template** with quick-reply buttons
("¿Vienes hoy a las 19:00 GI?" → *Sí* / *No*). Button taps arrive on a webhook and map
cleanly to a `ClassConfirmation` row.

This is genuinely better than a group message for this use case: you get one structured,
attributable answer per student instead of a group thread where half the replies are
thumbs-up emoji and nobody can tally them. Costs are per-conversation and small at academy
scale, but they are not zero — check current utility-template pricing for Costa Rica before
committing.

**2. WhatsApp Groups API.** Meta now offers group messaging, but it requires an
**Official Business Account**, which a small academy is unlikely to qualify for, and it is
not available to numbers using the WhatsApp Business *app*. Treat it as a later upgrade,
not a starting point. Verify current eligibility and participant limits before designing
around it.

**3. Unofficial libraries (Baileys, whatsapp-web.js).** These do work with groups and cost
nothing. They also violate WhatsApp's Terms of Service and carry a real risk of the number
being permanently banned. If this path is chosen anyway, never use the director's or the
academy's primary number — use a dedicated throwaway SIM, and accept that it will break.

**Fallback with no API at all:** the app generates a daily message and a short check-in link,
and a human pastes it into the existing group. Zero cost, zero risk, five seconds of effort.
Build this first — it makes the feature useful on day one and gives you the message
templates you'll reuse later.

### Data and behavior

```
ClassConfirmation  id, studentId, classSessionId, sessionDate,
                   response(YES|NO|NO_REPLY), respondedAt, channel, messageId
WhatsAppOptIn      studentId, phoneE164, optedInAt, optedOutAt?
```

- **Opt-in is mandatory.** Add a consent checkbox to the signup form and a toggle in the
  student portal. Never message a student who hasn't opted in, and honor "STOP"/"BAJA"
  replies by writing `optedOutAt` immediately.
- Send the prompt at a configurable offset before class (default 4 hours), per class slot,
  only to students who are `ACTIVE` and opted in, and only to students whose **home academy**
  owns that class. Nobody at Escalante should get pinged about an Escazú 6am class.
- Instructor dashboard shows, per upcoming class: confirmed / declined / no reply, with names.
- Rate-limit and batch sends. Log every outbound message and its delivery status.
- Put all WhatsApp code behind the `NotificationChannel` interface from §7 so the transport
  can be swapped without touching scheduling or business logic.

**Build this last.** Phases 1–6 are a working product without it.

---

## 8. Data model (starting point — refine as needed, keep the intent)

```
Academy         id, name, slug, address?, timezone, kioskTokenHash, active, createdAt
                  -- seed: "Alliance Escazú" (escazu), "Alliance Escalante" (escalante)
User            id, email, passwordHash, role, locale, active, createdAt
StaffAssignment id, userId, academyId, role(DIRECTOR|INSTRUCTOR)
                  -- ADMIN has no rows here; admin is global
Student         id, userId?, homeAcademyId, firstName, lastName, phone, email, dateOfBirth?,
                guardianName?, guardianPhone?, emergencyContact?,
                currentBelt, currentStripes, beltAwardedAt,
                codeHash (GLOBALLY unique), status(PENDING|ACTIVE|INACTIVE|ARCHIVED),
                joinedAt, notes
ClassSession    id, academyId, dayOfWeek, startTime, durationMinutes, name, type,
                countsTowardPromotion, active
AttendanceRecord id, studentId, academyId, classSessionId?, occurredAt,
                type(CHECKIN|ADJUSTMENT), delta(default 1),
                source(KIOSK|PORTAL|STAFF), reason?, createdById?, createdAt
Promotion       id, studentId, academyId, fromBelt, fromStripes, toBelt, toStripes,
                awardedById, awardedAt, notes?
BeltRequirement id, academyId(nullable = global default), belt,
                attendancesPerStripe, maxStripes, attendancesForExam
PaymentPlan     id, academyId, name, description, active
PaymentPeriod   id, studentId, academyId, year, month, planId, status, amount?, notes,
                recordedById, recordedAt
AuditLog        id, actorId, academyId?, action, entityType, entityId, before, after, createdAt
```

Indexes that matter: `AttendanceRecord(studentId, occurredAt)` for progression queries,
`AttendanceRecord(academyId, occurredAt)` for analytics, and the unique constraints on
`Student.codeHash` (global) and `AttendanceRecord(studentId, classSessionId, date)`.

Every mutation by staff writes an `AuditLog` row.

---

## 9. Build phases

Build and verify one phase at a time. Do not start a phase before the previous one runs.

1. **Foundation** — Next.js + Prisma + Neon, schema **including `academyId` everywhere**,
   migrations, seed (two academies, belt requirements, Escazú's class schedule, payment
   plans, one admin user), i18n scaffolding, belt graphic component with a visual test page
   showing all 5 belts × 0–4 stripes.
2. **Students & auth** — roles, staff login, **academy scoping helper and its integration
   test**, roster, student CRUD, code generation, signup form.
3. **Attendance** — ledger, kiosk, check-in windows, duplicate prevention, staff adjustments.
4. **Progression** — eligibility engine, promotion queue, promotion confirmation, history.
5. **Student portal** — login, progress view, history, self check-in.
6. **Payments** — periods, statuses, overdue view.
7. **Director analytics** — the `/dashboard/analytics` view in §4.3b.
8. **Notifications, reports, CSV export, GymDesk import.**
9. **WhatsApp confirmations** — manual-paste fallback first, Cloud API after (§7b).

---

## 10. Quality bar

- The eligibility engine is the heart of the app. **Write unit tests for it first**, covering:
  exact threshold, one below, one above, 4th stripe, exam threshold, negative adjustment
  dropping a student back below a threshold, and a promotion resetting the baseline.
- Mobile first. Students will use this on phones at the gym on bad wifi.
- The kiosk must be a PWA with an offline check-in queue that syncs when the connection
  returns. The academy wifi will fail; a student who showed up must not lose their class.
- No hard deletes anywhere. Archive instead.
- All money and belt-affecting mutations are audited.
- Accessibility: the belt graphic needs a text alternative — color alone must not convey rank.

---

## 11. Not in scope

- Payment processing or any card handling
- Video, technique libraries, curriculum tracking
- Academies beyond Escazú and Escalante (the schema supports N, but don't build an
  academy-onboarding flow — an admin creating a row is enough)
- Native mobile apps
