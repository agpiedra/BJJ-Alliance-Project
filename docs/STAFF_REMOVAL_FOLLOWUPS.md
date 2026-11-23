# Staff removal: follow-ups tracked separately (2026-11-23)

Found while reviewing "Remove from academy" (branch `feat/staff-remove-from-academy`, worktree `bjj-staff-removal`,
uncommitted). Neither item is part of that change. Each needs its own approval.

## F1. Academy picker after losing the current academy

**Current behaviour, recorded by `tests/integration/staff-remove-session.test.ts`:**
- A person in two academies, whose session currently points at academy A, is removed (or deactivated) there.
- On their next request their session is still valid and still selects A. The page gate re-checks membership, gets
  `NO_MEMBERSHIP` and redirects to `/{locale}/no-organization-access`.
- That page says the account "isn't linked to any organization" and offers only Sign out, although they still belong
  to academy B.
- Signing back in resolves to B (A's remembered choice is cleared by removal; B is their only active membership), and
  B works. Their B membership and assignments are unchanged.

This is not new: Deactivate leads to the same page today (`src/lib/tenant/context.ts` `getTenantContext` →
`resolveContext` for the session's selected academy; `src/lib/tenant/redirect-path.ts`).

**Improvement to design:** when the selected academy no longer grants access but the user has other active memberships,
re-resolve the way sign-in does: one membership → that academy; several → `/select-organization`. Questions to settle:
- Where to do it: in `getTenantContext`, or in the redirect target.
- How the session's selector gets updated.
- That a removed academy can never be re-selected.
- The copy on `/no-organization-access` for people who really have no membership.

## F2. Email addresses are not normalized consistently (pre-existing)

| Path | What it does with the address |
|---|---|
| Public signup (`o/[orgSlug]/signup/actions.ts`) | `z.string().email()`, no trim or lowercase; account looked up and created with the typed casing |
| Academy registration (`register-academy/actions.ts`) | same for `contactEmail`; approval (`approve-organization.ts`) finds or creates the Owner account by that exact address |
| Login (`login/actions.ts`, `verify-credentials.ts`) | exact lookup, so the typed casing must match the stored one |
| Staff invite (`staff-actions.ts` + `inviteStaffMember`) | trims and lowercases, then finds an existing account case-insensitively (`findFirst`) and stores THAT account's casing |
| Invitation acceptance (`accept-invitation/actions.ts`) | exact lookup by the invitation's address; creates a new account if none matches exactly |
| Database | `User_email_key` is a plain unique index, so it is case-sensitive |

**Consequences:**
- Two accounts that differ only in letter case can exist for one mailbox.
- If both exist, the invite's `findFirst` picks one of them arbitrarily.
- A person can be locked out at login by typing a different case.
- For removal specifically, revocation was exact-address, so a surviving case-variant invitation would have created a
  second account with access. **Fixed in the removal branch:** removal now revokes case-insensitively, with a test.

**Not fixed:** normalization itself. That needs a design covering existing mixed-case rows, a case-folded unique index
or `citext`, login lookup, and merging any existing duplicates. It touches every account path.
