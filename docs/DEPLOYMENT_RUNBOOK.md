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
   - `NODE_ENV` — Vercel sets this to `production` automatically; don't set it by hand.
     The e2e-auth-bypass route's production defense is the BUILD, not this runtime value:
     `next build` compiles the route's `NODE_ENV` check to the literal `"production"`
     (Next source: `build/define-env.js`), and CI's "Verify the production build" step
     observes the compiled route answering 404 with no cookie even when started with
     `NODE_ENV=test` and a bypass secret set. What would re-enable it: serving the app with
     `next dev`, or setting `experimental.allowDevelopmentBuild`. Whether the deployed host
     builds with `next build` and never runs `next dev` is a deployment fact to confirm on
     the first deploy; CI does not verify the hosted environment.
   Leave `E2E_AUTH_BYPASS_SECRET` unset (in production and preview). Do not send live
   requests to the bypass route as a check: a POST is a state-changing request, not a
   read-only probe, and any live probing is a separate, explicitly approved step. `TEST_DATABASE_URL`/`SHADOW_DATABASE_URL`/
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
   not from the deployed app itself. On a genuinely empty database it applies every migration the
   deployed commit ships; do not rely on a count written in this document (it goes stale with every
   release) - verify with "Verifying that every shipped migration is applied" below.
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
    verified; 300 queries and 60 interactive transactions through the app's real client,
    at most 10 in flight (the pool's size), all succeed and each returns its *own* answer;
    the same 360 operations all started at once, as a stress step where only Prisma's
    transaction-start timeout is information and any other failure fails `RESULT`; a control
    that opts in to named prepared
    statements (the one thing that breaks transaction pooling); and an HTTP check — 90
    concurrent GET requests to the URL you pass as `--app-url`, each of which must return 200.
    **Pass `--app-url` a public page that reads the database on every request**, e.g. an
    active academy's kiosk page (`/es/kiosk/<slug>` is rendered per request and looks the
    academy up in the database). What the HTTP check proves depends on that choice: it proves
    only that *this URL* answered 200 to that burst. It reaches the database only if the page
    reads it; it is not a capacity or load test, and it says nothing about authentication or
    any other page. If `DATABASE_URL` is not on the command line, `dotenv` loads your
    dev `.env` and the script says `NOTE: the target is a LOCAL database` — that run proves
    nothing about production.

    **Expected output** (the counts and the distinct-backend number will differ):
    ```
    Target: aws-0-us-east-1.pooler.supabase.com:6543/postgres   TLS config: DATABASE_SSL_CA_B64 (full verification)

    [1/5] TLS      PASS  encrypted, server certificate verified
    [2/5] APP LOAD PASS  360/360 queries and transactions succeeded, 10 in flight (10 distinct backend connections seen)
    [3/5] STRESS   PASS  unbounded: 360/360 started at once succeeded (10 distinct backend connections seen)
          (or, from a distant machine: [3/5] STRESS   INFO  unbounded: 60/360 failed, every one the transaction-start timeout — …)
    [4/5] CONTROL  INFO  named prepared statements DO break this pooler (…) — so [2/5] passing is meaningful.
    [5/5] APP URL  PASS  90/90 concurrent requests returned 200

    RESULT: PASS — every check ran and passed: verified TLS to a remote database, database load, 90/90 HTTP 200 from the supplied --app-url
    ```
    **Exit code 0 is the only go.** The script has three verdicts:

    | Exit | Last line | Means |
    |---|---|---|
    | 0 | `RESULT: PASS — every check ran and passed: …` | Remote database, `[1/5]` PASS (certificate verified), `[2/5]` PASS, `[3/5]` PASS or INFO, `[5/5]` PASS for the URL you gave. The only result that completes this step — and it covers only what these checks test (above). |
    | 2 | `RESULT: PARTIAL — the database checks passed, but not every check ran or was verified: …` | Nothing failed; the line lists each gap: no `--app-url` (`[5/5] SKIP`), the TLS no-verify fallback (`[1/5] WARN`), or a local database (plaintext `[1/5] INFO`, or `localhost`/`127.0.0.1`/`::1` at all). Running without `--app-url` is allowed — e.g. to check the database before the app is deployed — but it does not complete this step. |
    | 1 | `RESULT: FAIL …` | A step printed `FAIL`, or the run could not start (no `DATABASE_URL`, refused TLS configuration, no connection, unreadable schema). |

    `[4/5]` never affects the exit code. Exit 0 needs no particular `[4/5]` result.

    - **PARTIAL shows a "command failed" banner — expected.** Because PARTIAL exits 2,
      `pnpm` prints `[ELIFECYCLE] Command failed with exit code 2.` after it. That banner is
      not a failure verdict: read the `RESULT:` line and the gaps it lists. (A real failure is
      `RESULT: FAIL`, exit 1.)
    - **Any other exit code means "not verified".** The verdict is set without
      `process.exit()`, but not every way the process can end yields 0/1/2: an interrupted run
      (Ctrl+C), a Node crash, or the script's 30-second safety exit. That safety exit fires only
      if something unexpectedly keeps the process alive after `RESULT`. On Node 24 for Windows it
      can then abort on a libuv assertion (`Assertion failed … src\win\async.c`) and exit
      **127** whatever `RESULT` said. Keep the output and rerun.
    - **Older verifier versions exited 0 in more cases.** Before 2026-11 (PR #158), the script
      ended `RESULT: PASS` with exit 0 when `--app-url` was omitted (`[5/5] SKIP`), when the
      target was a local or plaintext database, and — as `RESULT: PASS, ON THE TEMPORARY
      no-verify FALLBACK` — on the TLS fallback. (That covers both the four-step `[1/4]…[4/4]`
      version and the unmerged bounded version `7b1f9fb`; the latter also reported every `[3/5]`
      stress failure as information.) On Windows, its runs with `--app-url` could also exit 127 whatever `RESULT` said (the abort
      above). **Interpret a historical `RESULT: PASS` by that version's rules:** check its
      `[1/5]` and `[5/5]` lines and its target before treating it as a pass under the current rules.

    **`[2/5]` is not the original test.** Until 2026-10, this step started all 360 operations
    at once. That shape fails from any machine more than ~60 ms from the database, with
    `Transaction API error: Unable to start a transaction in the given time` on every
    transaction. The cause is the script's own queue: 300 queries occupy the pool's 10
    connections for ~30 round trips, and Prisma's default `maxWait` (2000 ms, covering
    `pool.connect` + `BEGIN`) expires first. This was reproduced against a local database
    behind a delay proxy, with no pooler involved. It first appeared on staging from the
    operator's machine: 60/360 failed. `[2/5]` bounds the workload at 10 in flight: the pooler
    sees the same 10 concurrent connections, but nothing waits locally. Pool size and
    transaction timeouts are unchanged. **This changes the acceptance workload; it does not
    make the original test pass.** `[3/5]` still runs the original shape. Exactly one error
    there is information: Prisma's `P2028` with `Unable to start a transaction in the given
    time` — a finding about the local queue, reported as `INFO`, not a launch blocker. Every
    other `[3/5]` failure fails `RESULT` (exit 1): crossed results, `42P05`, `26000`, `53300`,
    dropped connections, other `P2028` errors (an expired or rolled-back transaction), or a
    schema that stopped being readable. When both kinds occur, the line counts the failing
    ones and adds the start timeouts in brackets as information.

    `[4/5]` is information, never a failure: if it says named statements did **not** fail,
    this pooler tolerates them (the PgBouncer 1.25.2 used to rehearse this did, at its
    defaults; it failed only with `max_prepared_statements=0`) — the app never uses them,
    so `[2/5]` holds either way; the control just couldn't demonstrate the failure.
    A `RESULT: PARTIAL` naming the no-verify fallback is not done — see "SSL fallback".

    **If it fails (exit 1) — do not launch; fix, then rerun until exit 0 and `RESULT: PASS`:**
    - `[1/5] … unable to verify the first certificate` — `DATABASE_SSL_CA_B64` isn't the CA
      that signed the database's certificate: re-download it, re-encode the *file*, retry.
    - `[1/5] … does not match certificate's altnames` — the CA is right but the certificate
      doesn't name the pooler's host. See what it does name:
      `openssl s_client -starttls postgres -connect <pooler-host>:6543 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName`.
      This is the case "SSL fallback" exists for; don't work around it any other way.
    - `[1/5] … Tenant or user not found` — the pooled string's user is `postgres.<project-ref>`,
      not plain `postgres`. `password authentication failed` — wrong password.
    - `[1/5] … Refusing to connect … without TLS configuration` — `DATABASE_SSL_CA_B64` isn't
      set in the shell you ran this from.
    - `[2/5] the schema is not readable` — step 5 didn't apply migrations to this database.
    - `[2/5] APP LOAD FAIL … 42P05` or `26000` (prepared statements) — Supavisor is not
      behaving like PgBouncer. First check nobody added a `statementNameGenerator`
      (`git grep statementNameGenerator src`; `tests/integration/no-named-prepared-statements.test.ts`
      pins it). If the app is clean, keep the output and don't launch: the alternative to
      transaction mode is Supabase's session-mode pooler (port 5432 on the pooler host, per
      Supabase's docs — not verified here), which gives each client its own backend at the
      cost of multiplexing.
    - `[2/5] APP LOAD FAIL … 53300` (too many connections) — the pooler's pool size or client
      limit is below what the load needs: raise it in Supabase's database settings.
    - `[2/5] APP LOAD FAIL … Unable to start a transaction in the given time` — with only 10 in
      flight, this means each operation takes far longer than one round trip. Check the
      pooler's queueing and this machine's connection, and keep the output. Do not raise
      `maxWait` to make it pass.
    - `[3/5] STRESS FAIL … failed with errors other than the transaction-start timeout` — read
      the codes on the line. `42P05`/`26000`/`53300` mean what they mean under `[2/5]`;
      `crossed result` means the pooler returned another session's answer — do not launch;
      `57P01`/`08006` mean connections were dropped mid-run. Keep the output. `[2/5]` passing
      does not cancel this failure.
    - `[5/5] … 404×90` — usually a wrong `--app-url` (e.g. an unknown or inactive academy
      slug). `500×…` (any 5xx) — the deployment failed to serve the page. Database connectivity
      is one possible cause, not the only one: read the Vercel function logs. Database-related
      causes include `DATABASE_SSL_CA_B64` or `DATABASE_URL` missing in the *Production*
      environment scope, or a certificate error the script's own connection didn't hit.
12. **Sign in, confirm `/platform` is reachable** — open your user menu (top right) and choose
    **Plataforma**, or go to `/platform` directly — then work through
    `docs/MULTI_ACADEMY_OPERATIONS.md` for anything else.

## Releasing a commit that adds migrations

Written for the release that ships `20260924034500_attendance_unmatched_daily_key` and
`20260924165601_queued_check_in_review` (PR #58), and reusable for any release that adds migrations. Every command
and output below was run against a real database (the local test server) except `psql` itself, which was not
installed for the check: the same queries were run through node-postgres.

### 0. First, which kind of database is it?

Ask the database, not your memory:

```sql
SELECT to_regclass('public."AttendanceRecord"') IS NOT NULL AS attendance_table_exists;
```

| The database is | `attendance_table_exists` | What to do |
|---|---|---|
| **Genuinely empty** (no schema yet - the first production deploy above) | `false` | Skip the duplicate preflight: it is not applicable and cannot even run (`ERROR 42P01: relation "AttendanceRecord" does not exist`). `prisma migrate deploy` creates everything, and the unique index is created on an empty table, so it cannot conflict. Go to section 2. |
| **An existing database** (holds an `AttendanceRecord` table: development, staging, a restored copy, anything with data) | `true` | The duplicate preflight (section 1) is **required** before migration `20260924034500_attendance_unmatched_daily_key` is applied to it. |
| An existing database where that migration is **already applied** | `true` | The preflight no longer matters (the index enforces it). Confirm the index exists (section 4). |

The development and test databases were checked and held no duplicates. Nothing else has been checked.

### 1. Existing databases only: duplicate preflight and backup

Take a backup or snapshot first. Then run this read-only query with a role that can read `AttendanceRecord` and expect
**zero rows**:

```sql
SELECT "studentId", "date"::text AS "day", count(*)::int AS "attendances",
       array_agg("id" ORDER BY "occurredAt", "id") AS "ids"
FROM "AttendanceRecord"
WHERE "classSessionId" IS NULL AND "type" = 'CHECKIN' AND "voidedAt" IS NULL
GROUP BY "studentId", "date"
HAVING count(*) > 1
ORDER BY "studentId", "date";
```

If it returns rows, nothing is deleted or voided automatically and no script does it. An ADMIN or DIRECTOR voids the
extra entries with the existing audited void action (a reason is required; the rows stay in the history) or reassigns a
tap that really belonged to a class, then you re-run the query until it returns zero. If an attempt to apply the
migration already failed, run `prisma migrate resolve --rolled-back 20260924034500_attendance_unmatched_daily_key`
after cleaning the data, then deploy again.

### 2. Apply

`prisma migrate deploy` over the direct connection, exactly as step 5 of the first deploy describes (never through the
pooler).

### 3. Verifying that every shipped migration is applied (no counts)

Run these from a checkout of **the exact commit you are deploying**, so "shipped" means what that commit ships.

**a. Prisma's own check.**

```
pnpm exec prisma migrate status
```

Observed on a fully migrated database: `N migrations found in prisma/migrations` (N is whatever the checkout ships)
followed by `Database schema is up to date!`, exit code 0. Observed on a database with pending migrations: it lists
them by name, ends with `To apply migrations in production run prisma migrate deploy.`, and exits with code 1. Use the
connection string the way step 5 does (`DIRECT_URL`).

**b. An independent comparison of shipped against applied.**

```
git ls-tree -d --name-only <deployed-commit> prisma/migrations/ | sed 's#.*/##' | sort > shipped.txt
psql "<libpq connection string to the database>" -Atc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | sort > applied.txt
comm -23 shipped.txt applied.txt   # shipped but NOT applied: must print nothing
comm -13 shipped.txt applied.txt   # applied but NOT shipped: must print nothing
```

Use a libpq connection string for `psql` (`sslmode=verify-full&sslrootcert=<CA file>`), not Prisma's `sslaccept` /
`sslcert` parameters, which `psql` rejects. A non-empty first list means the release is not fully migrated: stop. A
non-empty second list means the database is ahead of, or was migrated from a different commit than, the one you are
deploying: stop and find out why before going on. Also expect no half-applied or rolled-back rows to be unresolved:

```sql
SELECT migration_name, finished_at IS NULL AS unfinished, rolled_back_at IS NOT NULL AS rolled_back
FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
```

A row with `unfinished = true` is a migration that failed or is still running: stop. A `rolled_back` row that has a later
successful row of the same name is normal history after a `migrate resolve --rolled-back` and a redeploy.

### 4. Post-migration structure checks

```sql
SELECT indexname FROM pg_indexes WHERE indexname = 'AttendanceRecord_unmatched_student_date_key';   -- one row
SELECT to_regclass('public."QueuedCheckIn"') IS NOT NULL AS queued_table_exists;                    -- true
```

**`QueuedCheckIn` is empty only at one moment: right after the migration created it and before the new application
version takes traffic** (`SELECT count(*) FROM "QueuedCheckIn"` returns 0 then, as it did on the development database after verification). Once the
release is live, rows are expected and legitimate: an offline replay that cannot be attributed (an unverifiable
timestamp, no class open then, several classes open without a recorded selection) is stored there as a `PENDING` row for a
coach to record or set aside on the Kiosco page, and rows are never deleted. A non-zero count after go-live is therefore
not a failure; a `PENDING` row that stays unattended is work for staff, not a deployment fault.

### 5. After the new version is live

1. Pages answer 200: `/en/login`, `/es/login`, `/en/register-academy`, `/es/register-academy` and a student signup page;
   fonts load from `/_next/static/media` and none from `fonts.gstatic.com`.
2. Portal, as a real approved student: today's classes show honest states; checking in to an open class records it and
   refreshes the row, progress and history; a closed class is refused; "Show older attendance" pages to the end.
3. Kiosk, with the academy's real device token: no class open shows the unavailable message and writes nothing; one open
   class checks in automatically; overlapping classes show the picker and cancelling writes nothing; a class that closes
   while the picker is open shows the notice and fresh choices.
4. Offline replay: queue a tap on a tablet while offline, reconnect, and confirm it syncs; an ambiguous one appears under
   "Queued check-ins awaiting review" and a coach can record it on the original day with the confirmed tap time (a time
   outside the class window or in the future is refused) or set it aside with a reason.
5. Reload each kiosk tablet so it gets the new client. Entries already queued on an old client replay under the legacy key
   and follow the same rules.
6. Existing class-less attendance rows are unchanged; nothing is converted automatically.
7. `NODE_ENV` is `production` (step 4 of the first deploy).

### 6. Rollback - what is NOT known

The two migrations are additive: the index migration adds an index and the `QueuedCheckIn` migration adds two enums, a
table, indexes and foreign keys, and neither changes an existing row.

**Rolling the application back to a build older than this release while leaving the database as migrated is UNTESTED, and
it is not known to be safe.** By reasoning only, not by test: an older build does not know the `QueuedCheckIn` table, and
it does not handle the new unique index, so two concurrent class-less taps that used to write two rows would now hit a
unique violation instead, and how the older build answers that has not been observed. Do not rely on a rollback of the
application alone, and do not drop the index or revert migrations by hand, until a rollback has been rehearsed on a copy
of the database and its outcome recorded here. Decide the rollback plan before the release, not during it.

### 7. Promotion-accounting activation is a separate decision

Nothing in a release activates it. An existing organization stays on its current accounting until someone runs
`pnpm promotion:accounting report --org=<slug>` and then `activate --org=<slug> --report=<reportId> --activated-by=<email>`
(a dry run first, then `--apply`), on an explicit ask. It is not a step of this checklist.

## O4 prepaid-payment reversal (migration `20261110120000`) — read before deploying OR rolling back

> **⚠ CODE ROLLBACK BECOMES UNSAFE AFTER THE FIRST CANCELLATION.**
> Once any prepaid month has been cancelled by a payment reversal, **never** deploy a build older than O4 (or revert the O4
> code). An older build does not know cancelled obligations or released coverage exist: it would show cancelled months as
> owed and covered again, refuse to bill them (it sees the month as already billed), and let payments target them up to the
> database's own refusal. **After the first cancellation the only safe path is forward recovery (below).**

Owner decisions B1–B10 (2026-11-09); design in `docs/dues/O4-PREPAYMENT-REVERSAL-PLAN.md`. Reversing a payment cancels the
future prepaid months that payment alone created (their coverage is released, and the monthly job bills each month normally
when it opens); started months and every other charge become owed again. Nothing is ever deleted.

### 1. Applying the migration

1. **Backup first**, as for any migration (section 1 above).
2. **Migrate, then deploy.** The O4 code reads the new columns; on the old schema every obligation/coverage read fails. The
   pre-O4 code on the new schema is safe **until** the first cancellation (the narrowed unique indexes behave exactly as
   before while nothing is cancelled).
3. **The migration is one explicit transaction** (`BEGIN … COMMIT` inside the file). Verified locally on 2026-11-09:
   `prisma migrate deploy` (Prisma 7.10) does **not** wrap a migration file in a transaction — a failure mid-file left earlier
   statements applied — while the explicit transaction made a failing file change nothing. If it fails: the database is
   unchanged, Prisma records the migration as failed; fix the cause, run
   `prisma migrate resolve --rolled-back 20261110120000_dues_prepayment_reversal_cancellation`, then deploy again.
4. **Structure checks after migrating** (expect the counts shown):

```sql
SELECT count(*) FROM pg_trigger WHERE tgname IN ('DuesCoverage_release_once','DuesObligation_cancellation_guard',
  'DuesObligation_cancellation_consistent','DuesCoverage_release_consistent','DuesObligation_prepayment_settled_at_creation',
  'DuesSettlement_obligation_not_cancelled','DuesLateFee_obligation_not_cancelled','DuesObligation_no_marker_on_insert',
  'DuesCoverage_no_marker_on_insert');                                                                       -- 9
SELECT count(*) FROM pg_trigger WHERE tgname = 'DuesCoverage_no_update';                                    -- 0
SELECT indexdef FROM pg_indexes WHERE indexname IN ('DuesObligation_student_month_monthly_key','DuesCoverage_studentId_year_month_key');
-- both end in WHERE … "cancelledAt" IS NULL / WHERE ("releasedAt" IS NULL)
```

### 2. Is a code or schema rollback still possible? Ask the database

```sql
SELECT (SELECT count(*) FROM "DuesObligation" WHERE "cancelledAt" IS NOT NULL) AS cancelled_obligations,
       (SELECT count(*) FROM "DuesCoverage"   WHERE "releasedAt"  IS NOT NULL) AS released_coverage;
```

- **Both 0:** no cancellation has happened. A code rollback to a pre-O4 build is safe. A schema rollback is possible with
  `docs/dues/o4-schema-rollback.sql`, **only with explicit owner approval**, after the code rollback. It re-checks the counts
  under table locks and refuses otherwise. Rehearsed locally on 2026-11-09: rolled back, the schema dump and migration
  records equal those of a database that never had O4; with a released row present it refused and changed nothing.
- **Either above 0: do not roll back code or schema.** Use forward recovery.

### 3. Forward recovery (after the first cancellation)

1. **Contain without going backwards.** If reversals themselves must stop, ship a *forward* build whose
   `reversePaymentAction` refuses (or whose screen hides the action) — keeping every O4 reader filter and the writer's
   database rules in place. Do not deactivate the ledger as a containment step unless the owner decides to; do not disable
   triggers; do not edit rows by hand (the triggers refuse it anyway).
2. **Assess, read-only.** List what was cancelled and by which reversal:

```sql
SELECT o."id", o."studentId", o."coverageYear", o."coverageMonth", o."cancelledAt", o."cancelledByReversalOfPaymentId",
       p."reversalReason", p."reversedById"
FROM "DuesObligation" o JOIN "DuesPayment" p ON p."id" = o."cancelledByReversalOfPaymentId"
WHERE o."cancelledAt" IS NOT NULL ORDER BY o."cancelledAt";
```

   The database already guarantees each row is consistent (coverage released, exactly one settlement ever — the reversed
   payment's —, no fee, month not started at cancellation). A row that looks wrong is therefore a *business* mistake (the
   wrong payment was reversed), not corruption.
3. **Correct a mistaken cancellation forward, never by un-cancelling.** The month is uncovered again, so:
   - **a future month:** the owner prepays it again, or leaves it for the monthly job to bill when it opens;
   - **a month that has since opened:** a cancellation can only happen *before* its month opens (the database enforces it), so
     that month's own generation pass ran afterwards and billed it like any other month if the student was eligible. Confirm
     with `SELECT * FROM "DuesObligation" WHERE "studentId" = '<id>' AND "coverageYear" = <y> AND "coverageMonth" = <m> AND
     "cancelledAt" IS NULL` (one row expected). If none exists (for example, the student was not eligible then), that is the
     ordinary billing outcome, not an O4 fault. Whether a *finished* generation pass revisits a student later is not
     verified here — do not rely on it.
   The cancelled row and its history stay as the record of what happened.
4. **Fix the defect in code**, with tests, as a normal forward release. If data needs a new kind of correction, that is a
   new, reviewed writer or migration with its own owner approval — never an ad-hoc script.
5. **Record** the incident and the rows involved (the query above) before and after the fix.

## Stage 9 PR 9-1: activation record and organization gate (migration `20261111120000`)

- **Migrate first, then deploy.** The new code reads `"DuesActivation"` on every ledger check and takes the organization row
  lock in every writer that affects readiness. On the old schema every ledger check and every legacy payment fails. The
  migration is one explicit `BEGIN … COMMIT`, creates one empty table and its triggers, and changes no existing row.
- **Old code on the new schema is safe:** nothing in it reads or writes the table.
- **Nothing in the application writes `"DuesActivation"` in PR 9-1.** Every organization stays inactive exactly as before.
  Approval and the activation switch arrive in PR 9-3, with their own runbook section (forward-only after the first
  effective activation, A5).
- **Check after deploy:** `SELECT count(*) FROM "DuesActivation"` must be 0. A row here before PR 9-3 means a manual write;
  investigate before anything else (KNOWN_LIMITATIONS: the gate binds only application code).
- **Rollback order (owner approval only):**
  1. **Code first:** deploy a build that predates PR 9-1. It never touches `"DuesActivation"`, so it runs on either schema.
  2. **Then, only if the schema must go too:** run `docs/dues/stage9-1-schema-rollback.sql` by hand. It is the only
     sanctioned edit of migration history for 9-1. It takes an `ACCESS EXCLUSIVE` lock and **refuses if any activation
     record exists** (approval, withdrawal or effective); such rows are never deleted, so the answer then is a forward fix.
  3. **If O4 must also be rolled back, roll back 9-1 first:** 9-1's insert trigger uses O4's `dues_marker_absent_on_insert()`,
     which the O4 rollback drops.
  Never steps 1–2 in reverse: 9-1 code on the pre-9-1 schema fails on every ledger check and legacy payment.
  `prisma migrate resolve --rolled-back` cannot replace the script (it accepts only a failed migration — verified).
  Rehearsed locally on a disposable PostgreSQL 17 (2026-11-10): with an activation row present the script refused and changed
  nothing (table, row, migration record and schema dump identical); on an empty table the schema dump equals one migrated only
  up to O4 (ignoring pg_dump's per-run `\restrict` token), the migration record is gone, and `migrate deploy` re-applies 9-1.

## Stage 9 PR 9-2: opening obligations and O2 (migrations `20261112120000`, `20261112120100`)

- **Migrate first, then deploy.** `20261112120000` adds the enum value `OPENING` (its own one-statement migration: PostgreSQL
  refuses to use a new enum value in the transaction that adds it). `20261112120100` is one explicit `BEGIN … COMMIT`: the
  OPENING shape, the coverage refusal, and O4's cancellation rules widened for O2. Existing rows are unaffected (they all
  already satisfy the new constraints, re-validated by the migration).
- **Old code on the new schema is safe while no OPENING row exists** — and none can exist before PR 9-3's activation switch.
- **Nothing in the application creates OPENING rows in PR 9-2.** Payment entry, reversal and O2 cancellation can handle them;
  the switch (PR 9-3) creates them from the owner's reviewed opening items.
- **Rollback order (owner approval only):** previous code first; then `docs/dues/stage9-2-schema-rollback.sql`, the only edit
  of 9-2's migration history. It **refuses once any OPENING obligation exists**. The enum value stays (PostgreSQL cannot drop
  one without rebuilding the type; unused, it is inert), and so does its migration record. If 9-1 or O4 must also be rolled
  back, the order is 9-2, then 9-1, then O4.
- **Rehearsed locally (2026-11-10, disposable PostgreSQL container):** with one OPENING row present the script refused and
  left the schema and the migration record unchanged; with none it removed only the `20261112120100` record, and a following
  `migrate deploy` re-applied it. The rolled-back schema is **not** the pre-9-2 schema: it matched a schema-only dump taken
  after `20261112120000` alone, so it differs from pre-9-2 by exactly one retained item — the value `OPENING` in enum
  `"DuesObligationType"` (unused, inert; its migration record stays).

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
  `pnpm verify:pooling` ends `RESULT: PARTIAL … TLS is on the temporary no-verify fallback`
  with exit code 2 — never `PASS`, never exit 0 — every time it is run, so it cannot go
  unnoticed.
- **Owner:** Alexis. Nothing else removes it.
- **Exit condition:** find out what the certificate actually names (the `openssl s_client`
  command in step 11), then make the verified configuration work — the right CA file, or a
  connection string whose hostname the certificate covers. Then remove
  `DATABASE_SSL_MODE`, set `DATABASE_SSL_CA_B64`, redeploy, and rerun step 11 until
  `[1/5] TLS PASS  encrypted, server certificate verified` and `RESULT: PASS — every check ran
  and passed` with exit code 0.
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

**The monthly-generation job (G2b) — built, NOT scheduled.** `GET /api/cron/monthly-generation` exists,
and `monthly-generation` is a registered job, but `vercel.json` has **no** entry for it until the schedule
(owner decision D5) is approved. Until then:
- **Nothing calls it.** Vercel never invokes it; only a request carrying `CRON_SECRET` would. Do **not** add its
  `vercel.json` entry, create its Healthchecks.io check or call it on a hosted environment as part of a deploy.
  Scheduling, hosted execution and activation (stage 9) are separate, unapproved steps.
- **Health shows it as unscheduled.** `/api/health/jobs` reports it with `scheduled: false` and `stale: false`, so an
  unscheduled job never turns health red; a stuck run still does. `/platform/monitoring` shows **Not scheduled**.
- **The readiness screen keeps check 10 failing.** Check 10 ("Monthly charges scheduled") lists **Not scheduled** and
  **never ran**, so `ready` stays false.

**When D5 is approved** (a later, separate change), do these together:
1. Add the `vercel.json` entry and its `STALE_AFTER_HOURS` value in the same change. A unit test fails if one lands without
   the other.
2. Create its **four** Healthchecks.io checks and set their URLs for **Production only** (Sensitive). One existing variable
   and three new ones (docs/dues/MONTHLY-GENERATION-ALERTING-PLAN.md §2):

   | Check | Variable | Healthchecks schedule | Goes down when |
   |---|---|---|---|
   | **Scheduler** | `HEALTHCHECK_MONTHLY_GENERATION_URL` | cron `0 */3 * * *` UTC, grace 30 min | a run did not report (missed ping), or its `JobRun` could not be created or finalized. It is **liveness only**: a run with billing failures still pings success here |
   | **Urgent billing** | `HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL` | simple, period 7 days, grace 1 day | the new month is not observed fully billed 15 h after it opened (A), detection failed (D), or the run had run-level errors |
   | **Older-month billing data** | `HEALTHCHECK_MONTHLY_GENERATION_DATA_URL` | simple, period 7 days, grace 1 day | an older month's last pass was not clean (B): usually missing pricing the academy must fix |
   | **Workload review** | `HEALTHCHECK_MONTHLY_GENERATION_WORKLOAD_URL` | simple, period 7 days, grace 1 day | a workload-review threshold is reached (D5 brief §6). **Never a billing failure**: billing continues and the run stays `SUCCEEDED` |

   Unset, a check records `not_configured` (scheduler: `heartbeatStatus`; the others: `JobRun.alertPings`), and check 10
   cannot pass (`heartbeatNotOk` / `alertChecksNotConfigured`). Turn on the **daily** email reminder (Account Settings ›
   Email Reports) for unresolved problems. Responder: the owner alone, checking urgent emails within one hour (an
   expectation, not a guarantee); a separate backup inbox is planned but not yet created.
3. Verify the first scheduled run as described above, and that its `JobRun` shows `heartbeatStatus: "ok"` and
   `alertPings` all `"ok"` (the requests reached the four checks). That proves configuration, not alert delivery.

**Reading a run:**
- **The `JobRun` row, the Healthchecks ping and `/api/health/jobs` are the liveness signal.** The HTTP status is only
  logged.
- **A 200 means the invocation ran;** `ok: false` means it recorded failures.
- **No response ever means a month's billing is complete.** Every body says `billingCompletenessCertified: false`, and a run
  that stops at its deadline with work left is a normal `SUCCEEDED` run. The next invocation resumes at the stored cursor;
  Vercel does not retry.
- **A 500 means no run happened,** or its bookkeeping is uncertain (`finalized: "unknown"`), or the route refused an
  infeasible budget (`RouteBudgetInfeasibleError`).
- **The function limit:** F = 300 s (`maxDuration`). The 30 s cold-start and 30 s margin reserves are approved reserves,
  not measurements. With four sequential pings and the detection read reserved, the generation deadline is **212 s**
  (admission 48 s). Stage 1's throughput was measured at 227 s; how it transfers to 212 s is an estimate, not a measurement.
- **Reading an alert:** each check alerts once when it goes down and recovers on the next run without that problem, so
  one lasting problem in a check hides a second one **in the same check** (the four checks keep different kinds apart).
  Detection reports what the last finished pass observed, never that a month is complete. Conditions A and B are checked
  for **ACTIVE** organizations only (a suspended or cancelled one is refused at the visit gate and owes no billing; it is
  listed as `notActiveOrganizations` and still counts toward workload). Condition C (an activated organization without a
  progress row) is **not evaluable until stage 9** and is never reported as passed: a green urgent check does not cover it.

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

Password-reset email (`src/lib/auth/password-reset.ts`) depends on the same verified sending
domain. Until `RESEND_API_KEY` and `EMAIL_FROM` are set, every reset request answers with the
same public message, logs `{ event: "password_reset.email", outcome: "not_configured" }`, and
the token it issued is made unusable — no link is ever logged by the app. The link carries the
token in its query string, so the hosting platform's own request logs may record it: check
what Vercel's request logs keep before relying on them, and treat log access accordingly.

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
