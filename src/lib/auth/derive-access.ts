import { resolveContext } from "@/lib/tenant/resolve-context";
import type { TenantContext } from "@/lib/tenant/types";
import { accessFromMembership, type AccessClaim } from "@/lib/auth/route-access";

const NO_ACCESS: AccessClaim = { staff: false, portal: false };

/** The claim for an already-resolved, database-verified context — the same rule the token uses. */
export function accessFromContext(context: TenantContext): AccessClaim {
  return accessFromMembership({ role: context.organizationRole, linkedStudentId: context.linkedStudentId });
}

/**
 * The `{ staff, portal }` claim for one user in one organization, derived from the
 * DATABASE through `resolveContext` — the very function every per-request check
 * uses, so the claim can never disagree with a page about what a membership means.
 * Anything that ends access (a deactivated account or membership, a non-ACTIVE
 * organization, no membership at all, no organization resolved) yields no access.
 *
 * Node-only (Prisma). Called from `signInJwtCallback` at sign-in and whenever the
 * session is updated (organization switch, explicit refresh); the Edge middleware
 * only ever reads the result.
 */
export async function deriveAccess(userId: string, organizationId: string | null): Promise<AccessClaim> {
  if (!organizationId) return NO_ACCESS;
  const result = await resolveContext(userId, organizationId);
  if (result.status !== "OK") return NO_ACCESS;
  return accessFromContext(result.context);
}
