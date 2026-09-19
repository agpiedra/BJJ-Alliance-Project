# Running the platform — for Alexis

This is the operator's guide, not an architecture document: what to actually click, type, or
run for the tasks you'll do most. For "why does it work this way," see
`docs/MULTI_ACADEMY_AND_KIDS_BELTS.md`; this doc only covers "what do I do."

Everything under `/platform/**` requires you to be signed in as a platform admin
(`isSuperAdmin`). If you're not sure you have that yet, see "Bootstrap a platform admin" below.

---

## Approve an academy that just registered

1. Sign in and go to `/platform/organizations/pending`. Every organization waiting on you shows
   up here — nothing else does.
2. Each row shows the academy's location, contact, student count, and how they heard about you
   (referral source).
3. Click **Approve**. This immediately:
   - Activates the organization.
   - Creates a default branch (academy) named after the city they gave you.
   - Creates the director's account (an inactive placeholder password — they can't sign in yet).
   - Emails them an invitation link to set their real password.
4. If it's not a fit, click **Reject** instead, type a reason (required — it's an internal
   note, the applicant doesn't see it), and confirm. Rejected organizations don't get an
   account or an invitation.

There is no "undo" on approval from the panel. If you approved by mistake, use **Suspend** (see
below) — it doesn't undo the account creation, but it blocks access immediately.

## Bootstrap a platform admin

**Granting yourself the very first time, or granting anyone else:** see the README's own
"Platform admin bootstrap" section — it has the exact one-time database step for the very
first grant (there is deliberately no button or script for that one), and the normal in-app
steps for every grant after that (`/platform/admins`, enter their email, click **Grant**).

## Suspend a non-paying organization, and reactivate it

Two places do this, same effect either way:

- **From the organizations list** (`/platform/organizations`): find the row, click **Suspend**
  (only shown for an active organization) or **Reactivate** (only shown for a suspended one).
  Suspend asks you to confirm first: *"Suspend this organization? Its members will lose access
  on their next request."* That's literal — the next page load or action any of their staff or
  students attempts is refused, not just new logins.
- **From the organization's own detail page** (click into it from the list): the same
  **Suspend** button lives in the **Danger zone** section at the bottom, alongside **Cancel
  organization** (a harder, more final action — reject an org before it's ever approved, or use
  Cancel only when you mean "this organization is done," not "pause them").

Suspending or cancelling **never deletes anything and never touches billing.** Their invoices,
grace days, and history stay exactly as they were — this is purely an access switch. Billing
state (whether they're behind on payment) and organization status (whether they're active) are
deliberately two separate things; suspending a non-paying org is a manual decision you make
after looking at the billing column on the organizations list, not something the system does
for you.

## Issue or resend an invitation

**Issuing one for the first time** happens automatically the moment you approve an organization
(see above) — you don't do anything extra.

**Resending** — the director lost the email, or the link expired (invitations expire; if
they've had it sitting unused for a while, this is likely why — see the section on running the
approval CLI, since resending an already-active organization is not exposed as a button in the
panel today, only from the command line):

```
pnpm exec tsx scripts/approve-organization.ts --slug=<their-org-slug> --approved-by=<your-email>
```

This is safe to run on an already-active organization — it's the same idempotent approval
logic the panel's own **Approve** button calls. It issues a brand-new invitation link and
invalidates whatever link existed before (so an old, possibly-leaked link stops working the
moment you resend). It does **not** create a second branch, a second director account, or
duplicate anything.

You can find an organization's exact slug on its detail page in the platform panel (it's part
of the URL and shown in the page itself).

## Run the approval CLI when the panel is down

The exact same command as "resend an invitation" above, and it's also how you approve a
brand-new pending organization without the panel:

```
pnpm exec tsx scripts/approve-organization.ts --slug=<org-slug> --approved-by=<your-email>
```

- `--slug` is the organization's slug (from their registration, or from the pending list if you
  can still read the database directly even though the panel itself is down).
- `--approved-by` must be the email of a real, active platform admin — the script refuses to
  run otherwise, exactly like the panel would.
- This calls the identical `approveOrganization()` function the panel's own Approve button
  calls — there is no separate, weaker approval path for the CLI. Anything the panel can do
  here, the CLI does the same way.

## Check whether the weekly digest fired

The digest runs automatically every Monday at 07:00 Costa Rica time (Vercel Cron), and is
**email-only** — it never creates anything you can see inside the app itself. To confirm it
ran:

1. **Vercel's dashboard** — your project's Cron Jobs tab shows every scheduled invocation of
   `/api/cron/weekly-digest` and whether it returned success. This is the most direct check.
2. **Resend's dashboard** — the "Sent" log shows every digest email actually delivered, per
   recipient, per organization.
3. **Ask a director or admin** whether they got Monday's email — the most literal
   confirmation, if you don't have dashboard access handy.

Do **not** call the cron route yourself to "test" it in production (even with the right
`CRON_SECRET`) — it isn't a dry-run endpoint, it sends the real email to every organization's
real staff every time it's invoked. If you need to verify the digest's logic itself rather than
whether Monday's run happened, that's a job for a test, not a manual production call.

If a single organization's digest fails (a bad email address, Resend having an outage), it
doesn't block anyone else's — the cron route always processes every organization and reports
per-organization errors, so one broken academy never means the rest silently stop getting
theirs.
