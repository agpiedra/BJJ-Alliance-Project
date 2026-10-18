# Platform "Resend invitation": truthful email outcome

The platform panel's **Resend invitation** button (organization detail → Members) said "Invitation resent." whenever the
action returned no error. That included a provider rejection, missing email configuration, an unconfirmed send, and the
case where no invitation was issued at all.

## What was traced

| Step | Code | Before this PR |
|---|---|---|
| Button | `src/app/[locale]/platform/organizations/[id]/resend-invitation-button.tsx` | `setResult(action.error ? "error" : "sent")`, so any non-error showed "Invitation resent." |
| Action | `approveOrganizationAction` in `src/app/[locale]/platform/organizations/actions.ts` | Discarded `approveOrganization()`'s result and returned `{ ok: true }`. |
| Shared approval | `approveOrganization()` in `src/lib/organizations/approve-organization.ts` | Sent through `sendTransactionalEmail` and exposed only `invitationEmailSent: boolean`. On failure it logged `emailResult.error` (the provider's free text, which can carry the recipient), and the SDK printed its own `[Resend API Error]` output outside production. |
| Email helper | `sendTransactionalEmail()` in `src/lib/email/send-transactional-email.ts` (PR #133) | Already classifies `accepted` / `rejected` / `unknown` / `not_configured`. Unchanged here. |

## What changed

- **`approveOrganization()`:**
  - also returns `invitationEmailOutcome` (PR #133's `EmailSendOutcome`), or `null` when no invitation was issued;
  - passes `suppressProviderErrorLogging: true`;
  - logs only `{ organizationId, outcome, providerCode }`, where `providerCode` is only ever one of the SDK's fixed codes;
  - adds no new sending mechanism and changes nothing about tokens.
- **`approveOrganizationAction`:**
  - returns `{ ok: true, invitationEmail }` beside the unchanged `ok` and `error`;
  - the email outcome is never returned as an `error`, so the pending queue's **Approve** button behaves as before;
  - authorization (`resolveSuperAdminActionContext`) and the `notFound` / `notApprovable` results are unchanged;
  - there are no new exports from the `"use server"` file.
- **Button:** renders one message per outcome, using the existing classes. Failures use `text-destructive`; accepted, unknown and not-issued use `text-muted-foreground`.

| Outcome | EN message | Style |
|---|---|---|
| `accepted` | New invitation issued. The email provider accepted the invitation email; delivery is not confirmed. | muted |
| `rejected` | New invitation issued, but the invitation email was not sent: the email provider rejected it. The previous link no longer works. | destructive |
| `not_configured` | New invitation issued, but the invitation email was not sent: email sending is not configured. The previous link no longer works. | destructive |
| `unknown` | New invitation issued, but sending the invitation email could not be confirmed. The previous link no longer works. | muted |
| `notIssued` | No new invitation was issued or sent: an earlier invitation to this address is already marked used (accepted, or replaced by an earlier resend). | muted |
| action error | Could not resend the invitation. (unchanged) | destructive |

- **Spanish copy:** added for every key. The old `resendInvitationSent` key was removed from both locales.

## What a resend does to tokens (unchanged; reported, not fixed)

1. **A resend supersedes the previous link before sending.** `approveOrganization()` marks every unused invitation for
   the organization and address as used, creates one new invitation, then sends.
   - If the send is rejected, unconfigured or unconfirmed, the old link is already dead.
   - The new link exists only in the database: the platform UI never shows links.
   - The new messages say so, but they don't change it.
   - Password reset (PR #133) invalidates its new token on `rejected` / `not_configured`. Invitations don't, and adding that would be a lifecycle change.
2. **A second resend issues nothing.**
   - `Invitation.usedAt` means "accepted **or** superseded" (`prisma/schema.prisma`, Invitation model).
   - `approveOrganization()`'s `alreadyAccepted` check matches any `usedAt`, though, so it treats a superseded link as accepted.
   - So after one resend, every later resend returns early, without issuing or sending anything. The old UI still said "Invitation resent."
   - The code can't tell "accepted" from "superseded" without a lifecycle change, so the new copy states only what is known.
   - Fixing it (for example, checking for an accepted membership or user rather than `usedAt`) changes token lifecycle and retry behavior. Per the brief, it is **reported and held for a decision, not changed here**. The integration test `pre-existing lifecycle, reported not changed` pins the current behavior.
3. **Retrying after `unknown`** can result in two emails if the first was actually accepted; only the newest link works.

## Evidence

### Integration tests: `tests/integration/platform-resend-invitation.test.ts` (8 tests, all pass)

Real action → real `approveOrganization()` → real `sendTransactionalEmail()` → **real Resend SDK**. Only `fetch` is
stubbed, and nothing leaves the machine. Run on the isolated `alliance_bjj_test` database.

| Test | Controlled provider response | Asserted |
|---|---|---|
| accepted | 200 `{ id }` | `{ ok: true, invitationEmail: "accepted" }`; SDK hit `https://api.resend.com/emails` once; token rotated exactly as before |
| rejected | 422 `validation_error`, body echoing the recipient and a synthetic secret | `"rejected"`; log is `{ organizationId, outcome: "rejected", providerCode: "validation_error" }` only |
| unknown: 5xx | 500 `internal_server_error` | `"unknown"`, never `"rejected"`; token rotated |
| unknown: unparseable | 502 HTML | `"unknown"` |
| unknown: network | `fetch` throws | `"unknown"`; the thrown message is not logged |
| not configured | `RESEND_API_KEY` empty | `"not_configured"`; no request made; the env-var error text is not logged |
| lifecycle (pre-existing) | second resend | `"notIssued"`; no request; live invitations unchanged |
| authorization | non-super-admin, then anonymous | both `{ error: "notFound" }`; no request; the invitation is untouched |

**Leak scan, every outcome test:** the console output and the action result contain none of the following:

- the provider's free text or the synthetic secret;
- the recipient address;
- `token=` or the invitation link taken from the SDK request body;
- `[Resend API Error]`.

### Component test: `tests/unit/resend-invitation-button.test.tsx` (12 tests, all pass)

**The action is mocked here.** This proves the outcome → message/class wiring only, in EN and ES.
Each failure outcome must not show the accepted text, and the old key is checked as gone.

### Mutation checks (each restored byte-identical, SHA-256 verified)

| Mutation | Result |
|---|---|
| Button back to blanket success (`action.error ? "error" : "accepted"`) | unit: 8 failed / 12 |
| Action drops the outcome (`return { ok: true }`) | integration: 8 failed / 8 |
| Log re-adds `error: emailResult.error` | integration: 3 failed / 8 |
| SDK error logging not suppressed | integration: 4 failed / 8 |

### Rendered check: real browser, real dev server, local fake provider

- **Database:** a disposable `resend_invitation_browser_test` on the test Postgres, migrated, **dropped afterwards**.
- **Server:** `next dev` on port 3100 with `RESEND_BASE_URL=http://127.0.0.1:8914`. That is a supported resend@6 setting.
- **Provider:** a fake local provider that returns controlled responses and counts requests without printing bodies.
- **No real email was sent.**
- **Super-admin bootstrap:** the one super-admin was **inserted directly into the disposable DB**. There is no UI or CLI path that creates a super-admin; the seed is the only one (`scripts/approve-organization.ts` header).
- **Target organizations, first round:** four registered through the real `/en/register-academy` form and approved through the panel's pending-queue **Approve** button.
- **First-round results not captured:** the first scripted resends ran, but the browser tool intercepted the `confirm()` dialog and returned nothing. Their messages are **not** used as evidence, and those organizations were then spent.
- **Target organizations, second round:** the registration form's existing rate limit refused further registrations. Three more organizations were created through the panel's **New organization** form, which runs the same `approveOrganization()`.
- **Confirm dialog:** for the captured runs, `window.confirm` was stubbed to return `true` in the page; the dialog's text is unchanged.

| Screenshot | Provider mode | Provider requests | Rendered text | Class |
|---|---|---|---|---|
| `screenshots/en-accepted-1280.png` | 200 | 14 → 15 | New invitation issued. The email provider accepted the invitation email; delivery is not confirmed. | muted |
| `screenshots/en-rejected-1280.png` | 422 `validation_error` | 15 → 16 | New invitation issued, but the invitation email was not sent: the email provider rejected it. The previous link no longer works. | destructive |
| `screenshots/es-unknown-network-drop-1280.png` | socket dropped | 16 → 17 | Nueva invitación emitida, pero no se pudo confirmar el envío del correo de invitación. El enlace anterior ya no funciona. | muted |
| `screenshots/en-second-resend-not-issued-1280.png` | 200 (not reached) | 17 → 17 | No new invitation was issued or sent: an earlier invitation to this address is already marked used (accepted, or replaced by an earlier resend). | muted |
| `screenshots/es-not-configured-1280.png` | server restarted with `RESEND_API_KEY=""` | 17 → 17 | Nueva invitación emitida, pero el correo de invitación no se envió: el envío de correo no está configurado. El enlace anterior ya no funciona. | destructive |

**Server log scan.** Both dev-server logs and the fake provider's log contain 0 occurrences of any of these:

- the provider's free text;
- `example.test` addresses;
- `token=`;
- `[Resend API Error]`;
- `RESEND_API_KEY`.

Each failure produced exactly one `[approve-organization] invitation email not accepted` entry with these fields only:

- `organizationId`
- `outcome` (`rejected`, `unknown` or `not_configured`)
- `providerCode` (`validation_error`, `application_error`, or undefined)

Member addresses visible in the screenshots are the page's existing member list, showing synthetic `example.test` rows.

## Scope and limitations

- **Unchanged in this PR:**
  - token lifecycle, retry behavior, permissions and the acceptance flow;
  - other email flows (registration confirmation, staff invitations, password reset, digests);
  - monitoring, security headers, branding, deployment.
- **Changed for every caller of `approveOrganization()`:** the failure log line now carries outcome and code instead of provider text. Those callers are pending-queue Approve, New organization and the CLI.
  - The CLI still prints `Invitation email sent: yes/no`.
  - Its "see logged error above" hint now points at that outcome line.
- **Not exercised:** a real provider. `accepted` means the provider took the request, never that it was delivered.
- **No migration, provider configuration, deployment or activation.**
