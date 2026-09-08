import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("home");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-bold">{t("heading")}</h1>
      <p className="text-lg text-muted-foreground">{t("subheading")}</p>
    </main>
  );
}
