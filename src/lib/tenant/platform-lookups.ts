import { unscopedPrisma } from "@/lib/prisma/unscoped";
import { deriveInitials, resolvePrimaryTheme, resolveSidebarTheme, type ResolvedPrimaryTheme, type ResolvedSidebarTheme } from "@/lib/theme";
import type { Academy } from "@/generated/prisma/client";

/**
 * The full set of genuinely platform-level Academy lookups — every one of
 * these resolves a tenant's IDENTITY from a public, pre-auth signal (a kiosk
 * device's slug, a cron job's own id, a hardcoded signup allowlist), which is
 * exactly the shape that can never itself be organization-scoped: a query
 * cannot be filtered by the organization it exists to discover.
 *
 * Isolating `unscopedPrisma` to this one small module (rather than
 * allowlisting every route/page that happened to need one of these) is
 * deliberate. The previous allowlist named 8 individual route files, several
 * of them the exact unauthenticated, pre-tenant surfaces that produced every
 * real leak in this codebase (revision 23/24) — a lint-blessed
 * general-purpose unscoped client sitting directly in `signup/page.tsx`
 * meant the *next* edit to that exact file got no warning at all, which is
 * the guard going quiet precisely where it is needed most. Every other
 * caller now imports a function that does ONE thing, never a client that
 * can do anything.
 */

/**
 * Resolves an Academy by its public URL slug (kiosk devices, self-signup).
 * `null` if no row matches — callers decide what "not found" means for
 * their own response shape (a generic 404, an indistinguishable
 * "invalid_token", etc.), so this never throws on a miss.
 */
export async function resolveAcademyBySlug(slug: string): Promise<Academy | null> {
  return unscopedPrisma.academy.findUnique({ where: { slug } });
}

/**
 * Resolves an Academy's own id/name/organizationId from its id — for
 * callers that already know WHICH academy (a cron's own per-academy
 * iteration, a notification event keyed on `academyId`) but not yet which
 * organization it belongs to.
 *
 * Named `...OrThrow`, matching Prisma's own convention this wraps
 * (`findUniqueOrThrow`) — deliberately NOT the same null-on-miss contract
 * as `resolveAcademyBySlug` above. Both take an id-shaped input and look
 * similar at the call site, so the failure behavior has to be visible in
 * the name, not something a caller has to go read the implementation to
 * discover. Throws if the id doesn't name a real row: every current
 * caller already knows this id came from its own trusted source (a
 * `ClassSession`/`AttendanceRecord` FK, a cron's own just-fetched list),
 * so a miss here means real data corruption, not a value worth handling
 * gracefully.
 */
export async function resolveAcademyByIdOrThrow(
  academyId: string,
): Promise<Pick<Academy, "id" | "name" | "organizationId">> {
  return unscopedPrisma.academy.findUniqueOrThrow({
    where: { id: academyId },
    select: { id: true, name: true, organizationId: true },
  });
}

/**
 * The self-signup form's academy dropdown. This flow is single-organization
 * today — `signup/actions.ts`'s own `homeAcademySlug` validation is a
 * hardcoded `z.enum(["escazu", "escalante"])`, not a real multi-tenant
 * selector (a genuine multi-org self-signup design is Phase 8 territory) —
 * so this queries exactly those two slugs, never "every active academy on
 * the platform," which is the cross-org leak this function's unrestricted
 * predecessor had.
 */
export async function listSignupAcademies(): Promise<Array<{ slug: string; name: string }>> {
  return unscopedPrisma.academy.findMany({
    where: { active: true, slug: { in: ["escazu", "escalante"] } },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });
}

/**
 * Every active Academy's id, for the weekly-digest cron's own per-academy
 * dispatch loop — the one legitimate "iterate every organization on the
 * platform" job in this codebase.
 */
export async function listActiveAcademyIdsForDigest(): Promise<string[]> {
  const academies = await unscopedPrisma.academy.findMany({ where: { active: true }, select: { id: true } });
  return academies.map((academy) => academy.id);
}

export interface SingleOrganizationBranding {
  displayName: string;
  initials: string;
  logoUrl: string | null;
  primary: ResolvedPrimaryTheme;
  sidebar: ResolvedSidebarTheme;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — a deliberately cheap, honest,
 * SELF-REMOVING stopgap for the login page, which has no per-org routing
 * yet (that's Phase 5). With exactly one organization on the platform, its
 * branding is unambiguous even pre-auth; the moment a second organization
 * exists, this returns `null` forever, on its own — no manual deletion step
 * needed, though it should still be deleted outright once Phase 5's real
 * per-org login routing exists, rather than left as permanently-dead code.
 *
 * Duplicates get-branding.ts's own composition (resolve primary, feed its
 * background into the sidebar as the active-color default) rather than
 * sharing it — deliberately: that function takes a tenant `AccessContext`
 * and reads through `getScopedDb`, which requires exactly the tenant
 * identity this function is being asked to find. There is no context to
 * scope by yet, which is what makes this a platform-lookups.ts function at
 * all, same as every other one in this file.
 */
export async function resolveSingleOrganizationBranding(): Promise<SingleOrganizationBranding | null> {
  const organizations = await unscopedPrisma.organization.findMany({ select: { id: true }, take: 2 });
  if (organizations.length !== 1) return null;

  const organizationId = organizations[0].id;
  const row = await unscopedPrisma.organizationBranding.findUnique({
    where: { organizationId },
    include: { organization: { select: { name: true } } },
  });

  const displayName = row?.displayName || row?.organization.name || "Academy";
  const primary = resolvePrimaryTheme(row?.primaryColor ?? "#FACC15");

  return {
    displayName,
    initials: deriveInitials(displayName),
    logoUrl: row?.logoUrl ?? null,
    primary,
    sidebar: resolveSidebarTheme({
      background: row?.sidebarBackground ?? "#111827",
      foreground: row?.sidebarForeground,
      activeBackground: row?.sidebarActiveBackground,
      activeForeground: row?.sidebarActiveForeground,
      activeBackgroundDefault: primary.background,
      border: row?.sidebarBorder,
    }),
  };
}
