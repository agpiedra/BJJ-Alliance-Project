import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { BeltGraphic, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { getPublicHomeStats } from "./home-data";

// Reads live, admin-editable data (academy/class-session counts, one
// academy's schedule) that can change without a redeploy — same reasoning
// as the signup and kiosk pages, never frozen at build time.
export const dynamic = "force-dynamic";

/** Static illustrative examples for this marketing page — not driven by
 * any real organization's catalog, so the color data is hardcoded here
 * (the same hex palette the real Alliance adult ranks are seeded with).
 * `code` is kept only so the existing `tBelt(code)` lookup below (the
 * deliberately-preserved static/marketing exception from Phase 3a) can
 * still localize the caption. */
function adultExample(code: string, primaryColor: string, barColor: string, stripes: number): {
  code: string;
  belt: BeltVisualData;
  stripes: number;
} {
  return {
    code,
    belt: {
      primaryColor,
      centerStripeColor: null,
      barColor,
      stripeColors: Array.from({ length: 4 }, () => "#FFFFFF"),
      maxStripes: stripes === 0 ? 0 : 4,
      visibleStripeSlots: 4,
    },
    stripes,
  };
}

const BELT_PROGRESSION = [
  adultExample("WHITE", "#F0EBE0", "#111116", 4),
  adultExample("BLUE", "#215DA5", "#111116", 4),
  adultExample("PURPLE", "#652F94", "#111116", 4),
  adultExample("BROWN", "#643D20", "#111116", 4),
  adultExample("BLACK", "#111116", "#B63B32", 0),
];

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Phase 3a: this marketing illustration isn't driven by any real
  // organization's catalog — it's a fixed, static example of the 5 adult
  // belts, so it stays on `belt.<code>` message keys rather than a real
  // rank row's labelEs/labelEn (the one other deliberate exception, besides
  // the pre-Phase-3b /dev/belts stub).
  const [t, tDay, tType, tBelt, { academyCount, weeklyClassCount, previewAcademy, previewSessions }] =
    await Promise.all([
      getTranslations("home"),
      getTranslations("dayOfWeek"),
      getTranslations("classType"),
      getTranslations("belt"),
      getPublicHomeStats(),
    ]);

  return (
    <>
      <BrandBanner />
      <main className="mx-auto flex max-w-4xl flex-col gap-12 p-6 pb-16">
        <section className="flex flex-col items-center gap-4 pt-8 text-center">
          <h1 className="text-3xl font-bold sm:text-4xl">{t("heading")}</h1>
          <p className="max-w-xl text-lg text-muted-foreground">{t("subheading")}</p>
          <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
            <Button size="lg" nativeButton={false} render={<a href={`/${locale}/signup`} />}>
              {t("cta")}
            </Button>
            <a href={`/${locale}/login`} className="text-sm underline">
              {t("loginLink")}
            </a>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-3xl font-bold text-brand-gold">{academyCount}</span>
              <span className="text-sm text-muted-foreground">{t("stats.academies")}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-3xl font-bold text-brand-gold">{weeklyClassCount}</span>
              <span className="text-sm text-muted-foreground">{t("stats.weeklyClasses")}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-xl font-bold sm:text-2xl">
                {previewAcademy?.timezone ?? "—"}
              </span>
              <span className="text-sm text-muted-foreground">{t("stats.timezone")}</span>
            </CardContent>
          </Card>
        </section>

        {previewAcademy && (
          <section className="flex flex-col gap-4">
            <div className="text-center">
              <h2 className="text-xl font-semibold">
                {t("schedule.heading", { academy: previewAcademy.name })}
              </h2>
              <p className="text-sm text-muted-foreground">{t("schedule.description")}</p>
            </div>
            {previewSessions.length > 0 ? (
              <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-4 py-2">{t("schedule.table.day")}</th>
                      <th className="px-4 py-2">{t("schedule.table.time")}</th>
                      <th className="px-4 py-2">{t("schedule.table.name")}</th>
                      <th className="px-4 py-2">{t("schedule.table.type")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewSessions.map((session) => (
                      <tr key={session.id} className="border-b last:border-0">
                        <td className="px-4 py-2">{tDay(session.dayOfWeek)}</td>
                        <td className="px-4 py-2">{session.startTime}</td>
                        <td className="px-4 py-2">{session.name}</td>
                        <td className="px-4 py-2">{tType(session.type)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-center text-sm text-muted-foreground">{t("schedule.empty")}</p>
            )}
          </section>
        )}

        <section className="flex flex-col items-center gap-4">
          <h2 className="text-xl font-semibold">{t("belts.heading")}</h2>
          <p className="max-w-xl text-center text-sm text-muted-foreground">
            {t("belts.description")}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            {BELT_PROGRESSION.map(({ code, belt, stripes }) => (
              <BeltGraphic key={code} belt={belt} label={tBelt(code)} stripes={stripes} />
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
