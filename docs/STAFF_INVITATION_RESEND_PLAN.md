# Staff invitation resend lifecycle repair plan

Status: **revision 2 — D1–D4 approved, implemented** (see "Implementation notes"). Base: main
`e5b96cdd82f414331ae3690ce39a790b52ea4fa2`.

Goal: a staff resend must not invalidate the previous invitation before the new email's outcome is known.

The owner lifecycle repair (PR #137, `docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md`) is the model. Its mechanism carries
over: issue → send → settle, the shared organization lock, and the exact-address recipient rule. Its failed-send policy
and its acceptance evidence do not carry over (see §2.3 and §1.3.4).

### Revision 2 — corrections

1. **Acceptance evidence.** Timestamp equality is removed as proof of cause. `acceptedMeanwhile` now rests only on the
   new invitation's own `acceptedAt`. A new invitation that was revoked or expired is reported with neutral
   `unavailable` wording. No schema change, and no change to acceptance.
2. **Truthful copy.** Messages describe what *this operation* did ("This resend did not invalidate earlier links"),
   never whether other links still work. Settlement failure is worded as *unknown* availability, not usability. Every
   availability statement is labelled as a snapshot.
3. **Expired links in the panel.** Usability comes from the existing `expired` / `expiresAt` that `listStaff` already
   returns, not from pending ids alone. A refresh hides an expired link as well as an accepted, revoked or replaced one.

D1–D4 are marked as recommendations awaiting approval. Academy matching is defined as order-independent.

### Implementation notes (D1–D4 approved; implemented in the staff-resend PR)

Where the implementation departs from, or adds to, the text below:

1. **D2 also covers the owner's invitations shown on the staff page.** The owner's links from approval (role ADMIN, no
   academies, the contact address) are listed on the staff page and share one offer key. A co-owner's Revoke of
   either one therefore withdraws both. PR #137's two "concurrent staff revocation" tests encoded per-row revoke; they
   now assert the approved behavior: `unavailable`, and nothing revived. A third test keeps owner settlement's own
   guarantee (it skips a row retired by something else, without rewriting its `revokedAt`) by retiring that row
   directly. Owner issue, settle and acceptance code is unchanged.
2. **Refresh re-check timing (found in the real browser).** A resend's result can render *before* the page refresh
   that lists the new invitation: the action's state update lands outside the refresh's transition. Absence from the
   list current when the result arrived therefore proves nothing. The panel re-checks only once a newer list arrives
   (a real refresh); until then, settlement's own check stands. There is still no polling and no new query.
3. **`usableInvitationIds`** — a pure helper added to `list-staff.ts` (pending AND not expired), used by the page. The
   `listStaff` query is unchanged.
4. **Copy.**
   - `link.unverified` no longer says "This resend did not invalidate earlier links". The panel's separate
     effect line says it, and only for a resend, because a first invite has no earlier links.
   - `link.resend.retired` reads "The earlier links this resend replaced no longer work". This stays true even when a
     concurrent settlement had already retired them.
5. **PR #138's logging test** asserted the old pre-send revoke on an `unknown` resend. It now asserts that the earlier
   link stays live (D1). Its logging assertions are unchanged.

---

## 1. What the code does today (traced)

### 1.1 Paths

| Step | Where | What happens |
|---|---|---|
| Invite | `inviteStaff` (`staff-actions.ts`, Owner-only via `resolveActionContext(…, ["ADMIN"])`) → `inviteStaffMember` (`staff-service.ts:176`) | One transaction under `lockOrganizationStaff`. It: resolves academies (deduplicated and sorted); looks up an existing account **case-insensitively** and stores **that account's exact casing** (else the lower-cased input); refuses `alreadyMember` / `alreadyMemberInactive` (an active student is promotable); refuses `alreadyInvited` if a live, unexpired invitation exists (case-insensitive); creates the invitation (role, `academyIds`, 7-day TTL) plus a `staff.invite` audit row. Then, outside the transaction, `deliverInvitation` sends. |
| Resend | `resendInvitation` → `resendStaffInvitation` (`staff-service.ts:246`) | One transaction under the lock. It refuses `notFound` / `notPending` (used, revoked, or non-staff role); an **expired** invitation may be resent. **It revokes the previous invitation immediately**, then creates a replacement (same exact email, role and `academyIds`) plus a `staff.invitationResend` audit row. Then it sends. ← **the defect** |
| Revoke | `revokeInvitation` → `revokeStaffInvitation` (`staff-service.ts:287`) | Under the lock: refuses used or revoked; sets `revokedAt` on **that one row**; writes a `staff.invitationRevoke` audit row. |
| Send | `deliverInvitation` (`staff-service.ts:136`) | Builds the link in the organization's locale and calls `sendTransactionalEmail(…, { suppressProviderErrorLogging: true })`. Logs `"[staff] invitation email outcome"` with `{ organizationId, outcome, providerCode }` (PR #138). Returns `{ invitationLink, emailSent: result.success }`. |
| Accept | `acceptInvitation` (`accept-invitation/actions.ts`) | Pre-read; re-validates academies. Under the lock with fresh `now`, it consumes conditionally (`usedAt/revokedAt null, expiresAt > now`) and sets `usedAt = acceptedAt = now`. It revokes every other live invitation to the **exact same address** in the organization. It finds the account by **exact** email, and creates or promotes the membership and assignments. |
| List | `listStaff` (`list-staff.ts`) | "Pending" = `usedAt null, revokedAt null`, staff roles (ADMIN included). **Expired invitations are deliberately included**, flagged `expired: expiresAt <= now` at render, with `expiresAt`, so they can be resent or revoked. |

### 1.2 UI (`admin/staff/page.tsx`, `staff-forms.tsx`)

- `InviteForm` and `InvitationRowActions` put the returned link into **one** page-level `LatestInvitationLink` panel
  (`StaffLinkProvider`).
- The panel always shows the link to copy. Its headline comes from `emailSent` (`staff-forms.tsx:141`):
  - EN *"We emailed the link."* / ES *"Enviamos el enlace por correo."*;
  - EN *"The email couldn't be sent. Copy the link below and send it yourself."* (ES equivalent).
- Note: *"Shown now only. If you lose it, resend the invitation to get a new one."*
- The revoke confirm says *"Revoke this invitation? The link stops working."*
- `emailSent` is read only in `staff-forms.tsx`.

### 1.3 Problems found

1. **Pre-send invalidation (the target).** The previous link dies before the new email's outcome is known. On
   `rejected`, `not_configured` or `unknown`, the invitee may be left with only a dead link in their inbox.
2. **Copy overclaims.**
   - *"We emailed the link"* is shown for provider acceptance, which is not delivery.
   - *"The email couldn't be sent"* is shown for `unknown`, when the email may well have been sent.
3. **The panel can go stale.** It keeps showing a link after that invitation was accepted, revoked, replaced or
   **expired**. Nothing re-checks it after the page refreshes.
4. **Owner evidence does not transfer.** PR #137's settlement treats *any* accepted row for the address as "accepted
   meanwhile". That is sound for owners only because owner issuance refuses once an acceptance exists. Staff issuance
   has no such precondition: someone made student-only, or deactivated and later re-invited, can have an old
   `acceptedAt` row for the same address.

---

## 2. Design

### 2.1 Terms

- **Offer key** of an invitation: `(organizationId, exact email, role, set of academyIds)`.
  - **Academy matching is order-independent**: two invitations match when their academy-id *sets* are equal
    (duplicates ignored), compared on sorted, deduplicated copies.
  - The key is used **only to find** matching rows. A replacement still **copies the resent invitation's `role` and
    `academyIds` exactly as stored**; nothing is re-sorted, merged or rewritten.
- **Live**: `usedAt IS NULL AND revokedAt IS NULL`. **Usable at time t**: live and `expiresAt > t`.

The exact address only, never normalized. It matches how acceptance finds the account (`findUnique({ email })`)
and the sibling revocation (`sameRecipient`). The case-insensitive `alreadyInvited` / account lookup at invite stays
exactly as it is.

### 2.2 Issue → send → settle (resend)

1. **Issue.** One transaction; `lockOrganizationStaff` is the first statement.
   - Same refusals as today (`notFound`, `notPending`).
   - **Do not revoke the previous invitation.**
   - Capture `previousIds`: the resent invitation plus every live invitation with the same offer key (recommendation
     D3), as a snapshot of ids.
   - Create replacement `N`.
   - Write the `staff.invitationResend` audit row (`before: { invitationId, previousIds }`).
   - Commit.
2. **Send.** `sendTransactionalEmail` with no transaction open; sanitized logging is unchanged.
3. **Settle.** A new transaction; lock first; fresh `now` after the lock. Read `N`.
   - **a. `N.acceptedAt` is set** → `acceptedMeanwhile`; write nothing. This is direct evidence: `N` itself was
     accepted.
   - **b. `N` is not usable at `now`** (revoked, or expired; consumed without `acceptedAt` cannot happen for a new row)
     → `unavailable`; write nothing. **No cause is claimed.** A sibling's acceptance, an explicit revocation or expiry
     all look the same here, and no existing data proves which one it was without inferring it from timestamps. Earlier
     links are untouched: retiring them for an unusable `N` could leave the invitee nothing.
   - **c.** Otherwise `N` was usable at `now`; act by outcome:
     - `accepted` → revoke the rows in `previousIds` that are still live (`id IN previousIds AND usedAt IS NULL AND
       revokedAt IS NULL`); write a `staff.invitationSuperseded` audit row → `settled`.
     - `rejected`, `not_configured`, `unknown` → write nothing → `settled`. This resend leaves earlier links exactly
       as they were. Whichever link is accepted first retires the rest (existing acceptance rule). See §2.3.
4. **If settle throws** → `failed`. Log `"[staff] invitation settle failed", { organizationId, outcome }` with no error
   text. The settle transaction rolled back, so this resend invalidated nothing. **Whether `N` is usable is unknown** —
   it was not checked.

A **first invite** uses the same send + settle with `previousIds = []`. Settle then only records whether `N` was usable
at settle time (`settled` / `acceptedMeanwhile` / `unavailable` / `failed`).

**Snapshot, not guarantee.** `settled` means "`N` was usable when settlement read it". It can be revoked, accepted or
expire a moment later. The UI says so (§3); refresh-time re-checks are covered in §3.3.

### 2.3 Outcomes: manual link and previous links

| Email outcome | Effect of this resend on earlier links | `N` | Link in panel |
|---|---|---|---|
| `accepted` (provider took it — **not** delivery) | the captured, still-live ones are retired | usable at settle | shown |
| `rejected` | **none** | usable at settle | shown — the manual link is the delivery channel |
| `not_configured` | **none** | usable at settle | shown — in an environment without email the manual link is the *only* channel |
| `unknown` | none | usable at settle | shown |
| any + `acceptedMeanwhile` | none | accepted (consumed) | **not shown** |
| any + `unavailable` | none | not usable at settle | **not shown** |
| any + settle `failed` | none (transaction rolled back) | **unknown** | shown **with a warning that it is unverified** — never presented as working |

"None" means this resend changed nothing. Earlier links may still be unusable for their own reasons: expiry, an
explicit revocation, a sibling's acceptance, or a concurrent resend's settlement.

**Why not copy the owner platform policy** (revoke `N` on `rejected` / `not_configured`)? The owner page has no
manual link, so a rejected `N` reached nobody. The staff page **hands `N` to the Owner** for exactly this case.
Revoking `N` would make the copied link dead.

Not invalidating earlier links on a failed send follows the CLI's `keepLinkOnFailedSend` reasoning: an earlier email
may be the one in the invitee's inbox, and the Owner may never forward `N`. Two live links carry the identical offer to
the same exact address, and the first acceptance retires the other. That adds no access beyond what today's single link
grants.

### 2.4 Explicit revocation (recommendation D2 — awaiting approval)

**If D2 is approved**, `revokeStaffInvitation(id)` revokes **every live invitation with the same offer key**
(order-independent academy match), not just the clicked row, in one transaction under the lock. It writes one
`staff.invitationRevoke` audit row listing the ids. Effects:

- A revoke that commits **before** a resend's issue makes the resend `notPending`: no send.
- A revoke that commits **after** issue but before settle also revokes `N`. Settle then sees `N` not usable →
  `unavailable` (neutral). It never revives anything: settle only ever sets `revokedAt`, and only on live rows.
- After an `unknown` or failed resend, either list row withdraws the whole offer. The confirm copy says so.

**If D2 is not approved** (per-row revoke, as today): the first bullet still holds. A revoke of `P` after issue leaves
`N` live, and settle proceeds normally. The Owner must also revoke `N`'s row.

Either way, a different-scope live invitation to the same address is left alone, and acceptance still retires all
exact-address siblings, as today.

### 2.5 Orderings (all serialize on the one organization lock)

| Ordering | Settlement | State after |
|---|---|---|
| Accept previous `P` while `N`'s email is in flight | `unavailable` (neutral: `N` was revoked; the cause is not claimed) | `P` accepted; `N` revoked by the existing sibling rule; no link shown |
| Accept `N` (fast click) before settle | `acceptedMeanwhile` (`N.acceptedAt`) | earlier links already retired by that acceptance |
| Accept a **different-scope** `Y` to the same address | `unavailable` (neutral) | `N` revoked by the sibling rule |
| Revoke before issue | resend → `notPending`; no send | unchanged |
| Revoke after issue, before settle | with D2: `unavailable`, nothing revived. Without D2: normal settle. | as §2.4 |
| `N` expires before settle | `unavailable` (fake-clock test) | no writes |
| Two resends R1, R2 of the same offer, R1 issued first | R2's snapshot includes `N1`; R1's does not include `N2`. If R2 settles `accepted` first, `P` and `N1` are retired, and R1 later sees `N1` unusable → `unavailable` (no writes). If R1 settles `accepted` first, it retires `P` only; `N2` is untouched, and R2 later retires `N1`. | **A late settle never touches an invitation issued after its own.** |
| Resend vs. edit or deactivate of the **membership** | unchanged | an invitation grants nothing until accepted; acceptance's existing rules apply |

### 2.6 What is preserved

- **Scope.** Role and `academyIds` are copied verbatim. Acceptance still re-validates academies (an academy removed
  meanwhile → `invalidToken`), creates or promotes the membership, and syncs assignments.
- **Authorization.** `assertOwner` plus `resolveActionContext(…, ["ADMIN"])` before issue. The settle helper stays
  module-private in `staff-service.ts`, which is not a `"use server"` file, so it is never callable directly. Settle
  grants nothing; it only retires captured links of the same offer.
  `tests/unit/staff-actions-are-owner-only.test.ts` still applies.
- **Expiry.** An expired invitation can still be resent. Acceptance re-checks expiry under the lock. Settle treats an
  expired `N` as not usable, and the panel hides expired links on refresh (§3.3).
- **Logging.** Only the existing fixed outcome line plus one fixed settle-failure line: no addresses, links, tokens or
  error text.
- **Audit.** Every staff mutation still writes its audit row in the same transaction. Audit rows are written, never read
  as state.
- **Unchanged files.** Acceptance, `listStaff` and the schema.

---

## 3. Return value and UI copy

### 3.1 Action result

`InvitationDelivery` gains `invitationId`, `expiresAt`, `emailOutcome: EmailSendOutcome` and
`settlement: "settled" | "acceptedMeanwhile" | "unavailable" | "failed"`.

- `invitationLink` is present when `settlement` is `settled` (`N` was usable at settle) or `failed` (unknown; shown
  only with the unverified warning). It is absent for `acceptedMeanwhile` and `unavailable`.
- `emailSent` is dropped; its only reader is `staff-forms.tsx`, updated in the same PR.

### 3.2 Messages (EN / ES) — draft copy

The panel headline is the email outcome. A second line states what this operation did to links. The link block carries
a snapshot label.

**Email outcome (headline):**

| Key | EN | ES |
|---|---|---|
| `link.outcome.accepted` | The email provider accepted the message. That doesn't confirm delivery. | El proveedor de correo aceptó el mensaje. Eso no confirma la entrega. |
| `link.outcome.rejected` | The email provider refused the message. Copy the link below and send it yourself. | El proveedor de correo rechazó el mensaje. Copia el enlace de abajo y envíalo tú. |
| `link.outcome.notConfigured` | Email sending isn't set up. Copy the link below and send it yourself. | El envío de correos no está configurado. Copia el enlace de abajo y envíalo tú. |
| `link.outcome.unknown` | We couldn't confirm whether the email was sent — it may still arrive. Copy the link below if needed. | No pudimos confirmar si se envió el correo; aún podría llegar. Copia el enlace de abajo si lo necesitas. |

**Effect of this resend on earlier links** (resend only; omitted for a first invite):

| Key | EN | ES |
|---|---|---|
| `link.resend.retired` | This resend withdrew the earlier links it replaced. | Este reenvío retiró los enlaces anteriores que reemplazó. |
| `link.resend.kept` | This resend did not invalidate earlier links. | Este reenvío no invalidó los enlaces anteriores. |

**Link status:**

| Key | EN | ES |
|---|---|---|
| `link.checked` | Usable when checked just now (valid until {expiresAt}). It can still be revoked, used or expire later. | Se podía usar al comprobarlo hace un momento (vence el {expiresAt}). Aún puede revocarse, usarse o vencer después. |
| `link.acceptedMeanwhile` | This new link was accepted while the email was being sent. | Este enlace nuevo se aceptó mientras se enviaba el correo. |
| `link.unavailable` | This new link was no longer usable when we checked after sending (it may have been revoked, replaced, or expired). Check the pending invitations below. | Este enlace nuevo ya no se podía usar al comprobarlo después del envío (puede haberse revocado, reemplazado o vencido). Revisa las invitaciones pendientes abajo. |
| `link.unverified` | We couldn't finish checking this invitation, so we don't know whether this link works. This resend did not invalidate earlier links. Refresh the page before sharing it. | No pudimos terminar de comprobar esta invitación, así que no sabemos si este enlace funciona. Este reenvío no invalidó los enlaces anteriores. Actualiza la página antes de compartirlo. |
| `link.noLongerUsable` | This link is no longer usable — it was accepted, revoked, replaced or has expired. | Este enlace ya no se puede usar: se aceptó, se revocó, se reemplazó o venció. |
| `link.note` | Shown now only. If you lose it, resend the invitation to get a new link. | Solo se muestra ahora. Si lo pierdes, reenvía la invitación para obtener un enlace nuevo. |
| `revoke.confirm` (if D2 is approved) | Revoke this invitation? All of its links stop working. | ¿Revocar esta invitación? Todos sus enlaces dejan de funcionar. |

`link.unavailable` lists possibilities; it does not assert a cause. Success styling is used only for `accepted` +
`settled`. Every other combination uses the warning style.

### 3.3 Refresh re-check, including expiry

- The panel stores `invitationId`.
- `page.tsx` already has each pending row's `id`, `expired` and `expiresAt` from `listStaff`. It passes the panel the
  set of ids that are **pending and not expired** at render — no new query.
- After any refresh, the panel shows its link only if its id is in that set **and** its stored `expiresAt` is still in
  the future at render. Otherwise it hides the link and shows `link.noLongerUsable`. That covers accepted, revoked,
  replaced, **and expired-but-still-listed** invitations.
- **No polling.** Like `listStaff`'s own `expired` flag, the panel is accurate as of the last render, which every staff
  action already triggers by revalidating the page. A link can expire or be revoked between renders; the
  `link.checked` wording says so.

---

## 4. Recommendations awaiting approval

These four are **recommendations, not decisions**. Implementation waits for your answer on each.

- **D1 — failed send (`rejected` / `not_configured`) — RECOMMENDED, awaiting approval.** This resend invalidates no
  link: `N` stays, and earlier links are not touched by it. The manual link is the staff page's delivery channel, so
  revoking `N` (the owner-UI policy) breaks the copy-and-send workflow. Retiring earlier links could strand an invitee
  whose only email is an earlier one.
  Alternative: retire earlier links once the Owner holds `N` — that brings back the original defect whenever the Owner
  doesn't forward it.
- **D2 — Revoke covers the whole offer — RECOMMENDED, awaiting approval. This broadens today's per-row Revoke.**
  Revoking any row withdraws every live link with the same exact address, role and academy set (order-independent).
  It is what makes an explicit revoke authoritative over an in-flight or unknown resend. Cost: one click affects more
  than the row clicked; the confirm copy changes to say so.
  Alternative: keep per-row revoke — then a second Owner revoking during a resend leaves `N` live and emailed, and
  duplicates must be revoked one by one.
- **D3 — what an accepted resend retires — RECOMMENDED, awaiting approval.** The resent invitation plus live links with
  the same offer key, snapshotted at issue. That cleans up leftovers from earlier unknown or failed resends and never
  touches a different-scope offer to the same address.
  Alternative: the resent row only — duplicates then accumulate until acceptance or expiry.
- **D4 — pending list during duplicates — RECOMMENDED, awaiting approval.** No list change. After an unknown or failed
  resend, two rows for the same offer appear. Either can be resent or revoked (with D2 that revokes both), and the
  panel copy explains it.
  Alternative: collapse rows by offer key in `listStaff` — more code, and it can be deferred.

Not open, because they are fixed by the brief: provider calls stay outside transactions; the existing lock is reused;
a late response never revives or retires a newer link; exact-address identity; no email normalization; no schema
change for cause attribution.

---

## 5. Scope, migration, tests

### 5.1 Files (one PR)

- `src/lib/staff/staff-service.ts`:
  - resend issue without pre-revoke, plus the `previousIds` snapshot;
  - private `settleStaffInvitation`;
  - `deliverInvitation` returns outcome + settlement + `expiresAt`;
  - offer-wide `revokeStaffInvitation` if D2 is approved;
  - invite uses the same settle.
- `src/lib/staff/staff-actions.ts`: type passthrough only (`InvitationDelivery`).
- `src/app/[locale]/(staff)/admin/staff/staff-forms.tsx`: outcome / effect / status copy; the panel stores
  `invitationId` + `expiresAt` and receives the set of usable ids.
- `src/app/[locale]/(staff)/admin/staff/page.tsx`: pass the pending, unexpired ids (from the existing `listStaff`
  result) to `LatestInvitationLink`.
- `messages/en.json`, `messages/es.json`: the keys in §3.2. `emailSent` and `emailNotSent` are replaced.
- Tests (below), and a verification README under `design/matroom/verification/staff-invitation-resend/`.

`accept-invitation/actions.ts`, `list-staff.ts`, the schema and the owner lifecycle are **unchanged**.

### 5.2 Migration

**None.** `acceptedAt` already exists (PR #137). Offer keys use existing columns. No backfill. Legacy-used staff rows
are consumed and never live, so they are untouched.

### 5.3 Deterministic tests (isolated test DB only)

Reuse the PR #137 harness: a mocked `sendTransactionalEmail` whose promise is held so tests can interleave; the held
lock is observed via `pg_locks` filtered to the current DB; fake `Date` only; and a Proxy mock of `@/lib/prisma` to
inject a settle-transaction failure.

New file `tests/integration/staff-invitation-resend-lifecycle.test.ts`:

1. **accepted:** `P` is still acceptable while the send is held; after settle `P` is refused, `N` works, and the
   superseded audit row is written.
2. **rejected / not_configured:** this resend invalidates nothing. `P` and `N` stay live, and the link is returned.
   Accepting either retires the other.
3. **unknown:** as 2, in both acceptance orders.
4. **`P` accepted mid-flight:** `unavailable` (**not** `acceptedMeanwhile`), no link, `N` revoked, nothing else
   written by settle.
5. **`N` accepted before settle:** `acceptedMeanwhile`.
6. **Different-scope `Y` accepted mid-flight:** `unavailable`.
7. **Old acceptance before the resend** (person made student-only, then re-invited and resent): settles normally. This
   guards against owner-style "any accepted" evidence (§1.3.4).
8. **Revoke before issue:** `notPending`, no send. **Revoke after issue:** with D2, `N` revoked → `unavailable`,
   nothing revived; without D2, normal settle. Only the approved variant is kept.
9. **Concurrent resends R1/R2, both settle orders:** an older settle never retires a newer `N`.
10. **Different-scope live `Y`:** untouched by settle-accepted and by revoke.
11. **Case-variant distinct account:** untouched by settle and revoke (exact address).
12. **Order-independent academy match:** a live invitation with the same academies stored in a different order is
    captured (D3) and revoked (D2) as the same offer. The replacement's stored `academyIds` equal the resent row's
    exactly, in its original order.
13. **Expired `P` resent:** works. **`N` expired before settle** (fake clock): `unavailable`, no writes.
14. **Settle transaction failure:** `failed`, nothing invalidated, a fixed log line only. The result carries the link
    and `settlement: "failed"`, never `settled`.
15. **Scope preserved:** role and academies copied; academy removed before acceptance → `invalidToken`.

Other test files:

- **Updated:** `staff-management.test.ts` and `staff-promotion.test.ts`. Their mocks return `outcome: "accepted"`, and
  the resend test asserts the old link dies **after** settle.
- **Extended:** `staff-invitation-email-logging.test.ts` — the settle-failure line, with every console argument
  inspected.
- **Unit:** `staff-forms.test.tsx`:
  - each outcome × settlement in EN and ES;
  - resend vs. first-invite effect line;
  - `failed` shows the unverified warning and never the `link.checked` line;
  - no link for `acceptedMeanwhile` / `unavailable`;
  - **refresh re-check:**
    - (a) id no longer pending → hidden;
    - (b) **id still in the pending list but `expired: true`** → hidden with `link.noLongerUsable`;
    - (c) id pending, unexpired → shown.

**Mutations to prove** (each must fail a test; restore byte-identical):

| # | Mutation |
|---|---|
| M1 | pre-send revoke restored |
| M2 | settle without the lock |
| M3 | `previousIds` recomputed at settle instead of snapshotted |
| M4 | acceptance inferred from anything but `N.acceptedAt` — owner-style "any accepted" (test 7), or "a captured / exact-address row was accepted" (tests 4, 6) |
| M5 | `rejected` revokes `N` |
| M6 | settle ignores `N`'s expiry |
| M7 | per-row revoke (only if D2 is approved) |
| M8 | settle writes to non-live rows |
| M9 | link returned when `unavailable` |
| M10 | settle-failure log carries error text |
| M11 | panel re-check uses pending ids only, ignoring `expired` |
| M12 | `failed` rendered with the `link.checked` wording |
| M13 | academy match order-dependent |

### 5.4 Verification limits (to be stated in the PR)

- No real provider; the transport is faked. Provider "accepted" is never verified as delivered.
- A browser check of the staff page on a disposable DB with a labelled local fake provider. No real emails.
- Usability is verified only at snapshots: at settle, and at each page render. Between snapshots a link can be revoked,
  used or expire. There is no live push or polling.
- The cause of an `unavailable` settlement is not determined. This is by design, without a schema change.
- Existing historical rows are not repaired. Legacy consumed rows are never live, so they are unaffected.

### 5.5 Estimate

Roughly 220–270 source lines and 650–750 test lines. One PR, held unmerged for review.

---

## 6. Out of scope (tracked separately)

- Ambiguous historical invitation rows (owner `legacyUnresolved`).
- The email-outcome UI for Approve / New organization.
- Remaining raw-exception logging (dispatch "channel threw", the notification catch-alls, fire-and-forget).
- Launch-verification items.
