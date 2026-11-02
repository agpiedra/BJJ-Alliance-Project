import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a shared secret: the pattern the e2e auth bypass route already used, moved here so every
 * secret-protected route compares the same way. Unequal lengths return false before comparing, so only the length — never
 * the content — is observable through timing.
 */
export function secretsMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * `Authorization: Bearer <secret>` against the expected secret, in constant time. Accepts exactly what the previous
 * `header !== \`Bearer ${secret}\`` checks accepted: the exact header value, nothing trimmed or case-folded.
 */
export function bearerMatches(authorizationHeader: string | null, secret: string): boolean {
  return secretsMatch(`Bearer ${secret}`, authorizationHeader ?? "");
}
