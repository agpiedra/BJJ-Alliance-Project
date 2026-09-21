/**
 * REDESIGN_BRIEF.md Phase 6 ruling #2: `PaymentPlan` is a per-academy
 * relational table (rows), not an enum — the custom-promotion plan is a row per
 * academy, matching how other plan names are plain admin-facing text in the DB,
 * not translated UI copy. This is the name column's value, not a message key:
 * never pass it through `useTranslations`/`getTranslations`.
 *
 * Its name follows the ORGANIZATION's language (`Organization.defaultLocale`),
 * the same rule as the default monthly plan (`default-plan-name.ts`): an English
 * academy must not see a Spanish system plan. Because a row is created once in
 * one language, "is this the promo plan?" can never be a comparison against a
 * single name — every check goes through `isCustomPromoPlanName`, which accepts
 * either language's name (rows created before the name followed the language
 * keep working). `tests/unit/custom-promo-plan-name.test.ts` fails the build if
 * any other production file hard-codes one of the names.
 *
 * Deliberately its OWN file with zero other imports — `ensure-custom-promo-
 * plan.ts` imports `@/lib/prisma`, which is Node-only. `RecordPaymentForm`/
 * `PaymentsTable` are Client Components that only need the STRINGS, not the
 * upsert helper; importing them from the Prisma-touching module would pull
 * Prisma's runtime into the client bundle (breaks the build) and, in tests,
 * throws on a missing `DATABASE_URL` just from importing the form — same
 * reasoning `get-promotion-history.ts` and friends already document.
 */
const NAMES_BY_LOCALE = {
  es: "Promoción personalizada",
  en: "Custom promotion",
} as const;

/** Every name the promo plan may carry, whatever language its row was made in. */
export const CUSTOM_PROMO_PLAN_NAMES: readonly string[] = Object.values(NAMES_BY_LOCALE);

/** The name a NEW promo plan is created with, for an organization's language.
 * Falls back to Spanish, the platform's own default. */
export function customPromoPlanNameFor(locale: string): string {
  return locale === "en" ? NAMES_BY_LOCALE.en : NAMES_BY_LOCALE.es;
}

export function isCustomPromoPlanName(name: string | null | undefined): boolean {
  return !!name && CUSTOM_PROMO_PLAN_NAMES.includes(name);
}
