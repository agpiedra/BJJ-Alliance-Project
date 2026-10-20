import { getTranslations } from "next-intl/server";
import { cn } from "cn";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { formatExactMoney } from "@/lib/payments/format-money";
import { formatMonthYear } from "@/lib/format-month";
import { addMonths, compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import type { Currency } from "@/generated/prisma/client";
import type { ReadinessScreen } from "@/lib/dues/readiness/screen";
import type { CheckStatus, ConfirmationState } from "@/lib/dues/readiness/evaluate";

/**
 * Stage 8d-1: the owner's READ-ONLY readiness screen. Server components only: no client JavaScript, no form that writes. The
 * single form here is the start-month picker, a plain GET form. Recording drafts, reviews, baselines and assignments is the
 * interactive PR (8d-2); nothing here pretends to do it.
 *
 * Money is shown with `formatExactMoney` (exact decimal strings; never a JavaScript number), and monthly charges and opening debt
 * are two separate tables, grouped by branch and currency, never added together.
 */

const ym = (m: YearMonth) => `${m.year}-${String(m.month).padStart(2, "0")}`;
const money = (amount: string, currency: string, locale: string) => formatExactMoney(amount, currency as Currency, locale);
const dateTime = (date: Date, locale: string) =>
  new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { timeZone: "America/Costa_Rica", dateStyle: "medium", timeStyle: "short" }).format(date);

/** The start-month picker: a GET form whose single field is `s=YYYY-MM`, so it works without JavaScript. */
export async function MonthPicker({ selected, defaultMonth, locale, invalid }: { selected: YearMonth | null; defaultMonth: YearMonth; locale: string; invalid: boolean }) {
  const t = await getTranslations("payments.readiness.month");
  const options: YearMonth[] = [];
  for (let i = -6; i <= 12; i++) options.push(addMonths(defaultMonth, i));
  if (selected && !options.some((m) => compareYearMonth(m, selected) === 0)) {
    options.push(selected);
    options.sort(compareYearMonth);
  }
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span>{t("label")}</span>
        <select
          name="s"
          defaultValue={ym(selected ?? defaultMonth)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "readiness-month-error" : undefined}
          className="h-11 min-w-0 rounded-lg border border-input bg-card px-3 text-sm sm:h-9"
        >
          {options.map((m) => (
            <option key={ym(m)} value={ym(m)}>
              {formatMonthYear(m.year, m.month, locale)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "h-11 sm:h-9")}>
        {t("submit")}
      </button>
      {invalid && (
        <p id="readiness-month-error" role="alert" className="w-full text-sm text-bad">
          {t("invalid")}
        </p>
      )}
    </form>
  );
}

type Translate = (key: string, values?: Record<string, string>) => string;

function itemLabeler(screen: ReadinessScreen, locale: string, t: Translate, paymentStatus: (status: string) => string) {
  const students = new Map(screen.students.map((s) => [s.id, s]));
  const branches = new Map(screen.branches.map((b) => [b.id, b.name]));
  const drafts = new Map(screen.activeDrafts.map((d) => [d.id, d]));
  return (item: string): { text: string; href?: string } => {
    const colon = item.indexOf(":");
    const kind = item.slice(0, colon);
    const id = item.slice(colon + 1);
    if (kind === "student" && students.has(id)) return { text: students.get(id)!.name, href: `/${locale}/students/${id}` };
    if (kind === "branch" && branches.has(id)) return { text: branches.get(id)! };
    if (kind === "legacy" && screen.legacyRows[id]) {
      const row = screen.legacyRows[id];
      return {
        text: t("items.legacy", { student: students.get(row.studentId)?.name ?? "", month: formatMonthYear(row.year, row.month, locale), status: paymentStatus(row.status) }),
        href: `/${locale}/students/${row.studentId}`,
      };
    }
    if (kind === "openingItem" && drafts.has(id)) {
      const d = drafts.get(id)!;
      return {
        text: t("items.openingItem", { student: students.get(d.studentId)?.name ?? "", month: formatMonthYear(d.coverageYear, d.coverageMonth, locale) }),
        href: `/${locale}/students/${d.studentId}`,
      };
    }
    return { text: t("items.unknown") };
  };
}

function ItemList({ items, label }: { items: string[]; label: (item: string) => { text: string; href?: string } }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 text-sm">
      {items.map((item) => {
        const { text, href } = label(item);
        return (
          <li key={item} className="min-w-0 break-words">
            {href ? (
              <a href={href} className="underline underline-offset-2">
                {text}
              </a>
            ) : (
              text
            )}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_VARIANT: Record<CheckStatus, "ok" | "bad" | "plain" | "warn"> = { pass: "ok", fail: "bad", notImplemented: "plain", decisionPending: "warn" };

export async function StatusAndChecks({ screen, candidate, locale }: { screen: ReadinessScreen; candidate: YearMonth; locale: string }) {
  const t = await getTranslations("payments.readiness");
  const tt: Translate = (key, values) => t(key as never, values as never);
  const month = formatMonthYear(candidate.year, candidate.month, locale);
  const tPayment = await getTranslations("students.paymentStatus");
  const label = itemLabeler(screen, locale, tt, (status) => tPayment(status as never));
  const { report } = screen;

  return (
    <>
      <section aria-labelledby="readiness-status" className="flex flex-col gap-2 rounded-xl border border-bad-line bg-bad-soft p-4">
        <h2 id="readiness-status" className="text-base font-semibold text-bad">
          {t("status.notReady")}
        </h2>
        <p className="text-sm">{t("status.notReadyBody")}</p>
        <p className="text-sm">
          <strong>{t("status.asOf", { time: dateTime(screen.asOf, locale) })}</strong> {t("status.asOfBody")}
        </p>
      </section>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>
            <h2>{t("checksHeading")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <ol className="flex flex-col divide-y divide-border">
            {report.checks.map((check) => {
              const key = `checks.${check.key}`;
              const body =
                check.status === "pass"
                  ? t("passed")
                  : check.status === "fail"
                    ? tt(`${key}.fail`, { month })
                    : check.status === "notImplemented"
                      ? tt(`${key}.unavailable`)
                      : tt(`${key}.pending`);
              return (
                <li key={check.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h3 className="text-sm font-medium break-words">
                      <span className="font-mono text-muted-foreground">{check.id}.</span> {tt(`${key}.title`, { month })}
                    </h3>
                    <p className="text-sm text-muted-foreground">{body}</p>
                    {check.status === "fail" && <ItemList items={check.items} label={label} />}
                  </div>
                  <Pill variant={STATUS_VARIANT[check.status]} className="sm:mt-0.5">
                    {t(`checkStatus.${check.status}`)}
                  </Pill>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>
            <h2>{t("warnings.heading")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-4">
          {report.warnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("warnings.none")}</p>
          ) : (
            report.warnings.map((w) => (
              <div key={w.key}>
                <h3 className="text-sm font-medium">{tt(`warnings.${w.key}`, { month })}</h3>
                <ItemList items={w.items} label={label} />
              </div>
            ))
          )}
          <p className="text-sm text-muted-foreground">{t("noteO3")}</p>
        </CardContent>
      </Card>
    </>
  );
}

function TotalsTable({ rows, branchName, locale, t }: {
  rows: { academyId: string; currency: string; count: number; total: string }[];
  branchName: (id: string) => string;
  locale: string;
  t: Translate;
}) {
  return (
    <>
      {/* Narrow screens: one stacked entry per branch and currency, so the total is never pushed out of view. */}
      <ul className="flex flex-col divide-y divide-border text-sm sm:hidden">
        {rows.map((row) => (
          <li key={`${row.academyId}:${row.currency}`} className="flex flex-col gap-1 py-2">
            <span className="break-words">{branchName(row.academyId)}</span>
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-muted-foreground">
                {row.currency} · {t("totals.count")} {row.count}
              </span>
              <span className="font-medium whitespace-nowrap tabular-nums">{money(row.total, row.currency, locale)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="pr-4 pb-2 font-medium">{t("totals.branch")}</th>
              <th scope="col" className="pr-4 pb-2 font-medium">{t("totals.currency")}</th>
              <th scope="col" className="pr-4 pb-2 text-right font-medium">{t("totals.count")}</th>
              <th scope="col" className="pb-2 text-right font-medium">{t("totals.total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.academyId}:${row.currency}`} className="border-t">
                <td className="max-w-[16rem] py-2 pr-4 align-top break-words">{branchName(row.academyId)}</td>
                <td className="py-2 pr-4 align-top">{row.currency}</td>
                <td className="py-2 pr-4 text-right align-top tabular-nums">{row.count}</td>
                <td className="py-2 text-right align-top whitespace-nowrap tabular-nums">{money(row.total, row.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const LISTS = ["undecidable", "notEligible", "explicitNoPlan", "unassigned", "configurationGap"] as const;

export async function Totals({ screen, candidate, locale }: { screen: ReadinessScreen; candidate: YearMonth; locale: string }) {
  const t = await getTranslations("payments.readiness");
  const tt: Translate = (key, values) => t(key as never, values as never);
  const month = formatMonthYear(candidate.year, candidate.month, locale);
  const branchName = (id: string) => screen.branches.find((b) => b.id === id)?.name ?? id;
  const studentName = new Map(screen.students.map((s) => [s.id, s.name]));
  const monthly = screen.report.preview.branches.flatMap((b) => b.wouldCreate.map((w) => ({ academyId: b.academyId, ...w })));

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>
          <h2>{t("totals.heading")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 pt-4">
        <section aria-labelledby="readiness-monthly" className="flex flex-col gap-2">
          <h3 id="readiness-monthly" className="text-sm font-semibold">{t("totals.monthlyHeading", { month })}</h3>
          <p className="text-sm text-muted-foreground">{t("totals.monthlyBody")}</p>
          {monthly.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("totals.noneMonthly")}</p>
          ) : (
            <TotalsTable rows={monthly} branchName={branchName} locale={locale} t={tt} />
          )}
          {screen.report.preview.branches.map((b) =>
            LISTS.some((key) => b[key].length > 0) ? (
              <details key={b.academyId} className="rounded-lg border border-border p-3 text-sm">
                <summary className="cursor-pointer font-medium break-words">{branchName(b.academyId)}</summary>
                <dl className="mt-2 flex flex-col gap-2">
                  {LISTS.filter((key) => b[key].length > 0).map((key) => (
                    <div key={key}>
                      <dt className="text-muted-foreground">
                        {t(`totals.lists.${key}`, { month })} ({b[key].length})
                      </dt>
                      <dd className="break-words">{b[key].map((id) => studentName.get(id) ?? id).join(", ")}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null,
          )}
        </section>
        <section aria-labelledby="readiness-opening" className="flex flex-col gap-2 border-t pt-4">
          <h3 id="readiness-opening" className="text-sm font-semibold">{t("totals.openingHeading")}</h3>
          <p className="text-sm text-muted-foreground">{t("totals.openingBody")}</p>
          {screen.report.openingDrafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("totals.noneOpening")}</p>
          ) : (
            <TotalsTable rows={screen.report.openingDrafts} branchName={branchName} locale={locale} t={tt} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function ConfirmationLine({ label, state, locale, t }: { label: string; state: ConfirmationState; locale: string; t: Translate }) {
  const variant = state.state === "valid" ? "ok" : state.state === "stale" ? "warn" : "plain";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{label}</span>
        <Pill variant={variant}>{t(`students.state.${state.state}`)}</Pill>
      </div>
      {state.state !== "missing" && (
        <p className="text-xs text-muted-foreground">
          {t("students.recorded", { time: dateTime(new Date(state.confirmedAt), locale), sequence: String(state.sequence) })}
          {state.declaredNoOpeningDebt === true && ` · ${t("students.declaredNone")}`}
          {state.declaredNoOpeningDebt === false && ` · ${t("students.declaredItems")}`}
        </p>
      )}
    </div>
  );
}

export async function Students({ screen, locale }: { screen: ReadinessScreen; locale: string }) {
  const t = await getTranslations("payments.readiness");
  const tStatus = await getTranslations("students.status");
  const tPayment = await getTranslations("students.paymentStatus");
  const tt: Translate = (key, values) => t(key as never, values as never);
  const withDraft = new Set(screen.activeDrafts.map((d) => d.studentId));
  const shown = screen.students.filter((s) => s.status === "ACTIVE" || withDraft.has(s.id) || s.promoOrExempt);
  const confirmations = new Map(screen.report.confirmations.map((c) => [c.studentId, c]));

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>
          <h2>{t("students.heading")}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("students.sub")}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 pt-4">
        {shown.length === 0 && <EmptyState message={t("students.none")} />}
        {screen.branches.map((branch) => {
          const inBranch = shown.filter((s) => s.academyId === branch.id);
          if (inBranch.length === 0) return null;
          return (
            <section key={branch.id} aria-label={branch.name} className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold break-words">{branch.name}</h3>
              <ul className="grid gap-3 md:grid-cols-2">
                {inBranch.map((student) => {
                  const c = confirmations.get(student.id);
                  const drafts = screen.activeDrafts.filter((d) => d.studentId === student.id);
                  return (
                    <li key={student.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <a href={`/${locale}/students/${student.id}`} className="min-w-0 font-medium break-words underline underline-offset-2">
                          {student.name}
                        </a>
                        <Pill>{tStatus(student.status as never)}</Pill>
                        {student.promoOrExempt && <Pill variant="accent">{t("students.promo")}</Pill>}
                      </div>
                      {c && <ConfirmationLine label={t("students.openingReview")} state={c.openingReview} locale={locale} t={tt} />}
                      {c && student.promoOrExempt && <ConfirmationLine label={t("students.pricingAck")} state={c.pricingAck} locale={locale} t={tt} />}
                      <div className="flex flex-col gap-1">
                        <h4 className="text-sm text-muted-foreground">{t("students.drafts")}</h4>
                        {drafts.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t("students.noDrafts")}</p>
                        ) : (
                          <ul className="flex flex-col gap-2 text-sm">
                            {drafts.map((d) => (
                              <li key={d.id} className="flex min-w-0 flex-col">
                                <span className="flex flex-wrap justify-between gap-x-3">
                                  <span>{formatMonthYear(d.coverageYear, d.coverageMonth, locale)}</span>
                                  <span className="whitespace-nowrap tabular-nums">{money(d.amount, d.currency, locale)}</span>
                                </span>
                                <span className="break-words text-muted-foreground">{d.note}</span>
                                {d.linkedLegacy && (
                                  <span className="text-xs text-muted-foreground">
                                    {t("students.linked", { month: formatMonthYear(d.linkedLegacy.year, d.linkedLegacy.month, locale), status: tPayment(d.linkedLegacy.status as never) })}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
