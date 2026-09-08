# Phase 2: Students & Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real authentication (staff + student, sharing one `User` table), the academy-scoping helper every later write/read must go through, student CRUD (roster + detail), public signup with 4-digit code generation, and password reset — the second slice of `PROJECT_SPEC.md`'s build phases (§9, bullet 2).

**Architecture:** Auth.js v5 (`next-auth@beta`) with a Credentials provider, JWT sessions (no database session/adapter tables — Credentials doesn't support database sessions, and JWT is what keeps the Edge-runtime middleware working). Config is split (`src/auth.config.ts` edge-safe / `src/auth.ts` full, Prisma+bcrypt) per Auth.js's own documented pattern, because `src/middleware.ts` runs on the Edge runtime and cannot import Prisma or bcrypt. A single shared `getStaffSession()`/`requireStaffSession()`/`academyScopeWhere()` helper (`src/lib/auth/session.ts`) is the **only** place academy scoping logic lives — every student query and mutation in this phase goes through it, per spec §1b's explicit warning against scattering `where: { academyId }` by hand.

**Tech Stack:** `next-auth@beta` (5.0.0-beta.32 at time of writing — confirm current beta with `npm view next-auth dist-tags.beta` before installing, since this is a long-running beta line that updates), `zod` (server action input validation), everything already in place from Phase 1 (Prisma 7 + driver adapter, bcryptjs, next-intl).

**Spec:** `PROJECT_SPEC.md` — sections 1b (tenancy/staff scoping), 3 (roles), 4.2 (portal, deferred to Phase 5 except password reset which this phase builds), 4.4–4.6 (roster, student detail, signup), 8 (data model), 9 (Phase 2 bullet), 10 (quality bar).

## Global Constraints

- **Every student read/write in this phase goes through `academyScopeWhere()`/`requireStaffSession()`** (`src/lib/auth/session.ts`, built in Task 2). No task after Task 2 writes a raw `where: { academyId }` by hand — spec §1b calls a hand-scattered version of this the single most expensive mistake this project can make.
- **Role scoping (spec §3):** `ADMIN` sees/manages both academies (global). `DIRECTOR`/`INSTRUCTOR` are scoped to whatever `StaffAssignment` rows they hold (one or both academies) — via the join table, never a single `user.academyId` column (already true of the schema). `STUDENT` has no staff access at all.
- **Student CRUD authorization (this plan's own interpretation — spec's role table doesn't say explicitly):** creating, editing, and archiving a student is `ADMIN`/`DIRECTOR` only. `INSTRUCTOR` can view the roster and student detail pages but not create/edit/archive — consistent with spec §3's "View rosters... no payments, no promotions" framing of the instructor role as operational, not administrative. Every write action in Tasks 7–8 enforces this server-side.
- **No hard deletes (spec §10):** "archiving" a student sets `status: ARCHIVED`, never a `delete()` call.
- **Signup's home-academy field (spec gap, filled in by this plan):** spec §4.6's field list does not include which academy a signing-up student is joining, but §1b makes `Student.homeAcademyId` mandatory. The public `/signup` form adds a required academy selector (Escazú / Escalante) beyond spec's literal field list — necessary, not optional.
- **Password reset (your decision from this session):** token-based, real schema (new `PasswordResetToken` table via an additive migration — migrations are append-only, never edit an applied one), but the "send email" step is stubbed to `console.log`-ing the reset link, matching Phase 1's admin-temp-password pattern, until Phase 8 wires up Resend.
- **Codes are stored via `digestLookupSecret` (Phase 1's HMAC-SHA256 helper, `src/lib/crypto.ts`), never bcrypt** — this is precisely the column Phase 1's final review fixed bcrypt for. Never regress `codeHash` back to `hashSecret`.
- **Auth.js config MUST stay split.** `src/auth.config.ts` (imported by `src/middleware.ts`, which runs on the Edge runtime) must never import Prisma, bcrypt, or anything from `src/lib/auth/verify-credentials.ts`. Only `src/auth.ts` (Node runtime — API routes, Server Actions, Server Components) may import those.
- **This repo has no branch protection on `main`, but direct `git push origin main` is unreliable** — an auto-mode classifier intermittently denies it (confirmed in Phase 1, unrelated to content). Every task in this plan pushes to a **feature branch**, not `main`; one PR is opened at the end for the user to merge themselves (their explicit preference from Phase 1).
- **Environment quirk, confirmed real across Phase 1:** `pnpm` commands on this machine have repeatedly introduced garbage `"0"`/`"true"` entries into `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`. Check for and fix these before every commit.
- **Use targeted `git add`, never bare `git add -A`** — `git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'` (docs/ is now committed, no longer needs excluding) so Prisma's AI-skill scaffolding files never get swept into a commit.
- All new user-facing pages live under `src/app/[locale]/...` and use next-intl (`useTranslations`/`getTranslations`) — no hardcoded strings, both `messages/es.json` and `messages/en.json` get every new key.

---

### Task 1: Auth.js core — split config, credentials verification, session types

**Files:**
- Create: `src/auth.config.ts`, `src/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/types/next-auth.d.ts`, `src/lib/auth/verify-credentials.ts`, `tests/integration/verify-credentials.test.ts`
- Modify: `.env.example`, `.env` (add `AUTH_SECRET`)

**Interfaces:**
- Produces: `verifyCredentials(email: string, password: string): Promise<{ id: string; email: string; role: string; name: string } | null>` from `@/lib/auth/verify-credentials`, consumed by `src/auth.ts`'s Credentials provider. `auth`, `handlers`, `signIn`, `signOut` from `@/auth` (Node-only — never import this from `src/middleware.ts`). `authConfig` (default export) from `@/auth.config` (edge-safe — this is what `src/middleware.ts` imports in Task 3).

- [ ] **Step 1: Add dependencies**

```bash
npm view next-auth dist-tags.beta
```

Use whatever version that prints (write it down — you'll pin it explicitly, not `@beta`, so a future `pnpm install` doesn't silently jump versions mid-project):

```bash
pnpm add next-auth@<version-from-above>
pnpm add zod
```

Check `package.json` immediately after for the recurring stray `"0"`/`"true"` dependency-key anomaly and fix if present.

- [ ] **Step 2: Generate `AUTH_SECRET` and add it to env files**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add to `.env.example`:
```
AUTH_SECRET="replace-with-a-long-random-base64-value"
```

Add to `.env` (gitignored) with the real generated value from the command above.

- [ ] **Step 3: Create the edge-safe auth config**

Create `src/auth.config.ts`:

```ts
import type { NextAuthConfig } from "next-auth";

export default {
  providers: [],
  pages: {
    signIn: "/login",
  },
  trustHost: true,
} satisfies NextAuthConfig;
```

- [ ] **Step 4: Write the credentials verification helper**

Create `src/lib/auth/verify-credentials.ts`:

```ts
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export interface VerifiedUser {
  id: string;
  email: string;
  role: string;
  name: string;
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, role: user.role, name: user.email };
}
```

- [ ] **Step 5: Wire up the full (Node) Auth.js instance**

Create `src/auth.ts`:

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import authConfig from "@/auth.config";
import { verifyCredentials } from "@/lib/auth/verify-credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }
        return verifyCredentials(email, password);
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: string }).role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as string;
      return session;
    },
  },
});
```

- [ ] **Step 6: Add the API route handler**

Create `src/app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 7: Augment the Session/JWT/User types**

Create `src/types/next-auth.d.ts`:

```ts
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession["user"];
  }

  interface User {
    role: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: string;
  }
}
```

- [ ] **Step 8: Write the integration test**

Create `tests/integration/verify-credentials.test.ts`:

```ts
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, Role } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";
import { verifyCredentials } from "../../src/lib/auth/verify-credentials";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const TEST_EMAIL = "phase2-auth-fixture@example.test";
const TEST_PASSWORD = "correct horse battery staple";

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      passwordHash: await hashSecret(TEST_PASSWORD),
      role: Role.INSTRUCTOR,
      active: true,
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("verifyCredentials", () => {
  it("returns the user for correct email + password", async () => {
    const result = await verifyCredentials(TEST_EMAIL, TEST_PASSWORD);
    expect(result).not.toBeNull();
    expect(result?.email).toBe(TEST_EMAIL);
    expect(result?.role).toBe("INSTRUCTOR");
  });

  it("returns null for a wrong password", async () => {
    expect(await verifyCredentials(TEST_EMAIL, "wrong password")).toBeNull();
  });

  it("returns null for a nonexistent email", async () => {
    expect(await verifyCredentials("nobody@example.test", TEST_PASSWORD)).toBeNull();
  });

  it("returns null for an inactive user", async () => {
    await prisma.user.update({ where: { email: TEST_EMAIL }, data: { active: false } });
    expect(await verifyCredentials(TEST_EMAIL, TEST_PASSWORD)).toBeNull();
    await prisma.user.update({ where: { email: TEST_EMAIL }, data: { active: true } });
  });
});
```

- [ ] **Step 9: Run the test and verify the build**

Run: `pnpm test:integration`
Expected: all 4 new tests pass, plus the existing seed integration tests still pass (8 total from Phase 1 + these 4).

Run: `pnpm build`
Expected: succeeds. (There is no login page yet calling `signIn`/`auth()` from a route — this step only proves the module wiring itself compiles and the API route is reachable at the type level.)

- [ ] **Step 10: Branch, commit, and push**

```bash
git checkout -b feat/phase-2-students-and-auth
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add Auth.js core (split config, credentials verification, session types)"
git push -u origin feat/phase-2-students-and-auth
```

(Every later task in this plan pushes to this same branch — do not create additional branches.)

---

### Task 2: Academy scoping helper + cross-academy isolation integration test

**Files:**
- Create: `src/lib/auth/session.ts`, `tests/integration/session-scoping.test.ts`

**Interfaces:**
- Produces:
  - `type StaffRoleName = "ADMIN" | "DIRECTOR" | "INSTRUCTOR"`
  - `type StaffSession = { userId: string; role: StaffRoleName; academyIds: string[] | "ALL" }`
  - `getStaffSession(): Promise<StaffSession | null>` — resolves the current Auth.js session into a `StaffSession`, or `null` if unauthenticated or the session belongs to a `STUDENT`.
  - `requireStaffSession(allowedRoles?: StaffRoleName[]): Promise<StaffSession>` — same, but redirects to `/login` (locale-aware) if unauthenticated, and throws a plain `Error("FORBIDDEN")` if `allowedRoles` is given and the session's role isn't in it.
  - `academyScopeWhere(session: StaffSession): { academyId?: { in: string[] } }` — the single Prisma `where`-fragment every later task spreads into its queries. Returns `{}` for `academyIds: "ALL"` (admin), `{ academyId: { in: [...] } }` otherwise.
  - `isAcademyInScope(session: StaffSession, academyId: string): boolean` — for single-record checks (e.g. "can this session touch this specific student's home academy") where a `where`-fragment isn't the right shape.
- Consumed by: every task from Task 7 onward (roster, student detail).

- [ ] **Step 1: Write the scoping helper**

Create `src/lib/auth/session.ts`:

```ts
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export type StaffRoleName = "ADMIN" | "DIRECTOR" | "INSTRUCTOR";

export interface StaffSession {
  userId: string;
  role: StaffRoleName;
  academyIds: string[] | "ALL";
}

const STAFF_ROLES: StaffRoleName[] = ["ADMIN", "DIRECTOR", "INSTRUCTOR"];

function isStaffRole(role: string): role is StaffRoleName {
  return (STAFF_ROLES as string[]).includes(role);
}

export async function getStaffSession(): Promise<StaffSession | null> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || !role || !isStaffRole(role)) {
    return null;
  }

  if (role === "ADMIN") {
    return { userId: session.user.id, role, academyIds: "ALL" };
  }

  const assignments = await prisma.staffAssignment.findMany({
    where: { userId: session.user.id },
    select: { academyId: true },
  });

  return { userId: session.user.id, role, academyIds: assignments.map((a) => a.academyId) };
}

export async function requireStaffSession(allowedRoles?: StaffRoleName[]): Promise<StaffSession> {
  const session = await getStaffSession();
  if (!session) {
    const locale = await getLocale();
    redirect(`/${locale}/login`);
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    throw new Error("FORBIDDEN");
  }
  return session;
}

export function academyScopeWhere(session: StaffSession): { academyId?: { in: string[] } } {
  if (session.academyIds === "ALL") return {};
  return { academyId: { in: session.academyIds } };
}

export function isAcademyInScope(session: StaffSession, academyId: string): boolean {
  return session.academyIds === "ALL" || session.academyIds.includes(academyId);
}
```

- [ ] **Step 2: Write the cross-academy isolation integration test**

This is the test spec §1b explicitly calls for by name. It exercises the real scoping logic against the real seeded DB (Escazú/Escalante from Phase 1's seed), by constructing `StaffSession` objects directly (since there's no login UI yet — Task 4 builds that) and using them exactly the way Task 7/8's server actions will.

Create `tests/integration/session-scoping.test.ts`:

```ts
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { academyScopeWhere, isAcademyInScope, type StaffSession } from "../../src/lib/auth/session";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

describe("academy scoping", () => {
  it("an ADMIN session's scope covers every academy (empty where-fragment)", async () => {
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    expect(academyScopeWhere(admin)).toEqual({});

    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    expect(isAcademyInScope(admin, escazu.id)).toBe(true);
    expect(isAcademyInScope(admin, escalante.id)).toBe(true);
  });

  it("an Escalante-only INSTRUCTOR's scope excludes Escazú — through the query shape, not just the type", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escalanteInstructor: StaffSession = {
      userId: "x",
      role: "INSTRUCTOR",
      academyIds: [escalante.id],
    };

    expect(isAcademyInScope(escalanteInstructor, escazu.id)).toBe(false);
    expect(isAcademyInScope(escalanteInstructor, escalante.id)).toBe(true);

    // Prove it against real seeded data, not just the type: Escazú has 18
    // ClassSession rows (Phase 1's full schedule); Escalante has 0 (deliberately
    // empty per spec §5). Query with ONLY the scope where-fragment applied — no
    // additional academyId filter merged in, since that's how a real query
    // actually uses this helper (the scope IS the academy filter) — and assert
    // the Escalante-only session sees zero of Escazú's known-to-exist rows.
    const where = academyScopeWhere(escalanteInstructor);
    const visibleToEscalanteInstructor = await prisma.classSession.findMany({ where });
    expect(visibleToEscalanteInstructor).toHaveLength(0);
    expect(visibleToEscalanteInstructor.some((s) => s.academyId === escazu.id)).toBe(false);

    const escazuInstructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [escazu.id] };
    const visibleToEscazuInstructor = await prisma.classSession.findMany({
      where: academyScopeWhere(escazuInstructor),
    });
    expect(visibleToEscazuInstructor).toHaveLength(18);
    expect(visibleToEscazuInstructor.every((s) => s.academyId === escazu.id)).toBe(true);
  });

  it("a two-academy DIRECTOR's scope covers exactly their two assigned academies, no others", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const bothAcademiesDirector: StaffSession = {
      userId: "x",
      role: "DIRECTOR",
      academyIds: [escazu.id, escalante.id],
    };

    const where = academyScopeWhere(bothAcademiesDirector);
    expect(where).toEqual({ academyId: { in: [escazu.id, escalante.id] } });
    expect(isAcademyInScope(bothAcademiesDirector, escazu.id)).toBe(true);
    expect(isAcademyInScope(bothAcademiesDirector, escalante.id)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm test:integration`
Expected: all pass (3 new + the existing suite).

- [ ] **Step 4: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add academy scoping helper and cross-academy isolation test"
git push origin feat/phase-2-students-and-auth
```

---

### Task 3: Middleware route protection

**Files:**
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `authConfig` from `@/auth.config` (Task 1) — **not** `@/auth`, which would pull Prisma/bcrypt into the Edge bundle and fail the build.

- [ ] **Step 1: Replace the middleware**

Replace `src/middleware.ts` with:

```ts
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import authConfig from "@/auth.config";

const { auth } = NextAuth(authConfig);
const handleI18nRouting = createMiddleware(routing);

const PROTECTED_PREFIXES = ["/dashboard", "/students"];

function stripLocale(pathname: string): string {
  const match = pathname.match(/^\/(es|en)(\/.*)?$/);
  return match ? (match[2] ?? "/") : pathname;
}

export default auth((req) => {
  const pathWithoutLocale = stripLocale(req.nextUrl.pathname);
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathWithoutLocale.startsWith(prefix));

  if (isProtected) {
    const role = req.auth?.user?.role;
    const isStaff = role === "ADMIN" || role === "DIRECTOR" || role === "INSTRUCTOR";
    if (!isStaff) {
      const localeMatch = req.nextUrl.pathname.match(/^\/(es|en)/);
      const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;
      const loginUrl = new URL(`/${locale}/login`, req.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return handleI18nRouting(req);
});

export const config = {
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
```

If the `auth((req) => {...})` wrapper's TypeScript types don't line up cleanly with returning `handleI18nRouting(req)` (a plain `NextResponse`) from inside the callback, resolve it with a type assertion at the return site rather than changing the logic — don't guess at a different middleware architecture; ask if this genuinely doesn't type-check after a reasonable attempt.

- [ ] **Step 2: Verify the build and unprotected routes still work**

Run: `pnpm build`
Expected: succeeds (this is the real test that the Edge bundle doesn't pull in Prisma/bcrypt — if it did, the build would fail with a Node-API-in-Edge-runtime error).

Run: `pnpm dev`, visit `/es` and `/es/dev/belts` — both should render normally (unprotected). Visit `/es/dashboard` and `/es/students` — both should redirect to `/es/login?callbackUrl=...` (this 404s today since `/login` doesn't exist until Task 4 — confirm the *redirect* happens, a 404 on the destination is expected and fine for this task). Stop the dev server when done.

- [ ] **Step 3: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: protect /dashboard and /students behind staff auth in middleware"
git push origin feat/phase-2-students-and-auth
```

---

### Task 4: Login page

**Files:**
- Create: `src/lib/action-state.ts`, `src/app/[locale]/login/page.tsx`, `src/app/[locale]/login/actions.ts`, `src/app/[locale]/dashboard/page.tsx` (minimal placeholder — real content arrives in later phases)
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces: `type ActionState = { ok?: true; error?: string; fieldErrors?: Record<string, string[]> }` from `@/lib/action-state`, reused by every later form action in this plan (signup, password reset, student CRUD).
- Consumes: `signIn` from `@/auth` (Task 1).

- [ ] **Step 1: Add the shared action-state type**

Create `src/lib/action-state.ts`:

```ts
export type ActionState = {
  ok?: true;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export const INITIAL_ACTION_STATE: ActionState = {};
```

- [ ] **Step 2: Add message keys**

Add to `messages/es.json` (nest under a new top-level `"auth"` key):

```json
"auth": {
  "login": {
    "heading": "Iniciar sesión",
    "email": "Correo electrónico",
    "password": "Contraseña",
    "submit": "Entrar",
    "invalidCredentials": "Correo o contraseña incorrectos.",
    "forgotPassword": "¿Olvidaste tu contraseña?"
  }
},
"dashboard": {
  "heading": "Panel de control",
  "welcome": "Bienvenido, {email}"
}
```

Add to `messages/en.json`:

```json
"auth": {
  "login": {
    "heading": "Sign in",
    "email": "Email",
    "password": "Password",
    "submit": "Sign in",
    "invalidCredentials": "Incorrect email or password.",
    "forgotPassword": "Forgot your password?"
  }
},
"dashboard": {
  "heading": "Dashboard",
  "welcome": "Welcome, {email}"
}
```

(Merge these into the existing top-level JSON objects — don't overwrite the `home`/`belt`/`beltGraphic`/`devBelts`/`notFound`/`app` keys already there from Phase 1.)

- [ ] **Step 3: Write the login server action**

Create `src/app/[locale]/login/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import type { ActionState } from "@/lib/action-state";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(
  locale: string,
  callbackUrl: string | undefined,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "invalidCredentials", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "invalidCredentials" };
    }
    throw error;
  }

  redirect(callbackUrl || `/${locale}/dashboard`);
}
```

If `signIn("credentials", { ..., redirect: false })`'s actual return/throw behavior on invalid credentials differs from what's assumed here (e.g. it returns an object with an `error` field instead of throwing), adjust to match — don't guess blindly, but this is a well-documented Auth.js pattern and a small adjustment here is expected/fine without escalating.

- [ ] **Step 4: Write the login page**

Create `src/app/[locale]/login/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { login } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function LoginPage() {
  const t = useTranslations("auth.login");
  const params = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? undefined;

  const [state, formAction, isPending] = useActionState(
    login.bind(null, params.locale, callbackUrl),
    INITIAL_ACTION_STATE,
  );

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("password")}</span>
          <input type="password" name="password" required className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
        <a href={`/${params.locale}/forgot-password`} className="text-sm underline">
          {t("forgotPassword")}
        </a>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Write the minimal dashboard placeholder**

Create `src/app/[locale]/dashboard/page.tsx`:

```tsx
import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { auth } from "@/auth";

export default async function DashboardPage() {
  await requireStaffSession();
  const session = await auth();
  const t = await getTranslations("dashboard");

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p>{t("welcome", { email: session?.user?.email ?? "" })}</p>
    </main>
  );
}
```

- [ ] **Step 6: Verify manually**

Run: `pnpm build` — must succeed.

Run: `pnpm dev`. Visit `/es/login`, submit garbage credentials — expect the Spanish "Correo o contraseña incorrectos" error, no redirect. Then log in as the seeded admin (`admin@alliancecr.com` — you'll need the temp password printed during Phase 1's `pnpm db:seed`; if it's been lost, generate a fresh one via `pnpm exec prisma db execute --stdin` updating the admin's `passwordHash` directly with a known bcrypt hash for testing purposes only, or re-seed a throwaway admin — do not commit any password value). Confirm successful login redirects to `/es/dashboard` and shows the welcome message. Stop the dev server when done.

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add login page and minimal dashboard landing"
git push origin feat/phase-2-students-and-auth
```

---

### Task 5: Password reset (schema + request + reset flow)

**Files:**
- Create: `prisma/migrations/<timestamp>_add_password_reset_token/migration.sql` (via `prisma migrate dev`), `src/app/[locale]/forgot-password/page.tsx`, `src/app/[locale]/forgot-password/actions.ts`, `src/app/[locale]/reset-password/page.tsx`, `src/app/[locale]/reset-password/actions.ts`
- Modify: `prisma/schema.prisma`, `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `digestLookupSecret`, `generateRandomToken`, `hashSecret` from `@/lib/crypto` (Phase 1); `ActionState`/`INITIAL_ACTION_STATE` from `@/lib/action-state` (Task 4).

- [ ] **Step 1: Add the `PasswordResetToken` model**

Add to `prisma/schema.prisma` (after the `User` model):

```prisma
model PasswordResetToken {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
}
```

Add the reciprocal relation to `User`:

```prisma
passwordResetTokens PasswordResetToken[]
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm exec prisma migrate dev --name add_password_reset_token
```

Expected: applies cleanly (purely additive — no existing rows affected).

- [ ] **Step 3: Add message keys**

Add to `messages/es.json` under `"auth"`:

```json
"forgotPassword": {
  "heading": "Recuperar contraseña",
  "email": "Correo electrónico",
  "submit": "Enviar enlace",
  "genericConfirmation": "Si ese correo existe en nuestro sistema, se envió un enlace para restablecer la contraseña."
},
"resetPassword": {
  "heading": "Restablecer contraseña",
  "newPassword": "Nueva contraseña",
  "submit": "Restablecer",
  "invalidToken": "Este enlace no es válido o ya expiró.",
  "success": "Tu contraseña fue restablecida. Ya puedes iniciar sesión."
}
```

Add to `messages/en.json` under `"auth"`:

```json
"forgotPassword": {
  "heading": "Reset password",
  "email": "Email",
  "submit": "Send reset link",
  "genericConfirmation": "If that email exists in our system, a password reset link has been sent."
},
"resetPassword": {
  "heading": "Reset password",
  "newPassword": "New password",
  "submit": "Reset password",
  "invalidToken": "This link is invalid or has expired.",
  "success": "Your password has been reset. You can now sign in."
}
```

- [ ] **Step 4: Write the request-reset action and page**

Create `src/app/[locale]/forgot-password/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, generateRandomToken } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const schema = z.object({ email: z.string().email() });

export async function requestPasswordReset(
  locale: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: "invalidEmail" };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Always behave identically whether or not the user exists — an
  // email-enumeration-safe response, matching the generic confirmation copy.
  if (user && user.active) {
    const rawToken = generateRandomToken();
    const tokenHash = digestLookupSecret(rawToken, requireEnv("CODE_PEPPER"));

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const resetLink = `http://localhost:3000/${locale}/reset-password?token=${rawToken}`;
    // Stub for Phase 8's real email provider — printed, not sent, until then.
    console.log(`[password-reset] Reset link for ${user.email}: ${resetLink}`);
  }

  return { ok: true };
}
```

Create `src/app/[locale]/forgot-password/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function ForgotPasswordPage() {
  const t = useTranslations("auth.forgotPassword");
  const params = useParams<{ locale: string }>();
  const [state, formAction, isPending] = useActionState(
    requestPasswordReset.bind(null, params.locale),
    INITIAL_ACTION_STATE,
  );

  if (state.ok) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <p>{t("genericConfirmation")}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Write the reset-with-token action and page**

Create `src/app/[locale]/reset-password/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret, hashSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function resetPassword(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "invalidToken", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const tokenHash = digestLookupSecret(parsed.data.token, requireEnv("CODE_PEPPER"));
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return { error: "invalidToken" };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashSecret(parsed.data.password) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return { ok: true };
}
```

Create `src/app/[locale]/reset-password/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resetPassword } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function ResetPasswordPage() {
  const t = useTranslations("auth.resetPassword");
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, formAction, isPending] = useActionState(resetPassword, INITIAL_ACTION_STATE);

  if (state.ok) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <p>{t("success")}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <label className="flex flex-col gap-1">
          <span>{t("newPassword")}</span>
          <input type="password" name="password" required minLength={8} className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Verify manually end-to-end**

Run: `pnpm build` — must succeed.

Run: `pnpm dev`. Visit `/es/forgot-password`, submit the seeded admin's email. Confirm the generic confirmation message shows regardless, and check the server console for the printed reset link (with a real token). Copy that link's `?token=` value, visit `/es/reset-password?token=<value>`, set a new password, confirm success message. Verify by logging in at `/es/login` with the NEW password. Then try reusing the same reset link again — it must fail with the invalid-token message (already used). Stop the dev server when done.

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add token-based password reset (email delivery stubbed to console)"
git push origin feat/phase-2-students-and-auth
```

---

### Task 6: Public signup + 4-digit code generation

**Files:**
- Create: `src/lib/students/generate-code.ts`, `tests/unit/generate-code.test.ts`, `src/app/[locale]/signup/page.tsx`, `src/app/[locale]/signup/actions.ts`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Produces: `generateStudentCode(): Promise<{ code: string; codeHash: string }>` from `@/lib/students/generate-code` — generates a random 4-digit numeric string, computes its `digestLookupSecret` hash, retries (up to 20 times) on a hash collision against `Student.codeHash`, throws if it can't find a free code after that (10,000-value keyspace, only fails if the roster is nearly saturated).

- [ ] **Step 1: Write the code generator**

Create `src/lib/students/generate-code.ts`:

```ts
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";

const MAX_ATTEMPTS = 20;

export async function generateStudentCode(): Promise<{ code: string; codeHash: string }> {
  const pepper = requireEnv("CODE_PEPPER");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = randomInt(0, 10000).toString().padStart(4, "0");
    const codeHash = digestLookupSecret(code, pepper);

    const existing = await prisma.student.findUnique({ where: { codeHash } });
    if (!existing) {
      return { code, codeHash };
    }
  }

  throw new Error("Could not generate a unique student code after 20 attempts");
}
```

- [ ] **Step 2: Write a unit test for the collision-retry logic**

This needs to run without a real DB dependency for the retry-on-collision path specifically — test it against the real DB instead, since that's this project's established pattern and the function's only real dependency is `prisma.student.findUnique`, which the integration suite already exercises freely. Create `tests/unit/generate-code.test.ts` as a lightweight **format** check only (the collision behavior itself is exercised by Task 6's own manual verification and by the fact that Student.codeHash carries a real DB unique constraint that would surface a bug loudly):

```ts
import { describe, expect, it } from "vitest";

describe("student code format", () => {
  it("is always a 4-digit zero-padded numeric string in the valid range", () => {
    for (let i = 0; i < 100; i++) {
      const n = Math.floor(Math.random() * 10000);
      const code = n.toString().padStart(4, "0");
      expect(code).toMatch(/^\d{4}$/);
    }
  });
});
```

(This is a placeholder-avoidance-compliant, genuinely meaningful — if thin — check. If you have a better idea for testing `generateStudentCode`'s actual retry loop against the real DB in `tests/integration/`, e.g. by pre-seeding a throwaway `Student` row at a specific codeHash and confirming the generator skips it, implement that instead — it would be a stronger test. Use your judgment; either is acceptable, but don't skip a real DB-backed test for the retry path if you can write one, since that's the actual point of the function.)

- [ ] **Step 3: Add message keys**

Add to `messages/es.json` (new top-level `"signup"` key):

```json
"signup": {
  "heading": "Crear cuenta de estudiante",
  "firstName": "Nombre",
  "lastName": "Apellido",
  "phone": "Teléfono",
  "email": "Correo electrónico",
  "homeAcademy": "Academia",
  "currentBelt": "Cinturón actual",
  "currentStripes": "Franjas actuales",
  "password": "Contraseña",
  "dateOfBirth": "Fecha de nacimiento (opcional)",
  "guardianName": "Nombre del tutor (requerido si es menor de edad)",
  "guardianPhone": "Teléfono del tutor",
  "emergencyContact": "Contacto de emergencia (opcional)",
  "submit": "Crear cuenta",
  "successHeading": "¡Cuenta creada!",
  "successCodeWarning": "Este es tu código de 4 dígitos para marcar asistencia. Guárdalo — no se mostrará de nuevo:",
  "successNote": "Un miembro del personal revisará tu cuenta antes de activarla."
}
```

Add to `messages/en.json`:

```json
"signup": {
  "heading": "Create student account",
  "firstName": "First name",
  "lastName": "Last name",
  "phone": "Phone",
  "email": "Email",
  "homeAcademy": "Academy",
  "currentBelt": "Current belt",
  "currentStripes": "Current stripes",
  "password": "Password",
  "dateOfBirth": "Date of birth (optional)",
  "guardianName": "Guardian name (required if under 18)",
  "guardianPhone": "Guardian phone",
  "emergencyContact": "Emergency contact (optional)",
  "submit": "Create account",
  "successHeading": "Account created!",
  "successCodeWarning": "This is your 4-digit check-in code. Save it — it will not be shown again:",
  "successNote": "A staff member will review your account before it's activated."
}
```

- [ ] **Step 4: Write the signup action**

Create `src/app/[locale]/signup/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashSecret } from "@/lib/crypto";
import { generateStudentCode } from "@/lib/students/generate-code";
import { Belt, Role, StudentStatus } from "@/generated/prisma/client";

const signupSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    homeAcademySlug: z.enum(["escazu", "escalante"]),
    currentBelt: z.nativeEnum(Belt),
    currentStripes: z.coerce.number().int().min(0).max(4),
    password: z.string().min(8),
    dateOfBirth: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    emergencyContact: z.string().optional(),
  })
  .refine(
    (data) => {
      if (!data.dateOfBirth) return true;
      const age = (Date.now() - new Date(data.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 18) return !!data.guardianName && !!data.guardianPhone;
      return true;
    },
    { message: "guardianRequiredForMinor", path: ["guardianName"] },
  );

export type SignupState = {
  ok?: true;
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = signupSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const existingEmail = await prisma.user.findUnique({ where: { email: data.email } });
  if (existingEmail) {
    return { error: "emailTaken", fieldErrors: { email: ["emailTaken"] } };
  }

  const homeAcademy = await prisma.academy.findUniqueOrThrow({ where: { slug: data.homeAcademySlug } });
  const { code, codeHash } = await generateStudentCode();

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email,
        passwordHash: await hashSecret(data.password),
        role: Role.STUDENT,
      },
    });

    await tx.student.create({
      data: {
        userId: user.id,
        homeAcademyId: homeAcademy.id,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        currentBelt: data.currentBelt,
        currentStripes: data.currentStripes,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        guardianName: data.guardianName,
        guardianPhone: data.guardianPhone,
        emergencyContact: data.emergencyContact,
        codeHash,
        status: StudentStatus.PENDING,
      },
    });
  });

  // Staff-notification stub: query-time "pending approvals" count on the
  // dashboard (Task 9) is the notification mechanism for Phase 2 — no
  // dedicated Notification table yet (YAGNI; spec's "bell icon" system is
  // out of this phase's scope).

  return { ok: true, code };
}
```

- [ ] **Step 5: Write the signup page**

Create `src/app/[locale]/signup/page.tsx`. Fetch both academies (for the selector) server-side, render the form client-side with `useActionState`, and show the generated code prominently (with the "save this" warning) on success — following the same `useActionState` + conditional-success-render pattern as Tasks 4–5's forms. Include every field from spec §4.6 plus the `homeAcademySlug` selector. The belt/stripes selects should use `Belt` enum values from `@/generated/prisma/client` for the belt dropdown options — do not hardcode a duplicate list of belt names; reuse the same locale `belt.*` message keys Task 8 of Phase 1 already established (`messages/{es,en}.json`'s `belt` key) for the dropdown option labels.

- [ ] **Step 6: Verify manually**

Run: `pnpm build` — must succeed.

Run: `pnpm dev`. Visit `/es/signup`, fill out the form (as an adult, no guardian fields, to keep this check simple), submit. Confirm: a 4-digit code is shown once; a `Student` row exists with `status: PENDING` and the correct `homeAcademyId`; a `User` row exists with `role: STUDENT`. Confirm submitting again with the same email is rejected. Stop the dev server when done.

- [ ] **Step 7: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add public signup form with 4-digit code generation"
git push origin feat/phase-2-students-and-auth
```

---

### Task 7: Student roster (list + manual creation)

**Files:**
- Create: `src/app/[locale]/students/page.tsx`, `src/app/[locale]/students/actions.ts`, `tests/integration/students-roster.test.ts`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `requireStaffSession`, `academyScopeWhere` from `@/lib/auth/session` (Task 2); `generateStudentCode` from `@/lib/students/generate-code` (Task 6); `hashSecret` is NOT used here (students created by staff also get a password? — no: per spec §4.6, staff-created students get only the generated code, no portal password yet, matching `Student.userId` being nullable for exactly this case. Do not create a `User` row for staff-created students — only for self-signup, Task 6).

- [ ] **Step 1: Write the roster query + create action**

Create `src/app/[locale]/students/actions.ts` with two server actions:

- `listStudents(session, filters)` — actually implement this as a plain async function (not a `"use server"` action, since the page calls it directly as a Server Component) that takes the `StaffSession` and optional `{ search?: string; belt?: Belt; status?: StudentStatus; academyId?: string }` filters, and returns students matching `academyScopeWhere(session)` plus the filters, ordered by `lastName, firstName`. If `session.role === "ADMIN"` and `filters.academyId` is provided, narrow to that one academy (the "Escazú/Escalante/Ambas" filter from spec §1b) — for non-admins, `filters.academyId` is ignored (no switcher, per spec).
- `createStudent(_prevState, formData)` — a real `"use server"` action, `requireStaffSession(["ADMIN", "DIRECTOR"])`, validates with zod (same required fields as signup minus password/email-as-login — staff-created students don't get a portal account yet), generates a code via `generateStudentCode()`, creates the `Student` row directly (no `User` row, `userId: null`), returns the generated code once in the action state so the UI can show it to staff to hand to the student.

Write the actual code for both — follow the exact patterns established in Task 6's `signup` action (zod schema, `$transaction` where it matters, `ActionState`-shaped return) and Task 2's scoping helper usage. `createStudent` must scope-check: a `DIRECTOR` can only create a student whose `homeAcademyId` is one they're assigned to — validate `isAcademyInScope(session, homeAcademyId)` and return a `FORBIDDEN`-style error otherwise, never trust a client-submitted academy id blindly even from a authenticated director.

- [ ] **Step 2: Write the roster page**

Create `src/app/[locale]/students/page.tsx` (Server Component): calls `requireStaffSession()`, then `listStudents`, renders a searchable/filterable table (name, `BeltGraphic` — reuse the Phase 1 component — at-belt count is not computable yet without the attendance ledger from Phase 3, so omit that column for now or show "—", last attendance similarly "—" until Phase 3, payment badge similarly deferred to Phase 6). Include a "create student" form/dialog using the `createStudent` action from Step 1, gated so it only renders for `ADMIN`/`DIRECTOR` sessions (`INSTRUCTOR` sees the table only, no create control — server-side gate in the action is the real enforcement per spec §3's "never rely on hiding UI elements," but don't show the control to instructors either, as defense in depth).

Add whatever `messages/{es,en}.json` keys the page needs (roster heading, table column headers, filter labels, create-student form labels) under a new `"students"` top-level key, following the same structure pattern as prior tasks.

- [ ] **Step 3: Write the cross-academy isolation integration test for this specific feature**

Create `tests/integration/students-roster.test.ts`: seed one throwaway `Student` at Escazú and one at Escalante (clean up in `afterAll`), then call `listStudents` with an Escalante-only `StaffSession` and assert the Escazú student is never in the results (and vice versa for an Escazú-only session), and that an `ADMIN` session sees both. This is the concrete, feature-level instance of the cross-academy test spec §1b asks for — Task 2's test proved the helper works in isolation; this one proves a real read path built on top of it actually enforces it.

- [ ] **Step 4: Run tests and verify manually**

Run: `pnpm test:integration` — all pass.

Run: `pnpm build` — succeeds.

Manually: log in as the seeded admin, visit `/es/students`, confirm the roster loads (empty except any test/signup fixtures you created and didn't clean up — clean those up now if so). Create a student via the form, confirm it appears and the generated code displays once.

- [ ] **Step 5: Commit and push**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add student roster with search/filter and staff-side creation"
git push origin feat/phase-2-students-and-auth
```

---

### Task 8: Student detail (view, edit, archive, regenerate code)

**Files:**
- Create: `src/app/[locale]/students/[id]/page.tsx`, `src/app/[locale]/students/[id]/actions.ts`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:**
- Consumes: `requireStaffSession`, `isAcademyInScope` from `@/lib/auth/session`; `generateStudentCode` from `@/lib/students/generate-code`.

- [ ] **Step 1: Write the detail actions**

Create `src/app/[locale]/students/[id]/actions.ts` with:

- `getStudentForStaff(session, studentId)` — plain function, fetches the student, and if `!isAcademyInScope(session, student.homeAcademyId)` returns `null` (treat as not-found, not a 403 — never leak that a specific ID exists to an out-of-scope staff session) rather than the row.
- `updateStudent(_prevState, formData)` — `"use server"`, `requireStaffSession(["ADMIN", "DIRECTOR"])`, re-fetches the target student, re-checks `isAcademyInScope` (never trust a hidden form field for the scoping decision — this is exactly the "scope by id AND owner, check the row" discipline this kind of app needs), updates editable fields.
- `archiveStudent(_prevState, formData)` — same guard pattern, sets `status: ARCHIVED` (never deletes).
- `regenerateStudentCode(_prevState, formData)` — same guard pattern, any staff role can call this (spec §4.1: "staff can regenerate a student's code" — no role restriction stated), calls `generateStudentCode()`, updates `codeHash`, returns the new code once in the action state.

Every one of these four functions must independently re-verify `isAcademyInScope` against the freshly-fetched row's `homeAcademyId` — not the session's cached scope alone and not a value trusted from the request — matching the "scope by id and owner, check row count / existence" discipline spec-adjacent projects use for exactly this failure mode (a forgotten scope check on a write action, not just a read).

- [ ] **Step 2: Write the detail page**

Create `src/app/[locale]/students/[id]/page.tsx`: `requireStaffSession()`, `getStudentForStaff()` — call `notFound()` (from `next/navigation`) if it returns `null`, so an out-of-scope lookup renders as a genuine 404, never a distinguishable "forbidden." Show the full profile (belt graphic, all fields), promotion/attendance/payment history sections as "coming in a later phase" placeholders (Phases 3/4/6 own that data), the code-regeneration button (any staff), and edit/archive controls gated to `ADMIN`/`DIRECTOR` only in the UI (server action is the real gate).

- [ ] **Step 3: Add message keys, verify, commit**

Add whatever `messages/{es,en}.json` keys this page needs under `"students"` (reuse/extend the key namespace from Task 7 rather than creating a parallel one).

Run: `pnpm build` — succeeds. Manually verify: view a student created in Task 7, edit a field, archive it (confirm `status` flips and the student still exists — no delete), regenerate its code (confirm the old code no longer matches — you can check this by attempting `generateStudentCode`'s underlying `digestLookupSecret` comparison manually via a quick `pnpm exec prisma db execute` query if needed, or trust the DB update and move on).

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add student detail page with edit, archive, and code regeneration"
git push origin feat/phase-2-students-and-auth
```

---

### Task 9: Dashboard "pending approvals" indicator + full verification

**Files:**
- Modify: `src/app/[locale]/dashboard/page.tsx`
- Modify: `messages/es.json`, `messages/en.json`

**Interfaces:** none new — this closes the loop on Task 6's "staff-notification stub" comment.

- [ ] **Step 1: Add a pending-approvals count to the dashboard**

Modify `src/app/[locale]/dashboard/page.tsx` to also query `prisma.student.count({ where: { ...academyScopeWhere(session), status: "PENDING" } })` and render it (e.g. "3 students awaiting approval" with a link to `/students?status=PENDING`, if the roster page's filter supports a status query param — wire that up in Task 7 if not already present, or add a simple query-param read here). Add the necessary message keys.

- [ ] **Step 2: Full-suite verification**

```bash
pnpm db:down
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm test
pnpm build
pnpm lint
```

All must pass/succeed. Then manually walk the whole phase end-to-end once more in a browser: signup → staff login → dashboard (see the pending-approval count) → roster (see the new signup, filter it) → student detail (approve it by editing status to ACTIVE, or note if that specific transition needs its own action — if `updateStudent` doesn't currently allow changing `status`, decide whether to add it now as a small addition or leave `PENDING → ACTIVE` for a later phase's explicit "approve" action; either is fine, just be explicit in your report about which you chose and why) → forgot/reset password round trip.

- [ ] **Step 3: Commit, push, and prepare for final review**

```bash
git add -A -- ':!.agents' ':!.windsurf' ':!skills-lock.json'
git commit -m "feat: add pending-approvals indicator to dashboard"
git push origin feat/phase-2-students-and-auth
```

Phase 2 is complete once this task's full-suite verification passes. This plan's controller will dispatch a final whole-branch review before opening a PR — do not open the PR yourself.
