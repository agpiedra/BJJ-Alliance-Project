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
 *
 * The check is done by REAL URL PARSING, not string pattern-matching. An
 * earlier version tested `!url.startsWith("/") || url.startsWith("//")`,
 * which a single leading backslash defeats: WHATWG URL parsers (i.e. every
 * browser, and Node's `URL`) treat `\` as `/` inside a special-scheme URL,
 * so `/\evil.example` normalizes to `//evil.example` and resolves off-site
 * while passing both string tests. Resolving the candidate against a
 * throwaway base and comparing `origin` is the only way to see what a
 * browser will actually do with it — the same parser answers the question.
 *
 * Two guards, both required:
 *  - a literal leading `/` on the raw input, so a bare `evil.example`
 *    (which resolves relative to the base into the same-origin, but
 *    surprising, path `/evil.example`) is rejected rather than silently
 *    rewritten; and
 *  - the parsed origin still being the throwaway base, which is what
 *    actually catches `\`, control-character, protocol-relative, absolute
 *    and non-http-scheme (`javascript:`, whose origin parses as `null`)
 *    payloads.
 *
 * The return value is the PARSED `pathname + search`, never the raw input,
 * so anything the parser normalized away (a stray `\`, an embedded tab or
 * newline) can't reach `redirect()` in its original form either.
 */
const PLACEHOLDER_BASE = "https://placeholder.invalid";

export function sanitizeCallbackUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("/")) return undefined;
  try {
    const parsed = new URL(url, PLACEHOLDER_BASE);
    if (parsed.origin !== PLACEHOLDER_BASE) return undefined;
    return parsed.pathname + parsed.search;
  } catch {
    return undefined;
  }
}
