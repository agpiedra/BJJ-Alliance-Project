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
2. **Create a NEW Supabase project for production** in `us-east-1` (above) — **not** the
   project your local `.env` points at. Your local `SUPABASE_URL` points at a real Supabase
   project, so every dev verification that uploads a logo writes a **real object into that
   project's bucket** (this happened: a test logo from a verification run landed there and had
   to be deleted by hand). If production reused that project, test logos would sit in the same
   bucket as customers' logos and dev and production would share one storage namespace. Keep
   the existing project as dev; production gets its own project, its own bucket (step 10),
   its own service-role key, and its own three storage variables in Vercel. (A second project
   may add to the Supabase bill — check Supabase's current pricing before creating it; that
   has not been verified here.) Note both connection strings the new project gives you — the
   direct connection and the pooled (Supavisor, transaction-mode, port 6543) connection — you
   need both, for different steps below, not just one.
3. **Create the Vercel project**, connect the GitHub repo, confirm its function region is
   `iad1`.
4. **Set every production environment variable before the first deploy.** Cross-checked
   against every `requireEnv`/`process.env` read in the codebase (re-verified for this
   runbook, nothing new since Phase 7's own audit): `README.md`'s table is complete. Three
   values need to be set specifically, not just "some Supabase URL":
   - `DATABASE_URL` — the **pooled** connection string (port 6543), exactly as Supabase gives
     it. **Nothing TLS-related and no `?pgbouncer=true` in it**: the app refuses a URL that
     carries `sslmode`/`ssl…` parameters alongside the CA below (they would silently discard
     the CA), and `pgbouncer=true` does nothing in this app — see "Connection pooling" below.
   - `DATABASE_SSL_CA_B64` — Supabase's CA certificate, base64-encoded (Dashboard → Database
     Settings → SSL Configuration → download the certificate). It is a public certificate, not
     a secret. Encode the *file*, not its text:
     `base64 -w0 <file>` (Git Bash/Linux) or
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("<file>"))` (PowerShell). Set it for
     **the same Vercel environments as `DATABASE_URL`, including Build**: in production mode
     the app refuses to construct a database client for a remote host without it, and
     `next build` constructs one. Without it every page fails with
     `Refusing to connect to "…" without TLS configuration in production` — loud, not a
     silent plaintext connection. Rotating the certificate is a config change: replace this
     value and redeploy. If verification fails on the first deploy, see "SSL fallback".
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_LOGO_BUCKET` — the **production**
     project's values from step 2, **never the values in your local `.env`** (that is the dev
     project, and copying it here would put production logos in the dev bucket and the dev
     service-role key in production).
   - `NODE_ENV` — Vercel sets this to `production` automatically; don't set it by hand, and
     confirm it's actually `production` after the first deploy (the e2e-auth-bypass route's
     entire defense rests on this evaluating correctly).
   Leave `E2E_AUTH_BYPASS_SECRET` unset. `TEST_DATABASE_URL`/`SHADOW_DATABASE_URL`/
   `BASELINE_DATABASE_URL` are dev/CI-only — don't set them here at all. **`DIRECT_URL` is
   also not set in Vercel** — it belongs only on the machine that runs step 5.
5. **Run `prisma migrate deploy` against the direct connection**, from a trusted machine:
   ```
   DIRECT_URL="<direct connection string, port 5432>?sslmode=require&sslaccept=strict&sslcert=<absolute path to the Supabase CA file>" \
   DATABASE_URL="<the pooled string from step 4>" \
   pnpm exec prisma migrate deploy
   ```
   `sslcert` is the same CA file step 4 base64-encodes — here as a path on the migration
   machine. **`sslaccept=strict` is what verifies the certificate; `sslmode` does not**:
   on the Prisma CLI's own connection path (its schema engine, not `pg`), `sslmode=require`
   and even `sslmode=verify-full` connected against a *wrong* CA in testing. The CLI refuses
   a remote `DIRECT_URL` that sets no `sslaccept`, so this can't be skipped by accident;
   `sslaccept=accept_invalid_certs` is the knowing, temporary equivalent of the fallback in
   "SSL fallback". A migration that fails with `Error opening a TLS connection` here is the
   same certificate problem as the app's — fix them together.

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
   bootstrap, but it applies here identically — finds it and adds an `ADMIN` membership
   (the organization's **Owner**, across every location — see revision 33 of the spec for why
   it is `ADMIN`, not `DIRECTOR`) rather than creating a second account. You end up as both
   platform admin and Alliance's own owner on one account, already able to sign in with the
   password from step 7. This also seeds Alliance's belt catalogs and default promotion
   configs automatically, via `seedOrganizationDefaults` — the real per-organization seeder,
   not `prisma/seed.ts`. One side effect: this step also emails an invitation link to your own
   address, since the function has no way to know you don't need one. It is harmless — an
   existing account keeps its password and is never signed in by a link — so it can be ignored
   or opened.
10. **Create the Supabase Storage bucket for logos**, and confirm it's set **public**, not
    the default-private a freshly created bucket gets. See "Supabase Storage" below for why
    this is easy to miss and where it actually breaks if missed.
11. **Verify pooling and TLS — before Anny (or anyone) touches anything.** The app's pooling
    was proven against PgBouncer; this is the first time it meets Supavisor. If Supavisor
    behaves differently, you want to find out from a script you ran on purpose, not from a
    director mid-class. From your trusted machine, with the same values Vercel has:
    ```
    DATABASE_URL="<the pooled string from step 4>" DATABASE_SSL_CA_B64="<the value from step 4>" \
    pnpm verify:pooling --app-url="https://<your-domain>/es/kiosk/<an-academy-slug>"
    ```
    (PowerShell: set `$env:DATABASE_URL` and `$env:DATABASE_SSL_CA_B64` first, then run
    `pnpm verify:pooling --app-url=...`.) It uses the app's own pool and client factories, so
    it tests the app's real configuration; it only reads (SELECTs and one count) and never
    prints credentials. It checks, in order: the TLS session is encrypted and the certificate
    verified; 360 concurrent queries and transactions through the app's real client all
    succeed and each returns its *own* answer; a control that opts in to named prepared
    statements (the one thing that breaks transaction pooling); and — the real production
    shape, many cold function instances each with their own pool — 90 concurrent requests
    to the deployed page. **Pass `--app-url` a public page that reads the database**, e.g. an
    academy's kiosk page. If `DATABASE_URL` is not on the command line, `dotenv` loads your
    dev `.env` and the script says `NOTE: the target is a LOCAL database` — that run proves
    nothing about production.

    **Expected output** (the counts and the distinct-backend number will differ):
    ```
    Target: aws-0-us-east-1.pooler.supabase.com:6543/postgres   TLS config: DATABASE_SSL_CA_B64 (full verification)

    [1/4] TLS      PASS  encrypted, server certificate verified
    [2/4] APP LOAD PASS  360/360 concurrent queries and transactions succeeded (4 distinct backend connections seen)
    [3/4] CONTROL  INFO  named prepared statements DO break this pooler (…) — so [2/4] passing is meaningful.
    [4/4] APP URL  PASS  90/90 concurrent requests returned 200

    RESULT: PASS
    ```
    Exit code 0 is the only go. Lines `[1/4]`, `[2/4]` and `[4/4]` must each be `PASS`.
    `[3/4]` is information, never a failure: if it says named statements did **not** fail,
    this pooler tolerates them (the PgBouncer 1.25.2 used to rehearse this did, at its
    defaults; it failed only with `max_prepared_statements=0`) — the app never uses them,
    so `[2/4]` holds either way; the control just couldn't demonstrate the failure.
    `RESULT: PASS, ON THE TEMPORARY no-verify FALLBACK` is not done — see "SSL fallback".

    **If it fails — do not launch; fix, then rerun until `RESULT: PASS`:**
    - `[1/4] … unable to verify the first certificate` — `DATABASE_SSL_CA_B64` isn't the CA
      that signed the database's certificate: re-download it, re-encode the *file*, retry.
    - `[1/4] … does not match certificate's altnames` — the CA is right but the certificate
      doesn't name the pooler's host. See what it does name:
      `openssl s_client -starttls postgres -connect <pooler-host>:6543 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName`.
      This is the case "SSL fallback" exists for; don't work around it any other way.
    - `[1/4] … Tenant or user not found` — the pooled string's user is `postgres.<project-ref>`,
      not plain `postgres`. `password authentication failed` — wrong password.
    - `[1/4] … Refusing to connect … without TLS configuration` — `DATABASE_SSL_CA_B64` isn't
      set in the shell you ran this from.
    - `[2/4] the schema is not readable` — step 5 didn't apply migrations to this database.
    - `[2/4] APP LOAD FAIL … 42P05` or `26000` (prepared statements) — Supavisor is not
      behaving like PgBouncer. First check nobody added a `statementNameGenerator`
      (`git grep statementNameGenerator src`; `tests/integration/no-named-prepared-statements.test.ts`
      pins it). If the app is clean, keep the output and don't launch: the alternative to
      transaction mode is Supabase's session-mode pooler (port 5432 on the pooler host, per
      Supabase's docs — not verified here), which gives each client its own backend at the
      cost of multiplexing.
    - `[2/4] APP LOAD FAIL … 53300` (too many connections) — the pooler's pool size or client
      limit is below what the load needs: raise it in Supabase's database settings.
    - `[4/4] … 404×90` — the `--app-url` is wrong (unknown academy slug). `500×…` — the
      deployment can't reach the database: read the Vercel function logs; the usual causes are
      `DATABASE_SSL_CA_B64` or `DATABASE_URL` missing in the *Production* environment scope, or
      a certificate error the script's own connection didn't hit.
12. **Sign in, confirm `/platform` is reachable** — open your user menu (top right) and choose
    **Plataforma**, or go to `/platform` directly — then work through
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
  `pg_prepared_statements`). Opting in fails concurrent queries with
  `42P05 prepared statement already exists` on a pooler that doesn't track prepared
  statements (110 of 120 against PgBouncer 1.25.2 with `max_prepared_statements=0`) — but the
  same PgBouncer at its *defaults* tolerated it, so support varies by pooler and version,
  which is exactly why the app doesn't depend on it. `tests/integration/no-named-prepared-statements.test.ts`
  pins both halves, so adding a `statementNameGenerator` later fails CI rather than
  production.
- **`max: 1` on the pool is not recommended.** Vercel's guidance is to avoid it — it limits
  concurrency inside an instance without reducing connections, and a request holding a
  connection while awaiting another can deadlock. The pool keeps `pg`'s default max.
- **Migrations go direct because of the advisory lock, not because DDL is unsupported.**
  `migrate deploy` through a transaction-mode pooler *succeeds* on a fresh database; the
  damage is that it leaves Prisma Migrate's session-level advisory lock held by an idle pooled
  backend, and the next deploy times out with `P1002`. See step 5 for the recovery.

**Limits of what was verified.** The pooler tested was PgBouncer 1.25.2 in transaction mode
with TLS, not Supavisor itself — same transaction-pooling semantics, but Supavisor has not
been exercised, and neither has a real Supabase certificate. Step 11 is that first real test,
run before anyone uses the app.

### SSL to the pooler

**The mechanism, checked before choosing a value** (against a real TLS Postgres with a
private CA, asking the server itself via `pg_stat_ssl`/its connection log whether each
session was encrypted — the same engine-versus-adapter trap as `pgbouncer=true`, and it
bites in both directions):

- **The URL's `sslmode` is not where TLS is configured on the app's path.** With no
  `sslmode` and no `ssl` option, `pg` connects in **plaintext** even to a server offering
  TLS, and Supabase accepts plaintext by default. The authoritative control is the Pool's
  `ssl` option, which the app now sets from `DATABASE_SSL_CA_B64` (`src/lib/prisma/database-ssl.ts`).
- **URL parameters override the Pool's option** (`Object.assign({}, config,
  parse(config.connectionString))` in `pg`): `?sslmode=verify-full` next to `ssl: { ca }`
  silently discards the CA and fails with `unable to verify the first certificate`. So the
  app refuses a `DATABASE_URL` carrying TLS parameters whenever the CA is configured, and
  refuses TLS-less remote hosts outright in production.
- **With an IP-address host, `pg` validates the certificate against `"localhost"`,** not the
  IP, so "verified" would be meaningless. The app refuses to verify against an IP host; use
  the DNS name (Supabase's strings already do). With a DNS host the certificate's name is
  checked: a certificate signed by the right CA that doesn't name the host is rejected.
- **The Prisma CLI is a different path** (step 5): there `sslmode` does *not* verify, and
  only `sslaccept=strict` + `sslcert=<CA file>` does — enforced by the CLI URL resolver for
  a remote `DIRECT_URL`.
- Supabase's own docs recommend `verify-full` with its CA (dashboard → Database Settings →
  SSL Configuration), and it is required if you enable "Enforce SSL".

**Decided:** full verification against Supabase's CA, supplied as `DATABASE_SSL_CA_B64`. The
certificate is public, so carrying it as an env var has no handling risk; that makes rotation
a config change plus a redeploy instead of a code change; and it is the only option that
verifies *who is answering* — encryption without authentication doesn't stop the wrong party
being on the other end of a connection that carries every tenant's data. Pinned by
`tests/integration/database-tls.test.ts` (right CA verified; wrong CA refused; right CA but
wrong hostname refused; the override trap; the real Prisma client over it).

**Not verified until step 11 runs:** that Supabase's *pooler* certificate names the pooler's
hostname. Supabase publishes one CA and recommends `verify-full`, which implies it does, but
that has not been checked against a real project.

### SSL fallback — temporary, with an owner and an exit

If step 11 fails on TLS and the cause is not something you can fix quickly (typically the
`altnames` case above), the fallback is `DATABASE_SSL_MODE=no-verify` **instead of**
`DATABASE_SSL_CA_B64` in Vercel (and `sslaccept=accept_invalid_certs` on the step 5
`DIRECT_URL`). That encrypts the connection and authenticates nothing.

- **It is temporary.** The app logs a warning on every start naming it as such, and
  `pnpm verify:pooling` ends `RESULT: PASS, ON THE TEMPORARY no-verify FALLBACK` — never a
  plain `PASS` — every time it is run, so it cannot go unnoticed.
- **Owner:** Alexis. Nothing else removes it.
- **Exit condition:** find out what the certificate actually names (the `openssl s_client`
  command in step 11), then make the verified configuration work — the right CA file, or a
  connection string whose hostname the certificate covers. Then remove
  `DATABASE_SSL_MODE`, set `DATABASE_SSL_CA_B64`, redeploy, and rerun step 11 until
  `[1/4] TLS PASS  encrypted, server certificate verified` and a plain `RESULT: PASS`.
  Until then the launch checklist should treat it as an open item, not a configuration.

### 1a. Set up the Healthchecks.io dead-man's switch (C1) before relying on the crons

C1 (`docs/MULTI_ACADEMY_AND_KIDS_BELTS.md`) gave the scheduled job a `JobRun` history and a
Healthchecks.io ping (`src/lib/jobs/heartbeat.ts`), but the account and the check
itself are **not part of this codebase** — do this once, at deploy time, as a real
manual step:

1. Create a free Healthchecks.io account (or use an existing team one).
2. Create **one** check for the job, with its schedule set to the EXACT cron
   expression `vercel.json` already uses (Healthchecks.io accepts a cron schedule directly —
   paste it verbatim, don't re-derive it by hand):
   | Job | Cron schedule (paste into Healthchecks.io) | Grace period |
   |---|---|---|
   | `weekly-digest` | `0 13 * * 1` (Monday 07:00 America/Costa_Rica) | 6 hours — the digest is informational; a few hours late is not worth waking anyone at 2am for. |
   There is no promotion job: every promotion is awarded by an instructor, so the former
   `promotion-auto-award` cron (and its `HEALTHCHECK_PROMOTION_URL`) no longer exists. Delete that
   Healthchecks.io check and env var if you created them earlier.
3. Copy the check's own "ping URL" (`https://hc-ping.com/<uuid>` — a plain GET to that URL
   means success, `<url>/fail` means failure; `heartbeat.ts` sends both forms itself, you
   never construct the `/fail` suffix by hand).
4. Set it as **`HEALTHCHECK_DIGEST_URL`** in Vercel's
   environment variables, scoped to Production only (same scoping mistake #2 below warns
   about for `CRON_SECRET` — get this one right the first time).
5. Verify: after the next real cron run (or by curling the route by hand with
   `CRON_SECRET`, matching this doc's own verification pattern elsewhere), Healthchecks.io's
   dashboard should show a green "last ping" for the check, and
   `GET /api/health/jobs` (behind `CRON_SECRET`, same shared secret as the crons themselves)
   should show `heartbeatStatus: "ok"` on the latest `JobRun` row for the job.

**Until this is done**, the job still runs and still writes its own `JobRun` history —
nothing is blocked on Healthchecks.io existing — but `heartbeatStatus` reads
`"not_configured"` instead of `"ok"`/`"failed"`, visible on the same `/api/health/jobs`
endpoint, so the gap is a fact you can see, not a silent assumption.

`GET /api/health` (public, no secret, database-only — deliberately narrower than
`/api/health/jobs`) is a second, independent thing worth pointing an uptime monitor
(Healthchecks.io itself can do this too, as a plain "URL check," or any other service) at
on a several-minute cadence — it answers "is the app's own database reachable right now,"
which the job heartbeat does not.

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

**Related gap, found during PR review (branding logo upload, revision 44): nothing validates
that `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/the bucket are present and usable, at startup
or on any health check.** `logo-storage.ts`'s functions read these lazily, on first real use,
by deliberate design (see that module's own comment on why) — but that same laziness means a
missing or misspelled env var in production degrades into a director seeing "There's a problem
with logo storage. Contact an administrator." (revision 44's own error taxonomy) instead of
anything you'd notice at deploy time. Confirmed directly: `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_LOGO_BUCKET`
appear nowhere outside `logo-storage.ts` — no startup check, and neither `/api/health`
(deliberately database-only, per C1's own decision #3) nor `/api/health/jobs` (deliberately
scoped to `JobRun` freshness) touches storage at all. **Not built here — report only, per the
review that found it.** Before relying on logo uploads in production: either add a one-time
manual verification step to this runbook's first-deploy checklist (step 3 above, "confirm
storage config" alongside "confirm the bucket is public"), or extend `/api/health` to also
ping Storage's own `/storage/v1/status` endpoint the way `checkDatabaseHealth` already pings
Postgres — a decision for whoever picks this up, not made here.

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
