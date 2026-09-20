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
   - `DATABASE_URL` — the **pooled** connection string (port 6543), as Supabase gives it,
     plus an explicit `sslmode` (which one is the open SSL decision below). **No `?pgbouncer=true`** — see "Connection
     pooling" below for why that flag does nothing in this app. Also read the SSL item there
     before this first deploy: it is an open decision, not a formality.
   - `NODE_ENV` — Vercel sets this to `production` automatically; don't set it by hand, and
     confirm it's actually `production` after the first deploy (the e2e-auth-bypass route's
     entire defense rests on this evaluating correctly).
   Leave `E2E_AUTH_BYPASS_SECRET` unset. `TEST_DATABASE_URL`/`SHADOW_DATABASE_URL`/
   `BASELINE_DATABASE_URL` are dev/CI-only — don't set them here at all. **`DIRECT_URL` is
   also not set in Vercel** — it belongs only on the machine that runs step 5.
5. **Run `prisma migrate deploy` against the direct connection**, from a trusted machine:
   ```
   DIRECT_URL="<direct connection string, port 5432>" \
   DATABASE_URL="<the pooled string from step 4>" \
   pnpm exec prisma migrate deploy
   ```
   `prisma7.config.ts` makes the Prisma CLI use `DIRECT_URL` when it is set (and
   `DATABASE_URL` when it isn't — local dev and CI, where no pooler is in front). It refuses
   to run if the two name different databases. Never run migrations through the pooler: it
   appears to work, then leaves Prisma Migrate's advisory lock held by an idle pooled
   connection, and the *next* deploy fails with `P1002: Timed out trying to acquire a
   postgres advisory lock` — a failure that surfaces one deploy after the mistake that caused
   it. (If you ever see that P1002: find the idle session holding advisory lock `72707369`
   via `pg_locks` / `pg_stat_activity` and `pg_terminate_backend` it.) Run it manually, once,
   not from the deployed app itself. Applies all 26 existing migrations to a database that
   has none yet.
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

**The problem.** In dev this app is one long-lived Node process with one `pg.Pool`, well
under any connection limit, forever. In production every Vercel function instance gets its
**own** `pg.Pool` (`pg`'s default max is 10). A burst of real concurrent traffic — several
staff loading the dashboard at once, a handful of kiosk taps at class start — makes Vercel
spin up several instances, each opening its own pool straight against Supabase's Postgres.
Direct connections are a small fixed number on any Supabase plan, so this is the textbook
serverless-Postgres exhaustion failure, and it cannot happen in a single-process dev
session however hard you test.

**What is implemented** (`src/lib/prisma/unscoped.ts`, `prisma7.config.ts`):
- The running app uses `DATABASE_URL` = Supabase's **pooled** string (Supavisor, transaction
  mode, port 6543). The pooler multiplexes many client connections onto a few real backends.
- The Prisma CLI uses `DIRECT_URL` = the direct string (port 5432) when set, and falls back
  to `DATABASE_URL` when not (dev, CI). Step 5 above is the only place it is set.
- The pool is built explicitly: `idleTimeoutMillis: 5000` plus `@vercel/functions`'
  `attachDatabasePool`, which is Vercel's own guidance for `pg` on Fluid compute — idle
  connections close before an instance is suspended instead of leaking. It is inert off
  Vercel, so dev and CI are unchanged.

**What this runbook used to say, and was wrong** (corrected in the same PR that implemented
the real fix — checked against the actual code and a real PgBouncer, not documentation alone):
- **`?pgbouncer=true` does nothing here.** It is a Prisma *engine* connection-string
  parameter. This app uses the `PrismaPg` *driver adapter*, which hands the URL to
  node-postgres; node-postgres parses the flag into an inert key and never sends it. Do not
  add it — it would only make a working configuration look like it depends on it.
- **The real transaction-pooling hazard is named prepared statements**, and this app is
  already safe from it *by construction*: `@prisma/adapter-pg` only creates named statements
  if you pass `statementNameGenerator`, which this app never does (0 rows in
  `pg_prepared_statements`). Opting in fails 110 of 120 concurrent queries with
  `42P05 prepared statement already exists`. `tests/integration/no-named-prepared-statements.test.ts`
  pins both halves, so adding a `statementNameGenerator` later fails CI rather than
  production.
- **`max: 1` on the pool is not recommended.** Vercel's guidance is to avoid it — it limits
  concurrency inside an instance without reducing connections, and a request holding a
  connection while awaiting another can deadlock. The pool keeps `pg`'s default max.
- **Migrations go direct because of the advisory lock, not because DDL is unsupported.**
  `migrate deploy` through a transaction-mode pooler *succeeds* on a fresh database; the
  damage is that it leaves Prisma Migrate's session-level advisory lock held by an idle pooled
  backend, and the next deploy times out with `P1002`. See step 5 for the recovery.

**Limits of what was verified.** The pooler tested was PgBouncer 1.25.2 in transaction mode,
not Supavisor itself — same transaction-pooling semantics, same conclusions, but Supavisor
has not been exercised. The first deploy is the first real Supavisor test: after step 9, load
the dashboard and tap the kiosk a few times concurrently and watch the Vercel function logs
for `prepared statement` or `too many connections` errors.

**Open decision — SSL to the pooler (needs Alexis before the first deploy).** With no
`sslmode` in the URL, `pg` connects **without TLS**, and Supabase accepts that by default
("to maximize client compatibility") — so a plain `DATABASE_URL` works and silently sends
credentials and data in cleartext. `pg` (8.23) treats `sslmode=require`, `prefer` and
`verify-full` all as *strict certificate verification* (and warns that it will change in
v9), and `sslmode=no-verify` as encrypted-but-unverified. Supabase's certificate chain is
signed by its own CA, which is not in Node's default trust store, so strict verification
against Supabase commonly fails with `self-signed certificate in certificate chain` — the
failure that will appear if this is skipped. The options:
1. **`sslmode=verify-full` + Supabase's CA certificate** (dashboard → Database Settings → SSL
   Configuration; Supabase's own recommendation, and required if you turn on "Enforce SSL"):
   correct, but needs the CA delivered to the Vercel runtime (`NODE_EXTRA_CA_CERTS` or a
   code change to pass `ssl.ca` to the pool). Not implemented; how to deliver the cert on
   Vercel has not been verified.
2. **`sslmode=no-verify`**: encrypted in transit, but does not check who is on the other end.
   Works with no other changes; a conscious downgrade, not a default.

Whichever is chosen, verify it on the *first* deploy: hit any page that reads the database
and confirm it renders rather than 500s with a TLS error. Nothing has been verified against
a real Supabase project yet.

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
