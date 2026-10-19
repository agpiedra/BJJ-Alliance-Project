# Notification thrown-exception logging — verification

Scope: four log calls that printed a raw error object. Nothing else changes: notification fan-out, counts,
swallowing, `after()` scheduling and the fallback, email classification and every return value are unchanged.

## Paths traced

| Handler | Reached from | What the raw error could carry |
|---|---|---|
| `dispatchNotification` "notification channel threw" (`src/lib/notifications/dispatch.ts`) | `dispatchToRecipients`, used by `notifyNewSignup`, `notifyEligibilityReached` and `sendWeeklyDigestForAcademy` | `InAppChannel.send` is `prisma.notification.create` with `userId`, `organizationId`, rendered `title` / `body` (student name): a Prisma error message can echo those query parameters. `EmailChannel.send` never throws. Any other channel may throw anything. |
| `notifyNewSignup` catch-all (`notify-new-signup.ts`) | `fireAndForget("notifyNewSignup", …)` in `src/app/[locale]/o/[orgSlug]/signup/actions.ts` | Prisma errors from the student lookup / `resolveStaffRecipients` (query parameters, recipient addresses), template rendering errors, and `requireEnv`'s message when `ALL_CHANNELS` is first imported without `RESEND_API_KEY`. |
| `notifyEligibilityReached` catch-all (`notify-eligibility.ts`) | `fireAndForget("notifyEligibilityReached", …)` in `src/lib/kiosk/perform-check-in.ts` | Same as above. |
| `fireAndForget` rejection handler (`fire-and-forget.ts`) | the two calls above, the only production callers | The raw error **and** the caller's `label`, interpolated into the message. Both callers pass literals today, but the parameter was `string`. Both notify functions swallow their own errors, so this handler is a backstop. |

## Fix

Reuses the existing `safeErrorCode` (`src/lib/auth/password-reset-log.ts`, already shared by login-throttle and
session-credentials): a Prisma `P####` code, an allow-listed error class name, or `"unrecognized_error"`.

| Handler | Before | After |
|---|---|---|
| dispatch | `"notification channel threw", outcome.reason` | `"notification channel threw", { type, error: safeErrorCode(reason) }` |
| notifyNewSignup | `"notifyNewSignup failed (non-fatal)", error` | `"notifyNewSignup failed (non-fatal)", { error: safeErrorCode(error) }` |
| notifyEligibilityReached | `"notifyEligibilityReached failed (non-fatal)", error` | `"notifyEligibilityReached failed (non-fatal)", { error: safeErrorCode(error) }` |
| fireAndForget | `` `${label} failed (non-fatal)`, error `` | `"background job failed (non-fatal)", { job, error: safeErrorCode(error) }` |

`type` is the `NotificationType` enum value the neighboring "notification delivery failed" line already logs.
`fireAndForget`'s `label` is now the literal union `"notifyNewSignup" | "notifyEligibilityReached"`, and the
logged `job` is checked at runtime against the same list (`"unrecognized_job"` otherwise), so a caller that bypasses
the type still cannot put its string in the log.

## Regression tests — `tests/unit/notification-error-logging.test.ts` (8 tests)

Prisma, `resolveStaffRecipients` and `next/server`'s `after` are mocked; no database, no network. Each injected error
carries a fabricated address, token, invitation-style link and query parameter in its message (so also its stack), in
`meta`, and in `cause`. Every call to `console.log/info/warn/error/debug` is captured and rendered with
`util.inspect(…, { depth: null, showHidden: true })`, which includes an Error's non-enumerable message and stack.
None of the four values may appear, and the calls must equal the exact expected list.

Behavior asserted alongside: dispatch counts (`{ attempted: 4, sent: 2, failed: 2 }`; the healthy channel is still
called for both recipients); the notify functions resolve `undefined`; `fireAndForget` returns `undefined`, registers
with `after()` without running the work inline, falls back to running it directly when `after()` throws, and logs
nothing for a successful job.

## Fails before, passes after

- **Previous code (main `3709606`):** 7/8 fail, each on `console contains synth.victim.q7@example.test`. The 8th, "a
  successful job logs nothing", is a baseline that passes either way.
- **With the fix:** 8/8 pass.

**Each source reverted to main independently** (restored afterwards, sha256 of the directory checked identical):

| Reverted | Fails | Passes |
|---|---|---|
| dispatch.ts | 2 (both dispatch tests) | 6 |
| notify-new-signup.ts | 1 (notifyNewSignup) | 7 |
| notify-eligibility.ts | 1 (notifyEligibilityReached) | 7 |
| fire-and-forget.ts | 3 (after(), fallback, unlisted label) | 5 |

## Checks (isolated test database only)

`tsc --noEmit` clean · lint clean · `check:guard-usage` OK · unit 1854/1854 (1846 + 8 new) · integration 2171/2171.

## Limitations

- Only console output in the test runner was inspected; no hosted log sink was exercised and no email was sent.
- The new lines say less than before by design: an unrecognized error is now only `"unrecognized_error"`. Diagnosing
  such a failure needs reproduction rather than the log line.
- `userId` is not added to "channel threw": `Promise.allSettled` drops which recipient the rejection belonged to, and
  restructuring the fan-out was out of scope. The neighboring "delivery failed" line keeps the `userId` it already had.
- The notify functions and `fireAndForget` were exercised with mocks, not through a real Next.js request or the real
  database; existing integration tests still cover their normal paths unchanged.
- Other raw-error logging elsewhere in the codebase was not audited here.
- Kept separate and not started: historical invitation repair, launch verification, production PostgreSQL 12+
  compatibility, and the unattributed test incidents.
