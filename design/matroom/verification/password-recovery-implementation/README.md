# Password recovery — implementation evidence

Implements `docs/PASSWORD_RECOVERY_PLAN.md` rev 2 (local plan document; not part of this PR). Branch `feat/password-recovery`, based on `main` @ `8ad28fc`.

**Not done here, by instruction:** session revocation (a separate owner decision and PR), login throttling, invitation messaging, security headers, branding, monitoring, deployment.

**Email:** no email was sent anywhere while producing this evidence. Tests mock the dispatch. The browser run used a server with no email configuration, so no provider was contacted.

---

## What changed

| File | Change |
|---|---|
| `src/lib/auth/password-reset.ts` (new) | Request and redemption cores, the after-response email step, and single-token cleanup |
| `src/lib/auth/password-reset-throttle.ts` (new) | Account/IP throttle with advisory locks; bounded sweep |
| `src/lib/auth/password-reset-log.ts` (new) | The only logger for this flow: fixed event shapes and allow-listed error codes |
| `src/lib/after-response.ts` (new) | `scheduleAfterResponse` over Next's `after()`. Returns false when it cannot schedule |
| `src/app/[locale]/forgot-password/actions.ts` | Thin wrapper. The production "withheld" stub and the development `console.log` of link and address are removed |
| `src/app/[locale]/reset-password/actions.ts` | Thin wrapper; adds a generic `resetFailed` error for an unexpected failure |
| `src/app/[locale]/reset-password/page.tsx` | On `invalidToken`: help line plus a "Request a new link" link to `/[locale]/forgot-password` |
| `src/lib/email/send-transactional-email.ts` | Additive `outcome` / `providerCode`. `success` and `error` are unchanged, so registration, approval and staff-invitation callers are untouched. Correction round: an opt-in `suppressProviderErrorLogging` option, used only by the reset send, silences the Resend SDK's own error logging on that one client instance |
| `prisma/schema.prisma`, `prisma/migrations/20261017180000_password_reset_request_throttle/` | New `PasswordResetRequest` table and two indexes. Additive |
| `messages/en.json`, `messages/es.json` | Conditional confirmation; reset-page help, link label and `resetFailed` |
| `docs/DEPLOYMENT_RUNBOOK.md` | Reset email depends on the verified sending domain; request-log limitation |

Unchanged: `auth.ts`, the JWT callbacks, middleware, the kiosk limiter (`src/lib/kiosk/rate-limit.ts`), the registration limiter, and existing email callers.

**Deviation from the plan:** the email subject and body are inline EN/ES strings in `password-reset.ts`, like `staff-service.ts`'s `deliverInvitation`, rather than `messages/*.json` keys. The page copy is in the message files.

---

## Behavior as implemented

**Request** (`requestPasswordResetCore`):
1. The throttle claim: advisory locks, account key then IP key.
2. The bounded sweep.
3. If allowed, look up the user.
4. Issue the token inside one transaction: lock the user row, re-check `active`, invalidate older tokens, create one.
5. Schedule the email after the response.

Every outcome returns the same `{ ok: true }`. The request core never throws:
- **Throttle failure** (a database error, or a key that cannot be derived): **fails closed**. No token, no email; logs `throttle_failed`.
- **Account-lookup failure:** stops the request; logs `lookup_failed`.
- **Missing `APP_URL` or pepper, or an issuance error:** caught; logs `issue_failed`.

None of these continues past the failed step, and none can answer differently from an unknown address.

**Redemption** (`redeemPasswordResetToken`):
1. An unlocked preliminary read refuses missing, used, expired or inactive-account tokens **before** bcrypt. It is not authoritative.
2. bcrypt.
3. One transaction: lock the user row → re-check `active` → take a **fresh time** → conditionally consume this token (`usedAt IS NULL AND expiresAt > now`) → set the password → invalidate the user's other unused tokens.
4. Any refusal writes nothing. Any error rolls everything back and returns `resetFailed`.

Infrastructure failures at any stage return the generic `resetFailed` and write nothing. Each is logged as `redeem_failed` with a fixed `stage`:
- `lookup`: the pepper or the preliminary token read;
- `hash`;
- `transaction`.

An ordinary unknown, used or expired token is still `invalidToken`.

**One lock order:** issuance and redemption both take the `User` row lock first, then token rows. Single-token cleanup takes only that token's row and no other lock.

**After-response step:**
- It is not a durable queue. It may not run, or may stop partway, with no retry.
- **Provider explicitly rejected:** that token is made unusable (`sendAttempted: true` if its cleanup fails).
- **Not configured, could not be scheduled, or an exception before the provider call:** that token is made unusable (`sendAttempted: false`).
- **Accepted, unknown, or an exception after the provider call started:** the token stays valid.
- **Cleanup always targets one token id,** so it never touches a newer request's token.
- **If cleanup itself fails,** the token stays redeemable until it expires (at most 1 hour). The log records only whether a provider request carrying the link may have been made. It does not claim anything about who holds the token.

**Provider outcome mapping:**
- **`accepted`:** the provider took the request. Not delivery.
- **`rejected`:** a client-side Resend code was returned.
- **`unknown`:** `internal_server_error`, `application_error` (which the SDK also returns for network failures and unparseable responses), idempotency conflicts, any unrecognized code, or a thrown error.
- **`not_configured`:** a required environment variable is missing.

**Logs:**
- **Events:** `password_reset.email` (`outcome`, plus `providerCode` when it is in the SDK's fixed list), `password_reset.throttled` (`keyKind`), and `password_reset.throttle_failed` / `lookup_failed` / `issue_failed` / `redeem_failed` (`stage`) / `token_cleanup_failed` / `throttle_cleanup_failed`.
- **Error field:** a Prisma code, an allow-listed class name, or `unrecognized_error`.
- **Never logged:** raw error objects or messages, ids, address, IP, link, token or password.

---

## Evidence

### Automated (isolated test database `alliance_bjj_test`, local Docker)

| Suite | Result |
|---|---|
| `tests/unit/password-reset-email-and-log.test.ts` | 9/9. Outcome classification (Resend SDK mocked): client code → rejected, provider-side and unrecognized codes → unknown, thrown network error → unknown, missing env → not_configured with no provider call. Error-code allow-listing maps arbitrary names, messages and malformed codes to `unrecognized_error` |
| `tests/integration/password-reset.test.ts` | 24/24 (email dispatch and `after()` scheduling mocked) |
| `tests/integration/password-reset-email-client.test.ts` (correction round) | 4/4. The **real** reset send path through the **real** Resend SDK, with only `fetch` stubbed. Provider error bodies echo the recipient and distinctive synthetic secrets (422 rejection, 500 provider error, 502 unparseable body, thrown network error). Every console argument is captured: none of the secrets, the recipient, the reset link or `[Resend API Error]` appears, and every line is a `[password-reset]` entry. A fourth case shows the default path (existing callers) still prints the SDK's own error output, i.e. their behavior is unchanged |
| `tests/integration/password-reset-failures.test.ts` (correction round) | 9/9. Failure injection with secret-bearing errors. Throttle database failure (test trigger) and underivable throttle key → fail closed, uniform response, no throttle row, no token, no scheduled email, no send. Account-lookup failure and missing `APP_URL` → same. Preliminary token-lookup failure, missing pepper and hashing failure during redemption → `resetFailed`, password and token unchanged. An ordinary unknown token is still `invalidToken` and logs nothing. No synthetic secret appears in captured logs |
| Full unit suite | 125 files, 1773 tests passed |
| Full integration suite | 155 files, 2021 tests passed (initial head); 157 files, 2034 tests passed (correction round) |
| Smoke (`page-routes`) against the browser-verification server | 2 files, 21 tests passed |
| typecheck / lint / guard-usage | Clean / 0 errors (23 pre-existing warnings, none in changed files) / all guards have call sites |
| Migration | Generated with `prisma migrate diff` against a disposable shadow database; applied to the isolated test database only; `db:check-drift` clean both ways |

**Integration coverage:**
- **Uniform response:** across unknown, inactive, active, throttled, unscheduled and every email outcome. `invalidEmail` only for a malformed address.
- **Throttle races:** 10 concurrent requests for one account → exactly 3 allowed, 3 sends scheduled, 1 unused token. 30 concurrent requests from one IP → exactly 20 allowed.
- **Throttle keys:** an address with no account is throttled identically, and keys never store raw values.
- **Bounded sweep:** 250 expired rows plus 5 recent → 100, 100, 50, 0 removed; recent rows untouched. The candidate scan can use `PasswordResetRequest_createdAt_idx`. A sweep failure (injected) is logged with an allow-listed code, and the response is unchanged.
- **Same-token concurrent redemption** (lock-gated): one success, one `invalidToken`, exactly one password stored.
- **Fresh time under the lock:** a token that expires while waiting for the lock is refused, and the password is unchanged.
- **Rollback:** an injected failure on the password write (a test-only trigger, dropped afterwards) leaves the password unchanged and the token unused, with a sanitized log.
- **Issuance first vs. redemption first** (lock-gated, both orders): superseded token refused, or password changed and then one fresh token.
- **Deactivation first vs. redemption first** (lock-gated, both orders): refused with nothing changed, or password changed and then login refused.
- **After-response outcomes:**
  - `rejected` and `not_configured` → token unusable; `unknown` and `accepted` → valid;
  - not scheduled → unusable;
  - an exception before the provider call → unusable (`not_attempted`); an exception after the call started → valid (`unknown`).
- **Stale cleanup:** a late rejection for an older send leaves the newer request's token valid.
- **Cleanup failure:** an injected failure logs an allow-listed code and `sendAttempted: false`; the token stays redeemable.
- **No secrets:** a full request → send → redeem → throttled run with synthetic values. The captured console output and the stored throttle and audit rows contain none of the address, IP, link, raw token, password or user id, and every log line is a `[password-reset]` entry.

**The tests fail when the safeguards are removed** (each change reverted afterwards; the file was restored byte-identical):

| Mutation | Tests that failed |
|---|---|
| Consume without `usedAt: null` | Concurrent same-token redemption; issuance-first ordering |
| Remove the `active` re-check under the lock | Deactivation-first ordering |
| Widen cleanup beyond the token id | Stale cleanup must not invalidate the newer token |
| Remove `suppressProviderErrorLogging` from the reset send (correction round) | 3 of the 4 email-client tests fail: the SDK printed `[Resend API Error]` containing the synthetic provider secret |
| Restore the previous head's `password-reset.ts` (`cfe8b90`) under the new failure tests (correction round) | 7 of 9 fail (all except the two control cases) |

### Real browser (local, disposable database, email unconfigured)

**Environment:**
- `next dev` on port 3100 against a separate throwaway database `password_reset_browser_test` (migrated, seeded, dropped afterwards).
- `RESEND_API_KEY` empty, so `sendTransactionalEmail` returned `not_configured` before contacting any provider.
- Playwright Chromium with emulated viewports (1280, 390).

**Account:** created through the public student signup at `/en/o/alliance-cr/signup` (not a seed account). The database confirmed `active = true`.

**Request flow:**
- **Same text everywhere:** the confirmation was identical for the real address, an unknown address, and three further requests for the real address (two of them throttled).
- **Text shown:** "If an eligible account matches that address, you may receive a password-reset email. Check your inbox and spam folder." The Spanish page showed the Spanish text.
- **Database after the run:**
  - 5 requests for the real address issued exactly 3 tokens, and all 3 are now unusable: each after-response step logged `not_configured` and invalidated its own token.
  - Throttle rows: 4 email rows (3 for the account plus 1 for the unknown address) and 4 IP rows.
- **What this shows about `after()`:** it ran in the local dev server. It says nothing about deployed behavior.

**Redemption flow:**
- **Tokens:** inserted (digest only) by a scratch helper against the throwaway database. Links were opened through a local redirect so raw tokens stayed out of commands and this document.
- **Expired link:** refused with "This link is invalid or has expired." plus the help line, which links to `/en/forgot-password`.
- **Valid link:** "Your password has been reset. You can now sign in."
- **The same link again:** refused.
- **Spanish invalid state at 390:** rendered with no horizontal overflow.
- **Login afterwards:** the old password is refused and the new one is accepted.

**First-attempt note:** the first redemption attempt failed because of a bug in the scratch helper, not the app. The `pg` driver stored a JS `Date` in local time (UTC−6) in a `timestamp without time zone` column, so the "valid" token was already expired, and the app correctly refused it. The helper was fixed to compute expiry in SQL from UTC and the run repeated.

**Server log** (the whole run): only `[password-reset] { event: 'password_reset.email', outcome: 'not_configured' }` (3) and `{ event: 'password_reset.throttled', keyKind: 'email' }` (2). It contains zero occurrences of the account address, the unknown address, any of the passwords used, or "Resend API Error". Token query strings appear **only** in `next dev`'s own request lines (`GET/POST /en/reset-password?token=… 200`). See the limitations.

**Screenshots (`screenshots/`):**
- `request-confirmation-en-1280.png`, `request-confirmation-es-390.png`
- `reset-invalid-expired-en-1280.png`, `reset-invalid-es-390.png`
- `reset-success-en-1280.png`

The Next.js dev overlay is hidden in captures; it exists only under `next dev`.

---

## Logging: what is verified, and what remains a deployment concern

**Verified by tests (application and email client).** During a password-reset request, send and redemption, nothing written to the console by this application's code or by the Resend SDK contains:
- the recipient address;
- the IP;
- the reset link or raw token;
- the password;
- provider free text;
- error messages or query parameters.

This covers success paths, provider rejections, provider-side errors, network failures and injected infrastructure failures (`password-reset.test.ts`, `password-reset-email-client.test.ts`, `password-reset-failures.test.ts`). These tests capture `console.log/info/warn/error/debug` in the test process. Other email callers (registration, approval, staff invitations) are unchanged: outside production the SDK still prints their provider errors.

**Separate deployment concern (not addressed by this code).** The reset link carries the token in its query string. Request URLs are written by the web server and hosting layer, not by this application's logging. `next dev` printed them locally (`GET/POST /en/reset-password?token=… 200`), and the hosting platform's request logs, browser history and `Referer` headers may contain them. Documented in `docs/DEPLOYMENT_RUNBOOK.md` for review before launch. The token-URL flow is not redesigned in this PR.

## Not verified here

- **Actual delivery:** whether an email reaches an address other than the Resend account owner's needs a verified sending domain.
- **Real provider rejection codes.** Only mocked here.
- **`after()` on the hosting runtime:** whether it completes, and its time limits. It ran in local `next dev` only.
- **Whether `x-forwarded-for` is set by the hosting platform and cannot be supplied by a client.** Locally, `next dev` supplied a value; that proves nothing about production.
- **Production log contents** and how the hosting platform logs request URLs.

## Limitations

- **Sessions:** this PR alone did not end existing sessions on reset. Addressed by the separate session-revocation work (`design/matroom/verification/session-revocation-implementation/README.md`).
- **Token in the URL:** the reset link carries the token in its query string. The app never logs it, but request logs (shown here by `next dev`; possibly the hosting platform's), browser history and `Referer` headers can contain it. Mitigations (a fragment or POST exchange, `Referrer-Policy`) are outside this PR. The security-headers workstream is separate.
- **The SDK override depends on its internals:** the reset send silences the SDK's error logging by shadowing its private `logError` on one client instance. That relies on an internal method name in resend@6.27.0; an SDK upgrade that renames it would make `password-reset-email-client.test.ts` fail.
- **Timing:** identical response text does not make timing identical. An existing, active account additionally runs one short token transaction.
- **IP throttling** is best effort and fails open when no IP is available.
- **Throttle rows inside 24 hours** have no fixed ceiling, and expired rows remain if requests stop entirely.
- **Delivery, bounces and spam placement** are not observed. `accepted` is not delivery.
- **Email lookup is still case-sensitive** (unchanged; separate review).
