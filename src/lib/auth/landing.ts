import { resolveActiveOrganizationForSignIn } from "@/lib/tenant/active-organization";
import { deriveAccess } from "@/lib/auth/derive-access";
import { landingFor } from "@/lib/auth/route-access";

/**
 * Where someone lands after signing in or switching organization, decided from the
 * DATABASE (never the global `User.role`): the staff app if they have it — including
 * a coach who also trains, whose staff app links to their training — else the portal.
 * With nothing to derive from (no organization resolved yet, or no access there) the
 * staff path is returned deliberately: the middleware and the refresh route then send
 * them exactly where a page would — choose an organization, "awaiting approval", or
 * "no organization access" — instead of guessing here.
 */
export async function landingPathForOrganization(userId: string, organizationId: string): Promise<"/dashboard" | "/portal"> {
  return landingFor(await deriveAccess(userId, organizationId)) ?? "/dashboard";
}

export async function landingPathForUser(userId: string): Promise<"/dashboard" | "/portal"> {
  const resolution = await resolveActiveOrganizationForSignIn(userId);
  if (resolution.kind !== "resolved") return "/dashboard";
  return landingPathForOrganization(userId, resolution.organizationId);
}
