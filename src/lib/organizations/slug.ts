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
