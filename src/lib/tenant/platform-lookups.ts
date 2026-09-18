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

export interface SignupOrganization {
  id: string;
  name: string;
  academies: Array<{ slug: string; name: string }>;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — replaces the old
 * `listSignupAcademies`'s hardcoded `z.enum(["escazu", "escalante"])`
 * stopgap. That restriction existed because signup was public and
 * pre-tenant — its unrestricted predecessor leaked every academy across
 * every organization to anonymous visitors (revision 23). The real fix
 * isn't a bigger allowlist, it's the same one login uses: the organization
 * is now explicit, named by `/o/[orgSlug]/signup`'s own URL segment, so the
 * academy list this returns is genuinely scoped by it — safe because the
 * org was deliberately identified, not because of a hardcoded list.
 *
 * `null` for an unknown OR non-ACTIVE organization slug — unlike login,
 * signup has no safe neutral fallback to show (there is nothing generic to
 * sign up FOR), so the caller renders a plain 404, same as any other
 * unmatched route.
 */
export async function resolveOrganizationForSignup(orgSlug: string): Promise<SignupOrganization | null> {
  const organization = await unscopedPrisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;

  const academies = await unscopedPrisma.academy.findMany({
    where: { organizationId: organization.id, active: true },
    orderBy: { name: "asc" },
    select: { slug: true, name: true },
  });

  return { id: organization.id, name: organization.name, academies };
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

export interface OrganizationLoginBranding {
  displayName: string;
  initials: string;
  logoUrl: string | null;
  primary: ResolvedPrimaryTheme;
  sidebar: ResolvedSidebarTheme;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — real per-org login branding,
 * replacing Phase 4's `resolveSingleOrganizationBranding` stopgap outright
 * (deleted, not deprecated, exactly as promised when that stopgap was
 * built: "it should still be deleted outright once Phase 5's real per-org
 * login routing exists").
 *
 * `null` for an unknown slug OR a non-ACTIVE organization — and
 * deliberately the SAME `null` for both. An anonymous, pre-auth visitor is
 * "not yet a member" by this project's own settled disclosure rule
 * ("disclose to members, never to non-members" — see the Global rules
 * above), so a PENDING/SUSPENDED/CANCELLED organization's branding, or
 * even the fact that a slug does or doesn't correspond to a real
 * organization, is never shown pre-auth. The caller (`/o/[orgSlug]/login`)
 * renders the exact same neutral, unbranded login for all three cases. A
 * real member who actually signs in still reaches `/organization-unavailable`
 * via the existing `requireTenantContext` flow, which already discloses the
 * honest reason correctly — that path is untouched here.
 *
 * IMPORTANT: `orgSlug` is a pre-auth DISPLAY signal only, never an
 * authorization input. It decides what's SHOWN before credentials are
 * submitted; it must never be used to scope, gate, or influence which
 * organization a `signIn()` call actually authenticates into — that is
 * resolved entirely from the verified user identity afterward, exactly as
 * it is for bare `/login`.
 *
 * Duplicates get-branding.ts's own composition (resolve primary, feed its
 * background into the sidebar as the active-color default) rather than
 * sharing it — deliberately: that function takes a tenant `AccessContext`
 * and reads through `getScopedDb`, which requires exactly the tenant
 * identity this function is being asked to find. There is no context to
 * scope by yet, which is what makes this a platform-lookups.ts function at
 * all, same as every other one in this file.
 */
export async function resolveOrganizationLoginBranding(orgSlug: string): Promise<OrganizationLoginBranding | null> {
  const organization = await unscopedPrisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return null;

  const row = await unscopedPrisma.organizationBranding.findUnique({ where: { organizationId: organization.id } });

  const displayName = row?.displayName || organization.name;
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
