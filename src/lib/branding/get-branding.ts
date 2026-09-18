import { getScopedDb } from "@/lib/tenant/scoped-client";
import { deriveInitials, resolvePrimaryTheme, resolveSidebarTheme, type ResolvedPrimaryTheme, type ResolvedSidebarTheme } from "@/lib/theme";
import type { AccessContext } from "@/lib/tenant/types";

/** System defaults for an organization with no branding row at all — should
 * never happen (see OrganizationBranding's own schema doc comment: it's
 * created transactionally alongside every Organization), but a missing row
 * degrades to these rather than crashing the page. A wrong/default theme is
 * a visual bug, not a tenant-isolation failure, so fail-soft is deliberate
 * here specifically. */
const DEFAULT_PRIMARY_COLOR = "#FACC15";
const DEFAULT_SIDEBAR_BACKGROUND = "#111827";

export interface ResolvedBranding {
  organizationId: string;
  displayName: string;
  initials: string;
  logoUrl: string | null;
  primary: ResolvedPrimaryTheme;
  sidebar: ResolvedSidebarTheme;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — a hand-rolled in-memory cache,
 * NOT `next/cache`'s `unstable_cache`/`revalidateTag`. Verified directly
 * (not assumed) that `unstable_cache` throws `Invariant: incrementalCache
 * missing` outside a real Next.js server request — it needs request-scoped
 * cache machinery Next sets up during actual page rendering, which doesn't
 * exist in a plain test process, making the read this entire feature is
 * built around impossible to integration-test. A simple `Map` keyed by
 * organizationId is simpler, fully testable in any environment, and
 * correctness-equivalent for what this needs.
 *
 * Trade-off, stated plainly: this is per-server-instance, not shared across
 * instances the way Next's Data Cache would be — a multi-instance
 * deployment may keep serving a stale color on OTHER instances for up to
 * `CACHE_TTL_MS` after a save on this one. Acceptable for a cosmetic value
 * (a color palette, a logo URL): the instance the director actually saved
 * from reflects the change immediately either way (this module calls
 * `revalidateBranding` synchronously in the same process), and nothing
 * about tenant isolation depends on the cache — a miss just re-runs the
 * same guarded query.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { value: ResolvedBranding; expiresAt: number }>();

/**
 * The ONE read path for organization branding, used identically by the
 * staff sidebar, kiosk, and student portal. `getScopedDb` accepts
 * `KioskContext` generically (it's a real `AccessContext` member, verified
 * directly in tenant/types.ts) — so the kiosk goes through the exact same
 * tenant-guarded query as an authenticated staff/student session, never a
 * platform-lookup escape hatch. There is no unscoped path to this table at
 * all — a cache miss re-runs this same guarded query, so there is no
 * version of this cache that could ever serve one organization's branding
 * under another's key.
 */
async function readBrandingRow(context: AccessContext) {
  return getScopedDb(context).organizationBranding.findUnique({
    where: { organizationId: context.organizationId },
    include: { organization: { select: { name: true } } },
  });
}

export async function getOrganizationBranding(context: AccessContext): Promise<ResolvedBranding> {
  const cached = cache.get(context.organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const row = await readBrandingRow(context);

  const displayName = row?.displayName || row?.organization.name || "Academy";
  const primaryColor = row?.primaryColor ?? DEFAULT_PRIMARY_COLOR;
  const sidebarBackground = row?.sidebarBackground ?? DEFAULT_SIDEBAR_BACKGROUND;
  const primary = resolvePrimaryTheme(primaryColor);

  const resolved: ResolvedBranding = {
    organizationId: context.organizationId,
    displayName,
    initials: deriveInitials(displayName),
    logoUrl: row?.logoUrl ?? null,
    primary,
    // activeBackgroundDefault: primary.background — see SidebarOverrides's
    // own doc comment. An org that hasn't set an explicit sidebar-active
    // color keeps today's exact look (active nav = brand color).
    sidebar: resolveSidebarTheme({
      background: sidebarBackground,
      foreground: row?.sidebarForeground,
      activeBackground: row?.sidebarActiveBackground,
      activeForeground: row?.sidebarActiveForeground,
      activeBackgroundDefault: primary.background,
      border: row?.sidebarBorder,
    }),
  };

  cache.set(context.organizationId, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

/** Called by the settings save/upload/remove actions after a successful
 * write, so this SAME process's next read reflects the change immediately
 * rather than waiting out CACHE_TTL_MS. */
export function revalidateBranding(organizationId: string): void {
  cache.delete(organizationId);
}
