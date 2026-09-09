import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
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

  const academy = await prisma.academy.findUnique({
    where: { slug: academySlug },
    select: { id: true, name: true, slug: true, active: true },
  });

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

  return (
    <KioskClient
      academyId={academy.id}
      academyName={academy.name}
      academySlug={academy.slug}
      token={tokenValue}
    />
  );
}
