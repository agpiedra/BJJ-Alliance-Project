/**
 * Where each non-OK tenant status sends a request — ONE map, used by
 * `requireTenantContext` (every page) and by the access refresh route, so a person
 * bounced by the middleware over a stale claim ends up exactly where the page itself
 * would have sent them rather than somewhere generic. All four fail closed (decision
 * 6); only the destination differs, and each destination's copy is honest about
 * which of them it is:
 *
 * - `UNAUTHENTICATED`              -> /login (the only case that actually means that);
 * - `NO_MEMBERSHIP`                -> /no-organization-access (signed in, zero active
 *   memberships — a deactivated member, or a pending applicant);
 * - `NEEDS_ORGANIZATION_SELECTION` -> /select-organization (2+ active memberships,
 *   nothing resolved yet);
 * - `ORG_NOT_ACTIVE`               -> /organization-unavailable.
 *
 * Pure and import-free so a unit test can pin it.
 */
export type NonOkTenantStatus = "UNAUTHENTICATED" | "NO_MEMBERSHIP" | "NEEDS_ORGANIZATION_SELECTION" | "ORG_NOT_ACTIVE";

export function tenantRedirectPath(status: NonOkTenantStatus, locale: string): string {
  switch (status) {
    case "UNAUTHENTICATED":
      return `/${locale}/login`;
    case "NO_MEMBERSHIP":
      return `/${locale}/no-organization-access`;
    case "NEEDS_ORGANIZATION_SELECTION":
      return `/${locale}/select-organization`;
    case "ORG_NOT_ACTIVE":
      return `/${locale}/organization-unavailable`;
  }
}
