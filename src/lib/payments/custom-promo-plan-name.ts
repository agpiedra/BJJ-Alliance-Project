/**
 * REDESIGN_BRIEF.md Phase 6 ruling #2: `PaymentPlan` is a per-academy
 * relational table (rows), not an enum — "Promoción personalizada" is
 * represented as a seeded row per academy, matching how other plan names
 * (`Mensualidad`, `Promoción`, `Becado` — see `prisma/seed.ts`) are already
 * plain admin-facing Spanish text in the DB, not translated UI copy. This is
 * the name column's value, not a message key: never pass it through
 * `useTranslations`/`getTranslations`.
 *
 * Deliberately its OWN file with zero other imports — `ensure-custom-promo-
 * plan.ts` (this constant's upsert helper) imports `@/lib/prisma`, which is
 * Node-only. `RecordPaymentForm`/`PaymentsTable` are Client Components that
 * only need the STRING, not the upsert helper; importing it from the same
 * module as the Prisma-touching helper would pull Prisma's runtime into the
 * client bundle (breaks the build) and, in tests, throws on a missing
 * `DATABASE_URL` just from importing the form — same reasoning
 * `get-promotion-history.ts` and friends already document for keeping
 * Prisma out of any module a Client Component imports from.
 */
export const CUSTOM_PROMO_PLAN_NAME = "Promoción personalizada";
