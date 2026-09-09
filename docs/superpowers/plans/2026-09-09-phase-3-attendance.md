# Phase 3: Attendance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the append-only attendance ledger and everything that writes to it — the public kiosk (with offline-queue PWA behavior), check-in windows, duplicate prevention, staff manual adjustments, and the admin class-schedule editor — per `PROJECT_SPEC.md` §9's Phase 3 bullet.

**Architecture:** All wall-clock math (check-in windows, the ledger's `date` column) goes through a single `America/Costa_Rica`-zoned helper built on Luxon — never raw `Date` arithmetic on a timestamp string, since this app's evening-heavy class schedule crosses the UTC day boundary constantly (18:00+ CR is already tomorrow in UTC). The actual check-in write path is a plain REST **Route Handler** (`POST /api/kiosk/check-in`), not a Next.js Server Action — a Server Action reference can go stale across a deployment, which would silently break a PWA's offline-queued replay; a stable URL doesn't have that problem, and it's the same reason this same route will be reusable by Phase 5's student-portal self-check-in later. Rate limiting and failed-attempt logging use a new DB table (Postgres, matching the rest of this app's infra) rather than an in-memory counter, since Vercel's serverless model gives no guarantee two requests share memory. This phase does **not** build the full belt-progression eligibility engine (unit-tested exhaustively per spec §10) or the promotion queue/confirmation UI — that's Phase 4. It builds just enough read-only "at-belt summary" math to show a kiosk/portal user their progress after checking in.

**Tech Stack:** `luxon` (new dependency — timezone-correct date math), everything already in place from Phases 1-2 (Prisma 7 + driver adapter, Auth.js, the academy-scoping helper, next-intl, the belt graphic component, bcrypt/HMAC crypto helpers).

**Spec:** `PROJECT_SPEC.md` — §1b (cross-training/visitor rules), §2.1 (belt/stripe thresholds — data only, not the engine), §2.2 (the ledger is the "single most important architectural decision"), §3 (roles — note INSTRUCTOR *can* mark/correct attendance, unlike student CRUD), §4.1 (kiosk), §5 (schedule, check-in windows, duplicate prevention), §8 (data model — `AttendanceRecord` already exists from Phase 1), §10 (PWA/offline requirement, no-hard-deletes, audit requirement).

## Global Constraints

- **The ledger is append-only, full stop.** Every attendance fact is a new `AttendanceRecord` row (`type: CHECKIN` or `type: ADJUSTMENT`). Nothing in this phase ever updates or deletes an existing `AttendanceRecord`, and nothing computes or stores a mutable running count anywhere (spec §2.2 — this is called out as the single most important architectural decision in the whole app; a regression here is Critical by definition).
- **`AttendanceRecord.date` must be derived via the Luxon + `America/Costa_Rica` zone helper this phase builds (Task 1), never `occurredAt.toISOString().slice(0, 10)`** — Phase 1's schema comment on this exact column warns about this, and this is the phase that finally writes to it.
- **Check-in window: 30 minutes before a `ClassSession.startTime` to 30 minutes after** (spec §5), computed in `America/Costa_Rica` wall-clock time against the session's `dayOfWeek`, not naive UTC.
- **One check-in per student per class session per day is already a DB-level unique constraint** (`AttendanceRecord @@unique([studentId, classSessionId, date])`, Phase 1). The app-level duplicate-prevention in this phase is a *pre-check for a friendly error message* — the DB constraint is the actual backstop and must still be caught gracefully (Postgres `23P01`/Prisma `P2002`) in case of a race, never surfaced as a raw 500.
- **Kiosk security (spec §4.1, do not skip any of these):** codes are looked up via the existing `digestLookupSecret` HMAC helper (never bcrypt — this is the exact column Phase 1's final review fixed for this reason); rate limiting is 10 attempts/minute per (academy, IP); a 60-second lockout follows 5 failed attempts within that window; every attempt (success and failure) is logged with its outcome; the kiosk **never** displays phone, email, payment status, or any PII beyond name + belt + stripes, and **never** creates a session (no cookie, no Auth.js `signIn` call — the whole point of the kiosk is that it grants attendance-marking only).
- **Cross-training is a feature, not a bug.** A student whose `homeAcademyId` differs from the academy they're physically checking in at is accepted normally; the `AttendanceRecord.academyId` is set to *where they checked in*, not their home academy, and the kiosk shows a small "Visitante de [home academy]"-style badge (spec §1b, §4.1).
- **Roles for attendance actions (spec §3, differs from Phase 2's student-CRUD rule):** `ADMIN`/`DIRECTOR`/`INSTRUCTOR` can all mark and correct attendance — this is explicitly an operational task, unlike student create/edit/archive which stayed `ADMIN`/`DIRECTOR`-only in Phase 2. Manual adjustments still go through `academyScopeWhere`/`isAcademyInScope` like every other student-touching write in this app.
- **Every staff adjustment is audited** (spec §10, and this app's established `AuditLog` pattern from Phase 2) — `action: "attendance.adjustment"`, with the delta and reason in `after`, never a raw counter value (there isn't one).
- **No hard deletes.** A `ClassSession` that's retired from the schedule gets `active: false`, never a `delete()` call (Phase 1 already modeled `active` on this table for exactly this).
- **This repo has no branch protection on `main`, but direct `git push origin main` is unreliable** (confirmed across both prior phases — an auto-mode classifier intermittently denies it). Every task in this plan pushes to a **feature branch**, `feat/phase-3-attendance`; one PR is opened at the end for the user to merge themselves.
- **Environment quirk, confirmed real across both prior phases:** `pnpm` commands on this machine have repeatedly introduced garbage `"0"`/`"true"` entries into `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`. Check for and fix these before every commit.
- **Use targeted `git add`, never bare `git add -A`** — `git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'`.
- **If a push (or anything) is denied by any mechanism, do not retry via a different tool.** A same-tool retry once is fine; a second denial means stop and report BLOCKED with the exact text.
- All new user-facing pages/messages use next-intl (`useTranslations`/`getTranslations`) — no hardcoded strings, both `messages/es.json` and `messages/en.json` get every new key.

---

### Task 1: Costa Rica timezone helper + check-in window logic

**Files:**
- Create: `src/lib/scheduling/zone.ts`, `src/lib/scheduling/check-in-window.ts`, `tests/unit/check-in-window.test.ts`

**Interfaces:**
- Produces: `ZONE = "America/Costa_Rica"` (exported constant) from `@/lib/scheduling/zone`; `toAttendanceDate(occurredAt: Date): Date` (returns the CR-calendar-day, midnight-UTC-normalized, suitable for the `@db.Date` column) from the same file; `isWithinCheckInWindow(session: { dayOfWeek: DayOfWeek; startTime: string; durationMinutes: number }, now: Date): boolean` and `getCheckInWindow(session, referenceDate: Date): { start: Date; end: Date }` from `@/lib/scheduling/check-in-window`.
- Consumed by: Task 5 (check-in core), Task 8 (adjustments, for date stamping).

- [ ] **Step 1: Add the Luxon dependency**

```bash
pnpm add luxon
pnpm add -D @types/luxon
```

Check `package.json` immediately after for the recurring stray `"0"`/`"true"` dependency-key anomaly and fix if present.

- [ ] **Step 2: Write the zone helper**

Create `src/lib/scheduling/zone.ts`:

```ts
import { DateTime } from "luxon";

export const ZONE = "America/Costa_Rica";

/**
 * Converts a UTC instant into the America/Costa_Rica calendar date it falls
 * on, returned as a UTC-midnight Date (the shape Prisma's `@db.Date` column
 * expects). NEVER use `occurredAt.toISOString().slice(0, 10)` for this —
 * most evening classes (18:00+ CR) fall on the next UTC calendar day, so a
 * naive slice silently produces the wrong date for the majority of
 * check-ins. See prisma/schema.prisma's comment on AttendanceRecord.date.
 */
export function toAttendanceDate(occurredAt: Date): Date {
  const crDate = DateTime.fromJSDate(occurredAt, { zone: "utc" }).setZone(ZONE);
  return DateTime.utc(crDate.year, crDate.month, crDate.day).toJSDate();
}
```

- [ ] **Step 3: Write the check-in window logic**

Create `src/lib/scheduling/check-in-window.ts`:

```ts
import { DateTime } from "luxon";
import { ZONE } from "./zone";
import type { DayOfWeek } from "@/generated/prisma/client";

const WINDOW_MINUTES = 30;

const DAY_INDEX: Record<DayOfWeek, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

interface SessionTiming {
  dayOfWeek: DayOfWeek;
  startTime: string; // "HH:mm", 24h, CR wall-clock
  durationMinutes: number;
}

/**
 * The check-in window for one occurrence of a class session, anchored to
 * the CR calendar date the session actually falls on relative to
 * `referenceDate`. Returns UTC instants (real Date objects), so callers can
 * compare directly against `new Date()`.
 */
export function getCheckInWindow(session: SessionTiming, referenceDate: Date): { start: Date; end: Date } {
  const [hour, minute] = session.startTime.split(":").map(Number);
  const refInZone = DateTime.fromJSDate(referenceDate, { zone: "utc" }).setZone(ZONE);

  const sessionStart = refInZone.set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  return {
    start: sessionStart.minus({ minutes: WINDOW_MINUTES }).toJSDate(),
    end: sessionStart.plus({ minutes: session.durationMinutes + WINDOW_MINUTES }).toJSDate(),
  };
}

/**
 * True if `now` falls within this session's check-in window, given that
 * `now`'s CR calendar day matches the session's scheduled day of week.
 * Callers should already have filtered sessions to today's dayOfWeek before
 * calling this (see Task 5's `findActiveClassSession`).
 */
export function isWithinCheckInWindow(session: SessionTiming, now: Date): boolean {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);
  if (DAY_INDEX[session.dayOfWeek] !== nowInZone.weekday) return false;

  const window = getCheckInWindow(session, now);
  return now >= window.start && now <= window.end;
}
```

- [ ] **Step 4: Write unit tests**

Create `tests/unit/check-in-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import { isWithinCheckInWindow, getCheckInWindow } from "@/lib/scheduling/check-in-window";

describe("toAttendanceDate", () => {
  it("keeps a morning CR check-in on the same UTC calendar day", () => {
    // 08:00 CR (UTC-6) = 14:00 UTC, same day
    const occurredAt = new Date("2026-03-10T14:00:00.000Z");
    expect(toAttendanceDate(occurredAt).toISOString().slice(0, 10)).toBe("2026-03-10");
  });

  it("rolls an evening CR check-in back to the CR day, even though it's already tomorrow in UTC", () => {
    // 19:00 CR (UTC-6) on March 10 = 01:00 UTC on March 11
    const occurredAt = new Date("2026-03-11T01:00:00.000Z");
    expect(toAttendanceDate(occurredAt).toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("isWithinCheckInWindow", () => {
  const mondaySixAm = { dayOfWeek: "MONDAY" as const, startTime: "06:00", durationMinutes: 60 };

  it("is true exactly at the session start (CR time)", () => {
    // Monday 2026-03-09 06:00 CR = 12:00 UTC
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:00:00.000Z"))).toBe(true);
  });

  it("is true 29 minutes before start", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:31:00.000Z"))).toBe(true);
  });

  it("is false 31 minutes before start", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:29:00.000Z"))).toBe(false);
  });

  it("is true 30 minutes after the session's end (start + duration + 30)", () => {
    // start 12:00 UTC + 60 min duration + 30 min window = 13:30 UTC
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:30:00.000Z"))).toBe(true);
  });

  it("is false 31 minutes after the session's end", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:32:00.000Z"))).toBe(false);
  });

  it("is false on the wrong day of week even at the exact right time", () => {
    // Tuesday 2026-03-10 06:00 CR = 12:00 UTC — one day later, same clock time
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-10T12:00:00.000Z"))).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests and verify**

Run: `pnpm test:unit`
Expected: all new tests pass, plus the full existing suite.

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 6: Branch, commit, and push**

```bash
git checkout -b feat/phase-3-attendance
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add Costa Rica timezone helper and check-in window logic"
git push -u origin feat/phase-3-attendance
```

(Every later task in this plan pushes to this same branch.)

---

### Task 2: At-belt attendance summary (read-only, not the full eligibility engine)

**Files:**
- Create: `src/lib/students/attendance-summary.ts`, `tests/integration/attendance-summary.test.ts`

**Interfaces:**
- Produces: `getAtBeltSummary(studentId: string): Promise<AtBeltSummary>` where `AtBeltSummary = { currentBelt: Belt; currentStripes: number; atBeltCount: number; lifetimeCount: number; attendancesPerStripe: number; maxStripes: number; nextStripeAt: number | null; remainingToNextStripe: number | null; examEligible: boolean }`. `nextStripeAt`/`remainingToNextStripe` are `null` when `currentStripes >= maxStripes` (i.e., BLACK belt, or a colored belt already at 4 stripes and past the exam threshold) — in that state the student is either terminal (BLACK) or already exam-eligible, not accumulating toward a numbered "next stripe."
- Consumed by: Task 5 (check-in response), and will be reused by Phase 4/5.

- [ ] **Step 1: Write the summary function**

Create `src/lib/students/attendance-summary.ts`:

```ts
import { prisma } from "@/lib/prisma";

export interface AtBeltSummary {
  currentBelt: string;
  currentStripes: number;
  atBeltCount: number;
  lifetimeCount: number;
  attendancesPerStripe: number;
  maxStripes: number;
  nextStripeAt: number | null;
  remainingToNextStripe: number | null;
  examEligible: boolean;
}

export async function getAtBeltSummary(studentId: string): Promise<AtBeltSummary> {
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { currentBelt: true, currentStripes: true, beltAwardedAt: true, homeAcademyId: true },
  });

  const requirement = await resolveBeltRequirement(student.currentBelt, student.homeAcademyId);

  const [atBeltAgg, lifetimeAgg] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where: { studentId, occurredAt: { gte: student.beltAwardedAt } },
      _sum: { delta: true },
    }),
    prisma.attendanceRecord.aggregate({
      where: { studentId },
      _sum: { delta: true },
    }),
  ]);

  const atBeltCount = atBeltAgg._sum.delta ?? 0;
  const lifetimeCount = lifetimeAgg._sum.delta ?? 0;

  const atMaxStripes = student.currentStripes >= requirement.maxStripes;
  const attendancesIntoCurrentStripeSpan = atBeltCount - student.currentStripes * requirement.attendancesPerStripe;

  let nextStripeAt: number | null = null;
  let remainingToNextStripe: number | null = null;
  let examEligible = false;

  if (!atMaxStripes && requirement.attendancesPerStripe > 0) {
    nextStripeAt = (student.currentStripes + 1) * requirement.attendancesPerStripe;
    remainingToNextStripe = Math.max(0, nextStripeAt - atBeltCount);
  } else if (atMaxStripes && requirement.attendancesForExam > 0) {
    // Past the 4th stripe: examEligible once `attendancesForExam` more
    // attendances have accrued since the 4th stripe was earned.
    examEligible = attendancesIntoCurrentStripeSpan >= requirement.attendancesForExam;
    if (!examEligible) {
      remainingToNextStripe = Math.max(0, requirement.attendancesForExam - attendancesIntoCurrentStripeSpan);
    }
  }

  return {
    currentBelt: student.currentBelt,
    currentStripes: student.currentStripes,
    atBeltCount,
    lifetimeCount,
    attendancesPerStripe: requirement.attendancesPerStripe,
    maxStripes: requirement.maxStripes,
    nextStripeAt,
    remainingToNextStripe,
    examEligible,
  };
}

async function resolveBeltRequirement(belt: string, homeAcademyId: string) {
  const perAcademy = await prisma.beltRequirement.findUnique({
    where: { academyId_belt: { academyId: homeAcademyId, belt: belt as never } },
  });
  if (perAcademy) return perAcademy;

  return prisma.beltRequirement.findFirstOrThrow({
    where: { academyId: null, belt: belt as never },
  });
}
```

- [ ] **Step 2: Write the integration test**

Create `tests/integration/attendance-summary.test.ts`. Seed a throwaway `Student` (clean up in `afterAll`) at `WHITE` belt, 0 stripes, with a known `beltAwardedAt`. Write real `AttendanceRecord` rows (`type: CHECKIN`, `delta: 1`, `occurredAt` at various points after `beltAwardedAt`, `academyId` = the student's home academy, `source: STAFF` is fine for a test fixture) and assert:
- 0 attendances → `atBeltCount: 0`, `remainingToNextStripe: 30` (White's real seeded `attendancesPerStripe` from Phase 1).
- 29 attendances → `remainingToNextStripe: 1`.
- 30 attendances → `remainingToNextStripe: 0` (the student has *reached* the threshold; Phase 4 owns actually flipping `currentStripes`/`beltAwardedAt` when a promotion is confirmed — this function only reports where they stand).
- A student already at 4 stripes (seed `currentStripes: 4`) with 29 more attendances since `beltAwardedAt` → `examEligible: false`, `remainingToNextStripe: 1`; at 30 more → `examEligible: true`.
- A negative `ADJUSTMENT` row (`delta: -5`, `reason: "test correction"`) correctly reduces `atBeltCount`.
- `lifetimeCount` includes attendance recorded *before* the current `beltAwardedAt` (seed one such row) while `atBeltCount` does not.

- [ ] **Step 3: Run tests, commit, push**

Run: `pnpm test:integration` — all pass.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add read-only at-belt attendance summary"
git push origin feat/phase-3-attendance
```

---

### Task 3: Kiosk rate-limiting + attempt logging

**Files:**
- Create: `src/lib/kiosk/rate-limit.ts`, `tests/integration/kiosk-rate-limit.test.ts`
- Modify: `prisma/schema.prisma` (new `KioskAttempt` model), new migration

**Interfaces:**
- Produces: `recordKioskAttempt(academyId: string, ipAddress: string, success: boolean): Promise<void>`; `checkKioskRateLimit(academyId: string, ipAddress: string): Promise<{ allowed: true } | { allowed: false; reason: "rate_limited" | "locked_out"; retryAfterSeconds: number }>` from `@/lib/kiosk/rate-limit`.
- Consumed by: Task 5 (check-in core).

**Why a new table, not in-memory:** Vercel's serverless model gives no guarantee two requests hit the same process, so an in-memory `Map` silently stops rate-limiting correctly the moment traffic spans more than one instance. This app already has no Redis/external cache — Postgres is the one thing guaranteed available, so the rate limiter lives there, same reasoning as this app's other fixed-window-in-Postgres patterns.

- [ ] **Step 1: Add the model**

Add to `prisma/schema.prisma`:

```prisma
model KioskAttempt {
  id        String   @id @default(cuid())
  academyId String
  ipAddress String
  success   Boolean
  createdAt DateTime @default(now())

  academy Academy @relation(fields: [academyId], references: [id])

  @@index([academyId, ipAddress, createdAt])
}
```

Add the reciprocal relation to `Academy`:

```prisma
kioskAttempts KioskAttempt[]
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm exec prisma migrate dev --name add_kiosk_attempt
```

Expected: applies cleanly (purely additive).

- [ ] **Step 3: Write the rate-limit helper**

Create `src/lib/kiosk/rate-limit.ts`:

```ts
import { prisma } from "@/lib/prisma";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const LOCKOUT_FAILURE_THRESHOLD = 5;
const LOCKOUT_SECONDS = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "locked_out"; retryAfterSeconds: number };

export async function checkKioskRateLimit(academyId: string, ipAddress: string): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);

  const recentAttempts = await prisma.kioskAttempt.findMany({
    where: { academyId, ipAddress, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "asc" },
    select: { success: true, createdAt: true },
  });

  if (recentAttempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldestInWindow = recentAttempts[0].createdAt;
    const retryAfterSeconds = Math.max(
      1,
      RATE_LIMIT_WINDOW_SECONDS - Math.floor((Date.now() - oldestInWindow.getTime()) / 1000),
    );
    return { allowed: false, reason: "rate_limited", retryAfterSeconds };
  }

  const recentFailures = recentAttempts.filter((a) => !a.success);
  if (recentFailures.length >= LOCKOUT_FAILURE_THRESHOLD) {
    const fifthFailure = recentFailures[LOCKOUT_FAILURE_THRESHOLD - 1].createdAt;
    const lockoutEndsAt = fifthFailure.getTime() + LOCKOUT_SECONDS * 1000;
    if (Date.now() < lockoutEndsAt) {
      return {
        allowed: false,
        reason: "locked_out",
        retryAfterSeconds: Math.ceil((lockoutEndsAt - Date.now()) / 1000),
      };
    }
  }

  return { allowed: true };
}

export async function recordKioskAttempt(academyId: string, ipAddress: string, success: boolean): Promise<void> {
  await prisma.kioskAttempt.create({ data: { academyId, ipAddress, success } });
}
```

- [ ] **Step 4: Write the integration test**

Create `tests/integration/kiosk-rate-limit.test.ts`. Use a throwaway, uniquely-tagged `ipAddress` string per test (no need to seed a real academy row's FK carefully — use the real seeded Escazú academy id, clean up created `KioskAttempt` rows in `afterEach`). Cover:
- Fresh IP → `{ allowed: true }`.
- After 10 attempts (any mix of success/fail) within the window → `{ allowed: false, reason: "rate_limited" }`.
- After exactly 5 failures (and fewer than 10 total attempts) within 60s → `{ allowed: false, reason: "locked_out" }`, with a `retryAfterSeconds` between 1 and 60.
- A DIFFERENT `ipAddress` at the same academy, or the same IP at a DIFFERENT academy, is unaffected by the first IP's lockout (rate limiting is scoped per academy+IP, not global).

- [ ] **Step 5: Run tests, commit, push**

Run: `pnpm test:integration` — all pass.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add kiosk rate-limiting and attempt logging"
git push origin feat/phase-3-attendance
```

---

### Task 4: Kiosk device-token admin management

**Files:**
- Create: `src/app/[locale]/admin/kiosk-tokens/page.tsx`, `src/app/[locale]/admin/kiosk-tokens/actions.ts`
- Modify: `messages/es.json`, `messages/en.json`, `src/middleware.ts` (add `/admin` to the protected prefixes)

**Interfaces:**
- Produces: `regenerateKioskToken(academyId): Promise<{ ok: true; token: string } | { error: string }>` — ADMIN-only (this touches a shared academy resource, not a single-academy-scoped one, so it's global-admin territory, not DIRECTOR).
- Consumed by: staff, to get the actual kiosk URL to load on a tablet (Task 6). Phase 1 seeded each academy's `kioskTokenHash` from a random token whose plaintext was never saved anywhere — this task is what makes a real, usable kiosk URL obtainable for the first time.

- [ ] **Step 1: Add `/admin` to protected routes**

In `src/middleware.ts`, add `"/admin"` to the `PROTECTED_PREFIXES` array (alongside the existing `"/dashboard"`, `"/students"`).

- [ ] **Step 2: Write the regenerate action**

Create `src/app/[locale]/admin/kiosk-tokens/actions.ts`. `"use server"`, `requireStaffSession(["ADMIN"])`, take an `academyId` (validate it's a real academy id via a `findUniqueOrThrow`, not blind trust), generate a new token via `generateRandomToken()` (`@/lib/crypto`, already exists), hash it via `digestLookupSecret(token, requireEnv("CODE_PEPPER"))`, `update` the `Academy.kioskTokenHash`, return the **plaintext token once** in the action's return value (never store it, never log it) so the admin UI can display the full kiosk URL (`/{locale}/kiosk/{academySlug}?token={token}`) for them to copy onto the tablet.

- [ ] **Step 3: Write the admin page**

Create `src/app/[locale]/admin/kiosk-tokens/page.tsx`: `requireStaffSession(["ADMIN"])`, list both academies with a "regenerate" button per academy (client component + `useActionState`, following this codebase's established form pattern), showing the resulting kiosk URL prominently with a "copy this now, it won't be shown again" warning — same spirit as the signup code / admin temp-password patterns already established in Phases 1-2.

- [ ] **Step 4: Add message keys, verify, commit**

Add keys under a new `"adminKioskTokens"` top-level namespace in both locale files.

Run: `pnpm build` — succeeds. Manually verify as ADMIN: regenerate a token, confirm the shown URL round-trips (you'll use it for real in Task 6's manual test).

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add admin kiosk device-token management"
git push origin feat/phase-3-attendance
```

---

### Task 5: Check-in core (`POST /api/kiosk/check-in`)

**Files:**
- Create: `src/app/api/kiosk/check-in/route.ts`, `src/lib/kiosk/perform-check-in.ts`, `tests/integration/perform-check-in.test.ts`

**Interfaces:**
- Produces: `performCheckIn(input: { academyId: string; code: string; source: "KIOSK" | "PORTAL" | "STAFF" }): Promise<CheckInResult>` from `@/lib/kiosk/perform-check-in` — the actual reusable core logic (Phase 5's portal self-check-in will call this same function with `source: "PORTAL"`). The Route Handler is a thin wrapper: token/rate-limit checks, then calls this, then shapes the HTTP response.
- `CheckInResult` is a discriminated union: `{ ok: true; student: {...}; summary: AtBeltSummary; earnedStripe: boolean; isVisitor: boolean } | { ok: false; error: "invalid_code" | "no_active_class" | "already_checked_in" }`.

- [ ] **Step 1: Write the core check-in logic**

Create `src/lib/kiosk/perform-check-in.ts`:

```ts
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import { isWithinCheckInWindow } from "@/lib/scheduling/check-in-window";
import { getAtBeltSummary, type AtBeltSummary } from "@/lib/students/attendance-summary";
import { AttendanceType, StudentStatus, type AttendanceSource } from "@/generated/prisma/client";

export type CheckInResult =
  | {
      ok: true;
      student: { firstName: string; lastName: string; currentBelt: string; currentStripes: number };
      summary: AtBeltSummary;
      earnedStripe: boolean;
      isVisitor: boolean;
    }
  | { ok: false; error: "invalid_code" | "no_active_class" | "already_checked_in" };

export async function performCheckIn(input: {
  academyId: string;
  code: string;
  source: AttendanceSource;
  now?: Date;
}): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  const codeHash = digestLookupSecret(input.code, requireEnv("CODE_PEPPER"));
  const student = await prisma.student.findUnique({ where: { codeHash } });

  if (!student || student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "invalid_code" };
  }

  const sessions = await prisma.classSession.findMany({
    where: { academyId: input.academyId, active: true },
  });

  const activeSession = sessions.find((s) => isWithinCheckInWindow(s, now));

  if (!activeSession) {
    return { ok: false, error: "no_active_class" };
  }

  const attendanceDate = toAttendanceDate(now);
  const summaryBefore = await getAtBeltSummary(student.id);

  try {
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: input.academyId,
        classSessionId: activeSession.id,
        occurredAt: now,
        date: attendanceDate,
        type: AttendanceType.CHECKIN,
        delta: 1,
        source: input.source,
      },
    });
  } catch (error) {
    // Postgres unique_violation (23P01) / Prisma P2002 on the
    // (studentId, classSessionId, date) constraint — the app-level check
    // above is a friendly pre-check; this is the real backstop for a race.
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: "already_checked_in" };
    }
    throw error;
  }

  const summaryAfter = await getAtBeltSummary(student.id);

  return {
    ok: true,
    student: {
      firstName: student.firstName,
      lastName: student.lastName,
      currentBelt: student.currentBelt,
      currentStripes: student.currentStripes,
    },
    summary: summaryAfter,
    // "This specific check-in was the one that crossed the threshold" — works
    // for both the ordinary stripe-earning case and the exam-eligibility case,
    // since getAtBeltSummary already folds exam-threshold progress into
    // remainingToNextStripe once a student is at max stripes.
    earnedStripe: summaryBefore.remainingToNextStripe === 1 && summaryAfter.remainingToNextStripe !== 1,
    isVisitor: student.homeAcademyId !== input.academyId,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
```

(The `input.now` parameter exists specifically so integration tests can inject a fixed reference time instead of fighting real wall-clock time against the seeded schedule — production call sites simply omit it and get `new Date()`.)

- [ ] **Step 2: Write the Route Handler**

Create `src/app/api/kiosk/check-in/route.ts`. `POST` only. Read `academySlug` and `token` from the request body (or query string — your choice, but be consistent with what Task 6's kiosk page will send), look up the `Academy` by slug, verify `digestLookupSecret(token, pepper) === academy.kioskTokenHash` (constant-shape comparison is fine here — this isn't a password, and the token space is large; a straightforward `===` on the two hash strings is acceptable), then call `checkKioskRateLimit` (Task 3) — if not allowed, return the appropriate HTTP 429-style JSON response with the reason and `retryAfterSeconds` and do NOT call `performCheckIn` at all. Otherwise call `performCheckIn({ academyId: academy.id, code, source: "KIOSK" })`, call `recordKioskAttempt(academy.id, ipAddress, result.ok)` (extract `ipAddress` from the `x-forwarded-for` header via `headers()` from `next/headers`, falling back to a placeholder string if absent — this route needs to run in the Node runtime, not Edge, since it touches Prisma), and return the result as JSON with an appropriate status code (200 for `ok: true`, 400/404-shaped for the various `ok: false` reasons, 401/403 for a bad kiosk token — pick sensible codes and be consistent, this is an internal API only the kiosk page and its offline queue call).

- [ ] **Step 3: Write the integration test**

Create `tests/integration/perform-check-in.test.ts` (test `performCheckIn` directly, not the Route Handler — that keeps the test fast and DB-focused, matching this codebase's established pattern of testing the underlying function directly for logic that doesn't depend on cookies/headers). Seed a throwaway ACTIVE student and use a real seeded Escazú `ClassSession`, passing an explicit `now` (the `input.now` parameter above) computed to fall inside that session's known window rather than fighting real wall-clock time. Cover:
- A valid code, within an active class's window → `ok: true`, correct `student`/`summary`, `isVisitor: false` for a student checking in at their home academy.
- The same student checking in again immediately for the SAME class/day → `ok: false, error: "already_checked_in"`.
- An invalid/nonexistent code → `ok: false, error: "invalid_code"`.
- A code belonging to a `PENDING` or `ARCHIVED` student → `ok: false, error: "invalid_code"` (not a more specific error — don't leak account status to an unauthenticated kiosk).
- A `now` outside any session's window for the given academy → `ok: false, error: "no_active_class"`.
- A student whose `homeAcademyId` is Escalante checking in at Escazú → `ok: true`, `isVisitor: true`, and the resulting `AttendanceRecord.academyId` is Escazú (not the student's home academy).
- A check-in that crosses a stripe threshold (seed the student at 29 attendances since `beltAwardedAt`, at a belt/requirement combination where the 30th check-in should cross it) → `earnedStripe: true`.

- [ ] **Step 4: Run tests, commit, push**

Run: `pnpm test:integration` — all pass.

Run: `pnpm build` — succeeds.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add check-in core logic and the kiosk check-in API route"
git push origin feat/phase-3-attendance
```

---

### Task 6: Kiosk UI page

**Files:**
- Create: `src/app/[locale]/kiosk/[academySlug]/page.tsx`, `src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx`
- Modify: `messages/es.json`, `messages/en.json`, possibly `src/lib/kiosk/perform-check-in.ts` (see Step 2)

**Interfaces:**
- Consumes: `POST /api/kiosk/check-in` (Task 5) via `fetch`, `BeltGraphic` (Phase 1).

- [ ] **Step 1: Write the server page shell**

`src/app/[locale]/kiosk/[academySlug]/page.tsx`: **no auth guard** — this is spec's explicitly public, unauthenticated route (do not wrap it in `requireStaffSession` or add it to `middleware.ts`'s protected prefixes). Look up the `Academy` by `academySlug` (404 via `notFound()` if it doesn't exist or `active: false`), pass the academy's `id`/`name`/`slug` and the `token` query param down to a client component.

- [ ] **Step 2: Write the kiosk client component**

`kiosk-client.tsx` (`"use client"`): the academy name displayed at all times (spec §4.1). A big numeric keypad (0-9, clear, submit — or auto-submit at 4 digits, your call) for the 4-digit code. On submit, `fetch("/api/kiosk/check-in", { method: "POST", body: JSON.stringify({ academySlug, token, code }) })`.

On success: show for ~6 seconds then reset to the keypad — student name, the `BeltGraphic` component (belt + stripes from the response), "attendances at current belt" + "remaining to next stripe/exam" from `summary`, a distinct congratulation state when `earnedStripe: true`, and the visitor badge (e.g. "Visitante de [home academy name]" — spec §4.1's example is literally "Visitante de Escalante"). `performCheckIn`'s current return shape does NOT include the home academy's name — before writing this component, add it: modify `CheckInResult`'s `ok: true` branch to include `homeAcademyName: string` (fetch it alongside the student lookup in `perform-check-in.ts`), and update Task 5's integration test to assert it's present and correct for the visitor case. This is a small, in-scope addition to close a real gap, not a redesign.

On `no_active_class`: show "No hay clase activa" / "No active class" and refuse the check-in (don't retry the fetch automatically).

On `already_checked_in` / `invalid_code`: show a clear, brief error, then reset to the keypad.

On a `429`-shaped rate-limit/lockout response: show the lockout message with the `retryAfterSeconds` if present, and disable further submission until that time elapses (client-side countdown is fine — the server is the real enforcement).

**Never display anything beyond name, belt, stripes, and the visitor badge** — no phone, email, or payment status, per spec's explicit kiosk security requirement.

- [ ] **Step 3: Add message keys, verify manually, commit**

Add keys under a new `"kiosk"` top-level namespace in both locale files.

Run: `pnpm build` — succeeds. Manually verify with `pnpm dev`: use the real kiosk URL from Task 4's admin page (`/{locale}/kiosk/escazu?token=...`) during one of Escazú's actual scheduled windows (or temporarily edit a seeded `ClassSession.startTime`/`dayOfWeek` in the DB to match "right now" for testing purposes, then restore it — do not leave test data in a state that breaks Phase 1's seed assumptions). Check in a real ACTIVE student (you may need to manually flip a signed-up student's `status` to `ACTIVE` via `pnpm exec prisma db execute`, or use Phase 2's `approveStudent` action if a UI path exists for it already). Confirm the full display cycle, the "no active class" state outside any window, and a locked-out state after 5 deliberate bad codes.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add kiosk UI page"
git push origin feat/phase-3-attendance
```

---

### Task 7: PWA + offline check-in queue

**Files:**
- Create: `public/manifest.json`, `public/sw.js`, `src/lib/kiosk/offline-queue.ts`
- Modify: `src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx`, `src/app/layout.tsx` (or wherever `<head>` metadata/manifest link belongs in this app's root layout)

**Interfaces:**
- Produces: `enqueueOfflineCheckIn(payload): Promise<void>`, `flushOfflineQueue(): Promise<void>` from `@/lib/kiosk/offline-queue` (IndexedDB-backed — use the browser's native `indexedDB` API directly or a minimal wrapper; this app has no existing IndexedDB dependency, and pulling in a heavy library for one small queue isn't warranted).

**Scope, deliberately kept modest:** spec §10 asks for "a PWA with an offline check-in queue that syncs when the connection returns" — this task builds exactly that (installability + offline check-in queuing/replay), not a full app-shell-caching PWA. Don't over-build asset caching beyond what's needed for the kiosk page itself to load once already visited.

- [ ] **Step 1: Add the web app manifest**

Create `public/manifest.json` with `name`, `short_name`, `start_url` (something like `/es/kiosk` — actually, since the kiosk is per-academy via a slug, `start_url` should probably be relative/generic; use `"."` or omit a hardcoded academy and let the manifest be generic app metadata, since a specific tablet will bookmark/install from its own already-loaded academy URL), `display: "standalone"`, `background_color`, `theme_color`, and at least one icon (reuse `src/app/favicon.ico` or generate/reference a simple icon asset — check what image assets already exist in `public/`/`src/app/` before creating a new one).

- [ ] **Step 2: Write a minimal service worker**

Create `public/sw.js`. Keep this deliberately simple: don't attempt to pre-cache Next.js's content-hashed JS/CSS bundle URLs (they change every build, and hardcoding them is fragile). Background Sync API support is inconsistent across browsers, so **don't** rely on a service-worker `sync` event for the offline-queue flush — instead, have the service worker exist mainly to satisfy PWA-installability requirements (a minimal `install`/`activate`/`fetch` handler is enough — a `fetch` handler that just falls through to the network for everything is fine here), and do the actual offline-detection/queue-flush logic in the CLIENT-side code (`kiosk-client.tsx`, Step 4) via `navigator.onLine` and the `online` window event instead. This is simpler, more portable, and sufficient for spec's actual requirement ("syncs when the connection returns").

- [ ] **Step 3: Write the offline queue**

`src/lib/kiosk/offline-queue.ts`: a small IndexedDB-backed FIFO queue storing `{ academySlug, token, code, queuedAt }` entries. `enqueueOfflineCheckIn` adds one. `flushOfflineQueue` reads all queued entries in order, POSTs each to `/api/kiosk/check-in` one at a time (not in parallel — a student who checked in twice while offline, once for real and once as a mis-tap, should have the SECOND one correctly rejected as `already_checked_in` by the server, which only works if they're replayed sequentially and each result is awaited before the next), removes each entry from the queue on either a definitive success OR a definitive rejection (`already_checked_in`, `invalid_code` — these are real answers, not connectivity failures), but LEAVES an entry in the queue and stops flushing if a request itself fails at the network level (still offline, or the server is down) — retry the whole flush on the next `online` event.

- [ ] **Step 4: Wire it into the kiosk client**

In `kiosk-client.tsx`: register the service worker on mount (`navigator.serviceWorker.register("/sw.js")`, guarded by a feature check). On code submission, if `navigator.onLine` is false (or the `fetch` itself throws a network error), call `enqueueOfflineCheckIn` instead of showing an error, and show a distinct "saved, will sync when back online" state to the student rather than a failure — the spec's whole point is that a student who showed up must not lose their class due to wifi. Listen for the `online` window event and call `flushOfflineQueue()` when it fires (and once on mount, in case the queue has leftover entries from a previous session).

- [ ] **Step 5: Verify manually and commit**

Run: `pnpm build` — succeeds. Manually verify with `pnpm dev` + your browser's devtools network throttling set to "Offline": submit a code, confirm the "saved, will sync" state (not an error), confirm no fetch actually reached the server while offline (check the Network tab), re-enable the network, confirm the queued check-in actually lands (check the DB or the roster/detail page for the new `AttendanceRecord`).

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add PWA manifest, service worker, and offline check-in queue"
git push origin feat/phase-3-attendance
```

---

### Task 8: Staff manual attendance adjustments

**Files:**
- Create: `src/app/[locale]/students/[id]/adjustment-actions.ts`
- Modify: `src/app/[locale]/students/[id]/page.tsx` (add an adjustment form/section), `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces: `addAttendanceAdjustment(_prevState, formData): Promise<ActionState>` — `"use server"`.

- [ ] **Step 1: Write the adjustment action**

Create `src/app/[locale]/students/[id]/adjustment-actions.ts`. `requireStaffSession(["ADMIN", "DIRECTOR", "INSTRUCTOR"])` — note this is a WIDER role set than Phase 2's `updateStudent`/`archiveStudent` (`ADMIN`/`DIRECTOR` only), matching spec §3's explicit grant of attendance marking/correction to `INSTRUCTOR`. Validate with zod: `studentId`, `delta` (a nonzero integer, positive or negative), `reason` (required, non-empty string — spec §2.2 makes this mandatory, not optional). Re-fetch the student, re-check `isAcademyInScope` against its real `homeAcademyId` (same discipline as every other write in this app — never trust a hidden field). Create the `AttendanceRecord` (`type: ADJUSTMENT`, `delta`, `reason`, `source: STAFF`, `createdById: session.userId`, `occurredAt: new Date()`, `date` via `toAttendanceDate` from Task 1, `academyId`: the student's home academy — an adjustment isn't tied to a specific check-in location the way a kiosk record is, so use `homeAcademyId` here). Write an `AuditLog` row (`action: "attendance.adjustment"`, `entityType: "AttendanceRecord"`, `entityId`: the new record's id, `before: null`, `after: { delta, reason }`).

- [ ] **Step 2: Add the UI to the student detail page**

Add an "Add adjustment" form to `src/app/[locale]/students/[id]/page.tsx` (or a client sub-component, following this app's established pattern), visible to any staff role (not gated to ADMIN/DIRECTOR the way edit/archive are). Show the student's current `AtBeltSummary` (Task 2) somewhere on this page too, if it isn't already shown — this is a natural, low-cost place to surface it now that the function exists.

- [ ] **Step 3: Add message keys, test, verify, commit**

Add an integration test (new file or extend `tests/integration/student-detail-actions.test.ts` from Phase 2) covering: a positive adjustment increases `atBeltCount` (via `getAtBeltSummary`); a negative adjustment decreases it and can even bring a student back below a threshold they'd already crossed (spec §10's own eligibility-engine test list calls this out explicitly, even though the *engine* is Phase 4 — the *data path* that makes it possible is this task, so prove it here); an INSTRUCTOR can successfully add an adjustment (unlike Phase 2's student-edit actions); an out-of-scope DIRECTOR is rejected; a missing `reason` is rejected by validation before any DB write.

Run: `pnpm test:integration` — all pass. Run: `pnpm build` — succeeds.

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add staff manual attendance adjustments"
git push origin feat/phase-3-attendance
```

---

### Task 9: Admin class-schedule CRUD + full phase verification

**Files:**
- Create: `src/app/[locale]/admin/schedule/page.tsx`, `src/app/[locale]/admin/schedule/actions.ts`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:** none new beyond the actions themselves.

- [ ] **Step 1: Write the schedule CRUD actions**

Create `src/app/[locale]/admin/schedule/actions.ts`: `listClassSessions(academyId)` (plain function — apply the same plain-function-vs-`"use server"`-action file-separation discipline Phase 2 established if a client component needs to import a `"use server"` action from a file that would otherwise also export this plain Prisma-touching function; check whether that constraint actually applies here given this page's structure before assuming it does), `createClassSession`, `updateClassSession`, `deactivateClassSession` (sets `active: false`, never deletes) — all three writes `requireStaffSession(["ADMIN"])` (schedule changes are academy policy calls per spec §5, admin-only, not DIRECTOR — DIRECTOR manages payments/promotions per §3's role table but schedule structure itself isn't listed as a DIRECTOR power). Validate `dayOfWeek`/`startTime` (`"HH:mm"` format)/`durationMinutes`/`name`/`type`/`countsTowardPromotion` with zod. Enforce the existing `@@unique([academyId, dayOfWeek, startTime, name])` constraint gracefully (catch `P2002`, return a friendly "a session already exists at this day/time/name" error).

- [ ] **Step 2: Write the admin schedule page**

`src/app/[locale]/admin/schedule/page.tsx`: `requireStaffSession(["ADMIN"])`, an academy selector (Escazú/Escalante), a table of that academy's sessions (including inactive ones, visually distinguished) with edit/deactivate controls, and a create form. Reuse the existing `belt`/enum-driven dropdown pattern from Phase 2's signup form for the `type`/`dayOfWeek` selects (real enum values, locale-keyed labels — add new `dayOfWeek.*`/`classType.*` message keys following the same structure as the existing `belt.*` keys).

- [ ] **Step 3: Add message keys, test, verify**

Add an integration test covering: creating a session, updating one, deactivating one (confirm `active: false`, row still exists — `findMany` including inactive still returns it), the duplicate-slot rejection, and a non-ADMIN (DIRECTOR or INSTRUCTOR) being rejected by all three write actions.

- [ ] **Step 4: Full-suite verification**

```bash
pnpm db:down
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm test
pnpm build
pnpm lint
```

All must pass/succeed. Then manually walk the whole phase end-to-end once more: regenerate a kiosk token (Task 4) → check in a student at the kiosk during a real window, including the visitor-badge case (Task 5/6) → confirm the offline-queue behavior once (Task 7) → add a manual adjustment as an INSTRUCTOR (Task 8) → create/edit/deactivate a class session as ADMIN (this task).

- [ ] **Step 5: Commit, push, prepare for final review**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add admin class-schedule CRUD"
git push origin feat/phase-3-attendance
```

Phase 3 is complete once this task's full-suite verification passes. This plan's controller will dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
