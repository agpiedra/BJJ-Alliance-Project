/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — "Desired slug auto-suggested
 * from the name." Plain, dependency-free slugify: lowercase, strip
 * diacritics (a Spanish-language form routinely has them — "Alliance
 * Jiu-Jitsu Costa Rica" -> "alliance-jiu-jitsu-costa-rica", "Núñez" ->
 * "nunez"), replace anything not [a-z0-9] with a hyphen, collapse repeats,
 * trim edges. Matches Organization.slug's real column shape (short,
 * URL-safe, hyphenated).
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The slug rule the server enforces (checkSlugAvailability and the registration schema): 2-60 characters of a-z 0-9 -. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,60}$/;

export function isCheckableSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** An availability answer, bound to the slug it was asked about. */
export type SlugCheck = { slug: string; available: boolean };

/**
 * What the availability line under the slug field may say. Feedback describes ONLY the current valid slug: nothing for a slug
 * that is not checkable, a result only when it was answered for this very slug, "checking" while a check is queued and this
 * slug has no answer yet, otherwise nothing.
 */
export function slugFeedback(slug: string, checked: SlugCheck | null, pending: boolean): "checking" | "available" | "taken" | null {
  if (!isCheckableSlug(slug)) return null;
  if (checked?.slug === slug) return checked.available ? "available" : "taken";
  return pending ? "checking" : null;
}
