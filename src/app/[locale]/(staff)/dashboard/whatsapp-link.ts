/**
 * `wa.me` deep link with a pre-filled message (REDESIGN_BRIEF.md §4.1 Task
 * 4). Strips everything but digits, then prepends Costa Rica's country code
 * — every stored/seeded phone in this app is a plain 8-digit local number
 * with no country code (see `tests/integration/students-roster.test.ts`'s
 * fixtures), so this always ends up prefixing 506 in practice.
 *
 * Returns `null` when the digits-only phone isn't a plausible CR number
 * (not exactly 8 digits, and not already 11 digits starting with "506") —
 * a free-text phone field ("no tiene") or a garbled value would otherwise
 * produce a `wa.me` link that looks clickable but goes nowhere real.
 *
 * Pulled out of `page.tsx` (a Next.js App Router page module, which may only
 * export its recognized route-config names) so it can be unit-tested
 * directly — same colocation pattern `weekly-attendance-chart.tsx` already
 * establishes for this route's other non-page helpers.
 */
export function buildWhatsAppLink(phone: string, message: string): string | null {
  const digits = phone.replace(/\D/g, "");
  let withCountryCode: string;
  if (digits.length === 8) {
    withCountryCode = `506${digits}`;
  } else if (digits.length === 11 && digits.startsWith("506")) {
    withCountryCode = digits;
  } else {
    return null;
  }
  return `https://wa.me/${withCountryCode}?text=${encodeURIComponent(message)}`;
}
