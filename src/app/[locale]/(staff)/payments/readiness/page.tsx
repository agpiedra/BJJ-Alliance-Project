import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { EmptyState } from "@/components/ui/empty-state";
import { getReadinessScreenForOwner } from "@/lib/dues/readiness/screen";
import { defaultCandidateMonth, parseCandidateParam } from "@/lib/dues/readiness/candidate";
import { BeforeStart, MonthPicker, StatusAndChecks, Students, Totals } from "./readiness-view";
import { ReadinessClientRoot } from "./use-readiness-action";

// A live report: never statically frozen.
export const dynamic = "force-dynamic";

/**
 * Stage 8d-1: the owner's READ-ONLY dues readiness screen (docs/dues/STAGE-8D-IMPLEMENTATION-PLAN.md).
 *
 * Owner (ADMIN) only, enforced FIRST and before any readiness data is read: a Director or Instructor gets a real `notFound()`, a
 * non-member the tenant redirect (`requireTenantContext`). `getReadinessScreenForOwner` repeats the owner check itself, with the
 * existing `organization.accessRefused` audit for a non-member, so the data can never be read around this page.
 *
 * `?s=YYYY-MM` is validated here; a malformed value shows the picker and an error and loads no report. Without `s`, the default
 * start month is computed from the same snapshot as the report (`defaultCandidateMonth`).
 */
export default async function DuesReadinessPage({ searchParams }: { searchParams: Promise<{ s?: string | string[] }> }) {
  const context = await requireTenantContext(["ADMIN"]);
  const [t, locale, branding, params] = await Promise.all([getTranslations("payments.readiness"), getLocale(), getOrganizationBranding(context), searchParams]);

  const raw = params.s;
  const parsed = typeof raw === "string" ? parseCandidateParam(raw) : null;
  const invalid = raw !== undefined && parsed === null;

  const header = (
    <header className="flex flex-col gap-1">
      <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">{t("eyebrow", { orgName: branding.displayName })}</p>
      <h1>{t("heading")}</h1>
      <p className="text-sm text-muted-foreground">{t("sub")}</p>
      <a href={`/${locale}/payments/plans`} className="w-fit text-sm underline">
        {t("backToPlans")}
      </a>
    </header>
  );

  if (invalid) {
    // No report for a malformed month: only the picker, around the default computed from the branches' own time zones.
    const academies = await getScopedDb(context).academy.findMany({ select: { timezone: true } });
    const { month } = defaultCandidateMonth(academies.map((a) => a.timezone), new Date());
    return (
      <main className="flex flex-col gap-6 p-4 sm:p-6">
        {header}
        <MonthPicker selected={null} defaultMonth={month} locale={locale} invalid />
      </main>
    );
  }

  const result = await getReadinessScreenForOwner(context.organizationId, parsed);
  if (!result.ok) notFound();
  const { screen } = result;
  const candidate = parsed ?? screen.defaultCandidate;

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      {header}
      <section aria-label={t("month.label")} className="flex flex-col gap-2">
        <MonthPicker selected={candidate} defaultMonth={screen.defaultCandidate} locale={locale} invalid={false} />
        <p className="text-xs text-muted-foreground">
          {t("month.defaultNote")} {screen.branchesDisagree && t("month.disagree")} {t("month.perMonth")}
        </p>
      </section>
      {screen.branches.length === 0 && screen.students.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        // `asOf` changes on every snapshot: the client forms use it to know a refresh has arrived (stage 8d-2).
        <ReadinessClientRoot asOf={screen.asOf.toISOString()}>
          <StatusAndChecks screen={screen} candidate={candidate} locale={locale} />
          <Totals screen={screen} candidate={candidate} locale={locale} />
          <BeforeStart screen={screen} candidate={candidate} locale={locale} organizationId={context.organizationId} />
          <Students screen={screen} candidate={candidate} locale={locale} organizationId={context.organizationId} />
        </ReadinessClientRoot>
      )}
    </main>
  );
}
