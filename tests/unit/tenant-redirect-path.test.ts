import { describe, expect, it } from "vitest";
import { tenantRedirectPath } from "../../src/lib/tenant/redirect-path";

/**
 * Where each non-OK tenant status sends a request. ONE map, used by
 * `requireTenantContext` (every page) AND by the access refresh route — so a person
 * bounced by the middleware for a stale claim ends up exactly where the page itself
 * would have sent them, not somewhere generic. All four fail closed; only the
 * destination differs, and each destination's copy is honest about which it is.
 */
describe("tenantRedirectPath", () => {
  it("REQUIRED: each status has its own destination, in the request's locale", () => {
    expect(tenantRedirectPath("UNAUTHENTICATED", "en")).toBe("/en/login");
    expect(tenantRedirectPath("NO_MEMBERSHIP", "en")).toBe("/en/no-organization-access");
    expect(tenantRedirectPath("NEEDS_ORGANIZATION_SELECTION", "es")).toBe("/es/select-organization");
    expect(tenantRedirectPath("ORG_NOT_ACTIVE", "es")).toBe("/es/organization-unavailable");
  });

  it("the four destinations are all different (an unauthenticated visitor is never told 'no organization')", () => {
    const paths = (["UNAUTHENTICATED", "NO_MEMBERSHIP", "NEEDS_ORGANIZATION_SELECTION", "ORG_NOT_ACTIVE"] as const).map((status) => tenantRedirectPath(status, "en"));
    expect(new Set(paths).size).toBe(4);
  });
});
