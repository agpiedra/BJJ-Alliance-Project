# Staff invitation email logging — verification

Scope: the staff invitation email send only. Nothing else in the invitation flow changes: issuance, resend/revocation,
authorization, return values (`invitationLink`, `emailSent`) and UI messages are all unchanged.

## Paths traced

Every staff invitation send goes through ONE function, `deliverInvitation` (`src/lib/staff/staff-service.ts`), called by:

- `inviteStaffMember` ← `inviteStaff` action (`src/lib/staff/staff-actions.ts`)
- `resendStaffInvitation` ← `resendInvitation` action

There is no other staff invitation send. `revokeStaffInvitation` sends nothing, and the action layer logs only its
unrelated revalidation failure.

## The two sources, and the fix

| Source | Before | After |
|---|---|---|
| Application log | `console.error("[staff] invitation email failed to send", { organizationId, error: result.error })`: `result.error` is the provider's free-text message (or the thrown error's / missing-env message) | `console.error("[staff] invitation email outcome", { organizationId, outcome, providerCode })`: classified outcome, plus `providerCode` only when it is one of the SDK's fixed codes |
| Resend SDK's own log | resend@6.27.0 `logError` prints `"[Resend API Error]:"` and the raw provider error object whenever `NODE_ENV !== "production"` | `sendTransactionalEmail(…, { suppressProviderErrorLogging: true })`: the existing per-client mechanism already used by password reset and owner approval |

Both reuse the existing `classifyProviderError` / `EmailSendOutcome` handling in `src/lib/email/send-transactional-email.ts`;
no new mechanism. A failed send logs exactly one line. An accepted send logs nothing.

## Regression tests — `tests/integration/staff-invitation-email-logging.test.ts`

These run through the real `inviteStaff` / `resendInvitation` actions and the real Resend SDK, with only `fetch` stubbed;
no request leaves the machine. Provider responses carry fabricated secrets plus an echo of the recipient and the
invitation link. Every console method (`log/info/warn/error/debug`) is captured, and every argument of every call is
checked:

- none of these appear anywhere: the fabricated secrets, the recipient, the link, the raw token, `[Resend API Error]`,
  or the thrown error / env text;
- exactly one call is made: `["[staff] invitation email outcome", { organizationId, outcome, providerCode? }]`, with no
  other keys.

The six cases:

| Case | NODE_ENV | Expected log |
|---|---|---|
| invite, 422 `validation_error` | development | rejected / validation_error |
| invite, 422 `validation_error` | test | rejected / validation_error |
| resend, 500 `internal_server_error` (after an accepted invite, which logs nothing) | development | unknown / internal_server_error |
| invite, unparseable 502 body, then network failure | development | unknown / application_error (both) |
| invite, 422 `validation_error` | production | rejected / validation_error |
| invite, provider unconfigured (no request made) | test | not_configured |

The same cases also assert that behavior is preserved: `ok: true`, `emailSent: false` (or `true` on acceptance), the
returned link is the one sent, there is exactly one live invitation, and resend revokes the earlier invitation exactly as
before.

## Fails before, passes after

- **Previous code (main `d63277b`):** 6/6 fail.
  - development/test cases: the `"[Resend API Error]:"` SDK output contains `SYNTH-PROVIDER-SECRET…`.
  - production: the app's `[staff]` line contains it.
  - unconfigured: the app's line contains `RESEND_API_KEY`.
- **With the fix:** 6/6 pass.
- **Each source mutated separately** (file restored byte-identical, sha256 checked):
  - SDK suppression removed → 4 fail. The 2 that pass are expected: production, where the SDK is silent, and
    unconfigured, where no request is made.
  - App line logs `error: result.error` again → 6 fail.

## Checks (isolated test database only)

`tsc --noEmit` clean · eslint clean on changed files · `check:guard-usage` OK · unit 1800/1800 · integration 2115/2115
(2109 + 6 new).

## Limitations

- The SDK suppression shadows resend's private `logError` on one client instance (pinned resend 6.27.0). An SDK upgrade
  that renames it would make these tests fail rather than silently leak.
- Only console output in the test runner was inspected. No hosted log sink was exercised, and no real email was sent.
- `organizationId` (an internal id) is still logged, the same as the owner-approval line.
- Out of scope and unchanged, with the same pattern: the registration-confirmation email
  (`src/app/[locale]/register-academy/actions.ts`, logs `error: emailResult.error`, no SDK suppression) and staff
  notification dispatch (`src/lib/notifications/dispatch.ts`, logs `error: result.error`).
- The staff resend lifecycle (the earlier link revoked before the email outcome is known) is deliberately unchanged and
  tracked separately.
