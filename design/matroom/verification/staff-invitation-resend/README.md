# Staff invitation resend lifecycle — verification

Implements `docs/STAFF_INVITATION_RESEND_PLAN.md` revision 2 (D1–D4 approved). Its "Implementation notes" section lists
where the implementation departs from or adds to the plan.

## What changed

| Path | Before | After |
|---|---|---|
| Resend (`resendStaffInvitation`) | revoked the earlier invitation **inside the issue transaction, before the email was sent** | issue under the organization lock **invalidates nothing**; it snapshots the replacement candidates (the resent invitation + live links of the same offer); send with no transaction open; **settle** under the lock with fresh time |
| Settle (new, module-private) | — | `acceptedMeanwhile` only on the new invitation's **own `acceptedAt`**; `unavailable` (no cause claimed) if it is revoked or expired; otherwise a **provider-accepted** send retires the still-live snapshotted ids; rejected / not configured / unknown change nothing; a failure → `failed`, nothing invalidated, one fixed log line |
| First invite | send, return `{ link, emailSent }` | same send + settle (empty snapshot) |
| Revoke (`revokeStaffInvitation`) | one row | **every live link of the same offer**: same organization, exact address, role, order-independent academy set (D2) |
| Result (`InvitationDelivery`) | `{ invitationLink, emailSent }` | `{ invitationId, invitationLink?, expiresAt, emailOutcome, settlement }`. The link is present only when settled (usable when checked) or failed (unknown) |
| Panel (`staff-forms.tsx`) | "We emailed the link." / "The email couldn't be sent…" | outcome headline (provider acceptance ≠ delivery), what **this** resend did to earlier links, a link status labelled for what is known (checked / unverified / unavailable / accepted meanwhile / no longer usable) |
| Refresh re-check | none (a stale link stayed on screen) | `page.tsx` passes `usableInvitationIds(invitations)` (pending **and not expired** — `listStaff`'s own data); the panel also checks its own `expiresAt`; it re-checks only once a newer list arrives |

**Unchanged:** acceptance (`accept-invitation/actions.ts`), the `listStaff` query, the schema (no migration),
authorization (`assertOwner` + `resolveActionContext(…, ["ADMIN"])`), sanitized logging, role/academy values (copied
exactly as stored), and the manual-link workflow.

## Tests (isolated test database only)

### `tests/integration/staff-invitation-resend-lifecycle.test.ts` — 21 tests, all new

These use real Postgres and the PR #137 harness: held sends, the held lock observed through `pg_locks`, fake `Date`
only, and a test-only `$transaction` failure. Real `acceptInvitation`.

| Area | Cases |
|---|---|
| Outcomes (D1) | accepted (earlier link still acceptable while in flight; retired after settle; superseded audit); rejected + not_configured (both live, manual link returned, either acceptance retires the other); unknown |
| Acceptance evidence | earlier link accepted mid-flight → `unavailable`, settlement writes nothing; new link accepted → `acceptedMeanwhile`; different-scope offer accepted → `unavailable`; an **old** acceptance by the same address → settles normally |
| Revocation (D2) | before issue → `notPending`, nothing sent; during flight → new link withdrawn, `unavailable`, `revokedAt` values unchanged; a first invite revoked in flight → `unavailable` |
| Concurrency | settle waits for the lock (`pg_locks`) and sees a change committed while waiting; two resends, **both settle orders**: a late settle never retires a newer invitation and never rewrites a non-live row; the new invitation expiring before settle (fake clock) → `unavailable`; settle failure → `failed`, nothing invalidated, exact log line `["[staff] invitation settle failed", { organizationId, outcome }]` |
| Scope and identity | different-scope live offer untouched by settle and revoke; case-variant address untouched; order-independent academy match captured and revoked, replacement's `academyIds` equal to the stored ones in their original order; expired resend works; academy removed → `invalidToken`; non-Owner → `FORBIDDEN`, nothing sent |
| Panel data | an invitation **still in `listStaff`'s pending list but expired** is excluded by `usableInvitationIds`; pending + unexpired is included |

### `tests/unit/staff-forms.test.tsx` — 26 tests (was 8)

- each outcome × settlement in **EN and ES**;
- a first invite has no earlier-links line;
- `failed` shows the unverified wording, never "usable when checked", and never success styling;
- no link for `acceptedMeanwhile` / `unavailable`;
- refresh re-check:
  - no longer pending → hidden;
  - **still listed but expired → hidden** (page set and the panel's own `expiresAt`);
  - pending + unexpired → shown;
  - **a fresh result is not hidden before the refresh that lists it arrives** (found in the real browser — see below).

### Updated existing tests

- **`staff-management.test.ts`:** realistic mock outcomes; assertions on `emailOutcome` / `settlement`. The resend test
  now asserts that the old link dies after settlement.
- **`staff-invitation-email-logging.test.ts` (PR #138):** an `unknown` resend now leaves the earlier link live (D1).
  The logging assertions are unchanged.
- **`invitation-lifecycle.test.ts` (PR #137):** the two "concurrent staff revocation" tests now assert D2 (a co-owner's
  Revoke of either owner link withdraws the offer → `unavailable`, nothing revived). A new test keeps owner settlement's
  "skip a row retired by something else, `revokedAt` unchanged" guarantee by retiring the row directly. See plan
  "Implementation notes" 1.

### Fails before, passes after

With main's versions of the 7 changed source and message files put back (then restored, sha256 checked): **30
integration and 18 unit tests fail**. Many of those are shape failures (the new fields are absent), so the mutation set
below is the behavioral proof.

### Targeted mutations — each applied alone, then restored (sha256 checked; tree unchanged after the run)

| # | Mutation | Caught by |
|---|---|---|
| M1 | pre-send revoke restored | 10 tests (accepted, D1 outcomes, revoke in flight, lock, both concurrency orders, expiry, settle failure…) |
| M2 | settle without the lock | settle-takes-the-lock |
| M3 | replacement set recomputed at settle instead of snapshotted | older-settles-first; different-scope untouched |
| M4 | owner-style "any accepted for the address" evidence | earlier link accepted; different-scope accepted; old acceptance |
| M5 | rejected / not_configured revokes the new link | rejected / not_configured |
| M6 | settle ignores the new invitation's expiry | expiry before settle |
| M7 | per-row revoke | revoke in flight; order-independent academy match |
| M8 | settle writes rows that are no longer live | older-settles-first (`revokedAt` rewritten) |
| M9 | link returned when unavailable / accepted meanwhile | 4 tests |
| M10 | settle-failure log carries error text | settle failure |
| M11a | `usableInvitationIds` ignores `expired` | still listed but expired |
| M11b | panel ignores its own `expiresAt` | still listed but expired (unit) |
| M12 | `failed` rendered with the "usable when checked" wording | settle failed (EN + ES) |
| M13 | order-dependent academy match | order-independent academy match |
| M14 | retire on any outcome, not only provider-accepted | rejected / not_configured; unknown |
| M15 | re-check before the refresh that lists the new invitation | fresh result not hidden before refresh |

## Rendered check — real browser, real dev server, **local fake provider (mocked)**

- **Database:** disposable `staff_resend_browser_test` on the test Postgres, migrated, **dropped afterwards**.
- **Server:** `next dev` on port 3100 with `RESEND_BASE_URL` pointing at the fake provider. The dev server was stopped
  afterwards; an orphaned `next dev` still listening on the port was found and stopped by PID.
- **Provider:** a local fake with controlled responses (accepted / 422 with free text / dropped socket / held). It keeps
  captured links in memory and serves them only as local redirects. Bodies are never printed. **No real email.**
- **Fixtures:** the super-admin was inserted directly (no UI path exists). The organization was created through the
  platform **New organization** form. The Owner accepted the real emailed link, set a password and skipped onboarding.
  Every invitee was invited through the staff page. One invitation's `expiresAt` was set in the past directly (S7).
- **Screenshots:** headless Chromium, 1280 wide, full page. The token in the copyable link is **masked in the DOM
  before each screenshot** (display only).

| Screenshot | Scenario | Provider | Rendered | DB afterwards |
|---|---|---|---|---|
| `01-en-invite-accepted` | first invite | accepted | provider accepted (not delivery), usable when checked, link | 1 live |
| `02-en-resend-rejected-two-rows` | resend | 422 | refused + "did not invalidate earlier links", link; **two rows listed** (D4) | 2 live |
| `03-es-resend-unknown` | resend (ES page) | socket dropped | unknown + did not invalidate (ES), link | 3 live |
| `04-en-resend-accepted-earlier-retired` | resend | accepted | "earlier links this resend replaced no longer work", link | 3 revoked, 1 live |
| `05-en-unavailable-earlier-accepted` | email held; invitee accepted the earlier link in a separate browser; released | held → accepted | neutral "no longer usable … (may have been revoked, replaced, or expired)", **no link** | earlier accepted, new revoked |
| `06-en-revoked-while-in-flight` | email held; a second tab (2 rows listed) clicked Revoke; released | held → accepted | neutral unavailable, **no link** | both revoked |
| `07a-en-fresh-link-shown` | two invites in a row | accepted | the fresh link stays shown after the page refresh | 2 live |
| `07b-en-expired-link-hidden` | the shown invitation expired (fixture), then another staff action refreshed the page | — | "no longer usable", **no link**; the row is still listed, flagged **Expired** | — |

The Revoke confirm text recorded in the browser was *"Revoke this invitation? All of its links stop working."*

**Found by the browser, fixed, and tested:** the first run showed "no longer usable" right after a resend. The action's
result rendered before the page refresh that lists the new invitation. Fixed by re-checking only against a newer list
(plan "Implementation notes" 2); unit test plus mutation M15. The full browser run was then repeated from a fresh
database.

**Log scan (final run).**

- **Fake provider log:** 0 matches for the provider's free text, `example.test` or `token=`.
- **Dev-server log:** 0 matches for the provider's free text, `example.test`, `[Resend API Error]`, `RESEND_API_KEY` or
  the fake key.
- **`token=`:** 4 matches, all **`next dev`'s own request lines** for the accept page (GET/POST, the Owner and the
  invitee opening their links). That is pre-existing dev-mode framework logging, not a line this PR adds.
- **The application's own lines:** two, both
  `[staff] invitation email outcome { organizationId, outcome, providerCode }` (rejected/validation_error,
  unknown/application_error).

**Not rendered** (covered by integration + unit tests): settle `failed` (needs an injected database failure),
`acceptedMeanwhile`, `not_configured`.

## Checks

- `tsc --noEmit` clean · eslint clean on changed files · `check:guard-usage` OK · unit **1818/1818**.
- **Integration, first full run: 2147/2148.**
  - **The failure:** `password-reset.test.ts` → "each sweep removes at most 100 expired rows, oldest first, and never a
    recent row".
  - **Detail not captured:** the run's output was filtered to the summary, so the failing assertion is unknown.
  - **Reruns:** the test passed alone twice (24/24). A second full run passed **2148/2148**.
  - **Cause not established.** The test clears and fills its own table, in password-reset code this PR does not touch.
    The browser-check server and database were already torn down before that run.
- **Integration, final full run: 2148/2148** (2126 + 21 new + 1 added owner-settlement test).

## Limitations

- **Snapshots, not guarantees.** Usability is checked at settlement and at each page render. Between those, a link can
  be revoked, used or expire. There is no polling or push.
- **No cause for `unavailable`.** Revoked-by-acceptance, explicit revocation and expiry are indistinguishable without
  inferring from timestamps (deliberately not done, and no schema change).
- **D2 reaches the owner's invitations listed on the staff page** (plan "Implementation notes" 1).
- **No real provider.** Provider acceptance is never verified as delivery.
- **Historical rows** are not repaired. Legacy consumed rows are never live, so they are unaffected.
- **Out of scope, unchanged:** the Approve / New organization outcome UI; remaining raw-exception logging; the
  launch-verification items.
