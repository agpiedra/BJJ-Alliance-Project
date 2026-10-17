# Superadmin monitoring — discovery and bounded plan

**Status:** planning only. No code, config, infrastructure, or database changes. Nothing in this document has been built, installed, purchased, or activated.

**Scope:** a central monitoring area in the existing superadmin portal (`/platform`), for the platform owner — not an academy-owner dashboard, not a per-tenant view. Covers all six requested signal areas; some areas have real in-app data today, others start as an honestly-labeled "not verified" placeholder — see §1 and §5.

**What this is not:** proof the app can handle 1,000 concurrent users. Monitoring observes behavior under whatever load actually occurs; it does not generate or validate load. Load testing is a separate workstream (see §5's roadmap closing note).

**A note on evidence throughout this document.** Three different things get conflated easily, and this revision exists specifically to stop doing that:
- *Code implements X* — verifiable by reading the file. The strongest claim this document can make.
- *X is correctly configured/operating in production* — not verifiable from this repository at all. No production logs, env vars, or provider dashboards were accessed. "Unverified" means exactly that — not "probably fine," not "probably broken."
- *X is absent from repository configuration* — means unverified from code, never "confirmed absent." An external service can be wired up entirely in a provider's own dashboard, invisible to a repo search.

---

## 1. Inventory — what exists today

Three independent read-only sweeps covered the owner's six required areas. Every row below is sourced to a file:line; the most load-bearing claims were independently re-verified against the actual files before this document was written.

Legend: ✅ **Implemented** (code path confirmed to exist and be wired into a real trigger — production operation is a separate, unverified claim; see the note above) — Unverified (depends on a provider/env-var state this repository cannot show either way) — ❌ **Missing** (no implementation found)

### 1a. Availability, request volume, latency, errors, saturation

| Signal | Status | Evidence |
|---|---|---|
| DB health check | ✅ Implemented | `src/app/api/health/route.ts` — **public, unauthenticated** (confirmed: no auth check in the handler), checks DB only via `checkDatabaseHealth()`, 5s-cached, 200/503. Explicitly designed per a prior decision ("C1") as the one thing an uptime monitor needs. |
| Something external actually polling it | Unverified from code | No repository configuration references an uptime monitor, load balancer, or Healthchecks.io check targeting `/api/health`. This means unverified from this repository, not confirmed absent — such a check could be configured entirely inside a third-party dashboard. **Needs a direct check of whatever uptime-monitoring account(s) may already exist**, not a design decision. |
| Job freshness/staleness | ✅ Implemented | `src/app/api/health/jobs/route.ts`, gated by `CRON_SECRET` (see the correction in §1g — this is a separate auth model from `/api/health`'s public access). Reads `JobRun`, flags `stale` and `stuck`. See §3's correction: its aggregate `ok` field does **not** account for a `FAILED` run that is neither stale nor stuck. |
| Dead-man's-switch heartbeat (weekly-digest) | Implemented, production state unverified | `src/lib/jobs/heartbeat.ts` pings `HEALTHCHECK_DIGEST_URL` if set; `"not_configured"` is an explicit, documented, expected state until that env var is set. `docs/DEPLOYMENT_RUNBOOK.md` has the manual setup steps. Whether the env var is actually set in production is an access/verification gap, not something code can answer. |
| Request volume | ❌ Missing in-app; **required roadmap item, not removed** | No `instrumentation.ts`, no timing middleware, no `@vercel/analytics`. **Initial integration proposed for Increment 0:** a static link to the Vercel project dashboard (Vercel's own project view shows request/invocation counts natively, without any package install, for any project actually deployed there), explicitly labeled "external — not verified this session." Whether this app is *genuinely* the production deployment Vercel is serving (repository configuration — `vercel.json`, the `@vercel/functions` dependency — indicates a Vercel *target*, it does not verify an actual live, traffic-serving deployment) needs confirming by whoever has Vercel account access. |
| Latency | ❌ Missing in-app; same treatment as request volume | No timing instrumentation exists. Same proposed Increment 0 treatment: link to the Vercel dashboard, labeled not-verified, pending confirmation Vercel is the real deployment target. |
| Error rate | ❌ Missing in-app; same treatment | No error-rate aggregation exists (see §1b for individual error *logging*, which is a different thing from a *rate*). Same proposed Increment 0 treatment: link to the Vercel dashboard (function error counts are part of its native project view) plus, once adopted, an APM dashboard link (§5 Increment 2). |
| DB connection-pool saturation | ❌ Missing in-app; **required roadmap item, not removed** | No explicit pool size configured in `src/lib/prisma/database-pool.ts`, no metrics exposed by the app. `.env.example` comments reference a Supavisor pooler, consistent with — but not proof of — Supabase as the actual Postgres host. **Initial integration proposed for Increment 0:** a static link to the Postgres host's own dashboard (Supabase, if confirmed), labeled not-verified, since connection/saturation metrics live natively there if that is genuinely the host. |
| Hosting platform (repository signal only) | Repository configuration indicates Vercel | `vercel.json` (cron config), `@vercel/functions` dependency, no Dockerfile for the app (`docker-compose.yml` is dev/test Postgres only). This is a **configuration signal, not confirmation of the live deployment target** — see the row above. |

### 1b. Application errors and investigation context

| Signal | Status | Evidence |
|---|---|---|
| Error-tracking/APM SDK | ❌ Missing | No `@sentry/*` or any APM package in `package.json`. |
| Structured error logging | ✅ Implemented, ad hoc | 37 `console.error(...)` call sites across `src/`, a consistent informal shape (`"[module] message", {context}` — e.g. `src/app/[locale]/(staff)/admin/branding/actions.ts:223,268,330`), no shared logger utility. Context is inconsistent — some calls carry `organizationId`/`actorId`, others don't. This proves the *logging calls exist in code*; whether Vercel's platform actually retains/surfaces these `console.error` lines anywhere a human would see them in production is unverified from this repository. |
| Correlation/request IDs | ❌ Missing | No `requestId`/`correlationId`/`traceId` anywhere in request handling. (One unrelated `requestId` hit is a React ref counter, not a trace ID.) |
| Release/build/version identification | ❌ Missing | Vercel sets `VERCEL_GIT_COMMIT_SHA` etc. automatically at runtime, but nothing in the app reads or surfaces it — no `/version` endpoint, nothing attached to logs. |
| Audit trail (distinct from error logging) | ✅ Implemented | `AuditLog` (`prisma/schema.prisma:1770`) — `actorId`/`academyId`/`organizationId` (all nullable, deliberately, for system/platform-level entries), `action`, `entityType`, `entityId`, `before`/`after` JSON, `createdAt`. Actively written across branding, payments, org approval/billing, superadmin grants, and cross-tenant denials (§1f). This is an audit trail, not an error-rate metric — see §3 for why those are different things. |

### 1c. Critical operations

**`KioskAttempt` only persists two booleans (`success`, `countsAsFailure`) — not a full outcome classification, and neither boolean means quite what its name suggests.** Traced both write paths, plus the caller that finalizes them, directly:

- `reserveKioskAttempt` (`src/lib/kiosk/rate-limit.ts:127`) creates the row *before* the code is evaluated. When the reservation is **allowed**, the provisional row is written `countsAsFailure: true` (line 169's comment: "presumed a guess until `finalizeKioskAttempt` learns otherwise") — the opposite of what the name implies at creation time; it is corrected only if and when finalization succeeds. When the reservation is **refused** (already locked out / rate-limited), the row is written `countsAsFailure: false`, identical in shape to a legitimate non-guess outcome.
- `finalizeKioskAttempt` (`src/lib/kiosk/rate-limit.ts:202`) learns the real outcome from the richer `KioskAttemptOutcome` union (`success | invalid_code | already_checked_in | no_open_class | class_selection_required | invalid_class | class_not_open`, defined in the same file) but **writes only `success` and `countsAsFailure` back** (lines 207-214) — the specific outcome string is discarded, never persisted. Its own doc comment states that if this update itself fails, the row is left at whatever `reserveKioskAttempt` wrote and is never retried — "the conservative direction," in its own words, but it means a real success can be left permanently recorded as a counting failure if finalization throws.
- `src/app/api/kiosk/check-in/route.ts:188-189` finalizes a `queued_for_review` result — confirmed by `src/lib/kiosk/perform-check-in.ts:115-116` to mean *only* "kept as untrusted evidence for staff, or a recognized retry of an already-queued event — not a refusal and **not an attendance**" — with the outcome `"success"`. A recognized retry of the same offline event therefore also finalizes as `"success"`.

What this means for any metric built on this table — **none of the three rows below is what its plain-English name would suggest; each needs the honest label it's given**:

| Metric (honest label) | Status | What it actually counts |
|---|---|---|
| **"Attempts recorded as successful"** | ✅ Precisely computable, but not "completed check-ins" | `COUNT(*) WHERE success = true`. Includes every row `finalizeKioskAttempt` was told `"success"` for — which includes retained-for-review outcomes and recognized retries of an offline event, neither of which is a unique attendance record. Never label this "completed check-ins" or "unique attendance." |
| **"Attempts counted toward PIN limiting"** | ⚠️ Computable, but not an exact guess count | `COUNT(*) WHERE success = false AND countsAsFailure = true`. Includes allowed-but-not-yet-finalized reservations (provisional state, corrected only on successful finalization) and any row a failed finalization left stuck at its provisional value. Close to, but not identical to, the count of genuine wrong-code guesses — label it as what it is ("counted toward limiting"), not as a confirmed abuse count. |
| **"Other recorded attempts"** | ⚠️ One undifferentiated bucket | `COUNT(*) WHERE success = false AND countsAsFailure = false`. Mixes double-taps, arrivals outside any class window, class-selection-required/refused, and attempts the limiter rejected before evaluating the code at all. These cannot be told apart from stored data today. |
| Lockout/rate-limit **events** | ❌ Excluded from Increment 0 | No row or field records "a lockout occurred" — not even approximately reliably, given the provisional-state and finalization-failure caveats above would bias any reconstructed window. **Omitted from Increment 0 entirely**, not shown as an inferred estimate, per the standing rule: never present a reconstructed window as a recorded lockout event. Revisit only if a future schema change persists the real outcome (or a dedicated lockout-event write) that would let this be computed from actual evidence rather than inference. |
| Offline-queue delivery (client → server) | ❌ Missing | `src/lib/kiosk/offline-queue.ts` — entirely client-side (IndexedDB). A dropped/failed sync is visible only as a browser `console.warn` and an in-memory summary shown once in the UI. **Nothing reaches the server.** See §5's correction to the original (overstated) telemetry proposal. |
| Offline replay, ambiguous match | ✅ Implemented | A tap that *does* reach the server but can't be cleanly attributed becomes a `QueuedCheckIn` row (reason enum: `TIMESTAMP_NOT_VERIFIED` / `NO_CLASS_OPEN` / `SEVERAL_CLASSES_OPEN`) — server-observable. |
| Recorded successful payment events | ✅ Precisely computable, narrowly | `src/lib/dues/ledger/record-payment.ts` writes one `AuditLog` row (action `duesPayment.record`) per **successful** payment. A count of these rows is a count of recorded successful payment-recording events — **not** a payment failure rate (business-rule refusals like `notActive`/`alreadySettled`/`futureDate` are typed results, never logged or audited anywhere — their count is genuinely unknown, not merely unaggregated) and **not** revenue (this view must never sum `after.amount`; that belongs to the actual payments/accounting screens, not a system-health page). |
| Unexpected payment-recording DB failure | ❌ Missing | Uncaught, falls through to Next's generic 500 handling, no app-level log line found in this path. |
| Invitation/registration email | Implemented, not persisted | Failures are logged (`console.error("[approve-organization] invitation email failed to send", {...})`, confirmed directly in this session's own PR #130 work) but never written to a table. No way today to compute "how many invitation emails failed in the last 24h" from the database — only from raw platform logs, which this plan does not assume access to. |
| Weekly-digest email | ✅ Implemented | The one email type with real counted, queryable failure visibility — `sent`/`failed`/`skipped` on its `JobRun` row. |

### 1d. Scheduled jobs

**Job outcome and job freshness are two different signals — the existing endpoint's aggregate conflates them.** Read `src/app/api/health/jobs/route.ts` directly (line 70):

```ts
const healthy = Object.values(jobs).every((job) => !job.stale && !job.stuck);
```

`stale` means "no run started recently enough"; `stuck` means "a `RUNNING` row has sat too long." Neither checks `lastRun.status`. A job that ran exactly on schedule and finished (so `stale: false`, `stuck: false`) but with `status: "FAILED"` or `"PARTIAL"` makes this `healthy` boolean `true` — even though the job just failed. The per-job `lastRun.status` field is already present and correct in the response (`JobStatus`: `RUNNING | SUCCEEDED | PARTIAL | FAILED`, `prisma/schema.prisma:1829`); the aggregate simply doesn't look at it. A monitoring dashboard must never reuse that `ok`/`healthy` aggregate as "job health" — it must show, as separate fields, for each job:

| Field | Source | Status |
|---|---|---|
| Last run **outcome** (`SUCCEEDED`/`PARTIAL`/`FAILED`/`RUNNING`) | `JobRun.status`, most recent row | ✅ Already in the existing query's result — just not surfaced as its own signal today |
| Last run **failed-item count** | `JobRun.failed` | ✅ Already in the existing query's result |
| **Last successful run** (distinct from "most recent run") | ⚠️ Requires a *second* query: most recent row `WHERE status = 'SUCCEEDED'` | Not currently computed anywhere — if the last 3 runs all failed, "most recent run" and "last successful run" are different rows, and only a separate, status-filtered lookup answers the second question |
| **Stale** | `JobRun`, same logic as today | ✅ Implemented |
| **Stuck** | `JobRun`, same logic as today | ✅ Implemented |

**Contract note:** `/api/health/jobs`'s own public JSON response and its `CRON_SECRET` gate stay exactly as they are today — nothing about that endpoint's existing contract changes. The monitoring page calls the same underlying `JobRun` query logic directly (not the HTTP route — see §1g), and additionally performs the one new "last successful run" lookup above, which is new query logic, not new instrumentation (no new writes, no new table).

| Signal | Status | Evidence |
|---|---|---|
| Job execution record | ✅ Implemented | Exactly one cron exists today (`vercel.json`: `weekly-digest`, Mondays). It runs through a **shared, reusable wrapper**, `src/lib/jobs/run-scheduled-job.ts`, which writes a `JobRun` row at start and finish (status, counts, capped per-org breakdown, truncated error summary) — this wrapper is generic infra every future cron would reuse, not a one-off. |
| Missed/stuck detection | ✅ Implemented | Computed purely from `JobRun`, no external dependency (see the outcome-vs-freshness correction above for what this does and doesn't tell you). |
| Monthly obligation generation trigger | ❌ Missing, confirmed unambiguous | `src/lib/dues/monthly-generation.ts`'s own doc comment states plainly: *"No caller. Not a route, not a server action, no scheduler entry... a plain library function, tested by calling it directly."* `JOB_NAMES` (`src/lib/jobs/job-names.ts`) lists only `"weekly-digest"`. The generation **logic** is fully built; nothing invokes it. Per the owner's own framing, this belongs in this plan only as a **future dependency**, not as a gap to monitor today — there's no job to watch yet. |

### 1e. Backup, quotas, capacity, cost

These remain required planning items — provider-managed data is a dependency to account for, not a reason to drop the requirement. §5 restores each of these to the increment roadmap with a concrete proposed treatment (a labeled external link plus an explicit not-verified status; never an invented number).

| Signal | Status | Evidence |
|---|---|---|
| Backup scripts/docs at the app layer | ❌ Missing at the app layer | Nothing in the repo. `docker-compose.yml` is dev/test only, no backup volumes or cron. This says nothing about whether the hosting provider backs up the database — that's the next row. |
| DB hosting provider / backup policy | Unverified from code | The `.env.example` Supavisor-pooler reference is consistent with Supabase as the host, but does not confirm it, and says nothing about plan tier or whether point-in-time-recovery/automated backups are enabled. This is a provider-dashboard fact — an access/discovery gap for whoever administers that account, not a design decision for this plan. |
| Restore-test evidence | ❌ Missing | No restore drill evidence found in the repo; restore-test evidence by its nature would live as an operational record, not code, so its absence here is expected regardless of whether a drill has actually been run. |
| Storage quota (Supabase logo storage) | ❌ Missing in-app; roadmap item | No tracking code in the app. Proposed treatment: a labeled link to the Supabase storage dashboard (§5), not an in-app rebuild of what the provider already shows. |
| Email quota/volume (Resend) | ❌ Missing in-app, in general; ⚠️ partial for one job | No general tracking. The one exception: weekly-digest's own `sent`/`failed`/`skipped` counts on its `JobRun` row — real, but scoped to that one job only, not an account-wide Resend quota view. |
| Cost signals | ❌ Missing in-app; roadmap item | No cost-tracking code found. Proposed treatment: labeled links to each provider's own billing dashboard (§5). |

### 1f. Security signals

Login/reset abuse is flagged here as an inventory finding only. Per §5's correction, closing it is scoped as a **separate security-hardening assessment**, not folded into this monitoring plan as an increment — see the note at the end of §5.

| Signal | Status | Evidence |
|---|---|---|
| Kiosk PIN abuse (preventive control) | ✅ Implemented — the strongest existing preventive control in the app | `src/lib/kiosk/rate-limit.ts`, DB-backed via `KioskAttempt`, per-`(academyId, kioskTokenHash)`, advisory-lock-serialized, two-tier (rate-limit + lockout). The control itself works correctly from the limiter's own internal (non-persisted) failure count; what the *persisted* `KioskAttempt` rows can retroactively tell a monitoring dashboard is narrower — see §1c's corrected metric labels. |
| Login brute-force | ❌ Missing | No rate limit or lockout found near the login action or `src/auth.ts`. |
| Password-reset abuse | ❌ Missing | No rate limit found on the reset flow. |
| Other rate limiting | ✅ Implemented, one more instance, no shared utility | Logo upload (`src/app/[locale]/(staff)/admin/branding/actions.ts:161-174`) — hand-rolled, counts `AuditLog` rows in a time window. Two bespoke implementations total; no reusable rate-limit library. This plan does **not** propose touching either existing implementation — see §5. |
| Denied cross-tenant access | ✅ Implemented | `src/lib/tenant/context.ts:136` — `resolveActionContext` both `console.error`s **and** writes an `AuditLog` row (`action: "organization.accessRefused"`) on every refused cross-org action attempt. Verified directly. |
| Unscoped-query guard (`UnscopedTenantQueryError`) | Exists, but it's a **developer-mistake guard**, not an attacker signal | Blocks code that forgot to scope a query by `organizationId`. Throws, uncaught → 500, not separately audited. Don't frame it as a security-monitoring signal — that would mislabel an engineering safety net as an incident. |
| Privileged changes | ✅ Implemented | Org approve/suspend/billing changes and superadmin grant/revoke all write `AuditLog` inside the same transaction as the privileged write. |
| Bulk-operation detection | ❌ Missing | Nothing found. |
| Suspicious traffic (IP/UA patterns, scraping) | ❌ Missing | Nothing found beyond the kiosk's own per-key rate limit. |

### 1g. Superadmin portal structure (existing pattern to extend, not replace)

| Item | Finding |
|---|---|
| Route group | `/platform/**` (`src/app/[locale]/platform/{page,organizations/*,admins}.tsx`) |
| Page-level guard | `requireSuperAdmin()` in `platform/layout.tsx` wraps the **entire group** — one enforcement point, not per-page. A new page under `/platform` inherits this automatically. |
| Action-level guard | `resolveSuperAdminActionContext()` — every mutating action under `/platform` calls it first, consistently, not ad hoc. |
| Guard semantics | Re-reads `isSuperAdmin`/`active` from the database on every call (never trusts the session/JWT alone); returns `notFound()`, not a 403, so an unauthorized visitor can't even learn the route exists. |
| Auth boundary — corrected | `/api/health` is **public and unauthenticated by design** (§1a — no auth check in its handler, deliberately, so an external uptime monitor can call it with no credential). `/api/health/jobs` is the one gated by `CRON_SECRET` (`src/app/api/health/jobs/route.ts:41`) — a machine-to-machine secret for cron infrastructure, not a session credential, and not something a logged-in superadmin's browser should present either. The monitoring page must not simply "reuse the routes" for either case: it calls the underlying **library functions** directly (`checkDatabaseHealth()`, the `JobRun` query), each independently authorized via `requireSuperAdmin()` at the point of data access (§5's acceptance criteria), never by fetching `/api/health/jobs` over HTTP with the cron secret, and never by relying solely on the fact that the page sits under `/platform`'s layout guard. |

### 1h. Already-installed tooling

Checked the full root `package.json` dependency list: no Sentry/APM package, no logging library (pino/winston), no rate-limiter package (`rate-limiter-flexible`, `express-rate-limit`), no `helmet`, no Vercel Analytics/Speed Insights. `src/middleware.ts` does auth/i18n routing only — no security headers, no edge-level rate limiting. One CI workflow (`.github/workflows/parity-check.yml`) — typecheck/lint/test/build/smoke/browser/parity-diff, no monitoring or backup references.

---

## 2. What this adds up to

The app already produces real in-app data for a meaningful slice of the owner's requirements — not the whole list:

- **`JobRun`** → scheduled-job outcome and freshness, with the correction in §1d (outcome and freshness are two different fields, not one aggregate).
- **`KioskAttempt`** → three honestly-labeled counts ("attempts recorded as successful," "attempts counted toward PIN limiting," "other recorded attempts") — none of them a precise "completed check-ins" or "wrong-code guesses" figure; see §1c for exactly why.
- **`AuditLog`** → recorded successful payment events, cross-tenant denials, and privileged changes — recorded-event counts, not failure rates or revenue (§1c, §1f).
- **`checkDatabaseHealth()`** → DB up/down, for the one check it performs.

For request volume, latency, error rate, saturation, backup/restore evidence, and quota/cost signals, the app has **no in-app data today** — these are restored to the roadmap in §5 with an honest starting treatment (a labeled external link, explicitly marked not-verified), not dropped from scope because the underlying provider likely already has something useful.

The genuine gaps, stated precisely:

1. **Offline-queue drops never reach the server** — best-effort reporting on reconnect is the most this can ever be, by the nature of being offline (§5 corrects the earlier, overstated "one guaranteed POST" framing).
2. **Invitation/registration email failures aren't persisted** — console-only.
3. **No external alerting** — nothing running *inside* the app can alert when the app itself is down; this is the one requirement an in-app page can never satisfy by its own construction.
4. **No error-tracking/APM, no correlation IDs, no release tagging** — investigation context for genuine application errors (not business-rule refusals) is thin.
5. **No login/reset rate limiting** (a *preventive control* gap) — scoped out of this plan as a separate security-hardening assessment (§5); **bulk-operation and suspicious-traffic *detection*** stay on this plan's own roadmap (§5) — detection is a monitoring concern, only *changing a preventive control* is not.
6. **Request volume, latency, error rate, saturation, backups, quotas, and cost all currently live only in provider dashboards (if at all)** — not an app-code gap exactly, but a visibility gap this plan addresses with links, not invented numbers.

---

## 3. Recommendation: is an external service needed?

**Likely, for the "works when the app is down" requirement specifically — but which one, and whether anything beyond that is needed, is not yet decidable**, because the provider capabilities that would answer it haven't been verified.

The full requirement set spans availability, request volume, latency, error rate, saturation, application errors with investigation context, critical operations, job outcomes, backup/restore, quotas, costs, and security signals. No single lightweight tool covers all of that, and neither does a from-scratch in-app build — most of it is already somebody else's job:

- **Vercel** (if confirmed as the actual production deployment — §1a) natively shows request volume, function invocation counts, and function errors in its own project dashboard, with no package install required. Whether that native view is sufficient, or whether `@vercel/analytics`/`@vercel/speed-insights` would add enough value to justify adding them, is unverified — it depends on what that dashboard already shows, which needs checking, not guessing.
- **The Postgres host** (Supabase, if confirmed — §1a, §1e) natively shows connection/saturation metrics, storage usage, and backup/point-in-time-recovery configuration in its own dashboard, if that is genuinely the host and whatever plan tier is active supports those views.
- **Resend** (confirmed as the email provider) has its own send-volume and quota dashboard.

**What a full Grafana/Prometheus stack would require that doesn't exist today:** metrics exporters, a hosted or self-hosted Grafana instance, and ongoing maintenance (no `prom-client`, no `instrumentation.ts`, no metrics endpoint anywhere in this codebase). Whether that investment is worth it depends entirely on whether the provider-native dashboards above turn out to be sufficient or too fragmented to be practically usable by one person checking multiple logins — a question this plan cannot answer without someone actually opening those dashboards. **Grafana is not ruled in or out here; it is explicitly deferred pending that verification step**, which belongs in Increment 0/1 as a discovery action, not a code task (§5).

**The one requirement that is independently decidable without that verification:** "external alerting must work when the app itself is down" cannot, by construction, ever be satisfied by a page that only loads when the app is up. That specific piece needs *something* outside the app pinging `/api/health` or receiving a heartbeat — the app already has half of this wired for the weekly-digest job (Healthchecks.io, production configuration unverified — §1a). Which provider is the right one (extend Healthchecks.io, adopt a separate uptime pinger, or something a provider dashboard already offers) is a genuine owner decision (§7), not something this plan resolves.

**For application error tracking** (item 2) specifically, a standard error-tracking SDK (Sentry has first-party Next.js support and a free tier) is the one addition that would add real value beyond what any provider's generic dashboard shows — but it is still a recommendation requiring owner approval, not a prerequisite for shipping Increment 0.

---

## 4. Proposed superadmin page structure

New route: `src/app/[locale]/platform/monitoring/page.tsx`, under the existing `/platform` layout. The layout's `requireSuperAdmin()` gate covers page *navigation*; per §5's acceptance criteria, each data-fetching function the page calls also independently calls `requireSuperAdmin()` at the point of data access — not relying solely on the parent layout.

| Panel | Backed by | Metric definition (see §1 for full derivation) |
|---|---|---|
| **System status** — DB up/down, response time | `checkDatabaseHealth()`, called directly | Single DB connectivity check, 5s-cached. Not a latency/saturation metric. |
| **Scheduled jobs** — per job: last-run **outcome**, failed-item count, last **successful** run, stale flag, stuck flag, heartbeat status, all shown as separate fields | `JobRun` query, extended with the "last successful run" lookup (§1d) | Outcome and freshness are never collapsed into one healthy/unhealthy boolean. |
| **Kiosk activity** — "Attempts recorded as successful," "Attempts counted toward PIN limiting," "Other recorded attempts," each shown with its own caveat caption, no lockout count | `KioskAttempt` | Exactly the three categories §1c establishes as actually computable, with the honest labels §1c requires — no finer breakdown, and no inferred-lockout figure, is claimed. |
| **Security — cross-tenant access denials** — recent list: actor, target org, reason, timestamp | `AuditLog` where `action = "organization.accessRefused"` | Recorded refusal events. |
| **Privileged changes** — recent list: org approve/suspend/billing, superadmin grants/revokes | `AuditLog`, filtered by action | Recorded privileged-change events. |
| **Payment activity** — count of recorded successful payment-recording events only | `AuditLog` where `action = "duesPayment.record"`, count only | Explicitly not a failure rate (refusals aren't persisted anywhere) and not revenue (no amount aggregation). |
| **External dashboards** — request volume, latency, error rate, DB saturation, backups, storage/email quotas, cost | Static labeled links (Vercel project dashboard, Postgres host dashboard, Resend dashboard), each tagged "external — not verified this session" | No query, no computed number — an honest placeholder restoring these to the page instead of silently dropping them. |
| **Email delivery** — invitation/registration failures | *(future increment — §5)* | Not in Increment 0: requires new persistence, not yet built. |
| **Offline-queue drops** | *(future increment — §5, with the corrected best-effort framing)* | Not in Increment 0: requires new client+server work, not yet built. |

**Data-minimization note (architecture requirement, not optional):** the page shows *aggregates and recent-event metadata* (counts, timestamps, actor/org IDs as opaque references, action names) — never raw payment amounts, student names, emails, kiosk tokens, or IP addresses, and never a dumped `AuditLog.after` payload. IDs are shown because a superadmin needs to know *which* organization an event concerns, but each query's `select` clause names only the fields the panel needs — never `select: { }` omitted (which would return everything) and never a raw-payload field. A superadmin wanting full payment or audit detail already has that via existing admin screens; this page is for system health, not a second investigation UI.

---

## 5. Launch scope and increments

### Increment 0 — smallest useful launch
A read-only page with the first seven rows of §4's table: `JobRun`, `KioskAttempt`, `AuditLog` (three distinct action filters), `checkDatabaseHealth()`, and a small set of static external-dashboard links. No new tables, no new packages, no new writes.

**Metric definitions used (binding for this increment, not aspirational — see §1c for the full write-path tracing each of these rests on):**
- *"Attempts recorded as successful"* = `KioskAttempt` rows where `success = true`. Includes retained-for-review outcomes and recognized offline-event retries (`check-in/route.ts:188-189` finalizes both as `"success"`) — not unique attendance, and must never be labeled "completed check-ins."
- *"Attempts counted toward PIN limiting"* = `KioskAttempt` rows where `success = false AND countsAsFailure = true`. Includes allowed-but-not-yet-finalized provisional reservations and any row a failed finalization left stuck — not a confirmed, exact count of wrong-code guesses, and must never be labeled "abuse" or "attacks."
- *"Other recorded attempts"* = `KioskAttempt` rows where `success = false AND countsAsFailure = false` — one undifferentiated bucket (double-taps, outside-window arrivals, selection-required/refused, and rate-limiter-rejected attempts are all indistinguishable here).
- **No lockout/rate-limit event metric ships in this increment.** Excluded entirely, not shown as an inferred estimate — revisit only if a future schema change persists real evidence this could be computed from.
- *Recorded successful payment events* = count of `AuditLog` rows where `action = "duesPayment.record"` — never summed into a dollar figure, never presented as a failure rate.
- *Job outcome* = `JobRun.status` of the most recent row, shown separately from *stale*/*stuck*, which never substitute for it.
- *Last successful run* = `JobRun.status = 'SUCCEEDED'`, most recent — a distinct lookup from "most recent run."

**Bounded-read design (binding):**
- **Time window:** fixed "last 24 hours" for every recent-event list and count in this increment — no date picker yet.
- **Pagination/limits:** every recent-event list query is `ORDER BY createdAt DESC LIMIT 50`.
- **Query-cost note:** neither `KioskAttempt` nor `AuditLog` has a `createdAt`-leading index today (`KioskAttempt` is indexed on `(academyId, kioskTokenHash, createdAt)` and `(organizationId)`; `AuditLog` on `(entityType, entityId)`, `(actorId)`, `(organizationId)` — confirmed directly in `prisma/schema.prisma`). A platform-wide, time-bounded query across either table is not index-backed today. At current row volume this is an acceptable sequential-scan-plus-limit cost; if volume grows enough to matter, adding a `createdAt` index is a small, additive, low-risk migration — a build-time decision for whoever implements this increment, not a database change made by this plan.
- **Per-panel failure isolation:** each panel's query is fetched independently (e.g. `Promise.allSettled`), so one panel's failure (including the DB-health panel reporting down) renders that panel's own "data unavailable" state without blanking the rest of the page.
- **Authorization:** every server-side data-fetching function for this page calls `requireSuperAdmin()` itself, at its own top — not inherited only from the page/layout. This holds even though `/platform/layout.tsx` already gates the route, as defense in depth consistent with how `resolveActionContext`/`getScopedDb` are checked at the point of data access elsewhere in this codebase, not assumed from a caller.
- **Field selection:** explicit `select` on every query — no `ipAddress`, no `kioskTokenHash`, no raw `after`/`before` JSON, ever rendered in this page.

- **Dependencies:** none external. No new tables, no new packages, no provider decisions required to ship this specific increment.
- **Acceptance checks:**
  - Page is reachable only by an active, currently-flagged superadmin, verified at the data-fetching layer, not only the page layout.
  - Page performs zero new database writes.
  - Each panel's number matches a direct, independently-run query of the underlying table using the exact metric definitions above — not a looser approximation.
  - No panel renders a raw payment amount, student name, email, IP address, or kiosk token.
  - The job-outcome panel shows a `FAILED` most-recent run as failed, even when `stale: false` and `stuck: false` (the specific case the existing `/api/health/jobs` aggregate gets wrong).
  - The kiosk-activity panel uses the exact three honest labels above (never "completed check-ins," never "wrong-code guesses," never any lockout/abuse figure) and shows no finer breakdown than those three.
  - `/api/health` and `/api/health/jobs`'s existing contracts (response shape, auth model) are unchanged by this work.
- **Provisional effort:** small-to-medium. The jobs panel needs one new query (last-successful-run lookup) beyond what exists today; everything else is a handful of bounded, `select`-scoped read queries against tables that already exist, reusing the existing `/platform` layout.

### Increment 1 — external alerting, and the two critical-operation gaps
- **External alerting for `/api/health`** so the owner is notified when the app itself is unreachable — provider choice is a genuine owner decision (§7); building the integration itself (pointing a chosen provider at the existing public endpoint) is routine once that choice is made.
- **Confirm the `HEALTHCHECK_DIGEST_URL` env var is actually set in production** for the existing weekly-digest job — an access/verification task, not a code task.
- **Persist invitation/registration email failures** (extend `AuditLog` usage, same pattern already used elsewhere — no new table required), then surface them in place of the Increment 0 placeholder.
- **Best-effort offline-queue-drop reporting.** Corrected scope: a client that is genuinely offline cannot report anything until it reconnects, and if the tab/device never reconnects before the drop is cleared from local state, that drop is permanently unreported — this is a structural limit, not a gap this increment can close. What it *can* do: on reconnect, best-effort-report any drops still held locally, authenticated (the existing kiosk-session/token the client already holds), with a bounded payload (counts and timestamps only, no student/class detail), deduplicated against what was already reported (so a retried reconnect doesn't double-count), and itself rate-limited (so a misbehaving client can't flood this endpoint). The monitoring page must display this metric with an explicit "best-effort; drops before a device last reconnects are not counted" caveat, not as a complete count.
- **Dependencies:** owner decision on alerting provider.
- **Acceptance checks:** simulate a failed email send and a reconnect-reported offline drop in the isolated test environment; confirm both appear in the monitoring page with correct counts. Confirm the chosen external alert actually fires when `/api/health` is made unreachable against a non-production target. Confirm a duplicate reconnect report does not double-count.
- **Provisional effort:** small-to-medium for the two persistence additions and their dedup/rate-limit handling; mostly configuration (not code) for whatever the chosen alerting provider requires.

### Increment 2 — provider-dashboard verification, then request volume/latency/error-rate/saturation/backup/quota/cost
- **Verify provider capabilities first** (the open question from §3): confirm the actual production deployment target, confirm the actual Postgres host and its dashboard's saturation/backup/PITR views, confirm what Resend's dashboard already shows for quota/volume. This is discovery, not a code task, and it determines everything below.
- Depending on what that verification finds, replace the Increment 0 placeholder links with either: richer linked views (if the provider dashboards are good enough as-is), a small number of genuinely useful in-app summaries pulled from provider APIs (only if a provider's own dashboard is confirmed insufficient), or leave the links as the permanent answer for signals that are fundamentally provider-owned (backup/restore evidence and cost, most plausibly, regardless of what the verification finds).
- Add a request-scoped correlation ID (generated per request, attached to error logs and, optionally, a response header) — improves "which request caused this error" without adopting a full APM.
- Surface release/build identification (`VERCEL_GIT_COMMIT_SHA` or equivalent) in the monitoring page and in error log context.
- Owner decision on whether to adopt an error-tracking SDK (Sentry recommended) for deeper error investigation — §7.
- **Dependencies:** the provider-capability verification above; owner decision on APM adoption and budget if pursued.
- **Provisional effort:** small for correlation ID + release tagging; the request-volume/latency/error-rate/saturation/backup/quota/cost work is unscoped in detail until the verification step reports back — this increment's first deliverable is that verification, not code.

### Increment 3 — detection signals: bulk operations and suspicious traffic
This stays on the monitoring roadmap because it is detection, not a change to any preventive control. Design (not yet build) bulk-operation and suspicious-traffic detection — this needs an actual threshold discussion (what counts as "bulk," what counts as "suspicious" for this specific app's real usage pattern) before any code, so this increment's first deliverable is that threshold design, the same pattern Increment 2 uses for provider verification.
- **Dependencies:** none external, but genuinely needs product/security judgment on thresholds before implementation — flagging this explicitly rather than guessing at numbers.
- **Provisional effort:** unscoped until thresholds are agreed; the threshold-design step itself is small.

### Separate workstream — preventive-control hardening (not an increment of this plan)
Login brute-force protection and password-reset abuse protection are real, confirmed gaps (§1f) — but they are gaps in **preventive controls**, not in monitoring, so closing them does not belong in this plan. They deserve their own security-hardening assessment: threat model, threshold design, and a decision on whether to generalize the two existing rate-limit implementations or add a third bespoke one. **This plan does not propose refactoring or changing the semantics of the existing, carefully-tuned kiosk limiter** (§1f, §1c) under any circumstance, including "to make a dashboard easier to build" — the kiosk limiter's existing behavior stays exactly as it is; only the display of what it already produces changes, in Increment 0.

### Also not part of this plan
- **Monthly obligation generation monitoring** — there is no trigger yet (§1d), so there is nothing running to monitor. Revisit once that trigger is built.
- **Load testing for 1,000 concurrent users** — a separate workstream entirely. Monitoring observes real traffic; it doesn't generate synthetic load or prove capacity.

---

## 6. Explicit non-goals of this document

- No code was written, no file outside this plan was touched.
- No service was installed, purchased, or configured.
- No attack simulation or load test was run.
- No database was migrated or written to (the tenant-branding migration from PR #130 remains unapplied to dev/production, unrelated to this task and unchanged by it).

---

## 7. Genuine owner decisions (not resolved here)

Reduced to decisions that actually require the owner's judgment — provider/budget/retention choices, each attached to the increment where it first becomes necessary. Facts that merely need *discovering* (deployment provider, env-var configuration, backup settings) are findings in §1, not listed again here — those need someone with the relevant dashboard access to check, which may or may not be the owner personally, but they are not design choices.

1. **External alerting provider**, needed before Increment 1 — extend the existing Healthchecks.io account, adopt a separate uptime pinger, or something a provider dashboard already offers once §3's verification happens. Includes budget if a paid tier is needed.
2. **Whether to adopt an error-tracking/APM SDK** (Sentry recommended), needed before Increment 2 if deeper error investigation is wanted — cost beyond the free tier, and error payloads leaving the app's own infrastructure.
3. **Data-retention period** for the monitoring views built on `AuditLog`/`KioskAttempt`, needed before any retention policy is actually implemented (not needed for Increment 0, which reads current rows with a fixed 24-hour window and introduces no new storage) — a compliance/storage-cost tradeoff.
4. **Approve (or schedule) load testing** for 1,000 concurrent users, as its own separate project, whenever capacity planning becomes a priority.

Increment 0 uses the existing `isSuperAdmin` audience as-is — no new role is proposed, and none is needed to ship it.

---

## Appendix: source citations for the inventory

All citations above were independently re-verified against the live files at the time of writing (not solely taken from sub-agent reports):

- `src/app/api/health/route.ts`, `src/app/api/health/jobs/route.ts`, `vercel.json` — health endpoints and cron config.
- `prisma/schema.prisma` — `AuditLog` (line 1770), `JobRun` (line 1843), `KioskAttempt` (line 1689).
- `src/lib/tenant/context.ts:136` — cross-tenant denial logging + audit write.
- `src/lib/dues/monthly-generation.ts`, `src/lib/jobs/job-names.ts` — monthly-generation trigger status.
- `src/lib/kiosk/rate-limit.ts`, `src/app/[locale]/(staff)/admin/branding/actions.ts:161-174` — existing rate-limit implementations.
- `src/lib/jobs/run-scheduled-job.ts`, `src/lib/jobs/heartbeat.ts`, `docs/DEPLOYMENT_RUNBOOK.md` — job execution and heartbeat mechanism.
- `src/lib/kiosk/offline-queue.ts` — offline-queue client-only scope.
- `src/lib/dues/ledger/record-payment.ts` — payment audit trail.
- `src/app/[locale]/platform/layout.tsx`, `src/lib/auth/require-super-admin.ts` — superadmin guard pattern (page-level `requireSuperAdmin()` and the action-level `resolveSuperAdminActionContext()`).
- Root `package.json` — full dependency audit for existing/missing tooling.

**Additionally re-verified for this revision** (§3 and §4's corrections required tracing exact write paths, not summaries):
- `src/lib/kiosk/rate-limit.ts` (lines 24-44, 127-184, 202-219) — the full `KioskAttemptOutcome` union, what `reserveKioskAttempt` and `finalizeKioskAttempt` actually persist versus discard.
- `src/app/api/health/jobs/route.ts` (line 70) — the exact `healthy = !stale && !stuck` aggregate that omits `JobRun.status`.
- `src/app/api/health/route.ts` — confirmed no auth check in the handler (public by design).
- `prisma/schema.prisma` — `@@index` declarations on `KioskAttempt` (lines 1725-1726) and `AuditLog` (lines 1796-1798), neither `createdAt`-leading; `JobStatus` enum (lines 1829-1834).
