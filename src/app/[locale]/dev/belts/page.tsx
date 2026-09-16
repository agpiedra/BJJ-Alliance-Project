import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { BeltGraphic, type BeltSize, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";

// No auth — this route sits outside the (staff) layout and isn't matched
// by middleware.ts's STAFF_PREFIXES/STUDENT_PREFIXES, and it carries no
// real student data, only the org's own rank catalog.
export const dynamic = "force-dynamic";

const SIZES: BeltSize[] = ["xs", "sm", "lg"];

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b — "Build a dev-only page at
 * /dev/belts rendering every rank in both tracks at all three sizes, with
 * every degree from 0 to maxStripes, on light and dark surfaces." The
 * fastest way to catch id collisions, invisible white tape, split-belt
 * errors, and the black-belt red bar — reviewed by screenshot, not
 * assumed.
 */
export default async function DevBeltsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "devBelts" });

  const organization = await prisma.organization.findUnique({ where: { slug: "alliance-cr" } });
  const ranks = organization
    ? await prisma.beltRank.findMany({
        where: { organizationId: organization.id },
        orderBy: [{ track: "asc" }, { order: "asc" }],
      })
    : [];

  function surface(theme: "light" | "dark") {
    return (
      <div
        key={theme}
        className={theme === "light" ? "flex flex-col gap-8 bg-white p-6 text-black" : "flex flex-col gap-8 bg-neutral-900 p-6 text-white"}
      >
        <h2 className="text-lg font-semibold">{theme === "light" ? "Light surface" : "Dark surface"}</h2>
        {ranks.map((rank) => {
          const belt: BeltVisualData = {
            primaryColor: rank.primaryColor,
            centerStripeColor: rank.centerStripeColor,
            barColor: rank.barColor,
            stripeColors: rank.stripeColors,
            maxStripes: rank.maxStripes,
            visibleStripeSlots: rank.visibleStripeSlots,
          };
          const degrees = Array.from({ length: rank.maxStripes + 1 }, (_, i) => i);
          const label = locale === "es" ? rank.labelEs : rank.labelEn;
          return (
            <div key={rank.id} className="flex flex-col gap-2">
              <span className="font-mono text-xs opacity-70">
                {rank.track} · {rank.code} · order {rank.order}
                {rank.isTerminal ? " · terminal" : ""}
              </span>
              {SIZES.map((size) => (
                <div key={size} className="flex flex-wrap items-end gap-3">
                  <span className="w-8 font-mono text-[10px] uppercase opacity-60">{size}</span>
                  {degrees.map((degree) => (
                    <BeltGraphic
                      key={degree}
                      belt={belt}
                      stripes={degree}
                      size={size}
                      label={`${label} ${degree}/${rank.maxStripes}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <main className="flex flex-col gap-4">
      <h1 className="p-6 pb-0 text-2xl font-bold">{t("heading")}</h1>
      {organization ? (
        <>
          {surface("light")}
          {surface("dark")}
        </>
      ) : (
        <p className="p-6 text-sm">No alliance-cr organization found in this database.</p>
      )}
    </main>
  );
}
