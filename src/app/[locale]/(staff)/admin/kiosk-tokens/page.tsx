import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RegenerateKioskTokenButton } from "./regenerate-kiosk-token-button";

// The academy list an ADMIN sees here could change without a redeploy —
// never frozen at build time, same reasoning as the roster/dashboard pages.
export const dynamic = "force-dynamic";

export default async function KioskTokensPage() {
  // ADMIN-only — this page manages a shared, academy-wide device credential,
  // not a single academy's own data, so it's global-admin territory rather
  // than something a DIRECTOR/INSTRUCTOR session can reach. The read below
  // (listing every academy) is only safe to do unscoped because this call
  // already rejected any non-ADMIN session.
  await requireStaffSession(["ADMIN"]);

  const academies = await prisma.academy.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true },
  });

  const t = await getTranslations("adminKioskTokens");

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>

      <div className="flex flex-col gap-4">
        {academies.map((academy) => (
          <Card key={academy.id}>
            <CardHeader>
              <CardTitle>{academy.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <RegenerateKioskTokenButton academyId={academy.id} academySlug={academy.slug} />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
