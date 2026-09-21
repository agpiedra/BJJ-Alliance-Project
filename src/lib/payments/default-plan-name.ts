/**
 * The name of an organization's default monthly plan, chosen by the language
 * the registrant asked for (`Organization.defaultLocale`, captured by the
 * registration form) so an English-speaking academy doesn't start with a
 * Spanish plan name. The name is only ever a starting point: a director can
 * rename it on the plans page.
 */
const DEFAULT_PLAN_NAMES = { es: "Mensualidad", en: "Monthly" } as const;

/** Every name a default monthly plan can carry — for code that has to
 * recognise "the academy's ordinary monthly plan" whatever language it was
 * seeded in (e.g. the quick "mark paid" fallback). */
export const ALL_DEFAULT_PLAN_NAMES: readonly string[] = Object.values(DEFAULT_PLAN_NAMES);

export function defaultPlanNameFor(locale: string): string {
  return locale === "en" ? DEFAULT_PLAN_NAMES.en : DEFAULT_PLAN_NAMES.es;
}
