import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";

/**
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md's fifth "invisible to a fully green
 * suite" finding — an entire page (student portal) returned 500 for every
 * real user because it called a "use client" module's plain export
 * (`rowFor`) during server-side rendering. No test anywhere in this repo
 * renders a page through Next's real SSR pipeline; every other suite
 * constructs a context or mocks `auth()` directly. This suite closes that
 * permanently: every `page.tsx` in `src/app` gets one real HTTP request,
 * through a real running server, and the only thing asserted is "did this
 * come back with something other than a 5xx" — content is out of scope by
 * design (that's what the rest of the test suite is for).
 *
 * Requires SMOKE_BASE_URL, explicitly — never inferred, and refused unless
 * it points at localhost, same "explicit target, no silent fallback"
 * reasoning as TEST_DATABASE_URL (scripts/lib/test-database-guard.ts). This
 * suite is never meant to run against a real deployed environment.
 */
function resolveGuardedSmokeBaseUrl(): string {
  const raw = process.env.SMOKE_BASE_URL;
  if (!raw) {
    throw new Error(
      "SMOKE_BASE_URL is required to run the page-route smoke suite (e.g. http://localhost:3000). " +
        "Start the app first (`pnpm build && pnpm start`, or `pnpm dev`) and set this to point at it.",
    );
  }
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(
      `SMOKE_BASE_URL must point at localhost/127.0.0.1, got "${url.hostname}". ` +
        "This suite makes real, unauthenticated-by-default HTTP requests and must never target a real deployment.",
    );
  }
  return raw.replace(/\/$/, "");
}

const BASE_URL = resolveGuardedSmokeBaseUrl();
const E2E_SECRET = process.env.E2E_AUTH_BYPASS_SECRET;
if (!E2E_SECRET) {
  throw new Error("E2E_AUTH_BYPASS_SECRET is required to mint authenticated sessions for the smoke suite.");
}

/** Mints a real session cookie via the same dev-only bypass Playwright/manual
 * screenshot verification uses (src/app/api/e2e-auth-bypass/route.ts) — it
 * runs the app's own real sign-in jwt callback, not a second hand-rolled
 * session shape, so a session this suite mints is structurally identical to
 * one real login produces (see tests/integration/e2e-auth-bypass-equals-real-login.test.ts). */
async function mintSessionCookie(userId: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/e2e-auth-bypass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, secret: E2E_SECRET }),
  });
  if (!response.ok) {
    throw new Error(`Failed to mint a smoke-test session for user ${userId}: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`e2e-auth-bypass did not return a session cookie for user ${userId}`);
  }
  return setCookie.split(";")[0]!;
}

interface RouteCase {
  label: string;
  path: string;
  cookie?: string;
}

async function assertNotServerError(routeCase: RouteCase): Promise<void> {
  const response = await fetch(`${BASE_URL}${routeCase.path}`, {
    headers: routeCase.cookie ? { Cookie: routeCase.cookie } : {},
    redirect: "follow",
  });
  expect(
    response.status,
    `${routeCase.label} (${routeCase.path}) returned ${response.status} — a page that only mocked tests ever rendered just crashed for a real request`,
  ).toBeLessThan(500);
}

describe("every page route renders through a real running server (non-5xx)", () => {
  let adminCookie: string;
  let directorCookie: string;
  let instructorCookie: string;
  let studentCookie: string;
  let studentDetailId: string;
  let kioskAcademySlug: string;
  let orgSlug: string;

  beforeAll(async () => {
    const users = await prisma.user.findMany({
      where: {
        email: { in: ["admin@alliancecr.com", "director@test.com", "instructor@test.com", "student@test.com"] },
      },
      select: { id: true, email: true },
    });
    const byEmail = new Map(users.map((u) => [u.email, u.id]));
    const adminId = byEmail.get("admin@alliancecr.com");
    const directorId = byEmail.get("director@test.com");
    const instructorId = byEmail.get("instructor@test.com");
    const studentUserId = byEmail.get("student@test.com");
    if (!adminId || !directorId || !instructorId || !studentUserId) {
      throw new Error("Smoke suite requires the seeded QA users (admin/director/instructor/student@test.com) to exist.");
    }

    [adminCookie, directorCookie, instructorCookie, studentCookie] = await Promise.all([
      mintSessionCookie(adminId),
      mintSessionCookie(directorId),
      mintSessionCookie(instructorId),
      mintSessionCookie(studentUserId),
    ]);

    // Academy/Student are tenant-scoped models (see tenant-guard.ts) — the
    // guard only requires a real organizationId somewhere in the query
    // args, not that the call goes through getScopedDb(context), so
    // resolving one via the admin's own (non-tenant-scoped)
    // OrganizationMembership row and filtering by it here is a genuinely
    // scoped query, not a workaround around the guard.
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId: adminId },
      select: { organizationId: true },
    });
    if (!membership) throw new Error("Smoke suite requires the seeded admin to have an OrganizationMembership.");
    const { organizationId } = membership;

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { slug: true },
    });
    orgSlug = organization.slug;

    const student = await prisma.student.findFirst({ where: { organizationId }, select: { id: true } });
    if (!student) throw new Error("Smoke suite requires at least one seeded Student row.");
    studentDetailId = student.id;

    const academy = await prisma.academy.findFirst({ where: { organizationId }, select: { slug: true } });
    if (!academy) throw new Error("Smoke suite requires at least one seeded Academy row.");
    kioskAcademySlug = academy.slug;
  });

  it("public pages (anonymous)", async () => {
    const routes: RouteCase[] = [
      { label: "marketing home", path: "/en" },
      { label: "login", path: "/en/login" },
      { label: "forgot password", path: "/en/forgot-password" },
      { label: "register academy", path: "/en/register-academy" },
      { label: "accept invitation (invalid token)", path: "/en/accept-invitation?token=smoke-test-invalid-token" },
      { label: "reset password (no/invalid token)", path: "/en/reset-password?token=smoke-test-invalid-token" },
      { label: "dev belts showcase", path: "/en/dev/belts" },
      { label: "dev components showcase", path: "/en/dev/components" },
      { label: "unmatched path (404, not 5xx)", path: "/en/this-route-does-not-exist-smoke-test" },
      // Auth-gated pages that null-check auth() themselves and redirect —
      // hit anonymously, this only proves the module loads without
      // crashing, not that the page's own "true" state renders correctly.
      { label: "organization unavailable (unconditional render, no auth check)", path: "/en/organization-unavailable" },
      { label: "no organization access (redirects when anonymous)", path: "/en/no-organization-access" },
      { label: "select organization (redirects when anonymous)", path: "/en/select-organization" },
    ];
    for (const route of routes) {
      await assertNotServerError(route);
    }
  });

  it("kiosk (real academy slug, no session)", async () => {
    await assertNotServerError({ label: "kiosk check-in", path: `/en/kiosk/${kioskAcademySlug}` });
  });

  it("org-scoped routes (real org slug, no session) — replaces the deleted hardcoded /signup", async () => {
    await assertNotServerError({ label: "org-scoped login", path: `/en/o/${orgSlug}/login` });
    await assertNotServerError({ label: "org-scoped signup", path: `/en/o/${orgSlug}/signup` });
    await assertNotServerError({ label: "org-scoped login (unknown slug — same neutral fallback)", path: "/en/o/smoke-test-unknown-org-slug/login" });
    await assertNotServerError({ label: "org-scoped signup (unknown slug — 404, not 5xx)", path: "/en/o/smoke-test-unknown-org-slug/signup" });
  });

  it("onboarding — already-onboarded org redirects away, non-5xx either way", async () => {
    await assertNotServerError({ label: "onboarding (ADMIN, already completed)", path: "/en/onboarding", cookie: adminCookie });
  });

  it("staff pages (ADMIN — a superset of every staff page's allowed roles)", async () => {
    const routes: RouteCase[] = [
      { label: "dashboard", path: "/en/dashboard" },
      { label: "dashboard analytics", path: "/en/dashboard/analytics" },
      { label: "students roster", path: "/en/students" },
      { label: "student detail", path: `/en/students/${studentDetailId}` },
      { label: "payments", path: "/en/payments" },
      { label: "admin schedule", path: "/en/admin/schedule" },
      { label: "admin kiosk tokens", path: "/en/admin/kiosk-tokens" },
      { label: "admin branding", path: "/en/admin/branding" },
    ];
    for (const route of routes) {
      await assertNotServerError({ ...route, cookie: adminCookie });
    }
  });

  it("staff pages render for DIRECTOR and INSTRUCTOR too, not only ADMIN", async () => {
    await assertNotServerError({ label: "dashboard (DIRECTOR)", path: "/en/dashboard", cookie: directorCookie });
    await assertNotServerError({ label: "dashboard (INSTRUCTOR)", path: "/en/dashboard", cookie: instructorCookie });
  });

  it("student portal (STUDENT session) — the exact page and role that were 500ing", async () => {
    await assertNotServerError({ label: "student portal", path: "/en/portal", cookie: studentCookie });
  });
});
