import { describe, expect, it } from "vitest";
import { accessFromMembership, isStaffRole, routeAccess } from "../../src/lib/auth/route-access";

/**
 * The middleware's whole decision, as a pure function with positive controls.
 *
 * The middleware runs on the Edge and reads only the session's `access` claim
 * (`{ staff, portal }`, derived from the database at sign-in and on organization
 * switch) — it can REFUSE a stale claim but it cannot GRANT anything: every page
 * still re-derives access from the database (`requireTenantContext`), so a forged
 * or stale `staff: true` gets through the middleware and is stopped there. The
 * tests here pin what the middleware itself does:
 *
 * - a claim that is missing or malformed FAILS CLOSED (forces a re-login) — never
 *   open, never guessed from anything else;
 * - a well-formed claim that denies the tree asks for a refresh from the database
 *   (`refresh`), because the database may now say yes (a promotion while logged in)
 *   — a silent bounce to the login page is not an answer for someone just granted
 *   access;
 * - trees are matched on whole path segments.
 */
const STAFF_PATHS = ["/dashboard", "/dashboard/analytics", "/students", "/students/abc123", "/admin", "/admin/staff", "/admin/locations"];
const PORTAL_PATHS = ["/portal", "/portal/anything"];
const UNGATED_PATHS = ["/", "/login", "/select-organization", "/no-organization-access", "/no-access", "/register-academy", "/o/some-gym/signup", "/kiosk/some-academy", "/payments", "/onboarding"];

const NONE = { staff: false, portal: false };
const STAFF_ONLY = { staff: true, portal: false };
const PORTAL_ONLY = { staff: false, portal: true };
const BOTH = { staff: true, portal: true };

describe("routeAccess", () => {
  it("leaves every ungated path alone — signed in or not, with any claim", () => {
    for (const path of UNGATED_PATHS) {
      for (const [hasSession, access] of [[false, undefined], [true, undefined], [true, NONE], [true, BOTH]] as const) {
        expect(routeAccess(path, hasSession, access), `${path} ${hasSession} ${JSON.stringify(access)}`).toBe("allow");
      }
    }
  });

  it("matches whole path segments — a lookalike prefix is not a gated tree", () => {
    for (const path of ["/dashboards", "/studentsfoo", "/administrator", "/portalx", "/dashboard-old"]) {
      expect(routeAccess(path, false, undefined), path).toBe("allow");
    }
  });

  it("REQUIRED: a gated path with no session goes to login", () => {
    for (const path of [...STAFF_PATHS, ...PORTAL_PATHS]) {
      expect(routeAccess(path, false, undefined), path).toBe("login");
      expect(routeAccess(path, false, BOTH), path).toBe("login"); // a claim without a session is nothing
    }
  });

  it("REQUIRED (fail closed): a signed-in request with a missing or malformed claim is sent to login — never allowed, never refreshed from a guess", () => {
    const malformed = [undefined, null, {}, { staff: true }, { portal: true }, { staff: "true", portal: "true" }, { staff: 1, portal: 1 }, "staff", 1, [], { staff: true, portal: null }];
    for (const claim of malformed) {
      for (const path of [...STAFF_PATHS, ...PORTAL_PATHS]) {
        expect(routeAccess(path, true, claim), `${path} ${JSON.stringify(claim)}`).toBe("login");
      }
    }
  });

  it("a well-formed claim that allows the tree lets the request through", () => {
    for (const path of STAFF_PATHS) {
      expect(routeAccess(path, true, STAFF_ONLY), path).toBe("allow");
      expect(routeAccess(path, true, BOTH), path).toBe("allow");
    }
    for (const path of PORTAL_PATHS) {
      expect(routeAccess(path, true, PORTAL_ONLY), path).toBe("allow");
      expect(routeAccess(path, true, BOTH), path).toBe("allow");
    }
  });

  it("REQUIRED: a well-formed claim that DENIES the tree asks for a refresh from the database — not login, not allow", () => {
    for (const path of STAFF_PATHS) {
      expect(routeAccess(path, true, PORTAL_ONLY), path).toBe("refresh");
      expect(routeAccess(path, true, NONE), path).toBe("refresh");
    }
    for (const path of PORTAL_PATHS) {
      expect(routeAccess(path, true, STAFF_ONLY), path).toBe("refresh");
      expect(routeAccess(path, true, NONE), path).toBe("refresh");
    }
  });

  it("a claim only ever grants the tree it names (each side is independent)", () => {
    expect(routeAccess("/dashboard", true, STAFF_ONLY)).toBe("allow");
    expect(routeAccess("/portal", true, STAFF_ONLY)).toBe("refresh");
    expect(routeAccess("/portal", true, PORTAL_ONLY)).toBe("allow");
    expect(routeAccess("/dashboard", true, PORTAL_ONLY)).toBe("refresh");
  });
});

describe("accessFromMembership — one rule for the claim and for every per-request check", () => {
  it("staff access comes from a staff ROLE; portal access from a linked, active student record — and they are independent", () => {
    expect(accessFromMembership({ role: "ADMIN", linkedStudentId: null })).toEqual(STAFF_ONLY);
    expect(accessFromMembership({ role: "DIRECTOR", linkedStudentId: null })).toEqual(STAFF_ONLY);
    expect(accessFromMembership({ role: "INSTRUCTOR", linkedStudentId: null })).toEqual(STAFF_ONLY);
    expect(accessFromMembership({ role: "STUDENT", linkedStudentId: "s1" })).toEqual(PORTAL_ONLY);
    // A coach who also trains has BOTH.
    expect(accessFromMembership({ role: "INSTRUCTOR", linkedStudentId: "s1" })).toEqual(BOTH);
    expect(accessFromMembership({ role: "ADMIN", linkedStudentId: "s1" })).toEqual(BOTH);
  });

  it("a STUDENT membership with no linked, active student record has no portal — membership alone is not enough", () => {
    expect(accessFromMembership({ role: "STUDENT", linkedStudentId: null })).toEqual(NONE);
  });

  it("isStaffRole names exactly the three staff roles", () => {
    expect(["ADMIN", "DIRECTOR", "INSTRUCTOR", "STUDENT"].filter(isStaffRole)).toEqual(["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  });
});
