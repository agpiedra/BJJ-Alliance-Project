import { useTranslations } from "next-intl";
import { BeltGraphic, type Belt } from "@/components/belt-graphic/belt-graphic";

const BELTS: Belt[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];
const STRIPE_COUNTS = [0, 1, 2, 3, 4];

export default function DevBeltsPage() {
  const t = useTranslations("devBelts");

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      {BELTS.map((belt) => (
        <div key={belt} className="flex flex-wrap gap-4">
          {STRIPE_COUNTS.map((stripes) => (
            <BeltGraphic key={`${belt}-${stripes}`} belt={belt} stripes={stripes} />
          ))}
        </div>
      ))}
    </main>
  );
}
