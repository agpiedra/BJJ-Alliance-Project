import { notFound } from "next/navigation";
import { resolveAcademyBySlug } from "@/lib/tenant/platform-lookups";
import { BrandBanner } from "@/components/brand/brand-banner";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { BrandingScope } from "@/components/branding/branding-scope";
import type { KioskContext } from "@/lib/tenant/types";
import { KioskClient } from "./kiosk-client";

// Public, zero-credential tablet surface — spec explicitly calls for NO auth
// guard here (not `requireStaffSession`, not a `middleware.ts` protected
// prefix). Any staff member with a browser can also load this URL, but the
// only "credential" involved is the kiosk device token in the query string,
// which is verified server-side by the check-in API itself, never here.
//
// Whether the academy exists/`active` could change without a redeploy
// (a director could deactivate an academy), so this is never statically
// cached.
export const dynamic = "force-dynamic";

export default async function KioskPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; academySlug: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { academySlug } = await params;
  const { token } = await searchParams;

  // Resolving the organization FROM its academy's slug is the one thing
  // that can never itself be organization-scoped (Appendix C decision 4,
  // point 3 — this is the kiosk's own tenant resolution, not a read that
  // already has a tenant to scope by) — see platform-lookups.ts.
  const academy = await resolveAcademyBySlug(academySlug);

  // A missing academy AND a deactivated one 404 identically — neither should
  // leak to a caller which of the two applies.
  if (!academy || !academy.active) {
    notFound();
  }

  // The token itself is never validated here — only the check-in API
  // (`POST /api/kiosk/check-in`) verifies it against `Academy.kioskTokenHash`.
  // A missing/blank token still renders the keypad; every submit will just
  // come back `invalid_token` from the API, same as a wrong one.
  const tokenValue = typeof token === "string" ? token : "";

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — the kiosk matters most: it's
  // the screen students actually stand in front of. `KioskContext` is a
  // real `AccessContext` member (tenant/types.ts), so this goes through the
  // exact same tenant-guarded `getOrganizationBranding` read every other
  // surface uses — never a platform-lookup escape hatch for branding
  // specifically, even though the academy identity above genuinely needs
  // one of its own.
  const kioskContext: KioskContext = { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
  const branding = await getOrganizationBranding(kioskContext);

  return (
    <BrandingScope branding={branding}>
      <BrandBanner
        compact
        logoUrl={branding.logoUrl}
        initials={branding.initials}
        initialsBackground={branding.sidebar.background}
        initialsForeground={branding.sidebar.foreground}
        alt={branding.displayName}
      >
        <span className="truncate font-medium">{academy.name}</span>
      </BrandBanner>
      <KioskClient
        academyId={academy.id}
        academyName={academy.name}
        academySlug={academy.slug}
        token={tokenValue}
      />
    </BrandingScope>
  );
}
