# Registration-confirmation and staff-notification email logging — verification

Scope: logging only, on two paths. Nothing else changes: registration, notification fan-out and counts,
invitation, retry, authorization and UI behavior are all unchanged.

## Paths traced

**1. Registration confirmation.** `registerOrganization` (`src/app/[locale]/register-academy/actions.ts`) → after the
transaction commits → `sendTransactionalEmail` → `new Resend(key).emails.send`. It is the only send on this path.
`platform/organizations/new/actions.ts` and `seed-defaults.ts` import other things from this module but do not
send this email.

**2. Staff notification dispatch.** Every email notification is sent by `EmailChannel.send`
(`src/lib/notifications/email-channel.ts`), and its failure is logged by `dispatchNotification`
(`src/lib/notifications/dispatch.ts`). Real clients reach `EmailChannel` in exactly two places:

- `ALL_CHANNELS` (`channels.ts`): `new EmailChannel(new Resend(requireEnv("RESEND_API_KEY")))`, used by
  `notifyNewSignup` and `notifyEligibilityReached`;
- `sendWeeklyDigestForAcademy` (`weekly-digest.ts`): its default `new Resend(…)` client, wrapped in
  `new EmailChannel(…)`.

## Sources and fixes

| Path | Source | Before | After |
|---|---|---|---|
| Registration | App log | `"[register-academy] confirmation email failed to send", { organizationId, error: emailResult.error }`, where `error` is the provider's free-text message (or the thrown / missing-env message) | `"[register-academy] confirmation email outcome", { organizationId, outcome, providerCode }` |
| Registration | SDK log | `sendTransactionalEmail(…)` without suppression: resend@6.27.0 prints `"[Resend API Error]:"` and the raw object when `NODE_ENV !== "production"` | `sendTransactionalEmail(…, { suppressProviderErrorLogging: true })` |
| Notifications | App log | `"notification delivery failed", { userId, type, error: result.error }` | `"notification delivery failed", { userId, type, outcome, providerCode }` |
| Notifications | SDK log | the `Resend` client given to `EmailChannel` was never silenced | `EmailChannel`'s constructor calls `silenceSdkErrorLogging(client)`, covering both construction sites at once |

**Reuse.** The fix uses the existing `classifyProviderError`, `EmailSendOutcome`, `ResendErrorCode` and
`silenceSdkErrorLogging`, moved unchanged into `src/lib/email/provider-errors.ts` and re-exported from
`send-transactional-email.ts`, so every existing import still works.

**Why move them.** About 30 test files mock `send-transactional-email` with a factory that exports only
`sendTransactionalEmail`. `EmailChannel` importing from that module would have broken `ALL_CHANNELS` under those mocks
(missing mock export), and would have added an import cycle (that module imports `bodyToHtml` from `email-channel`).

**Delivery handling is unchanged.** `DeliveryResult` gains only optional `outcome` / `providerCode`, which only the
email channel sets. `success` is unchanged and still drives the `sent` / `failed` counts. The free-text `error` string is
still returned, but it is never logged.

`EmailChannel.send` now resolves `EMAIL_FROM` before the request: if it is missing, the result is
`{ success: false, …, outcome: "not_configured" }` — the same failure result as before, now classified.

## Regression tests — `tests/integration/email-error-logging.test.ts` (11 tests)

These use the real helpers and the real Resend SDK, with only `fetch` stubbed; no request leaves the machine. Provider
responses contain a fabricated secret, a fabricated token, a fabricated invitation-style link and an echo of the real
recipient address. Every console method (`log/info/warn/error/debug`) is captured, and every argument of every call is
checked:

- none of these appear anywhere: the secret, the token, the link, the recipient, `[Resend API Error]`, `ECONNREFUSED`, or
  the env-var names;
- exactly one call is made: the fixed event with exactly the allowlisted keys.

| Path | Case | NODE_ENV | Expected log |
|---|---|---|---|
| Registration | 422 `validation_error` | development | rejected / validation_error |
| Registration | 422 `validation_error` | test | rejected / validation_error |
| Registration | 500 `internal_server_error`, then network failure | development | unknown / internal_server_error; unknown / application_error |
| Registration | 422 `validation_error` | production | rejected / validation_error |
| Registration | `RESEND_API_KEY` missing (no request) | test | not_configured |
| Registration | accepted | test | nothing logged |
| Notifications (`notifyNewSignup` → real `ALL_CHANNELS`) | 422 `validation_error` | development | rejected / validation_error |
| Notifications | unparseable 502 body, then network failure | development | unknown / application_error (both) |
| Notifications | 422 `validation_error` | production | rejected / validation_error |
| Notifications | `EMAIL_FROM` missing (no request) | test | not_configured |
| Weekly-digest construction (`new EmailChannel(new Resend(key))` via `dispatchNotification`) | 422 `validation_error` | development | rejected / validation_error, counts `{1, 0, 1}` |

**Behavior is preserved.**

- Registration still returns `{ ok: true }` and the organization stays `PENDING`.
- The real in-app channel still writes its `NEW_SIGNUP` notification whatever the email outcome. The notification
  fixture is a fresh organization whose only staff is its own Owner, so no other fixture receives rows.
- Dispatch counts are unchanged.

## Fails before, passes after

- **Previous code (main `4480d32`):** 10/11 fail. The 11th, "an accepted send logs nothing", is a baseline that passes
  either way.
  - Non-production cases: the SDK's `"[Resend API Error]:"` output contains `SYNTH-PROVIDER-SECRET…`.
  - Production cases: the app lines (`[register-academy] …` / `notification delivery failed`) contain it.
  - Unconfigured cases: the app lines contain `RESEND_API_KEY` / `EMAIL_FROM`.
- **With the fix:** 11/11 pass.

**Each source mutated independently** (file restored byte-identical, sha256 checked):

| Mutation | Fails | Passes (expected) |
|---|---|---|
| R1 registration: SDK suppression removed | 3 (registration dev/test/unknown) | production (SDK silent), unconfigured (no request), all notification cases |
| R2 registration: app logs `error: emailResult.error` | 5 (every failing-send registration case) | accepted case, all notification cases |
| N1 `EmailChannel`: `silenceSdkErrorLogging` call removed | 3 (notification dev, unknown/network, digest) | notification production / unconfigured, all registration cases |
| N2 dispatch: app logs `error: result.error` | 5 (every notification case) | all registration cases |

## Checks (isolated test database only)

`tsc --noEmit` clean · eslint clean on changed files · `check:guard-usage` OK · unit 1800/1800 (3 `email-channel`
exact-equality expectations updated for the additive `outcome` field) · integration 2126/2126 (2115 + 11 new).

## Limitations

- The SDK suppression shadows resend's private `logError` per client instance (pinned resend 6.27.0). An SDK upgrade
  that renames it would make these tests fail rather than silently leak. `EmailChannel` sets that property on whatever
  client it is given; on a test fake it is an unused extra property.
- Only console output in the test runner was inspected. No hosted log sink was exercised, and no real email was sent.
- Internal ids (`organizationId`, `userId`) are still logged, as they already were.
- `notifyEligibilityReached` and the full `sendWeeklyDigestForAcademy` cron path were not driven end to end. Both send
  only through `EmailChannel` + `dispatchNotification`, which are covered: the digest by its exact construction shape.
- Unchanged and out of scope. These are not provider-error logs, but they can carry raw error objects:
  - `dispatchNotification`'s `"notification channel threw"` (a channel throwing — `EmailChannel` never does);
  - the catch-all lines in `notifyNewSignup` / `notifyEligibilityReached` (lookup/render failures, or a missing
    `RESEND_API_KEY` when `ALL_CHANNELS` is first imported);
  - `fire-and-forget.ts`.
- Kept separate and not started: the staff resend lifecycle repair, the historical invitation repair, the
  Approve/New organization outcome UI, and the launch-verification items.
