# Invitation lifecycle repair — plan, revision 3

Base: `main` @ `4aefd19064d2450d5a8cecf5c9c3828a5b75c91f` (PR #136 merged). **Implemented** on branch
`fix/invitation-lifecycle`; the evidence, deviations and limitations are in
`design/matroom/verification/invitation-lifecycle/README.md`, which is authoritative where it differs from this plan.

Revision 3 (during implementation):

- **§6.2 rewritten:** forward-fix is the default recovery; redeploying the old build is not a safe rollback.
- **No cause is claimed from `revokedAt` alone.** The planned `supersededMeanwhile` result (§5, R1 note) is replaced by a
  neutral `unavailable` ("The new invitation is no longer available…"), because a revoked link may have been withdrawn
  by staff, superseded, or revoked by an acceptance. `acceptedMeanwhile` is reported only on evidence: an `acceptedAt`
  recorded while the email was in flight.
- **Messages are two sentences:** the email outcome, then what settlement found. The keys in §4 are adjusted to match;
  see the README for the shipped copy.
- **Settlement makes no change when its own link is no longer live,** so an unusable new link never retires the earlier
  ones.
- **One recipient = one organization + one EXACT stored address** (`sameRecipient`), for issue, acceptance evidence,
  settlement, sibling revocation and the diagnostic. `User.email` is unique case-sensitively and acceptance resolves the
  account exactly, so case-variant addresses can be distinct accounts; the first implementation's case-insensitive
  matching let one block, settle or revoke the other's invitations. Stored emails, account lookup and the staff flow's
  own `alreadyInvited` check are unchanged.
- **The diagnostic reports actual owner-resend blockers** with the application's predicates (§6.3), not every legacy
  row in an organization.

Revision 2 applies five corrections from review:

1. settlement runs inside a short locked transaction (§3.3, §5);
2. acceptance re-checks expiry under the lock (§3.4);
3. all affected EN/ES copy is rewritten for outcome accuracy (§4, §7);
4. the rollback section is rewritten (§6.2);
5. historical successor timing is strictly diagnostic (§6.3).

The two product defaults are now **decided** (§11).

Out of scope:

- monitoring Increment 1;
- security headers;
- branding;
- deployment;
- provider configuration;
- other email flows. The staff-flow items in §9 stay separately tracked.

Every outstanding launch-verification item stays as tracked.

---

## 1. The two defects (confirmed in code)

| # | Defect | Where |
|---|---|---|
| D1 | A superseded owner invitation blocks every later resend. `approveOrganization` supersedes by setting `usedAt`, and its "already accepted" check is `usedAt IS NOT NULL`. After one resend, every later resend returns `notIssued`. | `src/lib/organizations/approve-organization.ts:139-154` |
| D2 | A resend kills the previous link **before** the replacement email's outcome is known (`updateMany … usedAt = now()` runs before `sendTransactionalEmail`). | same file, `:151-180` |

Related facts:

- **No atomicity.** `approveOrganization`'s check, supersession and create are three separate statements with no transaction or lock. `acceptInvitation` takes no organization lock either.
- **`usedAt` is overloaded.** The schema's own comment (`prisma/schema.prisma:661-663`) gives `usedAt` two meanings. `revokedAt` (`:664-667`) means "withdrawn".
- **The staff flow already supersedes with `revokedAt`** (`src/lib/staff/staff-service.ts:253`).
- **Only two writers of `Invitation.usedAt` exist**: `acceptInvitation` (`src/app/[locale]/accept-invitation/actions.ts:92-95`) and `approveOrganization`'s supersession. No seed or script writes invitations, and `git log -S` shows the supersession code unchanged since the file was introduced.
- **The current acceptance consume does not re-check expiry.** Expiry is checked only in the pre-transaction read (`actions.ts:56`). The consume `updateMany` (`:92-95`) filters on `usedAt` and `revokedAt` only.

## 2. What was traced

| Path | Entry | Reaches |
|---|---|---|
| Platform approve (pending queue) | `approveOrganizationAction` — `platform/organizations/actions.ts:31` (super-admin gate). `pending-row-actions.tsx:19` shows errors only; it **shows no email outcome**. | `approveOrganization` |
| Platform resend button | same action, via `[id]/resend-invitation-button.tsx` | `approveOrganization` (ACTIVE branch) |
| Manual organization creation | `createOrganizationManually` — `new/actions.ts:52-108` (super-admin gate). It ignores the result; `new/page.tsx` shows no email outcome. | `approveOrganization` |
| CLI approval | `scripts/approve-organization.ts:46`. **Prints the raw link** as the manual fallback (`:55-57`). | `approveOrganization` |
| Acceptance (shared) | `acceptInvitation` — conditional consume inside a transaction | — |
| Invitation preview (shared) | `describeInvitation` — `src/lib/staff/describe-invitation.ts:43` (checks `usedAt`, `revokedAt` and expiry) | — |
| Staff pending list (shared table) | `listStaff` — `src/lib/staff/list-staff.ts:43` (`usedAt null, revokedAt null`). `ADMIN` is a staff role, so the owner's pending invitation appears there. | — |
| Staff invite / resend / revoke | `staff-service.ts:173-307`, using the advisory lock `lockOrganizationStaff` (`:68`, `pg_advisory_xact_lock(hashtext(organizationId))`) | `deliverInvitation` |

**Authoritative acceptance evidence.** The only evidence is the conditional consume in `acceptInvitation`'s transaction. The following are not used:

- `User.active` — excluded as instructed;
- membership existence — approval creates the membership;
- the `staff.accept` audit row — keyed to the membership, not the invitation, and runtime code never reads audit rows.

## 3. Proposed model

### 3.1 One additive column

```prisma
/// Set only by acceptInvitation, in the same conditional update that sets usedAt. Null on every row consumed before
/// this column existed, or consumed by an application version without it (§6.2): those rows are "legacy-used".
acceptedAt DateTime?
```

| Column | Meaning (going forward) | Who sets it |
|---|---|---|
| `acceptedAt` | **Genuinely accepted.** | `acceptInvitation` only |
| `usedAt` | The link is consumed. Set together with `acceptedAt`, and never again by supersession. | `acceptInvitation` only |
| `revokedAt` | Dead without acceptance: withdrawn, **or superseded**. This is already its staff-flow meaning. | staff revoke/resend, platform settlement, acceptance's sibling revoke |

**Live** = `usedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`. This is unchanged for `describeInvitation`, `listStaff` and the staff flow.

**Accepted (for organization + email)** = some row has `acceptedAt IS NOT NULL`.

**Legacy-used** = `usedAt IS NOT NULL AND acceptedAt IS NULL AND revokedAt IS NULL`. A row with both `usedAt` and `revokedAt` was never accepted: the consume requires `revokedAt IS NULL`, and staff revoke refuses used rows. That row is simply dead.

**Monotonic invariant.** Lifecycle columns are only ever set from NULL, by conditional `updateMany`. No code path clears them, so no link is ever revived.

**One lock.** `pg_advisory_xact_lock(hashtext(organizationId))` is shared by:

- issuance;
- settlement;
- acceptance;
- every staff invitation mutation.

`lockOrganizationStaff` is exported and reused, not re-implemented. Lock order everywhere is the advisory lock first, then the invitation rows.

### 3.2 Issue (transaction 1, short)

Inside `approveOrganization`, after the unchanged status, academy, owner and membership steps:

1. Take the lock.
2. Check acceptance:
   - accepted → return `alreadyAccepted`; nothing is created or sent;
   - legacy-used → return `legacyUnresolved`; nothing is created or sent (§6.3).
3. Snapshot `previousIds`, the ids of the currently live rows for this organization and email.
4. Create `N`.
5. Commit.

### 3.3 Send, then settle (transaction 2, short)

**Send.** `sendTransactionalEmail(...)` runs **outside any transaction**, with the unchanged options and the neutral log from #136.

**Settle.** A short transaction:

1. Take the **same lock**.
2. Compute `now`.
3. Apply the outcome's id-scoped, monotonic update:

| Outcome | Settlement update |
|---|---|
| accepted | `updateMany where id IN previousIds AND usedAt IS NULL AND revokedAt IS NULL` → `revokedAt = now` |
| rejected / not_configured, platform callers | `updateMany where id = N AND usedAt IS NULL AND revokedAt IS NULL` → `revokedAt = now` |
| rejected / not_configured, CLI (`keepLinkOnFailedSend`) | none. N stays live for manual sharing; earlier links are not changed. |
| unknown | none |

4. **Re-read N under the lock** to classify the result honestly (`settled.n`):
   - `live`;
   - `consumed` (N itself was accepted);
   - `revoked` (by a concurrent acceptance of another link, or by this settlement).

   Also record whether any row for the organization and email now has `acceptedAt` (`settled.acceptedMeanwhile`).
5. Commit.

**If the settle transaction throws:**

- catch the error;
- log `[approve-organization] invitation settle failed` with `{ organizationId, outcome }` (no address, token, link or error text);
- return `settled = "failed"`.

The email outcome is still reported, and the action does **not** turn into a generic error: the email outcome is already known.

### 3.4 Acceptance

`acceptInvitation`, inside its existing transaction:

1. Take the lock on `invitation.organizationId`.
2. `const now = new Date()`. This is fresh time, taken **after** the lock is held.
3. Consume: `updateMany where id AND usedAt IS NULL AND revokedAt IS NULL AND expiresAt > now` → `usedAt = now, acceptedAt = now`. If the count is not 1, throw `InvitationAlreadyConsumed` → `invalidToken`, and the whole transaction rolls back.
4. Revoke live siblings: `updateMany where organizationId AND email = invitation.email (exact — revision 3) AND id <> invitation.id AND usedAt IS NULL AND revokedAt IS NULL` → `revokedAt = now`.
5. All existing steps are unchanged: account cases, promotion in place, staff assignments, audit rows, sign-in and the throttle redirect.

The pre-transaction check at `actions.ts:56` (used, revoked or expired) stays **as an optimization only**. It avoids hashing a password for a dead link, but correctness rests on step 3.

For the staff flow, step 4 is a no-op in practice: `alreadyInvited` prevents two live staff invitations, and resend revokes before it creates.

## 4. Outcomes, link validity and what the UI may claim

Rules for every message:

- **Provider acceptance is never delivery.**
- No message says the owner *has* a working link.
- No message promises an earlier link still works; it may be expired, consumed or revoked concurrently.
- Messages describe only what **this action did**.

"Old" = the rows in `previousIds`. "N" = the new invitation.

| Email outcome | Settle result | N after | Old after | Message key |
|---|---|---|---|---|
| accepted | ok, N live | live | revoked by this resend | `resendInvitationAccepted` |
| rejected | ok (platform) | revoked | not changed by this resend | `resendInvitationRejected` |
| not_configured | ok (platform) | revoked | not changed by this resend | `resendInvitationNotConfigured` |
| unknown | ok, N live | live | not changed by this resend | `resendInvitationUnknown` |
| any | `acceptedMeanwhile` (N revoked or consumed by a concurrent acceptance) | not live | — | `resendInvitationAcceptedMeanwhile` |
| any | `failed` | unknown to the action | unknown to the action | `resendInvitationSettleFailed` |
| — (not issued) | — | — | — | `resendInvitationNotIssued` (genuinely accepted earlier) / `resendInvitationLegacyUnresolved` |
| — (action error) | — | — | — | `resendInvitationError` (unchanged) |

**After a settlement failure**, the database may hold any of these states, and none is unsafe:

- N live and the old links live (the same as unknown);
- N or the old links consumed or revoked by a concurrent acceptance.

Whichever invitation is accepted first revokes the rest, and the next resend's settlement covers the leftovers. The message therefore says only that the earlier links *may not have been retired*.

**Process death between issue and settle** leaves the same state as unknown. It is safe, with nothing reported.

### Proposed copy (EN / ES)

**`confirmResendInvitation`** — the current text, "This invalidates any previous invitation link", is **false** for the rejected, not-configured and unknown outcomes.
- EN: "Send a new invitation? Earlier invitation links for this organization stop working only if the email provider accepts the new email."
- ES: "¿Enviar una nueva invitación? Los enlaces de invitación anteriores de esta organización dejan de funcionar solo si el proveedor de correo acepta el nuevo correo."

**`resendInvitationAccepted`**
- EN: "New invitation issued. The email provider accepted the email; delivery is not confirmed. Earlier invitation links for this address were retired."
- ES: "Nueva invitación emitida. El proveedor de correo aceptó el correo; la entrega no está confirmada. Los enlaces de invitación anteriores para esta dirección quedaron retirados."

**`resendInvitationRejected`** — replaces "The previous link no longer works", which is now false.
- EN: "The invitation email was not sent: the email provider rejected it. The new link was withdrawn; earlier invitation links were not changed by this resend."
- ES: "El correo de invitación no se envió: el proveedor de correo lo rechazó. El nuevo enlace se retiró; este reenvío no modificó los enlaces de invitación anteriores."

**`resendInvitationNotConfigured`** — likewise.
- EN: "The invitation email was not sent: email sending is not configured. The new link was withdrawn; earlier invitation links were not changed by this resend."
- ES: "El correo de invitación no se envió: el envío de correo no está configurado. El nuevo enlace se retiró; este reenvío no modificó los enlaces de invitación anteriores."

**`resendInvitationUnknown`** — likewise.
- EN: "New invitation issued, but sending the email could not be confirmed. Earlier invitation links were not changed by this resend; the first invitation accepted ends the others."
- ES: "Nueva invitación emitida, pero no se pudo confirmar el envío del correo. Este reenvío no modificó los enlaces de invitación anteriores; la primera invitación aceptada anula las demás."

**`resendInvitationAcceptedMeanwhile`** — new.
- EN: "An invitation for this address was accepted while this one was being sent, so the new link does not work. No further invitation is needed."
- ES: "Se aceptó una invitación para esta dirección mientras se enviaba esta, por lo que el nuevo enlace no funciona. No hace falta otra invitación."

**`resendInvitationSettleFailed`** — new. It is paired with the email outcome: the action returns both, and the button renders the outcome sentence plus this one.
- EN: "Earlier invitation links may not have been retired. They end when any invitation is accepted, or with the next resend."
- ES: "Es posible que los enlaces de invitación anteriores no se hayan retirado. Se anulan cuando se acepte cualquier invitación o con el próximo reenvío."

**`resendInvitationNotIssued`**
- EN: "No new invitation was issued: an invitation for this address has already been accepted."
- ES: "No se emitió una nueva invitación: ya se aceptó una invitación para esta dirección."

**`resendInvitationLegacyUnresolved`** — new.
- EN: "No new invitation was issued. An earlier invitation to this address is recorded as used under the previous rules, and it cannot be told whether it was accepted or replaced. A platform operator must resolve it."
- ES: "No se emitió una nueva invitación. Una invitación anterior a esta dirección figura como usada según las reglas anteriores, y no se puede saber si se aceptó o se reemplazó. Un operador de la plataforma debe resolverlo."

**Copy reviewed and left unchanged:**

| Copy | Why it stays |
|---|---|
| `auth.acceptInvitation.invalidToken`, "This invitation link is invalid or has expired." | Still true for revoked, consumed and expired links, and shared with the staff flow. |
| Staff-page invitation copy (`revoke.confirm`, `invitationLink.note`, …) | The staff flow is unchanged. |
| Pending-queue approve and manual creation | Neither shows any email copy. On a first issuance there are no earlier links, so nothing there becomes false. Showing the email outcome on those screens would be new UI, so it is **not** added. |

**CLI wording** (`scripts/approve-organization.ts`), English only as today. One line per result:

- *accepted*: "Invitation email accepted by the provider (delivery not confirmed). Earlier links retired."
- *rejected / not_configured*: "Invitation email NOT sent (\<outcome\>). Share the link above manually; it stays valid. Earlier links not changed."
- *unknown*: "Invitation email could not be confirmed. Link above is valid; earlier links not changed."
- *acceptedMeanwhile*: "An invitation was accepted meanwhile; the link above does not work."
- *settle failed*: appends "Earlier links may not have been retired."
- *alreadyAccepted*: "Owner already accepted an invitation — none issued."
- *legacyUnresolved*: "Earlier invitation recorded as used under the previous rules (accepted or replaced: unknown). None issued; run scripts/report-legacy-invitations.ts and resolve separately."

The current text "see logged error above" is removed: the log is neutral now.

## 5. Concurrency — every race is serialized by the one lock

The valid final states are listed per race. A test asserts the state is in that set; no race requires the acceptance to succeed.

| Race | Ordering | Final state (valid) |
|---|---|---|
| **S1** accepted-settle vs acceptance of old link O | **Acceptance wins** | O: `usedAt`, `acceptedAt`. N: `revokedAt` (sibling revoke). Settle's update skips O (`usedAt` set). Its re-read sees N revoked → `acceptedMeanwhile`. |
| | **Settle wins** | O: `revokedAt`. N: live. The later acceptance of O passes the stale pre-check, takes the lock, its consume matches 0 rows → `invalidToken`. Nothing is accepted. The owner can use N (if delivered) or request another resend (D1 fixed). |
| | **Stale pre-check** (acceptance read O before settlement committed, consumes after) | Identical to "settle wins": the consume under the lock re-checks `revokedAt` → `invalidToken`. |
| **S2** rejected-settle (revoke N) vs acceptance of N (possible only if N's link escaped, e.g. the CLI; the platform never shows it) | Acceptance wins | N: accepted. Siblings revoked. Settle's update skips N → `acceptedMeanwhile`. |
| | Settle wins | N: revoked. The acceptance of N → `invalidToken`. Old: unchanged. |
| **R1** two resends A, B (B issued after A) | A's provider response delayed past B's settle | B's `previousIds` contains A's N, so B's settle revokes A's N. A's delayed settle revokes only A's own `previousIds` → **B's N stays live**. A's re-read finds A's N revoked with no `acceptedAt` anywhere → A's result is `supersededMeanwhile` (note below). |
| **R3** issue vs acceptance | Acceptance first | Issue sees `acceptedAt` → `alreadyAccepted`. Nothing is sent. |
| | Issue first | N is committed before the acceptance's sibling revoke → N is revoked by the acceptance. |
| **R4** two acceptances of two live links | Either | Exactly one consumes. The other → `invalidToken`. One membership; the password is set once. |
| **R5** staff mutation vs platform resend | Either | Serialized by the same lock. |
| **E1** expiry while waiting for the lock | — | The consume's `expiresAt > now` (now taken after the lock) fails → `invalidToken`. Nothing is written. |

**Note on R1.** When this resend's own N has been superseded by a newer resend, the re-read finds N `revoked` with no acceptance. The result is `supersededByNewer`. It needs one more message key:
- EN `resendInvitationSupersededMeanwhile`: "A newer invitation was issued while this one was being sent, so this link does not work. The newer invitation's result is shown where it was sent."
- ES: "Se emitió una invitación más reciente mientras se enviaba esta, por lo que este enlace no funciona. El resultado de la invitación más reciente se muestra donde se envió."

This only happens when two operators resend at once.

## 6. Migration, rollback and existing rows

### 6.1 Migration

The migration is one additive statement, `ALTER TABLE "Invitation" ADD COLUMN "acceptedAt" TIMESTAMP(3);`.

- There is no default, no backfill and no data rewrite.
- It is applied to isolated test DBs only during implementation.
- Applying it to normal-dev or production is a separate, explicitly authorized step.

**Order:** migrate first, then deploy the application. The old application runs unchanged against the migrated schema: its Prisma client neither selects nor writes the unknown nullable column.

### 6.2 Recovery: forward-fix by default (revision 3)

"Drop the column" is **withdrawn**. Dropping it would destroy the only authoritative acceptance evidence recorded since deployment, and would make those rows ambiguous again.

**Redeploying the previous build is NOT a safe operational rollback**, even though its queries tolerate the extra column (§6.1). Query compatibility is not lifecycle safety. The previous build:

- **has no sibling revocation.** After an unknown or failed settlement, several links to one address can be live; under the old build, accepting one leaves the others live;
- **takes no organization lock** at acceptance or issuance, so the resend/acceptance race (R3) returns;
- **has no fresh-time expiry check** in the consume;
- **reintroduces D1 and D2**, and marks supersession with `usedAt` again, creating new ambiguous legacy-used rows.

**Default recovery is forward-fix:** correct the defect in a new build and deploy that. The `acceptedAt` column and every value in it stay untouched.

**Any return to the old invitation logic** requires all of the following, and is not something this PR authorizes:

1. invitation mutations stopped first — platform approve/resend, manual creation, CLI approval, staff invite/resend/revoke, and acceptance;
2. a separately reviewed recovery procedure covering the rows written in the window;
3. the column and its acceptance evidence kept intact.

No automatic data rewriting and no deployment work are part of this plan.

What running the old logic does to the data, if it ever happens:

| Effect of running the old application again | Data effect | On roll-forward |
|---|---|---|
| D1 and D2 return for its duration. | Its supersession sets `usedAt`, without `acceptedAt`. Its `where usedAt IS NULL` also reaches rows the new code revoked; those get `usedAt` too and become "used + revoked", which is dead and never counted as accepted. | Superseded rows look **legacy-used** → that organization is blocked with `legacyUnresolved`. This is safe: blocked, not falsely accepted. |
| Its acceptances set `usedAt` without `acceptedAt`. | Genuine acceptances in the window are recorded as **legacy-used**. | The same safe block. Evidence from *before* the window is preserved, untouched. |
| Its acceptance has no lock, no fresh expiry check and no sibling revocation. | Several live links to one address can each remain live after one is accepted. | Not repaired automatically; part of the reviewed recovery procedure. |

**Operator records:** the window's start and end timestamps, so the diagnostic (§6.3) can label rows created in it.

**Not part of any recovery:**

- dropping or rewriting the column;
- clearing lifecycle fields;
- any historical reclassification.

Each of those would be a separately authorized, destructive operation and is not proposed.

### 6.3 Existing (and rollback-window) rows

| State | Class | Treatment |
|---|---|---|
| `usedAt` null, `revokedAt` null | live or expired | unchanged |
| `revokedAt` set (with or without `usedAt`) | dead, never accepted | unchanged |
| `usedAt` set, `acceptedAt` null, `revokedAt` null | **legacy-used: accepted or superseded, unknown** | **left exactly as is** |

**Decided default:** a legacy-used row for the organization and email **blocks resend** with `legacyUnresolved`.

- Its link stays dead (`usedAt` is set).
- Any *other* still-live invitation for that organization keeps working and can be accepted. That acceptance then sets `acceptedAt` normally.
- **Affected existing organizations stay blocked from resend until each one is individually resolved** by a separately authorized repair. This PR contains no repair.

**Read-only diagnostic: `scripts/report-legacy-invitations.ts` (`reportOwnerResendBlockers`).** Revision 3: it reports
**exactly the organizations whose owner resend is blocked**, using the application's own predicates (`sameRecipient`,
`LEGACY_USED`, `ACCEPTED` exported from `approve-organization.ts`): a PENDING or ACTIVE organization with a contact
address, a legacy-used invitation to that **exact** address, and **no** genuinely accepted invitation to it (acceptance
takes precedence). Legacy rows for any other address — a staff invitation, a case-variant account — do not block the
owner resend and are not reported. (Revision 2 inventoried every legacy-used row in an organization, which overstated
the blockers.)

- It opens a **read-only** transaction (`SET TRANSACTION READ ONLY`) and issues SELECTs only.
- It prints organization ids and counts only: no addresses, tokens or links.
- Per blocked organization it prints, for the owner's contact address:
  - the number of legacy-used rows;
  - how many live invitations still exist;
  - the earliest and latest `usedAt` (to compare against recorded rollback windows);
  - a **successor observation**: whether a later sibling row (same organization and email) was created within N seconds of the row's `usedAt`.

The successor observation is labelled in the output as *"observation only — consistent with supersession, also consistent with an acceptance racing a resend (race R3 under the old code); proves neither"*. The script never classifies a row as accepted or superseded and never suggests a repair automatically.

## 7. Exact file scope

| File | Change |
|---|---|
| `prisma/schema.prisma` | add `acceptedAt`; correct the `usedAt` / `revokedAt` comments |
| `prisma/migrations/<ts>_invitation_accepted_at/migration.sql` | additive column only |
| `src/lib/staff/staff-service.ts` | `export` `lockOrganizationStaff`, with no behaviour change |
| `src/lib/organizations/approve-organization.ts` | issue tx → send → settle tx (§3.2–3.3); `keepLinkOnFailedSend` option. Result: `invitationIssue: "issued" \| "alreadyAccepted" \| "legacyUnresolved"`, `invitationEmailOutcome`, `settled: "ok" \| "acceptedMeanwhile" \| "supersededMeanwhile" \| "failed"` |
| `src/app/[locale]/accept-invitation/actions.ts` | lock, fresh `now`, expiry in the consume, `acceptedAt`, sibling revoke |
| `src/app/[locale]/platform/organizations/actions.ts` | map the result to `invitationEmail` + `invitationSettle` |
| `src/app/[locale]/platform/organizations/[id]/resend-invitation-button.tsx` | new keys; the settle-failed suffix; corrected comment |
| `messages/en.json`, `messages/es.json` | rewrite `confirmResendInvitation`, `resendInvitationAccepted`, `…Rejected`, `…NotConfigured`, `…Unknown`, `…NotIssued`; add `…AcceptedMeanwhile`, `…SupersededMeanwhile`, `…SettleFailed`, `…LegacyUnresolved` |
| `scripts/approve-organization.ts` | pass `keepLinkOnFailedSend: true`; per-result wording (§4) |
| `scripts/report-legacy-invitations.ts` | new, read-only (§6.3) |
| `tests/integration/invitation-lifecycle.test.ts` | new (§8) |
| `tests/integration/platform-resend-invitation.test.ts` | adjust `expectTokenRotated` (old link revoked only on accepted); replace the `notIssued` lifecycle test (repeated resends now succeed) |
| `tests/unit/resend-invitation-button.test.tsx` | new keys, the suffix, EN and ES |
| `design/matroom/verification/invitation-lifecycle/README.md` (+ screenshots) | evidence, with mocked evidence labelled as mocked. The #136 evidence folder is left untouched. |

**Not touched:**

- `describeInvitation`, `listStaff`, staff invite/resend/revoke logic;
- `createOrganizationManually`, the pending-row UI;
- `sendTransactionalEmail`;
- permissions and organization scoping;
- the #136 verification README (historical evidence).

## 8. Focused tests

All tests run against the isolated test DB on 5433, with the real Resend SDK and `fetch` stubbed. No real email.

**Determinism tools:**

- **Deferred `fetch`.** A promise the test resolves, so the test controls when each provider response returns and therefore when settlement runs.
- **Held-lock fixture.** A separate test transaction takes `pg_advisory_xact_lock(hashtext(orgId))`. The test polls `pg_locks` (`locktype = 'advisory' AND NOT granted`) until the operation under test is **observed waiting**, makes its change, then commits. This yields exact orderings without sleeps.
- **Fake `Date` only** (`vi.useFakeTimers({ toFake: ["Date"] })`) for expiry. Postgres I/O stays real.

**Lifecycle**

1. accepted → old revoked, N live, `acceptedAt` null everywhere.
2. Five consecutive accepted resends all issue (**D1**). Exactly one live row remains.
3. rejected → N revoked, old **still live and acceptable** (**D2**).
4. not_configured → the same, with no request made.
5. CLI path (`keepLinkOnFailedSend`) rejected and not_configured → N live, old unchanged. Accepting N revokes old.
6. unknown (5xx, unparseable, network) → N and old both live. Accepting either revokes the other; the other → `invalidToken`.
7. Accepting N → `usedAt` = `acceptedAt`. The next resend → `alreadyAccepted`, with no request.
8. An expired, unaccepted invitation never blocks a resend.
9. Legacy-used fixture → `legacyUnresolved`, nothing issued or sent, the row byte-identical. A separate live invitation is still acceptable, and it records `acceptedAt`.
10. A "used + revoked" fixture is not treated as accepted or as legacy → the resend issues.

**Ordering — deterministic**

11. **S1 acceptance wins:** hold the provider response; accept O; release → O accepted, N revoked, result `acceptedMeanwhile`.
12. **S1 settle wins:** release the response and await the action; then accept O → `invalidToken`. O revoked, N live, no `acceptedAt` anywhere.
13. **S1 stale pre-check:** hold the lock; start accepting O; wait until it is observed waiting; in the held transaction apply settlement's revoke of O; commit → `invalidToken`, nothing accepted, no partial writes (user, membership and audit unchanged).
14. **S2 both orderings** (CLI-escaped N vs rejected settle, with the platform option on) → the states listed in §5.
15. **R1:** A and B issued; A's response held; B accepted and settled; release A → B's N **live**; A's result `supersededMeanwhile`; A's N revoked.
16. **R3 both orderings** via the held lock → `alreadyAccepted` with nothing sent, or N revoked by the acceptance.
17. **R4:** two links accepted in parallel → exactly one success. The other gets `invalidToken`. One membership.
18. **E1 expiry while waiting:** link expiring at T+1s; hold the lock; start the acceptance (its pre-check passes); observe it waiting; advance the fake Date past T+1s; release → `invalidToken`, nothing written.
19. **Pre-check is an optimization only:** with the pre-check bypassed (the mutation in 25), test 18 still passes.

**Failure injection**

20. Email accepted, then the settle transaction throws (spy, once) → result `accepted` + `failed`, the neutral log has no secrets, both links live. The next resend's settle revokes both.
21. The issue transaction throws → no fetch, no rows changed.
22. A crash between issue and settle (simulated by never resolving the response and asserting the rows) → N and old both live; acceptance of either revokes the other.

**Preservation**

23. Authorization: non-super-admin and anonymous → `notFound`, nothing issued. Organization scope: another organization's rows are untouched by settle and by the sibling revoke.
24. Existing suites unchanged and green: `staff-management`, `staff-promotion`, `staff-utility-actions`, `accept-invitation-existing-account`, `describe-invitation`, `organization-approval`, `approved-owner-scope`. Plus a no-secret console check (address, link, `token=`, provider text) on every new test, reusing `expectNothingEscaped`.
25. Mutation checks, each of which must fail at least one test:
    - remove the lock from settle;
    - remove the lock from acceptance;
    - drop `expiresAt > now` from the consume;
    - compute `now` before the lock;
    - revoke by timestamp instead of `previousIds`;
    - supersede before the send;
    - remove the sibling revoke;
    - drop `usedAt IS NULL` from settle;
    - treat legacy-used as accepted silently;
    - make the diagnostic write.
26. **Diagnostic:** the row snapshot before and after a run is identical; the output contains no addresses or tokens; the successor observation is printed with its "proves neither" label.

**Rendered check:** a local fake provider via `RESEND_BASE_URL` (as in #136), EN and ES, covering:

- the confirm dialog text;
- accepted;
- rejected;
- unknown;
- legacy;
- settle-failed (forced by the spy).

All are labelled as mocked provider responses.

## 9. Separately tracked (not in this PR)

- **Staff resend delivery (D2 equivalent).** `resendStaffInvitation` (`staff-service.ts:253`) revokes before `deliverInvitation` knows the outcome. The same issue → send → settle model applies. Separate PR.
- **Staff invitation email log sanitization.** This is **not a one-line fix**. Two sources leak provider free text, which can carry the recipient:
  1. `deliverInvitation` logs `error: result.error` (`staff-service.ts:161`);
  2. the Resend SDK itself, in non-production environments, logs `console.error("[Resend API Error]:", …)` (see `send-transactional-email.ts:96-108`). It is suppressed only when the caller passes `suppressProviderErrorLogging`.

  The fix needs both: pass the option, and log outcome plus allowlisted `providerCode` only. It also needs the outcome classification wired into the staff UI result and tests modelled on #136's no-secret checks. Separate PR, recommended soon.
- **Email case sensitivity.** Revision 3: every lifecycle match uses the exact stored address. Unchanged: stored emails, account lookup, and the staff flow's own case-insensitive checks (`inviteStaffMember`'s existing-account lookup and `alreadyInvited` guard) — those only refuse or pick an account; they never revoke, settle or block another recipient's invitation. A broader identity redesign (normalizing addresses, merging case-variant accounts) is out of scope.
- **Approval screens show no email outcome.** The pending-queue approve and manual creation do not surface the first invitation's email outcome. This is an existing gap; new UI, separate decision.

## 10. Estimate

About **2.5–3 days** of focused work, as one PR. Up from 1.5–2 days: the settle transaction, the fresh-time expiry check, the expanded copy and the deterministic lock-ordering harness.

| Part | Effort |
|---|---|
| Schema and migration | 0.5 h |
| Issue, send and settle rework | 4 h |
| Acceptance changes | 1.5 h |
| Action, button and EN/ES copy (10 keys) | 2.5 h |
| CLI | 1 h |
| Diagnostic | 1.5 h |
| Tests, including the held-lock harness, deterministic orderings and mutations | 8–9 h |
| Rendered check and README | 2.5 h |

The held-lock fixture is the main risk to the estimate. If `pg_locks` observation proves flaky on CI, the fallback is a test-only hook between the pre-check and the lock. That needs explicit approval, because it adds a seam to production code.

## 11. Decisions (resolved by review)

- **CLI manual-link fallback: preserved.** On a rejected or unconfigured send, the CLI keeps N live and prints it; earlier links are not changed. Platform callers withdraw N.
- **Legacy-used rows: unchanged and blocked.** A distinct `legacyUnresolved` explanation is shown, and the read-only diagnostic is provided. Any historical repair stays separately authorized, per organization.

No open product questions remain.
