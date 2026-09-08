/**
 * Validates a client-supplied `callbackUrl` before it's ever passed to
 * `redirect()`. Only same-origin relative paths are allowed — an absolute
 * URL (`https://evil.example`) or a protocol-relative one (`//evil.example`,
 * which browsers resolve as scheme-relative, not as a relative path) is
 * rejected outright rather than sanitized, since there's no safe rewrite of
 * an off-site target back to same-origin.
 *
 * The only legitimate producer of this value is `src/middleware.ts`, which
 * always sets it from `req.nextUrl.pathname` (a same-origin relative path).
 * Anything else reaching this function came from a client-controlled query
 * string and must not be trusted (CWE-601, open redirect).
 */
export function sanitizeCallbackUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("/") || url.startsWith("//")) return undefined;
  return url;
}
