# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js 15 + Prisma + Postgres foundation for the Alliance Jiu-Jitsu app — full schema (with `academyId` tenancy from the first migration), seed data for both academies, i18n scaffolding, and an accessible belt-graphic component with a visual test page — so every later phase builds on real, migrated tables instead of retrofitting them.

**Architecture:** A single Next.js 15 App Router project at the repo root (pnpm-managed). Prisma owns the schema/migrations against a local Dockerized Postgres for now (swap `DATABASE_URL` for Neon later — no code change needed). next-intl handles locale routing (`/es`, `/en`) with Spanish as default. shadcn/ui + Tailwind (as scaffolded by `create-next-app`) supply the component primitives. No auth, no business-logic routes, no attendance/promotion/payment UI yet — those are Phase 2+.

**Tech Stack:** Next.js 15 (App Router, TS, React 19), Prisma + PostgreSQL 16 (Docker for dev), Tailwind CSS + shadcn/ui, next-intl, bcryptjs (password/token hashing), Vitest + Testing Library (unit), Vitest against real Postgres (integration), pnpm.

**Spec:** `PROJECT_SPEC.md` (repo root) — sections 1, 1b, 2.1, 5, 6, 8, 9 (Phase 1), 10 are the ones this plan implements.

## Global Constraints

- Stack is fixed by the spec: Next.js 15 (not 16), App Router, TypeScript, Prisma, PostgreSQL, Tailwind + shadcn/ui, next-intl. Do not substitute.
- Every location-owned table carries `academyId` from this very first migration — retrofitting tenancy later is explicitly called out as the most expensive mistake to avoid (§1b).
- `Student.codeHash` must be globally unique (not per-academy) — enforce with a DB-level unique constraint even though Phase 1 seeds no students (§1b, §4.1).
- `AttendanceRecord` is an append-only ledger — never a mutable counter column (§2.2). Phase 1 only creates the table; no writes happen until Phase 3.
- Belt/stripe thresholds live in a `BeltRequirement` DB table, admin-editable later — never hardcoded in application code (§2.1).
- No hard deletes anywhere (§10) — schema uses status/`active` flags, not cascading deletes, for business data.
- Every staff mutation eventually writes an `AuditLog` row (§8) — Phase 1 only creates the table; no staff mutations exist yet to log.
- Spanish is the default locale; no hardcoded user-facing strings — all copy goes through next-intl message files (§1).
- The belt graphic needs a visible text alternative — color alone must never convey rank (§10).
- All wall-clock scheduling in this app uses `America/Costa_Rica` (UTC-6, fixed, no DST) (§1).
- Package manager: pnpm. Dev database: local Docker Postgres now, Neon connection string swapped in later (user decision, not spec-mandated).
- Repo already has `origin` set to `https://github.com/agpiedra/BJJ-Alliance-Project.git` on branch `main` — every task ends with a commit **and a push to `origin main`**. This repo has NO branch protection on `main` — push directly there. (A parent-directory `CLAUDE.md`/cross-project memory describes a *different, unrelated* project with a push-protected `master` — that does not apply here.)
- **Ruling (made during Task 3):** the installed Prisma version is 7.10.0 (a real, current, stable release — not a hallucination; `latest` on npm is actually an `8.0.0-rc` pre-release, so pinning 7.10.0 was correct). Prisma 7's default `prisma-client` generator outputs the client to a project-local path (`../src/generated/prisma` relative to `prisma/schema.prisma`, i.e. `src/generated/prisma`) rather than to the `@prisma/client` package the way the older `prisma-client-js` generator did. Every task below has already been updated to import from the generated path instead of `"@prisma/client"` — do not revert to `"@prisma/client"` imports.
- `prisma init` on this Prisma version also scaffolds `.agents/`, `.windsurf/`, and `skills-lock.json` (AI-editor skill files) as a side effect — never commit these; they are out of scope for every task. Use targeted `git add <files>` in every task's commit step, never `git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'`, so these (and this plan's own `docs/` directory) don't get swept into a commit by accident.

---

### Task 1: Next.js project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts` (or whatever `create-next-app` generates), `.eslintrc.json`, `.gitignore`, `README.md`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Modify: none (fresh scaffold; `PROJECT_SPEC.md` and `.git/` already exist and must survive)

**Interfaces:**
- Produces: a working `pnpm dev` / `pnpm build` Next.js 15 app at the repo root, with `src/` layout and the `@/*` import alias, that later tasks add files into.

- [ ] **Step 1: Scaffold the app in the existing repo root**

Run from the repo root (`BJJ Alliance Project/`):

```bash
pnpm dlx create-next-app@15 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes
```

If it refuses because the directory isn't empty (it should tolerate `.git` and `PROJECT_SPEC.md`, but if not): run the same command targeting `../bjj-scaffold-tmp`, then move every generated file and folder (everything except a `.git` you'd overwrite) into the repo root, then delete `../bjj-scaffold-tmp`.

- [ ] **Step 2: Verify the scaffold builds and runs**

Run: `pnpm build`
Expected: build succeeds with no errors.

Run: `pnpm dev` (then stop it once it prints "Ready")
Expected: dev server starts on port 3000 with no errors.

- [ ] **Step 3: Confirm the pre-existing files survived**

Run: `ls PROJECT_SPEC.md` and `git log --oneline -3`
Expected: `PROJECT_SPEC.md` still exists; the pre-existing "chore: initial commit" entry is still in history.

- [ ] **Step 4: Add project-specific `.gitignore` entries**

Ensure `.gitignore` (whatever `create-next-app` generated) also contains these lines (append any missing ones):

```
# Env files (never commit real secrets/local DB credentials)
.env
.env.local

# Prisma
/prisma/dev.db
```

- [ ] **Step 5: Write the project README**

Replace the auto-generated `README.md` content with:

```markdown
# Alliance Jiu-Jitsu — Attendance & Belt Progression App

Replaces GymDesk for Alliance Jiu-Jitsu Costa Rica (Escazú + Escalante academies).
See `PROJECT_SPEC.md` for the full product spec and `docs/superpowers/plans/` for
phase-by-phase implementation plans.

## Local setup

1. `pnpm install`
2. Copy `.env.example` to `.env` (defaults already match `docker-compose.yml`)
3. `pnpm db:up` — starts local Postgres in Docker
4. `pnpm db:migrate` — applies all migrations
5. `pnpm db:seed` — seeds both academies, belt requirements, Escazú's class
   schedule, payment plans, and one admin user (credentials printed to console
   on first run — change the password after logging in once auth ships)
6. `pnpm dev` — starts the app at http://localhost:3000 (redirects to `/es`)

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint`
- `pnpm test` — unit + integration tests (integration tests need `pnpm db:up`
  and a seeded database)
- `pnpm db:up` / `pnpm db:down` — local Postgres via Docker Compose
- `pnpm db:migrate` — `prisma migrate dev`
- `pnpm db:seed` — `prisma db seed`

## Dev-only pages

- `/es/dev/belts` (or `/en/dev/belts`) — visual QA page showing all 5 belts ×
  0–4 stripes for the belt-graphic component.
```

- [ ] **Step 6: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "chore: scaffold Next.js 15 app (TS, Tailwind, App Router, src/)"
git push origin main
```

---

### Task 2: shadcn/ui setup

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/components/ui/button.tsx`, `src/components/ui/card.tsx`, `src/components/ui/badge.tsx`
- Modify: `tailwind.config.ts` / `src/app/globals.css` (shadcn's init writes theme tokens into whichever of these its detected Tailwind version uses)

**Interfaces:**
- Produces: `cn()` helper at `@/lib/utils`, and `Button`/`Card`/`Badge` components at `@/components/ui/*` for later screens to import.

- [ ] **Step 1: Initialize shadcn/ui non-interactively**

```bash
pnpm dlx shadcn@latest init -y -d
```

If that errors or behaves unexpectedly (e.g. it tries to scaffold a whole new app), re-run as:

```bash
pnpm dlx shadcn@latest init -y
```

and answer follow-on prompts (if any slip through) with the defaults.

- [ ] **Step 2: Add the base components this build will need**

```bash
pnpm dlx shadcn@latest add -y button card badge
```

- [ ] **Step 3: Verify the build still passes**

Run: `pnpm build`
Expected: succeeds; `src/components/ui/button.tsx`, `card.tsx`, `badge.tsx` exist.

- [ ] **Step 4: Smoke-test Button renders**

Create `tests/unit/button.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Guardar</Button>);
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();
  });
});
```

(This test can't run yet — Vitest isn't installed until Task 5. Leave the file in place; Task 5's step 4 will run the full suite including this file.)

- [ ] **Step 5: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "chore: initialize shadcn/ui with button, card, badge"
git push origin main
```

---

### Task 3: Local Postgres + Prisma init

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `.env`, `prisma/schema.prisma` (initial datasource/generator block only — models come in Task 4)

**Interfaces:**
- Produces: `DATABASE_URL` env var wired to a local Postgres container; `prisma/schema.prisma` ready for models.

- [ ] **Step 1: Add Prisma**

```bash
pnpm add -D prisma
pnpm add @prisma/client
```

Verify in `package.json` that the `prisma` and `@prisma/client` versions match exactly (same version string) — if pnpm resolved them differently, run `pnpm add prisma@<version> @prisma/client@<version>` pinning both to the higher of the two.

- [ ] **Step 2: Create the Docker Compose file**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: alliance
      POSTGRES_PASSWORD: alliance_dev_password
      POSTGRES_DB: alliance_bjj
    ports:
      - "5432:5432"
    volumes:
      - alliance_pgdata:/var/lib/postgresql/data

volumes:
  alliance_pgdata:
```

- [ ] **Step 3: Create env files**

Create `.env.example`:

```
DATABASE_URL="postgresql://alliance:alliance_dev_password@localhost:5432/alliance_bjj?schema=public"
```

Create `.env` with the same content (this file is gitignored per Task 1 Step 4).

- [ ] **Step 4: Start Postgres and initialize Prisma**

```bash
pnpm exec docker compose up -d
pnpm exec prisma init --datasource-provider postgresql
```

`prisma init` will create `prisma/schema.prisma` and may overwrite `.env` — after it runs, confirm `.env` still contains the exact `DATABASE_URL` from Step 3 (re-paste it if `prisma init` replaced it with a placeholder).

- [ ] **Step 5: Verify connectivity**

Run: `pnpm exec prisma db pull`
Expected: connects successfully and reports an empty schema (no tables yet) — this confirms `DATABASE_URL` is correct and Postgres is reachable.

- [ ] **Step 6: Add DB scripts to `package.json`**

Add to the `"scripts"` block:

```json
"db:up": "docker compose up -d",
"db:down": "docker compose down",
"db:migrate": "prisma migrate dev",
"db:seed": "prisma db seed",
"db:generate": "prisma generate"
```

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "chore: add local Postgres via Docker Compose and initialize Prisma"
git push origin main
```

(`.env` itself is not committed — only `.env.example`, `docker-compose.yml`, and `prisma/schema.prisma`.)

---

### Task 4: Full Prisma schema + initial migration

**Files:**
- Modify: `prisma/schema.prisma` (replace the placeholder from Task 3 with the full Phase 1 data model), `.gitignore` (ignore the generated Prisma client output)
- Create: `prisma/migrations/<timestamp>_init/migration.sql` (generated, then hand-edited once)

**Interfaces:**
- Produces: every table, enum, relation, and constraint from spec §8, migrated into the local database — the schema every later task and phase reads/writes against.

- [ ] **Step 1: Write the full schema**

Replace the contents of `prisma/schema.prisma` with:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

Note: no `url` line here — this Prisma version (7.10.0) reads `DATABASE_URL` from `prisma7.config.ts` (created in Task 3), not from the schema file.

```prisma

enum Role {
  ADMIN
  DIRECTOR
  INSTRUCTOR
  STUDENT
}

enum StaffRole {
  DIRECTOR
  INSTRUCTOR
}

enum Belt {
  WHITE
  BLUE
  PURPLE
  BROWN
  BLACK
}

enum StudentStatus {
  PENDING
  ACTIVE
  INACTIVE
  ARCHIVED
}

enum AttendanceType {
  CHECKIN
  ADJUSTMENT
}

enum AttendanceSource {
  KIOSK
  PORTAL
  STAFF
}

enum PaymentStatus {
  PAID
  PENDING
  PROMO
  EXEMPT
}

enum DayOfWeek {
  MONDAY
  TUESDAY
  WEDNESDAY
  THURSDAY
  FRIDAY
  SATURDAY
  SUNDAY
}

enum ClassType {
  GI
  NO_GI
  STRIKING
  KIDS
  OPEN_MAT
  COMPETITION
}

model Academy {
  id             String   @id @default(cuid())
  name           String
  slug           String   @unique
  address        String?
  timezone       String   @default("America/Costa_Rica")
  kioskTokenHash String   @unique
  active         Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  staffAssignments  StaffAssignment[]
  homeStudents      Student[]          @relation("HomeAcademy")
  classSessions     ClassSession[]
  attendanceRecords AttendanceRecord[]
  promotions        Promotion[]
  beltRequirements  BeltRequirement[]
  paymentPlans      PaymentPlan[]
  paymentPeriods    PaymentPeriod[]
  auditLogs         AuditLog[]
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  role         Role
  locale       String   @default("es")
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  staffAssignments       StaffAssignment[]
  student                Student?
  auditLogs              AuditLog[]
  promotionsAwarded      Promotion[]
  paymentPeriodsRecorded PaymentPeriod[]
}

model StaffAssignment {
  id        String    @id @default(cuid())
  userId    String
  academyId String
  role      StaffRole
  createdAt DateTime  @default(now())

  user    User    @relation(fields: [userId], references: [id])
  academy Academy @relation(fields: [academyId], references: [id])

  @@unique([userId, academyId])
  @@index([academyId])
}

model Student {
  id               String        @id @default(cuid())
  userId           String?       @unique
  homeAcademyId    String
  firstName        String
  lastName         String
  phone            String
  email            String
  dateOfBirth      DateTime?
  guardianName     String?
  guardianPhone    String?
  emergencyContact String?
  currentBelt      Belt          @default(WHITE)
  currentStripes   Int           @default(0)
  beltAwardedAt    DateTime      @default(now())
  codeHash         String        @unique
  status           StudentStatus @default(PENDING)
  joinedAt         DateTime      @default(now())
  notes            String?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  user              User?              @relation(fields: [userId], references: [id])
  homeAcademy       Academy            @relation("HomeAcademy", fields: [homeAcademyId], references: [id])
  attendanceRecords AttendanceRecord[]
  promotions        Promotion[]
  paymentPeriods    PaymentPeriod[]

  @@index([homeAcademyId])
}

model ClassSession {
  id                    String    @id @default(cuid())
  academyId             String
  dayOfWeek             DayOfWeek
  startTime             String
  durationMinutes       Int
  name                  String
  type                  ClassType
  countsTowardPromotion Boolean   @default(true)
  active                Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  academy           Academy            @relation(fields: [academyId], references: [id])
  attendanceRecords AttendanceRecord[]

  @@unique([academyId, dayOfWeek, startTime, name])
  @@index([academyId])
}

model AttendanceRecord {
  id             String           @id @default(cuid())
  studentId      String
  academyId      String
  classSessionId String?
  occurredAt     DateTime
  date           DateTime         @db.Date
  type           AttendanceType
  delta          Int              @default(1)
  source         AttendanceSource
  reason         String?
  createdById    String?
  createdAt      DateTime         @default(now())

  student      Student       @relation(fields: [studentId], references: [id])
  academy      Academy       @relation(fields: [academyId], references: [id])
  classSession ClassSession? @relation(fields: [classSessionId], references: [id])

  @@unique([studentId, classSessionId, date])
  @@index([studentId, occurredAt])
  @@index([academyId, occurredAt])
}

model Promotion {
  id          String   @id @default(cuid())
  studentId   String
  academyId   String
  fromBelt    Belt
  fromStripes Int
  toBelt      Belt
  toStripes   Int
  awardedById String
  awardedAt   DateTime @default(now())
  notes       String?

  student   Student @relation(fields: [studentId], references: [id])
  academy   Academy @relation(fields: [academyId], references: [id])
  awardedBy User    @relation(fields: [awardedById], references: [id])

  @@index([studentId])
}

model BeltRequirement {
  id                   String   @id @default(cuid())
  academyId            String?
  belt                 Belt
  attendancesPerStripe Int
  maxStripes           Int
  attendancesForExam   Int
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  academy Academy? @relation(fields: [academyId], references: [id])

  @@unique([academyId, belt])
}

model PaymentPlan {
  id          String   @id @default(cuid())
  academyId   String
  name        String
  description String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  academy        Academy         @relation(fields: [academyId], references: [id])
  paymentPeriods PaymentPeriod[]

  @@unique([academyId, name])
}

model PaymentPeriod {
  id           String        @id @default(cuid())
  studentId    String
  academyId    String
  year         Int
  month        Int
  planId       String
  status       PaymentStatus
  amount       Decimal?      @db.Decimal(10, 2)
  notes        String?
  recordedById String
  recordedAt   DateTime      @default(now())

  student    Student     @relation(fields: [studentId], references: [id])
  academy    Academy     @relation(fields: [academyId], references: [id])
  plan       PaymentPlan @relation(fields: [planId], references: [id])
  recordedBy User        @relation(fields: [recordedById], references: [id])

  @@unique([studentId, year, month])
  @@index([academyId, year, month])
}

model AuditLog {
  id         String   @id @default(cuid())
  actorId    String
  academyId  String?
  action     String
  entityType String
  entityId   String
  before     Json?
  after      Json?
  createdAt  DateTime @default(now())

  actor   User     @relation(fields: [actorId], references: [id])
  academy Academy? @relation(fields: [academyId], references: [id])

  @@index([entityType, entityId])
  @@index([actorId])
}
```

- [ ] **Step 2: Validate the schema**

Run: `pnpm exec prisma validate`
Expected: "The schema at prisma/schema.prisma is valid".

- [ ] **Step 3: Generate the migration without applying it yet**

```bash
pnpm exec prisma migrate dev --name init --create-only
```

- [ ] **Step 4: Hand-add the partial unique index Prisma can't express**

Prisma's `@@unique([academyId, belt])` on `BeltRequirement` allows Postgres to silently accept multiple rows with `academyId = NULL` for the same belt (Postgres treats NULLs as distinct in unique indexes). Since `academyId = NULL` means "global default," there must be exactly one such row per belt. Open the generated `prisma/migrations/<timestamp>_init/migration.sql` and append this line at the end of the file:

```sql
-- Enforce exactly one global (academy-independent) BeltRequirement per belt.
-- Prisma's @@unique([academyId, belt]) alone does not prevent duplicate NULLs.
CREATE UNIQUE INDEX "BeltRequirement_belt_global_key" ON "BeltRequirement"("belt") WHERE "academyId" IS NULL;
```

- [ ] **Step 5: Apply the migration**

```bash
pnpm exec prisma migrate dev
```

Expected: applies cleanly, generates the Prisma Client.

- [ ] **Step 6: Verify the partial index exists**

Run: `pnpm exec prisma db execute --stdin <<< "SELECT indexname FROM pg_indexes WHERE tablename = 'BeltRequirement';"`
Expected: output includes `BeltRequirement_belt_global_key`.

- [ ] **Step 7: Verify it actually blocks duplicates**

Run: `pnpm exec prisma db execute --stdin <<< "INSERT INTO \"BeltRequirement\" (id, \"academyId\", belt, \"attendancesPerStripe\", \"maxStripes\", \"attendancesForExam\", \"createdAt\", \"updatedAt\") VALUES ('test1', NULL, 'WHITE', 30, 4, 30, now(), now()); INSERT INTO \"BeltRequirement\" (id, \"academyId\", belt, \"attendancesPerStripe\", \"maxStripes\", \"attendancesForExam\", \"createdAt\", \"updatedAt\") VALUES ('test2', NULL, 'WHITE', 30, 4, 30, now(), now());"`
Expected: the second INSERT fails with a unique violation on `BeltRequirement_belt_global_key`.

Then clean up the test row: `pnpm exec prisma db execute --stdin <<< "DELETE FROM \"BeltRequirement\" WHERE id = 'test1';"`

- [ ] **Step 8: Gitignore the generated Prisma client**

The schema's `generator client` block outputs to `src/generated/prisma` (Prisma 7's default `prisma-client` generator, regenerated by `prisma generate`/`prisma migrate dev` — not something to hand-edit or commit). Add this line to `.gitignore`:

```
/src/generated/
```

- [ ] **Step 9: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add full Phase 1 Prisma schema and initial migration"
git push origin main
```

---

### Task 5: Prisma client singleton + crypto helper

**Files:**
- Create: `src/lib/prisma.ts`, `src/lib/crypto.ts`, `tests/unit/crypto.test.ts`, `vitest.config.ts`, `tests/setup.ts`

**Interfaces:**
- Produces:
  - `prisma` (singleton `PrismaClient` instance) from `@/lib/prisma`
  - `hashSecret(secret: string): Promise<string>` from `@/lib/crypto`
  - `generateRandomToken(byteLength?: number): string` from `@/lib/crypto` (base64url-encoded, default 24 bytes)
- Consumed by: Task 6's seed script (`hashSecret`, `generateRandomToken`), Task 2's `button.test.tsx` (via the Vitest config this task installs).

- [ ] **Step 1: Add dependencies**

```bash
pnpm add bcryptjs pg @prisma/adapter-pg dotenv
pnpm add -D @types/bcryptjs @types/pg vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom tsx
```

Prisma 7's `prisma-client` generator requires an explicit driver adapter for SQL providers (no bundled query engine binary reads a schema `url` anymore) — `@prisma/adapter-pg` + `pg` provide that for PostgreSQL. `dotenv` is needed because Prisma 7 no longer auto-loads `.env` outside of `prisma.config.ts`'s own explicit `import "dotenv/config"` (Task 3 already relies on this in `prisma7.config.ts`) — any other script that reads `process.env.DATABASE_URL` directly (Task 6's `seed.ts` and its integration test) needs the same explicit import. Next.js itself auto-loads `.env` for the app runtime, so `src/lib/prisma.ts` below does not need `dotenv/config` — it runs inside Next's process.

- [ ] **Step 2: Create the Prisma client singleton**

Create `src/lib/prisma.ts`:

```ts
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 3: Create the crypto helper**

Create `src/lib/crypto.ts`:

```ts
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const SALT_ROUNDS = 12;

export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, SALT_ROUNDS);
}

export function generateRandomToken(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}
```

- [ ] **Step 4: Write the failing test**

Create `tests/unit/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { generateRandomToken, hashSecret } from "@/lib/crypto";

describe("crypto helpers", () => {
  it("hashes a secret so the hash differs from the plaintext but verifies against it", async () => {
    const hash = await hashSecret("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(await bcrypt.compare("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect secret against the stored hash", async () => {
    const hash = await hashSecret("correct horse battery staple");
    expect(await bcrypt.compare("wrong guess", hash)).toBe(false);
  });

  it("generates a url-safe random token of non-zero length", () => {
    const token = generateRandomToken(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(0);
  });

  it("generates a different token on each call", () => {
    expect(generateRandomToken()).not.toBe(generateRandomToken());
  });
});
```

- [ ] **Step 5: Create the Vitest config and setup file**

Create `tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Create `vitest.config.ts`:

```ts
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

- [ ] **Step 6: Add test scripts to `package.json`**

```json
"test:unit": "vitest run tests/unit",
"test:integration": "vitest run tests/integration",
"test": "pnpm test:unit && pnpm test:integration"
```

- [ ] **Step 7: Run the unit tests and verify they pass**

Run: `pnpm test:unit`
Expected: all `crypto.test.ts` tests pass, and `button.test.tsx` from Task 2 now also runs and passes (it needs `/** @vitest-environment jsdom */` at its top, which it already has).

- [ ] **Step 8: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add Prisma client singleton, crypto helper, and Vitest setup"
git push origin main
```

---

### Task 6: Seed script + integration test

**Files:**
- Create: `prisma/seed.ts`, `tests/integration/seed.test.ts`
- Modify: `prisma7.config.ts` (add the `migrations.seed` field — `package.json`'s legacy `prisma.seed` field does not work on this Prisma version)

**Interfaces:**
- Consumes: `hashSecret`, `generateRandomToken` from `@/lib/crypto` (Task 5); the full schema from Task 4.
- Produces: a re-runnable (`upsert`-based) seed that populates both academies, the five global `BeltRequirement` rows, Escazú's 18-session schedule, 3 payment plans × 2 academies, and one `ADMIN` user.

- [ ] **Step 1: Wire up the seed command**

`package.json`'s legacy `prisma.seed` field is inert on this Prisma version — once a `prisma.config.ts`-style config file exists (this repo's is `prisma7.config.ts`, from Task 3), the CLI reads the seed command from there instead. Add `seed: "tsx prisma/seed.ts"` to `prisma7.config.ts`'s existing `migrations` block, so it reads:

```ts
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
```

(Only the `migrations` block changes — add the `seed` line inside it, keep everything else in the file exactly as Task 3 generated it.)

- [ ] **Step 2: Write the seed script**

Create `prisma/seed.ts`:

```ts
import "dotenv/config";
import { PrismaClient, Role } from "../src/generated/prisma/client";
import type { Belt, ClassType, DayOfWeek } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { generateRandomToken, hashSecret } from "../src/lib/crypto";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const BELT_REQUIREMENTS: Array<{
  belt: Belt;
  attendancesPerStripe: number;
  maxStripes: number;
  attendancesForExam: number;
}> = [
  { belt: "WHITE", attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30 },
  { belt: "BLUE", attendancesPerStripe: 65, maxStripes: 4, attendancesForExam: 65 },
  { belt: "PURPLE", attendancesPerStripe: 75, maxStripes: 4, attendancesForExam: 75 },
  { belt: "BROWN", attendancesPerStripe: 85, maxStripes: 4, attendancesForExam: 85 },
  { belt: "BLACK", attendancesPerStripe: 0, maxStripes: 0, attendancesForExam: 0 },
];

const ESCAZU_SCHEDULE: Array<{
  dayOfWeek: DayOfWeek;
  startTime: string;
  durationMinutes: number;
  name: string;
  type: ClassType;
  countsTowardPromotion: boolean;
}> = [
  { dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "GI — Principiantes", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Avanzados", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "18:30", durationMinutes: 60, name: "Competición", type: "COMPETITION", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "FRIDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "FRIDAY", startTime: "18:30", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "SATURDAY", startTime: "09:00", durationMinutes: 60, name: "Striking", type: "STRIKING", countsTowardPromotion: false },
  { dayOfWeek: "SATURDAY", startTime: "10:00", durationMinutes: 60, name: "Kids", type: "KIDS", countsTowardPromotion: true },
  { dayOfWeek: "SATURDAY", startTime: "11:00", durationMinutes: 60, name: "Open Mat", type: "OPEN_MAT", countsTowardPromotion: true },
];

const PAYMENT_PLAN_NAMES = ["Mensualidad", "Promoción", "Becado"] as const;

const ADMIN_EMAIL = "admin@alliancecr.com";

async function main() {
  const escazu = await prisma.academy.upsert({
    where: { slug: "escazu" },
    update: {},
    create: {
      name: "Alliance Escazú",
      slug: "escazu",
      timezone: "America/Costa_Rica",
      kioskTokenHash: await hashSecret(generateRandomToken()),
    },
  });

  const escalante = await prisma.academy.upsert({
    where: { slug: "escalante" },
    update: {},
    create: {
      name: "Alliance Escalante",
      slug: "escalante",
      timezone: "America/Costa_Rica",
      kioskTokenHash: await hashSecret(generateRandomToken()),
    },
  });

  // Prisma's generated compound-unique WhereUniqueInput for (academyId, belt)
  // requires academyId: string, not null — it can't be used to look up the
  // global (academyId IS NULL) rows even though the column itself is
  // nullable. findFirst + create/update (a plain WhereInput, which does
  // allow null) is the correct idempotent pattern here; upsert cannot be.
  for (const requirement of BELT_REQUIREMENTS) {
    const existingRequirement = await prisma.beltRequirement.findFirst({
      where: { academyId: null, belt: requirement.belt },
    });
    if (existingRequirement) {
      await prisma.beltRequirement.update({
        where: { id: existingRequirement.id },
        data: requirement,
      });
    } else {
      await prisma.beltRequirement.create({
        data: { academyId: null, ...requirement },
      });
    }
  }

  for (const session of ESCAZU_SCHEDULE) {
    await prisma.classSession.upsert({
      where: {
        academyId_dayOfWeek_startTime_name: {
          academyId: escazu.id,
          dayOfWeek: session.dayOfWeek,
          startTime: session.startTime,
          name: session.name,
        },
      },
      update: {
        durationMinutes: session.durationMinutes,
        type: session.type,
        countsTowardPromotion: session.countsTowardPromotion,
      },
      create: { academyId: escazu.id, ...session },
    });
  }

  for (const academy of [escazu, escalante]) {
    for (const name of PAYMENT_PLAN_NAMES) {
      await prisma.paymentPlan.upsert({
        where: { academyId_name: { academyId: academy.id, name } },
        update: {},
        create: { academyId: academy.id, name },
      });
    }
  }

  const existingAdmin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existingAdmin) {
    const tempPassword = generateRandomToken(9);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await hashSecret(tempPassword),
        role: Role.ADMIN,
        locale: "es",
      },
    });
    console.log("=".repeat(60));
    console.log(`Admin account created: ${ADMIN_EMAIL}`);
    console.log(`Temporary password: ${tempPassword}`);
    console.log("Change this password after first login.");
    console.log("=".repeat(60));
  } else {
    console.log(`Admin account ${ADMIN_EMAIL} already exists — skipped.`);
  }

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 3: Run the seed**

Run: `pnpm db:seed`
Expected: completes with "Seed complete.", and prints the admin's temporary password once. **Copy that password somewhere safe now** — it won't be shown again until Phase 2 rebuilds auth, at which point you should change it immediately after first login.

- [ ] **Step 4: Write the integration test**

Create `tests/integration/seed.test.ts`:

```ts
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

describe("seed data", () => {
  it("creates exactly two academies: Escazú and Escalante", async () => {
    const academies = await prisma.academy.findMany({ orderBy: { slug: "asc" } });
    expect(academies.map((a) => a.slug)).toEqual(["escalante", "escazu"]);
  });

  it("seeds a global BeltRequirement row for all five belts with no academy override", async () => {
    const requirements = await prisma.beltRequirement.findMany({ where: { academyId: null } });
    expect(requirements).toHaveLength(5);
    const white = requirements.find((r) => r.belt === "WHITE");
    expect(white?.attendancesPerStripe).toBe(30);
    expect(white?.maxStripes).toBe(4);
  });

  it("seeds Escazú's full 18-session class schedule and leaves Escalante empty", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escazuSessions = await prisma.classSession.findMany({ where: { academyId: escazu.id } });
    const escalanteSessions = await prisma.classSession.findMany({ where: { academyId: escalante.id } });

    expect(escazuSessions).toHaveLength(18);
    expect(escalanteSessions).toHaveLength(0);
  });

  it("marks Saturday Striking as not counting toward promotion, everything else as counting", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const striking = await prisma.classSession.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Striking" },
    });
    expect(striking.countsTowardPromotion).toBe(false);

    const otherSessions = await prisma.classSession.findMany({
      where: { academyId: escazu.id, name: { not: "Striking" } },
    });
    expect(otherSessions.every((s) => s.countsTowardPromotion)).toBe(true);
  });

  it("seeds three payment plans per academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plans = await prisma.paymentPlan.findMany({ where: { academyId: escazu.id } });
    expect(plans.map((p) => p.name).sort()).toEqual(["Becado", "Mensualidad", "Promoción"].sort());
  });

  it("seeds exactly one ADMIN user with no StaffAssignment rows", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@alliancecr.com" } });
    expect(admin.role).toBe("ADMIN");
    const assignments = await prisma.staffAssignment.findMany({ where: { userId: admin.id } });
    expect(assignments).toHaveLength(0);
  });

  it("gives each academy a distinct, non-empty kiosk token hash", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    expect(escazu.kioskTokenHash).not.toBe(escalante.kioskTokenHash);
    expect(escazu.kioskTokenHash.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run the integration test**

Run: `pnpm test:integration`
Expected: all tests pass against the seeded local database.

- [ ] **Step 6: Verify the seed is safely re-runnable**

Run: `pnpm db:seed` a second time.
Expected: no errors, no duplicate rows, prints "Admin account ... already exists — skipped." Then re-run `pnpm test:integration` and confirm it still passes (row counts unchanged).

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add idempotent seed script for academies, belts, schedule, plans, admin"
git push origin main
```

---

### Task 7: next-intl i18n scaffolding

**Files:**
- Create: `messages/es.json`, `messages/en.json`, `src/i18n/routing.ts`, `src/i18n/request.ts`, `src/middleware.ts`, `src/app/[locale]/layout.tsx`, `src/app/[locale]/page.tsx`
- Modify: `next.config.ts` (wrap with `withNextIntl`), `src/app/layout.tsx` (become a pass-through root layout), delete `src/app/page.tsx` (moves to `[locale]`)

**Interfaces:**
- Produces: `routing` (locales `["es","en"]`, default `"es"`) from `@/i18n/routing`, consumed by `src/middleware.ts` and `src/i18n/request.ts`. `messages/{locale}.json` keys (`app`, `home`, `belt`, `beltGraphic`, `devBelts`) consumed by Task 8's `BeltGraphic` component and Task 9's dev page.

- [ ] **Step 1: Add next-intl**

```bash
pnpm add next-intl
```

- [ ] **Step 2: Create the message files**

Create `messages/es.json`:

```json
{
  "app": {
    "title": "Alliance Jiu-Jitsu Costa Rica"
  },
  "home": {
    "heading": "Bienvenido a Alliance Jiu-Jitsu Costa Rica",
    "subheading": "Escazú y Escalante"
  },
  "belt": {
    "WHITE": "Blanco",
    "BLUE": "Azul",
    "PURPLE": "Morado",
    "BROWN": "Café",
    "BLACK": "Negro"
  },
  "beltGraphic": {
    "label": "Cinturón {belt}, {stripes, plural, =0 {sin franjas} one {# franja} other {# franjas}}"
  },
  "devBelts": {
    "heading": "Vista previa de cinturones"
  }
}
```

Create `messages/en.json`:

```json
{
  "app": {
    "title": "Alliance Jiu-Jitsu Costa Rica"
  },
  "home": {
    "heading": "Welcome to Alliance Jiu-Jitsu Costa Rica",
    "subheading": "Escazú and Escalante"
  },
  "belt": {
    "WHITE": "White",
    "BLUE": "Blue",
    "PURPLE": "Purple",
    "BROWN": "Brown",
    "BLACK": "Black"
  },
  "beltGraphic": {
    "label": "{belt} belt, {stripes, plural, =0 {no stripes} one {# stripe} other {# stripes}}"
  },
  "devBelts": {
    "heading": "Belt preview"
  }
}
```

- [ ] **Step 3: Create the routing config**

Create `src/i18n/routing.ts`:

```ts
import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["es", "en"],
  defaultLocale: "es",
});
```

- [ ] **Step 4: Create the request config**

Create `src/i18n/request.ts`:

```ts
import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

- [ ] **Step 5: Create the middleware**

Create `src/middleware.ts`:

```ts
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
```

- [ ] **Step 6: Wrap `next.config.ts` with the next-intl plugin**

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
```

- [ ] **Step 7: Make the root layout a pass-through**

Replace `src/app/layout.tsx` with:

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
```

- [ ] **Step 8: Delete the non-localized home page**

Delete `src/app/page.tsx` (it moves under `[locale]` in Step 9/10).

- [ ] **Step 9: Create the locale layout**

Create `src/app/[locale]/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  title: "Alliance Jiu-Jitsu Costa Rica",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 10: Create the localized home page**

Create `src/app/[locale]/page.tsx`:

```tsx
import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("home");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-bold">{t("heading")}</h1>
      <p className="text-lg text-muted-foreground">{t("subheading")}</p>
    </main>
  );
}
```

- [ ] **Step 11: Verify locale routing works**

Run: `pnpm dev`, then visit `http://localhost:3000/` (should redirect to `/es`), `http://localhost:3000/es` (Spanish heading), and `http://localhost:3000/en` (English heading). Stop the dev server when done.

- [ ] **Step 12: Verify the production build still passes**

Run: `pnpm build`
Expected: succeeds with both locales statically generated.

- [ ] **Step 13: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add next-intl locale routing (es default, en toggle)"
git push origin main
```

---

### Task 8: Belt graphic component

**Files:**
- Create: `src/components/belt-graphic/belt-graphic.tsx`, `tests/unit/belt-graphic.test.tsx`

**Interfaces:**
- Produces: `BeltGraphic({ belt: Belt, stripes: number, className?: string })` and the exported `Belt` union type from `@/components/belt-graphic/belt-graphic`, consumed by Task 9's `/dev/belts` page.
- Consumes: `useTranslations` from `next-intl` against the `belt` and `beltGraphic` message keys added in Task 7.

- [ ] **Step 1: Write the component**

Create `src/components/belt-graphic/belt-graphic.tsx`:

```tsx
import { useTranslations } from "next-intl";

export type Belt = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";

const BELT_FILL: Record<Belt, string> = {
  WHITE: "#F5F5F0",
  BLUE: "#1D4ED8",
  PURPLE: "#7C3AED",
  BROWN: "#5C4033",
  BLACK: "#171717",
};

const BELT_BORDER: Record<Belt, string> = {
  WHITE: "#D4D4D4",
  BLUE: "#1E3A8A",
  PURPLE: "#5B21B6",
  BROWN: "#3F2A1D",
  BLACK: "#000000",
};

const BAR_FILL: Record<Belt, string> = {
  WHITE: "#171717",
  BLUE: "#171717",
  PURPLE: "#171717",
  BROWN: "#171717",
  BLACK: "#B91C1C",
};

export interface BeltGraphicProps {
  belt: Belt;
  stripes: number;
  className?: string;
}

export function BeltGraphic({ belt, stripes, className }: BeltGraphicProps) {
  const t = useTranslations("belt");
  const tGraphic = useTranslations("beltGraphic");

  const clampedStripes = Math.max(0, Math.min(4, Math.round(stripes)));
  const beltName = t(belt);
  const label = tGraphic("label", { belt: beltName, stripes: clampedStripes });

  return (
    <figure className={className}>
      <svg
        viewBox="0 0 200 60"
        width={200}
        height={60}
        role="img"
        aria-label={label}
      >
        <rect
          x={1}
          y={1}
          width={198}
          height={58}
          rx={6}
          fill={BELT_FILL[belt]}
          stroke={BELT_BORDER[belt]}
          strokeWidth={2}
        />
        <rect x={130} y={1} width={69} height={58} fill={BAR_FILL[belt]} />
        {Array.from({ length: clampedStripes }, (_, index) => (
          <rect
            key={index}
            x={140 + index * 13}
            y={9}
            width={7}
            height={42}
            fill="#FFFFFF"
          />
        ))}
      </svg>
      <figcaption className="text-sm">{label}</figcaption>
    </figure>
  );
}
```

- [ ] **Step 2: Write the tests**

Create `tests/unit/belt-graphic.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

function renderBelt(
  locale: "es" | "en",
  belt: "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK",
  stripes: number,
) {
  const messages = locale === "es" ? esMessages : enMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <BeltGraphic belt={belt} stripes={stripes} />
    </NextIntlClientProvider>,
  );
}

describe("BeltGraphic", () => {
  it("renders the Spanish belt name and stripe count as visible text", () => {
    renderBelt("es", "BLUE", 2);
    expect(screen.getByText("Cinturón Azul, 2 franjas")).toBeInTheDocument();
  });

  it("renders the English belt name and singular stripe count as visible text", () => {
    renderBelt("en", "BROWN", 1);
    expect(screen.getByText("Brown belt, 1 stripe")).toBeInTheDocument();
  });

  it("renders the zero-stripes case correctly in both locales", () => {
    renderBelt("es", "BLACK", 0);
    expect(screen.getByText("Cinturón Negro, sin franjas")).toBeInTheDocument();
  });

  it("exposes the same visible text via aria-label on the SVG, so color alone never carries meaning", () => {
    renderBelt("en", "PURPLE", 3);
    expect(screen.getByRole("img", { name: "Purple belt, 3 stripes" })).toBeInTheDocument();
  });

  it("clamps stripes above 4 down to 4", () => {
    renderBelt("en", "WHITE", 9);
    expect(screen.getByText("White belt, 4 stripes")).toBeInTheDocument();
  });

  it("clamps negative stripes up to 0", () => {
    renderBelt("en", "WHITE", -3);
    expect(screen.getByText("White belt, no stripes")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `pnpm test:unit`
Expected: all `belt-graphic.test.tsx` cases pass.

- [ ] **Step 4: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add accessible BeltGraphic component with text alternative"
git push origin main
```

---

### Task 9: `/dev/belts` visual test page + Phase 1 verification

**Files:**
- Create: `src/app/[locale]/dev/belts/page.tsx`, `tests/unit/dev-belts-page.test.tsx`

**Interfaces:**
- Consumes: `BeltGraphic` and `Belt` from `@/components/belt-graphic/belt-graphic` (Task 8); `devBelts.heading` message key (Task 7).

- [ ] **Step 1: Write the page**

Create `src/app/[locale]/dev/belts/page.tsx`:

```tsx
import { useTranslations } from "next-intl";
import { BeltGraphic, type Belt } from "@/components/belt-graphic/belt-graphic";

const BELTS: Belt[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];
const STRIPE_COUNTS = [0, 1, 2, 3, 4];

export default function DevBeltsPage() {
  const t = useTranslations("devBelts");

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      {BELTS.map((belt) => (
        <div key={belt} className="flex flex-wrap gap-4">
          {STRIPE_COUNTS.map((stripes) => (
            <BeltGraphic key={`${belt}-${stripes}`} belt={belt} stripes={stripes} />
          ))}
        </div>
      ))}
    </main>
  );
}
```

- [ ] **Step 2: Write a smoke test asserting all 25 combinations render**

Create `tests/unit/dev-belts-page.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import DevBeltsPage from "@/app/[locale]/dev/belts/page";
import esMessages from "../../messages/es.json";

describe("DevBeltsPage", () => {
  it("renders all 5 belts across all 5 stripe counts (25 total)", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <DevBeltsPage />
      </NextIntlClientProvider>,
    );
    const belts = screen.getAllByRole("img");
    expect(belts).toHaveLength(25);
  });

  it("includes the white belt with 0 stripes and the black belt with 4 stripes among them", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <DevBeltsPage />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Cinturón Blanco, sin franjas")).toBeInTheDocument();
    expect(screen.getByText("Cinturón Negro, 4 franjas")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the full unit suite**

Run: `pnpm test:unit`
Expected: every unit test file (button, crypto, belt-graphic, dev-belts-page) passes.

- [ ] **Step 4: Full-stack manual verification**

```bash
pnpm db:down
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Visit `http://localhost:3000/es/dev/belts` and `http://localhost:3000/en/dev/belts` in a browser. Confirm visually: 5 rows (one per belt), 5 belt graphics per row, correct belt colors, correct stripe counts drawn on the bar, and a red bar specifically on the black belt row. Stop the dev server when done.

- [ ] **Step 5: Run the complete test suite one more time**

Run: `pnpm test`
Expected: unit and integration suites both pass.

- [ ] **Step 6: Run the production build one more time**

Run: `pnpm build`
Expected: succeeds cleanly.

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json' ':!docs'
git commit -m "feat: add /dev/belts visual QA page for all belt/stripe combinations"
git push origin main
```

Phase 1 is complete once this task's checks all pass. Phase 2 (students, auth, academy-scoping helper) is the next plan to write — do not start it until this one is fully merged and verified.
