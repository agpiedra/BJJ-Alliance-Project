/**
 * Pagos "Estado del mes" table's "Registrado" column (REDESIGN_BRIEF.md
 * §6.3): `"11 sep · alexis@…"` — no existing helper in this codebase
 * combines a date with an actor into one string (`get-promotion-history.ts`
 * and `format-date.ts` render date and actor as SEPARATE columns), so this
 * is new. `User` has no first/last name field (only `email`), so — same
 * precedent `getPromotionHistory`'s `awardedByName` already established
 * (`promotion.awardedBy.email` directly) — the "who" half is the email, not
 * a display name that doesn't exist in the data model.
 *
 * Same CR-zone discipline as `format-date.ts`: a real timestamp is rendered
 * in `America/Costa_Rica`, never a naive local/UTC read.
 */
export function formatRecordedBy(recordedAt: Date, recordedByEmail: string, locale: string): string {
  const day = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    timeZone: "America/Costa_Rica",
    day: "numeric",
    month: "short",
  }).format(recordedAt);
  return `${day} · ${recordedByEmail}`;
}
