# Owner invitation lifecycle repair

Fixes the two defects PR #136 reported and left alone (plan: `docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md`, revision 3):

- **D1 — a superseded invitation blocked every later resend.** `approveOrganization()` superseded with `usedAt`, and its
  "already accepted" check was `usedAt IS NOT NULL`, so after one resend every later one returned "not issued".
- **D2 — a resend killed the previous link before the new email's outcome was known.** A rejected, unconfigured or
  unconfirmed send could leave the owner with no working link.

## The model

| Column | Meaning now | Written by |
|---|---|---|
| `acceptedAt` (new, nullable, no backfill) | genuine acceptance, nothing else | `acceptInvitation` only, in the same conditional update as `usedAt` |
| `usedAt` | consumed | `acceptInvitation` only |
| `revokedAt` | dead without acceptance: withdrawn by an Owner, superseded, or retired by a sibling's acceptance | staff revoke/resend (unchanged), platform settlement, acceptance's sibling revocation |

- **Live** (unchanged everywhere): `usedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`.
- **Accepted:** some row for the organization and address has `acceptedAt`. Never inferred from `User.active` or membership.
- **Legacy-used:** `usedAt` set, `acceptedAt` null, `revokedAt` null. Consumed under the old rules, accepted or superseded
  — unknowable. Left unchanged; blocks a platform resend (`legacyUnresolved`).
- **Monotonic:** every lifecycle write is a conditional `updateMany` that only sets a field that is still NULL. No code
  clears one, so no link is ever revived.
- **One lock:** `pg_advisory_xact_lock(hashtext(organizationId))` — the existing `lockOrganizationStaff`, now exported —
  is the first lock taken by issue, settle, acceptance and every staff invitation mutation.

### `approveOrganization()`: issue → send → settle

1. **Issue** (short transaction, locked): `alreadyAccepted` if any `acceptedAt`; `legacyUnresolved` if any legacy-used
   row; otherwise capture the ids of the currently live rows (`previousIds`) and create the new invitation N.
2. **Send:** `sendTransactionalEmail` with **no transaction open** (unchanged options and neutral log from #136).
3. **Settle** (second short transaction, locked):
   - any `acceptedAt` for the address now → `acceptedMeanwhile`, no change (the acceptance already retired the rest);
   - N no longer live → `unavailable`, no change — the row records no cause, so none is claimed, and earlier links are
     not retired for a dead link;
   - otherwise, by outcome: **accepted** → revoke exactly `previousIds` (still unused/unrevoked); **rejected /
     not_configured** → revoke N (panel callers) or keep it (CLI, `keepLinkOnFailedSend`); **unknown** → no change.
   - If settlement throws: logged as `[approve-organization] invitation settle failed { organizationId, outcome }` (no
     error text), result `failed`; the email outcome is still reported.

### `acceptInvitation()`

Inside its existing transaction: take the lock; take `now` **after** the lock; consume with
`usedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`, setting `usedAt` and `acceptedAt`; then revoke every other
live invitation to the same recipient (exact stored address) in the same organization. Everything else — the three account
cases, promotion in place, staff assignments, audit rows, sign-in, the throttle redirect — is unchanged. The earlier
pre-transaction check stays as an early exit only.

### Link validity by outcome (panel)

| Outcome | New link | Earlier links |
|---|---|---|
| accepted | live | retired (only those captured at issue) |
| rejected / not_configured | withdrawn | not changed |
| unknown | live | not changed; the first invitation accepted retires the others |
| settle failed | as issue left it, or as a concurrent change made it | may still work; retired by any acceptance or by a later accepted resend |
| process lost between issue and settle | live | not changed (same as unknown) |

The CLI keeps the new link live on rejected / not_configured and prints it for manual sharing, as before.

## UI copy (EN; ES equivalent in `messages/es.json`)

The message is two sentences: the email outcome, then what settlement found. Provider acceptance is never called
delivery; no message promises an earlier link still works.

| Email outcome | Settlement | Rendered (EN) | Style |
|---|---|---|---|
| accepted | settled | New invitation issued. The email provider accepted the invitation email; delivery is not confirmed. Earlier invitation links for this address were retired. | muted |
| rejected | settled | The invitation email was not sent: the email provider rejected it. The new link was withdrawn; earlier invitation links were not changed by this resend. | destructive |
| not_configured | settled | The invitation email was not sent: email sending is not configured. The new link was withdrawn; earlier invitation links were not changed by this resend. | destructive |
| unknown | settled | New invitation issued, but sending the invitation email could not be confirmed. Earlier invitation links were not changed by this resend; the first invitation accepted ends the others. | muted |
| any | acceptedMeanwhile | …An invitation to this address was accepted while this resend was in progress, so no further invitation is needed. | by outcome |
| any | unavailable | …The new invitation is no longer available, so its link does not work. Earlier invitation links were not changed by this resend. | by outcome |
| any | failed | …The invitation records could not be updated after sending, so earlier links may still work. Outstanding links end when any invitation is accepted, or when the provider accepts a later resend's email. | destructive |
| — | not issued (accepted earlier) | No new invitation was issued: an invitation to this address has already been accepted. | muted |
| — | legacy-used row | No new invitation was issued. An earlier invitation to this address is recorded as used under the previous rules, and it cannot be told whether it was accepted or replaced. A platform operator must resolve it. | destructive |

Confirm dialog: "Send a new invitation? Earlier invitation links for this organization stop working only if the email
provider accepts the new email." (was: "…This invalidates any previous invitation link…", false for three outcomes).

Reviewed and unchanged: `auth.acceptInvitation.invalidToken` ("invalid or has expired" — still true, shared with staff),
staff-page copy (staff flow unchanged), pending-queue Approve and New organization (they show no email outcome).

## Deviations from the plan

- **No cause from `revokedAt` alone.** The plan's `supersededMeanwhile` became the neutral `unavailable`; a revoked
  link may have been withdrawn by staff, superseded, or retired by an acceptance. `acceptedMeanwhile` requires an
  `acceptedAt` recorded while the email was in flight.
- **Settlement changes nothing when N is no longer live** (planned: retire `previousIds` regardless on accepted).
- **Two-sentence messages** with settlement keys (`resendInvitationSettledAccepted / SettledWithdrawn / SettledUnknown /
  AcceptedMeanwhile / Unavailable / SettleFailed`) instead of per-combination keys.
- **Recipient = organization + exact stored address** (`sameRecipient`), everywhere in the lifecycle — see "Address
  scope" below. (The first commit matched case-insensitively; corrected.) Settlement writes also carry `organizationId`.
- **Existing tests' email mocks** (`organization-approval`, `platform-admin`, `accept-invitation-existing-account`,
  `approved-owner-scope`) now return `outcome: "accepted"`, as the real helper always does; one assertion in
  `organization-approval` counts live as `usedAt` AND `revokedAt` null.

## Recovery

**Forward-fix is the default.** Redeploying the previous build is not a safe rollback even though its queries tolerate
`acceptedAt`: it has no sibling revocation, no acceptance lock and no fresh-time expiry check, and it reintroduces D1/D2
and new ambiguous `usedAt` rows. Any return to the old invitation logic needs invitation mutations stopped first and a
separately reviewed recovery procedure; the column and its acceptance evidence stay intact. No automatic data
rewriting. (Plan §6.2.)

## Address scope (correction commit)

**Rule:** one invitation recipient = one organization + one **exact stored address** (`sameRecipient` in
`approve-organization.ts`), applied to issuance (accepted / legacy checks, captured live ids), acceptance evidence at
settlement, sibling revocation in `acceptInvitation`, and the diagnostic. This is the identity acceptance already resolves:
`User.email` is unique case-sensitively and `acceptInvitation` / `approveOrganization` look the account up exactly, so two
addresses differing only by case can be two distinct accounts.

**Trace (isolated fixture, first commit `37b3594`):** an organization's owner invitation to `x@…` plus a distinct, active
account `X@…` with its own invitation in the same organization. With the first commit's case-insensitive matching, 3 of 4
new tests failed: accepting the variant account's invitation **revoked the owner's live link**; the owner's accepted
resend **retired the variant account's live invitation**; and the variant account's legacy-used row **blocked the owner's
resend**. All pass with the exact rule. The same-recipient test (identical stored address) passed both before and after.

**Unchanged:** stored emails, account lookup, and the staff flow's own case-insensitive checks (`inviteStaffMember`'s
existing-account lookup and `alreadyInvited` guard). Those only choose an account or refuse an invite; they never revoke,
settle or block another recipient's invitation, so no staff-workflow adjustment was needed. No identity redesign.

## Existing rows and the diagnostic

No backfill and no reinterpretation. **Organizations whose owner resend is blocked by a legacy-used row stay blocked
until each is individually resolved by a separately authorized repair**; any other live invitation for them can still be
accepted normally.

`scripts/report-legacy-invitations.ts` (logic: `reportOwnerResendBlockers` in
`src/lib/organizations/legacy-invitation-report.ts`) reports **exactly the organizations whose owner resend is blocked**,
with the application's own predicates (`sameRecipient`, `LEGACY_USED`, `ACCEPTED`): PENDING or ACTIVE, a legacy-used
invitation to the exact contact address, and no accepted invitation to it (acceptance takes precedence). Legacy rows for
a staff address or a case-variant account are not reported — they do not block the owner resend. (The first commit
inventoried every legacy-used row in an organization; corrected.) It runs in a `READ ONLY` transaction and prints
organization ids, counts and `usedAt` ranges only. Its "successor observed" count (a sibling to the same address created
within 5 s of a legacy row's `usedAt`) is labelled **observation only — proves neither supersession nor acceptance**. It
was not run against normal-dev or production.

## Evidence

All on the isolated test database (`alliance_bjj_test`, port 5433). The migration was applied there and to the
disposable browser database only.

### Full suites (on the final code)

- `tsc --noEmit`: clean. `eslint` on changed/new files: 0 errors (warnings only on pre-existing mock signatures).
  `check:guard-usage`: OK.
- First commit: unit **1800 / 1800**, integration **2105 / 2105** (161 files).
- After the address-scope correction: `tsc` clean, `eslint` on the changed files clean, `check:guard-usage` OK, unit
  **1800 / 1800**, integration **2109 / 2109** (161 files).

### `tests/integration/invitation-lifecycle.test.ts` (30 tests after the correction; first commit: 26, 3 consecutive green runs before its last two were added)

Email helper mocked with held, test-controlled responses; real Postgres; no production test hook. Orderings under the
lock use a **held-lock harness**: the test takes the organization's advisory lock in its own transaction, starts the
operations, waits until `pg_locks` (this database only) shows each one queued, then commits — Postgres grants queued
advisory-lock requests in arrival order. Expiry fakes `Date` only. Transaction failures come from a test-only wrapper
around this file's `@/lib/prisma` import.

| Area | Tests |
|---|---|
| By outcome | CLI fallback (rejected, not_configured); unknown keeps both, first acceptance retires the other; acceptance records `acceptedAt` = `usedAt` then `alreadyAccepted` with no send; expired never blocks; legacy-used blocks and stays byte-identical while another live link still accepts; used+revoked neither blocks nor counts; organization scope (another org's same-address row untouched) |
| S1 accepted settle vs old-link acceptance | acceptance wins; settlement wins; **stale pre-check** (queued behind settlement — refused, nothing written: user, password, audit unchanged) |
| S2 rejected settle vs new-link acceptance | acceptance wins; settlement wins |
| Other races | R1 newer settles first (older reports `unavailable`, newer stays live); R1 older settles first (retires only captured ids, newer untouched); captured link consumed by an older build mid-flight is never touched; **concurrent staff revocation** of the new link (`unavailable`, earlier link NOT retired) and of the old link (settlement skips it); R3 both queue orders; R4 two links accepted at once (one wins, one membership, one audit) |
| Expiry | E1: link expires while acceptance waits for the lock → refused, nothing written |
| Transaction failures | settle fails (reported with outcome, neutral log, both live, next resend retires both); issue fails (no send, no row); process lost between issue and settle; **acceptance rollback** (a later step fails after consume + sibling revoke → both undone) |
| Address scope (correction) | two distinct case-variant accounts in one organization: accepting one's invitation neither revokes the other's live link nor makes the other's resend `alreadyAccepted`; an owner resend's settlement never retires the other account's live invitation; the other account's legacy-used row does not block the owner's resend; same recipient (identical address): repeated invitations still supersede and one acceptance retires all the others, then `alreadyAccepted` |
| Diagnostic (correction) | reports the organization blocked by a legacy row to the exact contact address; does **not** report one whose only legacy rows are an unrelated staff address and a case-variant address, nor one where the owner also genuinely accepted; agrees with `approveOrganization` for all three (`legacyUnresolved` / `issued` / `alreadyAccepted`); writes nothing (full table snapshot identical); no address (`@`) or token in output |

### `tests/integration/platform-resend-invitation.test.ts` (8 tests, updated)

Real action → real `approveOrganization()` → real Resend SDK, `fetch` stubbed. Accepted (earlier retired), rejected (new
withdrawn, earlier kept), unknown ×3 (both live; no non-acceptance claim in logs), not_configured, **D1: five consecutive
resends all issue**, authorization (non-super-admin and anonymous → `notFound`, nothing issued). Leak scan on every
outcome: no provider text, address, `token=`, link or `[Resend API Error]`.

### `tests/unit/resend-invitation-button.test.tsx` (27 tests; action mocked)

Every outcome × settlement combination in EN and ES, with class; old copy gone; no unconditional "previous link no
longer works"; `unavailable` copy names no cause; no message says "delivered".

### Mutation checks (each restored byte-identical, MD5 verified)

Re-run on the corrected code: **all 16 caught** (M1–M12 from the first commit, N1–N4 for the correction). "Caught by"
lists the first-commit result; on the corrected code each M-mutation is caught by at least the same tests.

| Mutation | Caught by |
|---|---|
| N1 recipient matched case-insensitively (issue / settle / diagnostic) | 3 case-variant tests; diagnostic test |
| N2 sibling revocation case-insensitive | case-variant acceptance test |
| N3 diagnostic ignores acceptance precedence | diagnostic test |
| N4 diagnostic counts legacy rows for any address in the organization | diagnostic test |
| M1 settle without the lock | stale pre-check; R3b |
| M2 acceptance without the lock | stale pre-check; R3a; R3b |
| M3 consume without `expiresAt > now` | E1 |
| M4 `now` taken before the lock | E1 |
| M5 settle retires by time, not captured ids | R1 older-settles-first (added after M5 first survived) |
| M6 supersede before the send | 15 tests |
| M7 no sibling revocation | 7 tests |
| M8 settle without the `usedAt IS NULL` guard | captured-link-consumed-by-older-build (added after M8 first survived; equivalent under single-version operation) |
| M9 legacy-used silently treated as accepted | legacy test |
| M10 diagnostic writes | diagnostic test |
| M11 `acceptedMeanwhile` inferred from `revokedAt` alone | R1; concurrent staff revocation |
| M12 unavailable link still retires earlier links | concurrent staff revocation |
| Control: remove the pre-check's expiry clause | **34 / 34 still pass** — correctness rests on the locked consume |

### Rendered check — real browser, real dev server, **local fake provider (mocked)**

Run on the first commit (`37b3594`). The correction changes no copy and no behavior for a single exact address, which is
all these scenarios use; it was not re-rendered.

- **Database:** disposable `invitation_lifecycle_browser_test` on the test Postgres, migrated, **dropped afterwards**.
- **Server:** `next dev` on port 3100, `RESEND_BASE_URL=http://127.0.0.1:8914` (resend@6 setting).
- **Provider:** a local fake with controlled responses (accepted / 422 rejected / dropped socket / held). It keeps
  captured links in memory and serves them only as local redirects; bodies are never printed. **No real email.**
- **Fixtures:** the super-admin was inserted directly (no UI/CLI path exists); one **legacy-used row was inserted
  directly** for Foxtrot. Six organizations were created through the panel's **New organization** form (first email
  accepted). `window.confirm` was stubbed to record its text and return true.

| Screenshot | Scenario | Provider | Rendered | Class | DB afterwards |
|---|---|---|---|---|---|
| `en-accepted-1280.png` | resend | accepted | accepted + earlier retired | muted | 1st retired, 1 live |
| `en-repeat-resend-accepted-1280.png` | second consecutive resend (D1) | accepted | same | muted | 2 retired, 1 live |
| `en-rejected-1280.png` | resend | 422 | rejected + new withdrawn, earlier unchanged | destructive | original live, new revoked |
| `es-unknown-network-drop-1280.png` | resend | socket dropped | unknown + earlier unchanged (ES) | muted | both live |
| `en-after-genuine-acceptance-not-issued-1280.png` | owner accepted the original link on the real accept page (separate logged-out context), then resend | not reached | not issued: already accepted | muted | `usedAt` + `acceptedAt` set |
| `en-accepted-meanwhile-1280.png` | email held; owner accepted the original link; email released | held → accepted | accepted + accepted meanwhile | muted | original accepted, new revoked |
| `es-legacy-unresolved-1280.png` | legacy fixture present | not reached (11 → 11 requests) | legacy block (ES) | destructive | fixture unchanged |
| `en-unavailable-older-resend-1280.png` | two tabs resend; newer email answered first, older delayed | held → accepted (LIFO) | older tab: accepted + no longer available | muted | older's link revoked by newer, newer live |
| `en-not-configured-1280.png` | server restarted with `RESEND_API_KEY=""` | not reached (2 → 2) | not configured + new withdrawn | destructive | earlier 2 live, new revoked |

Confirm text recorded in EN and ES matched the new copy.

**Log scan.** The fake provider's logs and the unconfigured server's log: 0 matches for provider free text,
`example.test`, `token=`, `[Resend API Error]`, `RESEND_API_KEY`. The first dev-server log: 4 matches, all `token=` in
**`next dev`'s own request lines** for the accept page (`GET/POST /en/accept-invitation?token=…`) when the owner opened
the link — pre-existing dev-mode framework logging, not a log line this PR adds. The app's own entries were
`[approve-organization] invitation email outcome` with outcome fields only; no `settle failed` occurred.

**Not rendered** (covered by integration + unit tests): settle failed (needs an injected database failure).

## Scope and limitations

- **Unchanged:** permissions and organization scoping; staff invite/resend/revoke logic (they now share the lock they
  already took); `describeInvitation` and `listStaff` predicates; `sendTransactionalEmail`; existing-account behavior.
- **Tracked separately, not done here:** staff resend delivery (it still revokes before `deliverInvitation` knows the
  outcome); staff invitation email-log sanitization (`deliverInvitation` logs `result.error`, and the SDK's own
  non-production `[Resend API Error]` logging needs `suppressProviderErrorLogging` too — not a one-line fix); showing the
  email outcome on pending-queue Approve and New organization.
- **Held-lock harness assumptions:** integration files run without file parallelism; Postgres grants queued advisory-lock
  requests in arrival order. No production test hook was added.
- **Not exercised:** a real provider; multiple app instances (the lock is in Postgres, so it holds across instances,
  but that was not run).
- **No normal-dev/production migration, historical-row repair, provider configuration, deployment or activation.**
