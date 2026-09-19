# Deployment runbook

One document for the first production deploy: the stack decision, regions, the exact
bootstrap sequence, and what to expect to break in production that never shows up in
dev. `README.md`'s own "Environment variables" table is still the source of truth for
every env var's purpose — this doc doesn't repeat it, only says when each one has to
exist and what to set it to.

## Stack (decided)

**Vercel Pro + Supabase Pro — $45/month, two providers.**

Considered against a cheaper combination (Railway, consolidating app hosting and the
database onto one provider, ~$20-25/month) and decided against it deliberately, not by
default: `vercel.json` already exists and is the best-documented failure surface for
this exact stack (Next.js Server Components + Server Actions), and the $240-300/year
difference matters less than an evening lost to an undocumented platform quirk while a
paying customer is watching check-in fail. If $45/month starts mattering later, the
Postgres side migrates to a cheaper provider in an evening (see "What's cheap to change
later" below) — the decision made here is not a one-way door.

## Regions

Nobody had said where any of this lives — worth being explicit, because a mismatch
doesn't error, it just adds permanent latency nobody diagnoses.

- **Vercel**: functions default to `iad1` (Washington, D.C.) for every new project. Confirm
  this in the project's settings rather than assume the default held — it's configurable per
  project and per function.
- **Supabase**: create the project in **AWS us-east-1 (North Virginia)** — the closest
  Supabase region to `iad1`, and the closest real option to Costa Rica full stop (no AWS/GCP
  region exists in Central America itself).
- **Why this pairing specifically**: the app talks to the database on every request; the
  Vercel-to-Supabase hop happens far more often, and at a much larger latency cost if
  mismatched, than the end user's own distance to Vercel's edge network. Pin both to the
  same metro area (`iad1` / `us-east-1`) and that hop stays single-digit milliseconds.
  Get this wrong — a European Supabase region with a US-East Vercel deployment, say — and
  every single page load pays a transatlantic round trip on top of everything else,
  permanently, with no error message pointing at why the app just feels slow.

## First production deploy — step by step

Nothing is live yet, so there's no data to preserve — this is a from-scratch sequence,
verified against the actual code in `approve-organization.ts` and
`scripts/lib/seed-safety-guard.ts`, not assumed from how the pieces are supposed to fit
together.

1. **Get a verified Resend sending domain first.** Everything after this step sends real
   email; until this exists, `EMAIL_FROM` is still pointed at Resend's sandbox, which only
   delivers to the Resend account's own verified address. This is the one item on the
   launch checklist that blocks Alliance's own launch outright — see
   `MULTI_ACADEMY_AND_KIDS_BELTS.md`'s own Launch checklist section.
2. **Create the Supabase project** in `us-east-1` (above). Note both connection strings it
   gives you — the direct connection and the pooled (Supavisor, transaction-mode, port
   6543) connection — you need both, for different steps below, not just one.
3. **Create the Vercel project**, connect the GitHub repo, confirm its function region is
   `iad1`.
4. **Set every production environment variable before the first deploy.** Cross-checked
   against every `requireEnv`/`process.env` read in the codebase (re-verified for this
   runbook, nothing new since Phase 7's own audit): `README.md`'s table is complete. Two
   values need to be set specifically, not just "some Supabase URL":
   - `DATABASE_URL` — the **pooled** connection string (port 6543), with `?pgbouncer=true`
     appended. See "Connection pooling" below for why this exact form, not the direct one.
   - `NODE_ENV` — Vercel sets this to `production` automatically; don't set it by hand, and
     confirm it's actually `production` after the first deploy (the e2e-auth-bypass route's
     entire defense rests on this evaluating correctly).
   Leave `E2E_AUTH_BYPASS_SECRET` unset. `TEST_DATABASE_URL`/`SHADOW_DATABASE_URL`/
   `BASELINE_DATABASE_URL` are dev/CI-only — don't set them here at all.
5. **Run `pnpm exec prisma migrate deploy`** — but against the **direct** connection string
   (port 5432), not the pooled one from step 4. `migrate deploy` needs session-level DDL
   that transaction-mode pooling doesn't support well; this is the one command in this whole
   sequence that should NOT use the same `DATABASE_URL` the running app uses. Run it once,
   manually, from a trusted machine — not from the deployed app itself. Applies all 26
   existing migrations to a database that has none yet.
6. **Do not run `prisma/seed.ts` against this database.** It's deliberately guarded
   (`scripts/lib/seed-safety-guard.ts`) to refuse any target that isn't localhost or named
   `*test*` — that's correct, working behavior, not a step to route around. It creates
   known-password QA accounts; production needs neither those nor the belt catalogs it
   seeds, which come from a different, production-safe mechanism (step 8).
7. **Insert your own `User` row directly, via one-time SQL, against the production
   database.** This is the step with no script on purpose — a script that grants
   platform-wide access by running it is exactly the shape `seed-safety-guard.ts` already
   refuses to let the deterministic seed become. Use the **same email** you'll register
   Alliance with in step 8 — that's what makes step 9 attach your existing account instead
   of creating a second one.
   ```sql
   INSERT INTO "User" (id, email, "passwordHash", role, "isSuperAdmin", active, "createdAt", "updatedAt")
   VALUES (gen_random_uuid()::text, 'you@yourdomain.com', '<a real bcrypt hash you generate locally>', 'ADMIN', true, true, now(), now());
   ```
   (Generate the bcrypt hash locally with the same `hashSecret` function the app uses —
   `pnpm tsx -e 'import("./src/lib/crypto").then(m => m.hashSecret("your-real-password").then(console.log))'`
   against your **local** dev environment, not production — you only need the resulting
   hash string, never a live connection to production from that command.)
8. **Register Alliance's organization** through the real public flow (`/register-academy`),
   using that same email as the contact.
9. **Approve it**: `scripts/approve-organization.ts --slug=alliance-cr --approved-by=<your-email>`.
   Because your `User` row already exists (step 7), `approveOrganization()`'s own "reuse an
   existing user" branch — built for the ordinary multi-organization case, not for this
   bootstrap, but it applies here identically — finds it and adds a `DIRECTOR` membership
   rather than creating a second account. You end up as both platform admin and Alliance's
   own director on one account, already able to sign in with the password from step 7. This
   also seeds Alliance's belt catalogs and default promotion configs automatically, via
   `seedOrganizationDefaults` — the real per-organization seeder, not `prisma/seed.ts`. One
   harmless side effect: this step also emails a redundant invitation link to your own
   address, since the function has no way to know you don't need one — ignorable.
10. **Create the Supabase Storage bucket for logos**, and confirm it's set **public**, not
    the default-private a freshly created bucket gets. See "Supabase Storage" below for why
    this is easy to miss and where it actually breaks if missed.
11. **Sign in, confirm `/platform` is reachable**, then work through
    `docs/MULTI_ACADEMY_OPERATIONS.md` for anything else.

## What breaks in production but never in dev

Ranked by how likely each one is to actually bite in Alliance's first weeks, not by how
interesting the failure mode is. Every dev session so far has been one person, one long-
lived process, zero concurrency, and a warm connection the whole time — none of that is
true in production, and none of these needed to be true for the app to look completely
correct up to now.

### 1. Connection pooling (most likely, and the one you named)

**What the code assumes today, checked directly** (`src/lib/prisma/unscoped.ts`): a single
`PrismaPg` adapter wrapping a `pg.Pool`, constructed from `DATABASE_URL` as-is, with no
pooler awareness anywhere in the connection string or the adapter config. In dev this is a
single long-lived Node process — one `pg.Pool`, well under any connection limit, forever.

In production, every Vercel serverless function instance gets its **own** `pg.Pool`
(`pg`'s own default max is 10 connections per pool). A burst of real concurrent traffic —
several staff loading the dashboard at once, a handful of kiosk taps in the same minute at
class start — can make Vercel spin up multiple function instances simultaneously, each
opening its own pool of connections directly against Supabase's Postgres. Direct
connections are a small, fixed number on any Supabase plan; this is the textbook
serverless-Postgres exhaustion failure, and it cannot happen in a single-process dev
session no matter how long or how hard you test locally.

**What has to change:**
- `DATABASE_URL` in production must point at Supabase's **pooled** connection (Supavisor,
  transaction mode, port 6543) — not the direct one. The pooler multiplexes many client
  connections down to a small number of real backend ones.
- Append **`?pgbouncer=true`** to that connection string. Verified against Prisma's own
  current docs: transaction-mode pooling doesn't preserve session state, prepared
  statements, or `SET` commands across transaction boundaries, and Prisma's engine uses
  prepared statements by default. Without this flag, expect intermittent "prepared
  statement already exists" or similar errors — specifically under concurrent load, which
  is exactly the condition a solo dev session never produces.
- `prisma migrate deploy` (step 5 above) needs the **direct** connection instead —
  migrations need real session-level DDL, which transaction pooling doesn't support well.
  Two different connection strings for two different jobs; using the pooled one for
  migrations, or the direct one for the running app, are both real mistakes to check for.
- Worth adding, not yet in the code: `@vercel/functions`' `attachDatabasePool` utility
  around the `pg.Pool`, per Prisma's own current Vercel-specific guidance — it prevents
  connections from leaking when Vercel suspends a function mid-lifecycle, a distinct
  failure mode from plain connection-count exhaustion. Also worth capping the `pg.Pool`'s
  own `max` low (e.g. `max: 1`), since each function instance already gets its own pool —
  a large per-instance pool defeats the point of pointing at a pooler in the first place.

### 2. The weekly digest cron silently never fires

Vercel scopes environment variables per environment (Development / Preview / Production).
Testing the cron route in dev means curling it manually with `CRON_SECRET` set locally —
that always "works," because you're the one triggering it and you know the secret is
right. It proves nothing about whether Vercel's own scheduler is registered and firing on
`vercel.json`'s schedule against the **production** environment specifically. If
`CRON_SECRET` (or anything else the route needs) only got set for the wrong environment
scope in Vercel's dashboard, the route 401s every Monday and nobody notices — a digest
nobody actively waits for is the least visible failure mode on this whole list. Also: cron
config in `vercel.json` only takes effect on production deployments, never preview ones —
if the very first deploy is promoted from a preview rather than pushed straight to
production, confirm the cron actually registered rather than assume it did.

### 3. Supabase Storage — a fresh bucket defaults to private

Dev has been working against a real Supabase Storage bucket that was, at some point,
manually configured public — `logo-storage.ts`'s own code comment says as much ("the
bucket is PUBLIC by design"). A **newly created** bucket in the production Supabase
project does not inherit that setting; it's private by default. Uploading a logo would
still succeed (the upload path uses the authenticated service-role key, which bypasses
bucket-level policy) — but *rendering* it on the kiosk's unauthenticated screen would
fail, silently, the first time a real director uploads a real logo. This is a "looks
completely fine in every test you'd think to run" bug: the upload succeeds, the admin
preview (also authenticated) shows it fine, and only the actual kiosk — which nobody but
a real student in front of a real tablet ever looks at — shows the broken image.

### 4. Email deliverability (already tracked, repeated here because it fits this pattern exactly)

Already the one launch-blocking item on the Launch checklist, but worth naming here for
why dev testing wouldn't have caught it even if nobody had flagged it separately: testing
an invitation or digest email by sending it to *your own* address is indistinguishable
from success in Resend's sandbox mode, because your own address is exactly the one
address sandbox mode is allowed to deliver to. The failure only appears for a real
director's or student's *different* address — which never happens until a real customer
is in the system.

### 5. Cold starts on the kiosk

The dev server is always warm — a persistent process, never once has anyone testing this
app locally experienced a cold start. A wall-mounted kiosk tablet that hasn't been tapped
in a while hits a Vercel function that may have scaled to zero; the first tap of the day
(or after any quiet stretch) pays real cold-start latency — likely a second or so, not
dramatic, but real — before the PIN pad responds. Not a functional break, a UX papercut: a
student standing there for an extra beat with no feedback that anything is happening.
Worth knowing about before a director reports "the kiosk feels slow sometimes" as if it
were a bug, not a known, bounded characteristic of serverless hosting.

### 6. `APP_URL` pointing at a placeholder domain

If a temporary or Vercel-generated domain gets used for `APP_URL` during initial setup and
the real custom domain is added afterward without updating it, every invitation link and
password-reset link built from `APP_URL` in the meantime points at the wrong place —
discovered only when someone reports a broken link, not at deploy time, since nothing
about generating the wrong-but-well-formed URL fails loudly.

## What's cheap to change later, and what isn't

Everything above is standard Postgres underneath (Supabase, Neon, Railway, DigitalOcean —
all of them). Moving the database later is `pg_dump` / `pg_restore` and a new
`DATABASE_URL`, no code changes, doable in an evening — this is why the stack decision
above isn't treated as high-stakes. **Supabase Storage is different**: `logo-storage.ts`
calls its API directly, so moving off it later is a real code change, not a config swap.
The cron mechanism (`vercel.json`) is similarly Vercel-specific — moving hosting later
means replacing it with whatever the new host offers, a small but real one-time task.
