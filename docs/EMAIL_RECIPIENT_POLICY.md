# Email recipient policy

Every email this app sends passes one fail-closed check first: `checkRecipient` in
`src/lib/email/recipient-policy.ts`. Both send paths call it before the provider:

- `sendTransactionalEmail` (registration confirmation, organization invitation, staff invitation, password reset),
  before the API key is read or a Resend client is created;
- `EmailChannel.send` (signup and eligibility notifications, the weekly digest), before the client is called.

A unit test fails if `emails.send(` appears anywhere else in `src/`.

## Settings

| Setting | Value |
|---|---|
| `EMAIL_DELIVERY_MODE` | exactly `allowlist` or `unrestricted` (surrounding spaces ignored, case-sensitive) |
| `EMAIL_RECIPIENT_ALLOWLIST` | comma-separated exact addresses, at most 25; no domains, wildcards, display names or other separators |

| Mode | Allowlist | `VERCEL_ENV` | Result |
|---|---|---|---|
| missing, empty or anything else | any | any | every send blocked (`mode_invalid`) |
| `allowlist` | missing or empty | any | every send blocked (`allowlist_missing`) |
| `allowlist` | any invalid entry | any | every send blocked (`allowlist_invalid`) — the whole list is rejected |
| `allowlist` | valid | any | only exact listed addresses (case-insensitive); others blocked (`not_allowlisted`) |
| `unrestricted` | set (even empty) | any | every send blocked (`mode_conflict`) |
| `unrestricted` | not set | `production` | any plain address (below); others blocked (`recipient_invalid`) |
| `unrestricted` | not set | anything else | every send blocked (`unrestricted_outside_production`) |

## One plain recipient address (every mode)

Unless the configuration already blocks every send, the recipient must be one plain address before **either** mode can
allow it; otherwise the send is blocked with reason `recipient_invalid` (`isPlainAddress`):

- rejected: multiple addresses, display-name forms (`Name <a@x.com>`), whitespace (including CR/LF, tabs and Unicode
  spaces), control and invisible format characters, the delimiters `,` `;` `<` `>` `:` `(` `)` `[` `]` `\`, the
  **double quote** `"`, and malformed `@` structure (none, more than one, empty local part, a domain without two
  non-empty labels);
- allowed: the **apostrophe** `'` (`o'brien@example.com`) and non-ASCII letters (internationalized local parts and
  domains). In `unrestricted` mode such addresses are sent unchanged. The allowlist itself still accepts only the
  strict ASCII pattern above.

## Blocked messages

A blocked send returns outcome `blocked` (`success: false`) and never reaches the provider. It is never recorded as
sent:

- notification dispatch and the weekly digest count it as `failed`;
- organization approval withdraws the new invitation link, like `not_configured` (unless the CLI keeps it);
- staff invitations settle nothing (only `accepted` retires earlier links);
- password reset makes the issued token unusable; the person sees the usual neutral response;
- the staff and platform screens show a "blocked by this environment's email recipient policy" message.

Logs record the outcome (and, in the transactional result's `error`, the reason code) only — never an address.

## Environments

| Environment | Setting |
|---|---|
| Staging | `EMAIL_DELIVERY_MODE=allowlist`, `EMAIL_RECIPIENT_ALLOWLIST=<owner-controlled addresses>` |
| Production | `EMAIL_DELIVERY_MODE=unrestricted`, `EMAIL_RECIPIENT_ALLOWLIST` **not set** |
| Local development | `.env.example` ships `allowlist` with an empty list: no email is sent until you list your own address |

Production must set `unrestricted` explicitly; without it, production sends no email at all.

## Staging limitation (accepted, documented)

`VERCEL_ENV` is a Vercel **deployment target**, not a staging/production boundary. The staging project's live deployment
is also a `production` target, so the policy cannot tell staging from production. The `VERCEL_ENV` check only stops
preview, development and local runs from sending freely.

What keeps staging restricted is staging's own configuration. Opening it to every address takes two deliberate
settings changes on the staging project: setting the mode to `unrestricted` **and** removing the allowlist. Either
change alone blocks every send (`mode_conflict`, or `allowlist_missing`). A unit test
(`DOCUMENTED LIMITATION` in `tests/unit/email-recipient-policy.test.ts`) pins this behavior.

## Status check

`GET /api/health/email-policy` (same `Authorization: Bearer <CRON_SECRET>` as `/api/health/jobs`; 401 otherwise). It
reads settings only: no database, no Resend client, no send. Response:

```json
{ "mode": "allowlist", "effective": "allowlist", "reason": null, "deploymentTarget": "production",
  "allowlistCount": 2, "allowlistFingerprint": "<64 hex>", "providerKeyPresent": true, "senderConfigured": true }
```

- `mode`: `allowlist`, `unrestricted` or `invalid` (any other configured value — never echoed).
- `effective`: `allowlist`, `unrestricted` or `blocked_all`; `reason` gives the cause when blocked.
- `allowlistFingerprint`: HMAC-SHA256 keyed with `CRON_SECRET` over the normalized list (lowercased, sorted, no
  duplicates, joined by `\n`); `null` unless the allowlist is in effect. Keyed, because an unkeyed hash of a few
  addresses could be reversed by guessing.
- No address, domain, key, sender or raw setting value is ever returned.

`docs/email-policy-status-check.ps1` (owner-run) asks for the secret and the intended addresses locally, computes the same
fingerprint, makes one GET and prints PASS or FAIL for mode, effective policy, count and fingerprint. The fingerprint
proves the list matches only to someone who already holds the secret; it is a check after each deployment or settings
change, not continuous enforcement.
