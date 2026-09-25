import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { BeltGraphic, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";

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
  const t = await getTranslations("home");
  const tBelt = await getTranslations("belt");

  return (
    <>
      <BrandBanner />
      <main className="mx-auto flex max-w-4xl flex-col gap-12 p-6 pb-16">
        <section className="flex flex-col items-center gap-4 pt-8 text-center">
          <h1 className="text-3xl font-bold sm:text-4xl">{t("heading")}</h1>
          <p className="max-w-xl text-lg text-muted-foreground">{t("subheading")}</p>
          <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
            {/* MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — this is the
                product's front door, so its CTA is the platform's own
                registration entry point, never a specific organization's
                signup link (that was the previous, pre-multi-tenant version
                of this page: Alliance's own signup, hardcoded). Alliance
                reaches its own students through /o/alliance-cr/signup
                directly, not through this page. */}
            <Button size="lg" nativeButton={false} render={<a href={`/${locale}/register-academy`} />}>
              {t("cta")}
            </Button>
            <a href={`/${locale}/login`} className="text-sm underline pointer-coarse:py-3">
              {t("loginLink")}
            </a>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-sm font-medium">{t("highlights.family")}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-sm font-medium">{t("highlights.progress")}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col items-center gap-1 text-center">
              <span className="text-sm font-medium">{t("highlights.schedule")}</span>
            </CardContent>
          </Card>
        </section>

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
