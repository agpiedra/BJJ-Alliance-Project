import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { SESSION_COOKIE_NAME, SMOKE_BASE_URL, mintSessionCookie, readSessionCookie, withAccessClaim } from "../helpers/smoke";

/**
 * Access is decided in two places, and only ONE of them can be fooled:
 *
 * - the Edge middleware reads a `{ staff, portal }` claim out of the session token. It
 *   has no database, so it can only REFUSE on a claim — a token whose claim says more
 *   than the database does (forged, or simply stale after a demotion) walks straight
 *   through it;
 * - every page then re-derives access from the DATABASE, which is what actually stops
 *   that person (tests/integration/forged-claim-server-components.test.ts drives the
 *   page half in-process; this drives it through the real middleware and a real server).
 *
 * And the opposite direction, which is where a customer would otherwise be told "no"
 * for something they were just given: promoted while logged in, holding a token that
 * still says portal-only. The middleware must NOT dead-end them (no 404, no login page,
 * no "log out and back in"): it sends them through `/api/access/refresh`, which
 * re-derives the claim from the database, WRITES it back into the session cookie, and
 * carries them on to where they were going.
 *
 * Every session here belongs to a real, seeded user — the claim inside is the only
 * thing altered, so nothing but the claim differs from what a real login produces.
 * Redirects are never followed automatically: the hop itself is what is asserted.
 */
const BASE_URL = SMOKE_BASE_URL;
const STAFF_TREES = ["/en/dashboard", "/en/students", "/en/admin/staff"] as const;
const FORGED = { staff: true, portal: true };

async function get(path: string, cookie?: string) {
  return fetch(`${BASE_URL}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
}

/** Where a redirect response points, as path + query on our own origin (asserting the host is ours). */
function redirectTarget(response: Response): string {
  expect(response.status, "expected a redirect").toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  const url = new URL(response.headers.get("location")!, BASE_URL);
  expect(url.origin).toBe(new URL(BASE_URL).origin);
  return url.pathname + url.search;
}

/** The `name=value` of the session cookie a response set, if it set one. */
function sessionCookieSetBy(response: Response): string | null {
  const found = response.headers.getSetCookie().find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`));
  return found ? found.split(";")[0]! : null;
}

describe("a stale or forged access claim, through real HTTP", () => {
  let studentCookie: string;
  let instructorCookie: string;

  beforeAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { in: ["student@test.com", "instructor@test.com"] } }, select: { id: true, email: true } });
    const byEmail = new Map(users.map((u) => [u.email, u.id]));
    const studentId = byEmail.get("student@test.com");
    const instructorId = byEmail.get("instructor@test.com");
    if (!studentId || !instructorId) throw new Error("Smoke suite requires the seeded QA student and instructor to exist.");
    studentCookie = await mintSessionCookie(studentId);
    instructorCookie = await mintSessionCookie(instructorId);
  });

  it("the seeded sessions carry the claims this suite assumes (so a passing run is not an accident of the seed)", async () => {
    expect((await readSessionCookie(studentCookie)).access).toEqual({ staff: false, portal: true });
    expect((await readSessionCookie(instructorCookie)).access).toMatchObject({ staff: true });
  });

  describe("a claim that says MORE than the database (forged, or stale after a demotion)", () => {
    it("REQUIRED: the honest student session is refused AT the middleware — the control that makes the next test mean something", async () => {
      for (const path of STAFF_TREES) {
        const response = await get(path, studentCookie);
        expect(redirectTarget(response), path).toBe(`/api/access/refresh?to=${encodeURIComponent(path)}`);
      }
    });

    it("REQUIRED: the same student with a claim of staff access sails through the middleware — and the PAGE sends them to the refresh, not to a bare 404", async () => {
      const forged = await withAccessClaim(studentCookie, FORGED);
      // The middleware would send them to the refresh with `to` = the path they asked for (the control above).
      // A `to` of the dashboard for these other paths can only have come from the page's own database check.
      for (const path of ["/en/students", "/en/admin/staff"]) {
        const response = await get(path, forged);
        expect(redirectTarget(response), `${path} — the middleware passed the forged claim, so only the page's database check can have redirected`).toBe(
          `/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`,
        );
      }
    });

    it("REQUIRED: that redirect, followed, corrects the session and explains — and the very next request is refused at the middleware", async () => {
      const forged = await withAccessClaim(studentCookie, FORGED);
      const fromPage = redirectTarget(await get("/en/students", forged));
      const refresh = await get(fromPage, forged);
      expect(redirectTarget(refresh)).toBe("/en/no-access");
      const healed = sessionCookieSetBy(refresh);
      expect(healed, "the refresh did not write the corrected claim back into the session cookie").not.toBeNull();
      expect((await readSessionCookie(healed!)).access).toEqual({ staff: false, portal: true });
      expect(redirectTarget(await get("/en/students", healed!))).toBe(`/api/access/refresh?to=${encodeURIComponent("/en/students")}`);
    });

    it("control: a STAFF member refused an Owner-only page is not sent anywhere — exactly 404 (they know the app exists)", async () => {
      const response = await get("/en/admin/staff", instructorCookie);
      expect(response.status).toBe(404);
    });

    it("REQUIRED: following the honest student's refusal ends on a plain 'no access' page, not the login page and not a crash", async () => {
      const hop = await get(`/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`, studentCookie);
      expect(redirectTarget(hop)).toBe("/en/no-access");
      const page = await get("/en/no-access", studentCookie);
      expect(page.status).toBe(200);
    });

    it("a stale staff claim on a student-only member is corrected by the refresh: the cookie is rewritten to what the database says", async () => {
      const stale = await withAccessClaim(studentCookie, FORGED);
      const hop = await get(`/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`, stale);
      expect(redirectTarget(hop)).toBe("/en/no-access");
      const rewritten = sessionCookieSetBy(hop);
      expect(rewritten, "the refresh did not write the corrected claim back into the session cookie").not.toBeNull();
      expect((await readSessionCookie(rewritten!)).access).toEqual({ staff: false, portal: true });
    });
  });

  describe("a claim that says LESS than the database (promoted while logged in)", () => {
    it("REQUIRED: is never a silent refusal — the middleware routes it through the refresh, which carries them on to the page they asked for", async () => {
      const stale = await withAccessClaim(instructorCookie, { staff: false, portal: true });

      const first = await get("/en/dashboard", stale);
      expect(redirectTarget(first)).toBe(`/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`);

      const refresh = await get(`/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`, stale);
      expect(redirectTarget(refresh)).toBe("/en/dashboard");

      const rewritten = sessionCookieSetBy(refresh);
      expect(rewritten, "the refresh must WRITE the new claim into the session cookie, or the very next click is refused again — a loop").not.toBeNull();
      expect((await readSessionCookie(rewritten!)).access).toMatchObject({ staff: true });

      const arrived = await get("/en/dashboard", rewritten!);
      expect(arrived.status, "with the refreshed cookie the dashboard renders — no redirect, no 404").toBe(200);
    });
  });

  describe("no usable claim at all: fails CLOSED", () => {
    it("REQUIRED: a token from before the claim existed goes to the login page (it is not quietly upgraded)", async () => {
      const claimless = await withAccessClaim(instructorCookie, undefined);
      for (const path of STAFF_TREES) {
        const target = redirectTarget(await get(path, claimless));
        expect(target, path).toBe(`/en/login?callbackUrl=${encodeURIComponent(path)}`);
      }
    });

    it("the refresh route does not heal it either: it sends it to the login page too", async () => {
      const claimless = await withAccessClaim(instructorCookie, undefined);
      const hop = await get(`/api/access/refresh?to=${encodeURIComponent("/en/dashboard")}`, claimless);
      expect(redirectTarget(hop)).toBe(`/en/login?callbackUrl=${encodeURIComponent("/en/dashboard")}`);
      expect(sessionCookieSetBy(hop), "a claim-less session must not be handed a fresh claim").toBeNull();
    });
  });

  it("the refresh route's `to` is same-origin only: it is never an open redirect", async () => {
    for (const to of ["https://evil.example/steal", "//evil.example/steal"]) {
      const hop = await get(`/api/access/refresh?to=${encodeURIComponent(to)}`, instructorCookie);
      const location = hop.headers.get("location") ?? "";
      expect(location, to).not.toContain("evil.example");
    }
  });
});
