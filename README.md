# Alliance Jiu-Jitsu — Attendance & Belt Progression App

Replaces GymDesk for Alliance Jiu-Jitsu Costa Rica (Escazú + Escalante academies).
See `PROJECT_SPEC.md` for the full product spec and `docs/superpowers/plans/` for
phase-by-phase implementation plans.

## Local setup

1. `pnpm install`
2. Copy `.env.example` to `.env` (defaults already match `docker-compose.yml`)
3. `pnpm db:up` — starts local Postgres in Docker
4. `pnpm db:migrate` — applies all migrations
5. `pnpm db:seed` — seeds both academies, belt requirements, Escazú's class
   schedule, payment plans, and one admin user (credentials printed to console
   on first run — change the password after logging in once auth ships)
6. `pnpm dev` — starts the app at http://localhost:3000 (redirects to `/es`)

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint`
- `pnpm test` — unit + integration tests (integration tests need `pnpm db:up`
  and a seeded database)
- `pnpm db:up` / `pnpm db:down` — local Postgres via Docker Compose
- `pnpm db:migrate` — `prisma migrate dev`
- `pnpm db:seed` — `prisma db seed`

## Dev-only pages

- `/es/dev/belts` (or `/en/dev/belts`) — visual QA page showing all 5 belts ×
  0–4 stripes for the belt-graphic component.

## Environment variables

`.env.example` is the source of truth, with a comment on every variable explaining what it's
for and why — copy it to `.env` and fill in real values for a real deployment. Summary:

| Variable | Required? | What it's for |
|---|---|---|
| `DATABASE_URL` | Always | What the **running app** connects with. In production this is the **pooled** connection string (Supabase port 6543) exactly as Supabase gives it — no `?pgbouncer=true` (a Prisma-engine parameter; inert on this app's driver-adapter path) and **no TLS parameters** (`sslmode`…): TLS comes from `DATABASE_SSL_CA_B64`, and the app refuses a URL carrying both. Locally it is just the dev database. See `docs/DEPLOYMENT_RUNBOOK.md`. |
| `DATABASE_SSL_CA_B64` | **Production**, for any non-local database (the app refuses to start without it or the fallback below) | The database provider's CA certificate **file**, base64-encoded (`base64 -w0 ca.crt`). A public certificate, not a secret. Enables full verification — chain and hostname — and makes rotation a config change. Set it for the same Vercel environments as `DATABASE_URL`, **including Build**. |
| `DATABASE_SSL_MODE` | Only as the temporary fallback (`no-verify`), instead of the row above | Encrypts but does **not** verify the server; warns on every start. Temporary, with an owner and exit condition in the runbook's "SSL fallback". Never set together with `DATABASE_SSL_CA_B64`. |
| `DIRECT_URL` | Only where `prisma migrate deploy` runs against a pooled database | The **direct** connection (Supabase port 5432) the Prisma CLI uses for migrations. Unset = the CLI falls back to `DATABASE_URL` (right for local dev and CI). Must name the same database as `DATABASE_URL` or the CLI refuses to run. A remote one must end `?sslmode=require&sslaccept=strict&sslcert=<path to the CA file>` — on the Prisma CLI `sslmode` alone does **not** verify the certificate. Set it on the trusted machine that runs migrations — **not** in the deployed app's environment. |
| `TEST_DATABASE_URL` | Only to run `pnpm test:integration` | A **separate** database (never the same as `DATABASE_URL`) — the integration suite resets and reseeds it. |
| `SHADOW_DATABASE_URL` | Only for `prisma migrate dev` / `pnpm db:check-drift` | An empty scratch database Prisma uses to compute migrations; never holds real data. |
| `CODE_PEPPER` | Always | Server-side secret mixed into password/token hashing. Long random value, never reused across deployments. |
| `AUTH_SECRET` | Always | next-auth's session-signing secret. Long random value. |
| `APP_URL` | Always | The deployment's own public URL (used to build links in emails). |
| `RESEND_API_KEY` | Always (for email to actually send) | The platform's Resend account key. Without it, registration/invitation/digest emails fail loudly rather than silently no-op. |
| `EMAIL_FROM` | Always | The **platform's** sender identity (e.g. `Platform Notifications <notifications@resend.dev>`) — shared by every email the app sends, for every organization. Must never name one organization; an org's own name belongs in the subject/body, which is already how it's built. Until this uses a real verified sending domain, Resend's sandbox mode only delivers to the Resend account's own address — expected, not a bug. |
| `CRON_SECRET` | Always | Shared secret Vercel Cron sends as `Authorization: Bearer <value>` to authenticate the two scheduled jobs below. Any long random value. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_LOGO_BUCKET` | Always | Supabase Storage, used only for organization logo uploads (never Postgres bytes). The service-role key is server-only — never expose it to the client. The bucket is public by design (logos render on the unauthenticated kiosk screen). **Your local `.env` points at a dev project; production uses a SEPARATE Supabase project** (`docs/DEPLOYMENT_RUNBOOK.md`, step 2) — dev verification writes real objects, and test logos must not sit beside customers'. |
| `DOTENV_CONFIG_QUIET` | Recommended, set to `"true"` | Silences dotenv's own promotional console output — a dependency printing arbitrary third-party strings into a console an agent or operator reads is a prompt-injection surface, independent of whether any given payload is malicious. |
| `E2E_AUTH_BYPASS_SECRET` | **Leave unset** in every real deployment | Dev/test-only session-minting bypass for automated browser verification. Inert unless `NODE_ENV !== "production"` **and** this is also set — leaving it unset in production is the actual safeguard, not just the `NODE_ENV` check. |

Two scheduled jobs run on Vercel Cron (`vercel.json`), authenticated by `CRON_SECRET`:

| Job | Schedule | What it does |
|---|---|---|
| `/api/cron/weekly-digest` | Monday 07:00 America/Costa_Rica (`0 13 * * 1` UTC) | Emails every organization's staff a weekly summary (attendance, inactive students, overdue payments). Email-only — never writes an in-app notification. |
| `/api/cron/promotion-auto-award` | Daily 06:00 America/Costa_Rica (`0 12 * * *` UTC) | Auto-awards promotions for organizations using attendance-based tracks. |

## Platform admin bootstrap

`isSuperAdmin` is a boolean on `User`, deliberately never granted through any form, API, or
profile field (`MULTI_ACADEMY_AND_KIDS_BELTS.md` Appendix C decision 5) — it crosses every
organization's boundary, so it can only ever come from someone who already has it, or from a
one-time manual step for the very first grant. There is no self-service path, on purpose.

**The very first platform admin, in a brand-new deployment:** see
`docs/DEPLOYMENT_RUNBOOK.md`'s own step-by-step first-deploy sequence — the exact order
matters (register-then-approve alone is circular with zero users in the database; the
runbook's sequence is verified against the real code in `approve-organization.ts`, not
assumed from how the pieces are supposed to fit together) and is kept in one place rather
than duplicated here where it could drift out of sync.

There is deliberately no script for this step: a script that grants platform-wide access by
running it is exactly the "backdoor admin account" shape `scripts/lib/seed-safety-guard.ts`
already refuses to let the deterministic seed become in production.

**Every subsequent platform admin** — once you have the first one — is a normal in-app action:
sign in, go to `/platform/admins`, enter the person's email under "Grant," and submit. The
target user must already have a real account (the form refuses an unknown email); it does not
create one.

**Revoking** a platform admin is on the same page. You cannot revoke your own access (a
deliberate choice — it would lock you out of the very page you're using to manage it), and the
system refuses to leave zero platform admins.

## Shipping a change — the closeout convention

"Merged, CI green" is **not** the end of a change. It is the end of the *PR*; the change is not
done until it is verified to be **on `main`**. This routine exists because a PR once merged
successfully into the wrong base and `main` silently never received it — nobody had checked
that it arrived (see revision 33 of `docs/MULTI_ACADEMY_AND_KIDS_BELTS.md`).

1. **One PR, one base, always `main`. No stacked PRs.** Start every change from a fresh branch
   off an up-to-date `main`. If work is sequential, merge the first PR *before* the next
   starts. GitHub does not retarget a stacked PR when its base merges — only when the base
   *branch is deleted* — so a stack can merge into a branch that is about to be thrown away.
2. **UI changes are verified in a real browser as a genuinely registered user** — register
   through `/register-academy`, approve, accept the invitation, sign in — never as a seed
   user. Seeds are the only thing that ever wrote the rows some bugs concern
   (the owner lockout, revision 33).
3. **Name a marker in the PR description**: a file and a distinctive string that only exists
   once the change has landed (the PR template has a field for it).
4. **After the merge, verify the change is ON `main` — this is a step, not a habit:**
   ```
   git fetch origin
   git show origin/main:<path> | grep -c "<marker>"     # must be >= 1
   ```
   or, for a merge or rebase (not a squash — a squashed commit is never an ancestor of `main`):
   `git merge-base --is-ancestor <sha> origin/main`. Checking that the PR *shows* "Merged" is
   not enough.
5. **Only then delete the branch** (local and remote). Never delete a branch before step 4
   has passed: it may hold the only copy.
6. **Clear verification debris from the dev database** (organizations, users, registration
   attempts, uploaded storage objects the verification created) and say what remains, so the
   dev database stays something you can reason about rather than a pile of accounts that look
   like live bugs.
