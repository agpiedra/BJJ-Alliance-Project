import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { Button } from "@/components/ui/button";
import { LogoUploader } from "@/components/branding/logo-uploader";
import { ThemePicker } from "@/components/branding/theme-picker";
import {
  uploadBrandingLogo,
  removeBrandingLogo,
  saveBrandingTheme,
} from "../(staff)/admin/branding/actions";
import { OnboardingStep1Form } from "./step1-form";
import { advanceOnboardingStep, completeOnboarding } from "./actions";

// Onboarding state changes without a redeploy — never statically cached.
export const dynamic = "force-dynamic";

const TOTAL_STEPS = 3;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — the first-login onboarding
 * wizard. Gate (trigger into this page) lives in (staff)/layout.tsx, not
 * here — this page only handles what happens once you're already on it:
 * idempotent redirect once already completed, resume at the persisted
 * step, and steps 2/3 embed Phase 4's LogoUploader/ThemePicker AS-IS with
 * their existing save actions — never a second uploader or color picker.
 */
export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  const t = await getTranslations("onboarding");

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — "Select explicit
  // field lists for organization reads on director surfaces; never...
  // a bare findUnique whose whole row is handed to a component." Only
  // these 4 fields are ever read from this row (below); an explicit
  // select means a future billing field (graceDays, billingNote) can
  // never leak into this server component's scope by accident.
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: context.organizationId },
    select: { onboardingCompletedAt: true, onboardingStep: true, name: true, slug: true },
  });

  // Idempotent and non-reentrant (doc): once completed, this page only ever
  // redirects away — nothing here is lost or reset by visiting it again.
  if (organization.onboardingCompletedAt) {
    redirect(`/${locale}/admin/branding`);
  }

  const step = Math.min(Math.max(organization.onboardingStep, 1), TOTAL_STEPS);

  const [raw, resolved] = await Promise.all([
    getScopedDb(context).organizationBranding.findUnique({ where: { organizationId: context.organizationId } }),
    getOrganizationBranding(context),
  ]);
  const displayName = raw?.displayName || organization.name;
  const skipAction = completeOnboarding.bind(null, locale);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">{t("stepOf", { step, total: TOTAL_STEPS })}</p>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </div>

      {step === 1 && (
        <OnboardingStep1Form
          locale={locale}
          organizationName={organization.name}
          displayName={displayName}
          slug={organization.slug}
        />
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("step2.hint")}</p>
          <LogoUploader
            organizationId={context.organizationId}
            logoUrl={resolved.logoUrl}
            displayName={displayName}
            previewBackground={resolved.sidebar.background}
            uploadAction={uploadBrandingLogo}
            removeAction={removeBrandingLogo}
          />
          <form action={advanceOnboardingStep.bind(null, locale, 3)}>
            <Button type="submit">{t("next")}</Button>
          </form>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("step3.hint")}</p>
          <ThemePicker
            organizationId={context.organizationId}
            initial={{
              displayName,
              primaryColor: resolved.primary.background,
              sidebarBackground: resolved.sidebar.background,
              sidebarForeground: raw?.sidebarForeground ?? null,
              sidebarActiveBackground: raw?.sidebarActiveBackground ?? null,
              sidebarActiveForeground: raw?.sidebarActiveForeground ?? null,
              sidebarBorder: raw?.sidebarBorder ?? null,
            }}
            action={saveBrandingTheme}
          />
          <form action={skipAction}>
            <Button type="submit">{t("finish")}</Button>
          </form>
        </div>
      )}

      <form action={skipAction}>
        <button type="submit" className="text-sm text-muted-foreground underline">
          {t("skipForNow")}
        </button>
      </form>
    </main>
  );
}
