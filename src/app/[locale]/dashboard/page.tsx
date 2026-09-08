import { getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { auth } from "@/auth";

export default async function DashboardPage() {
  await requireStaffSession();
  const session = await auth();
  const t = await getTranslations("dashboard");

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <p>{t("welcome", { email: session?.user?.email ?? "" })}</p>
    </main>
  );
}
