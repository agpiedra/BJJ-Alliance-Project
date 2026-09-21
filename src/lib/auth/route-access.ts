/**
 * Who may enter which route tree, as pure functions with no imports — safe for the
 * Edge middleware, and shared with the Node side that derives the claim, so the
 * two cannot drift.
 *
 * ACCESS IS MEMBERSHIP, NOT A GLOBAL ROLE. The session carries a claim
 * `{ staff, portal }`, derived from the database for the organization the person is
 * currently acting in (`derive-access.ts`, at sign-in and on organization switch):
 *
 * - `staff`  — an active membership whose role is ADMIN, DIRECTOR or INSTRUCTOR;
 * - `portal` — an active membership AND a linked `Student` record whose status is
 *   ACTIVE (a coach who trains has both; an archived student, or a coach whose OWN
 *   student record is archived, has no portal).
 *
 * The claim is only ever a hint. The middleware can REFUSE on it; it cannot GRANT
 * anything, because every page re-derives access from the database
 * (`requireTenantContext`) on every request. A forged or stale `staff: true` passes
 * the middleware and is stopped there — see `tests/smoke/stale-access-claim.test.ts`.
 *
 * `User.role` is NOT an authorization source and nothing here reads it.
 */
export interface AccessClaim {
  staff: boolean;
  portal: boolean;
}

const STAFF_ROLES: readonly string[] = ["ADMIN", "DIRECTOR", "INSTRUCTOR"];

export function isStaffRole(role: string): boolean {
  return STAFF_ROLES.includes(role);
}

/** The one rule turning a resolved membership into a claim — used for the token AND for every per-request check. */
export function accessFromMembership(input: { role: string; linkedStudentId: string | null }): AccessClaim {
  return { staff: isStaffRole(input.role), portal: input.linkedStudentId !== null };
}

const STAFF_TREES = ["/dashboard", "/students", "/admin"];
const PORTAL_TREES = ["/portal"];

function inTree(path: string, trees: readonly string[]): boolean {
  return trees.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

/** A claim is trusted only when it is exactly `{ staff: boolean, portal: boolean }`. Anything else is "no claim". */
export function isAccessClaim(value: unknown): value is AccessClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.staff === "boolean" && typeof record.portal === "boolean";
}

export type RouteAccessDecision = "allow" | "login" | "refresh";

/**
 * The middleware's whole decision for a locale-less path.
 *
 * - not a gated tree                           -> `allow`
 * - gated, no session                          -> `login`
 * - gated, session, claim missing or malformed -> `login`   (FAIL CLOSED: forces a re-login)
 * - gated, claim allows the tree               -> `allow`
 * - gated, claim denies the tree               -> `refresh` (ask the database — it may now say yes)
 */
export function routeAccess(pathWithoutLocale: string, hasSession: boolean, access: unknown): RouteAccessDecision {
  const staffTree = inTree(pathWithoutLocale, STAFF_TREES);
  const portalTree = inTree(pathWithoutLocale, PORTAL_TREES);
  if (!staffTree && !portalTree) return "allow";
  if (!hasSession) return "login";
  if (!isAccessClaim(access)) return "login";
  const allowed = staffTree ? access.staff : access.portal;
  return allowed ? "allow" : "refresh";
}

/** The locale-less path, for a request path that may start with `/es` or `/en`. */
export function stripLocale(pathname: string): string {
  const match = pathname.match(/^\/(es|en)(\/.*)?$/);
  return match ? (match[2] ?? "/") : pathname;
}
