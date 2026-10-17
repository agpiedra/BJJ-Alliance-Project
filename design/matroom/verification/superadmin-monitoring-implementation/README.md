# Superadmin Monitoring — Increment 0 implementation evidence

Implements `docs/SUPERADMIN_MONITORING_PLAN.md` Increment 0 as a read-only page at `/[locale]/platform/monitoring`, following the reviewed v2 visual proposal (`design/matroom/verification/superadmin-monitoring-proposal/`, kept unchanged, local only). Prototype controls and the fabricated-data banner did not ship.

Nothing here was deployed, activated or migrated outside the isolated environments named below.

---

## What shipped

| Area | Files |
|---|---|
| Page + nav link | `src/app/[locale]/platform/monitoring/page.tsx`, `src/app/[locale]/platform/layout.tsx` (one link) |
| Data-access boundary | `src/lib/monitoring/load-monitoring.ts` |
| Read queries | `src/lib/tenant/platform-lookups.ts` (four new functions; the only file allowed to use `unscopedPrisma`) |
| Shared job thresholds | `src/lib/jobs/job-health.ts` (moved out of `/api/health/jobs`; endpoint response and auth unchanged) |
| Database check time | `src/lib/health/database-check.ts` (`getDatabaseHealth()` adds the cached result's own time; `checkDatabaseHealth()` unchanged) |
| Translations | `messages/en.json`, `messages/es.json` (`platform.nav.monitoring`, `platform.monitoring.*`) |
| Indexes | `prisma/schema.prisma`, `prisma/migrations/20261017140000_monitoring_created_at_indexes/` |
| Tests | `tests/unit/monitoring-loader.test.ts`, `tests/unit/platform-monitoring-page.test.tsx`, `tests/unit/database-check.test.ts` (+1 case), `tests/integration/platform-monitoring.test.ts`, `tests/smoke/page-routes.test.ts` (+3 routes) |

Components reused: `Card`, `Pill`, `StatRow`/`StatTile`, `EmptyState`, existing platform nav and mobile sheet. No new packages, tables, writes, telemetry or external services.

---

## Authorization

`loadMonitoringSnapshot()` calls `requireSuperAdmin()` first, outside every per-panel `try/catch`. The guard re-reads `isSuperAdmin` and `active` from the database on every call and refuses with `notFound()`. A refusal propagates to Next as a 404; it is never turned into "panel unavailable", and no monitoring query starts before it passes. The `/platform` layout's own guard still applies on top.

| Check | Evidence |
|---|---|
| Refusal propagates unchanged; no query runs | unit: `monitoring-loader.test.ts` ("a refusal propagates unchanged…") |
| No query starts until authorization resolves | unit: same file, pending-promise test |
| Anonymous, non-superadmin org admin, **inactive** superadmin → `notFound()`; active superadmin → all panels | integration: `platform-monitoring.test.ts` (real guard, real test DB; only `auth()` mocked) |
| Real HTTP: superadmin non-5xx; org ADMIN and anonymous exactly 404 | smoke: `page-routes.test.ts` |
| Real browser, registered owner before grant → 404; after grant → page; set inactive → 404 | browser section below |

---

## Time scopes

- One snapshot instant per request. Every activity panel uses `[snapshot − 24 h, snapshot]`, inclusive at both ends (`createdAt >= start AND createdAt <= end`).
- The header shows the zone and offset (`America/Costa_Rica (GMT-06:00)`), the snapshot, and the exact window, all formatted in America/Costa_Rica.
- Jobs are not windowed: latest run and latest successful run over all history.
- The database card shows when its cached check actually ran (it can be up to 5 s before the snapshot).

Boundary evidence (integration test, fixed snapshot `2031-03-10T12:00Z`, far from other test files' rows): rows at `start` and at `snapshot` are counted; rows 1 ms outside either edge are not.

## Recent-event lists

`ORDER BY createdAt DESC, id DESC LIMIT 50`. The integration test inserts 55 in-window denials (five sharing one instant) plus one out-of-window row and checks the page returns exactly the 50 ids an independent SQL query returns, in the same order.

## Selected fields

| Panel | Columns read |
|---|---|
| Kiosk | `success`, `countsAsFailure` (grouped count over a `createdAt` range) |
| Payments | count of `AuditLog` rows with `action = 'duesPayment.record'` |
| Denials / privileged changes | `id, action, createdAt, actorId, entityType, entityId`, organization `name` |
| Jobs | `status, startedAt, finishedAt, failed, heartbeatStatus`; success lookup `startedAt, finishedAt` |

Never read: `ipAddress`, `kioskTokenHash`, `AuditLog.before/after` (where amounts, student ids and refusal reasons live). The integration test asserts the event object's exact key set and that a fixture amount (`45000`), a student id and a refusal reason never appear in the snapshot. Prisma's actual SQL was captured from the Postgres statement log (see the index section) and matches this list.

Privileged-change actions are the 14 platform-admin writes (`organization.approve/reject/suspend/cancel/reactivate/createManual/graceDays.changed`, `organizationInvoice.create/recordPayment/void/acknowledgeReview/graceExtended`, `user.superAdminGranted/Revoked`). A unit test checks that every filtered action string is actually written by some production code path.

## Kiosk and payment labels

Unchanged from the reviewed plan: "Attempts recorded as successful" (includes events kept for review and recognized retries), "Attempts counted toward PIN limiting" (includes attempts not yet finalized; not proof of abuse), "Other recorded attempts" (mixed outcomes). "Recorded payment events" is a count only: not revenue and not a failure rate. No lockout figure.

External signals (request volume, latency, error rate, database saturation, backups, storage/email quota, cost) show "Not connected" / "Not verified". No URLs, no integrations.

---

## Scheduled jobs

- Outcome (`latestRun.status`), failed-item count, freshness, stuck, heartbeat and latest success are separate fields. A recent `FAILED` run is shown as FAILED even when it is on schedule and not stuck.
- Freshness has three states: **On schedule**, **Overdue** (latest run older than the threshold), **No recorded run** (never ran; amber; never shown as healthy). "No recorded run" is distinct from zero activity and from "Could not load".
- The threshold (`STALE_AFTER_HOURS`, 192 h) and stuck window (30 min) come from `src/lib/jobs/job-health.ts`, now shared with `/api/health/jobs` (same `>` rule). That endpoint's response shape, `ok` semantics and `CRON_SECRET` auth are unchanged, and its existing integration test passes.
- The schedule line is rendered from `vercel.json`'s own cron expression (`0 13 * * 1`, which Vercel evaluates in UTC) and converted with `Intl` to America/Costa_Rica: "Every Monday at 13:00 UTC (Monday 07:00, America/Costa_Rica)". A non-weekly expression would be shown raw; a missing entry says so. No day or time is hardcoded.

## Database panel and the outage limitation

The card is labelled **Database reachability** and shows only Reachable / Not reachable plus the check's own time. No latency is shown: `checkDatabaseHealth()` caches for 5 s, so any timing taken around it would mostly measure the cache.

**This page cannot serve as an outage alert.** Authorization itself reads the database (`requireSuperAdmin()` re-reads the user row), so when the database is down the page fails before any panel renders. The "Not reachable" state can appear only in the narrow case where the guard's query succeeds and the ping does not. The page also only runs when someone opens it. Alerting that works while the app or its database is down still needs something outside the app (plan Increment 1, owner decision on provider). Nothing here changes that.

---

## Index measurements

### Decision

Two additive indexes: `KioskAttempt("createdAt")` and `AuditLog("action", "createdAt")`. Neither table had an index usable for a platform-wide time window, and neither is ever pruned, so every page load scanned both tables in full and the cost grows with retained history.

### Environment

- Separate disposable database `monitoring_explain_test` on the local isolated test container (Docker `postgres:16-alpine`, PostgreSQL 16.15, port 5433). Not the shared integration database, not dev, not production. Dropped after measuring.
- Docker host: 16 CPUs, ~15.6 GiB memory. `shared_buffers = 128MB`, `effective_cache_size = 4GB`, `work_mem = 4MB`, `track_io_timing = off`. Default parallel settings (the sequential scans used 2 parallel workers plus the leader).
- Schema from `prisma migrate deploy` (all migrations) plus the standard seed.

### Dataset

`evidence/explain-fixtures.sql`. Assumed scale: ~50 academies × ~150 kiosk attempts/day and ~2,500 audit rows/day, retained ~400 days, timestamps uniform over the last 400 days.

| Table | Rows | Heap | Heap pages |
|---|---|---|---|
| KioskAttempt | 3,000,000 (85 % success, 7 % counted toward PIN limit, 8 % other) | 478 MB | 61,225 |
| AuditLog | 1,000,000 (34.9 % `duesPayment.record`, 0.5 % `organization.accessRefused`, 0.2 % five privileged actions, rest other) | 183 MB | 23,406 |

Rows inside the 24-hour window: 7,435 kiosk attempts, 920 payment events, 13 denials, 2 privileged changes.

### Query shapes

These are the exact statements Prisma issued. They were captured from the Postgres statement log (`log_statement = 'all'` on that database only) by calling the real lookup functions. Parameters are inlined in `evidence/explain-queries.sql`:

1. `SELECT COUNT(*), success, "countsAsFailure" FROM "KioskAttempt" WHERE "createdAt" >= $1 AND "createdAt" <= $2 GROUP BY success, "countsAsFailure"`
2. `SELECT COUNT(*) FROM (SELECT id FROM "AuditLog" WHERE action = 'duesPayment.record' AND "createdAt" >= $1 AND "createdAt" <= $2) sub`
3. `SELECT id, action, "createdAt", "actorId", "entityType", "entityId", "organizationId" FROM "AuditLog" WHERE action IN ('organization.accessRefused') AND <window> ORDER BY "createdAt" DESC, id DESC LIMIT 50` (plus a separate `Organization` lookup by the returned ids)
4. Same as 3 with the 14 privileged actions.

The two `JobRun` lookups use the existing `(jobName, startedAt)` index and were not part of the comparison.

### Results — `EXPLAIN (ANALYZE, BUFFERS)`

Raw output: `evidence/explain-before-run{1,2}.txt`, `evidence/explain-after-run{1,2}.txt`. Each file is one pass over the four queries; run 2 immediately followed run 1.

| Query | Before: plan | Before (run 2): buffers hit / read | Before (run 2) time | After: plan | After (run 2): buffers hit / read | After (run 2) time |
|---|---|---|---|---|---|---|
| 1 kiosk | Parallel Seq Scan | 106 / 61,193 | 78.5 ms | Bitmap Index Scan on `KioskAttempt_createdAt_idx` + Bitmap Heap Scan | 7,062 / 0 | 9.4 ms |
| 2 payments | Parallel Seq Scan | 15,954 / 7,452 | 40.9 ms | Index Only Scan on `AuditLog_action_createdAt_idx` | 10 / 0 | 0.21 ms |
| 3 denials | Parallel Seq Scan | 16,080 / 7,414 | 39.7 ms | Index Scan Backward on the same index | 26 / 0 | 0.18 ms |
| 4 privileged | Parallel Seq Scan | 16,176 / 7,318 | 39.7 ms | Index Scan on the same index | 47 / 0 | 0.12 ms |
| **Sum of the four** | | **131,693 buffer accesses** | **≈ 199 ms** | | **7,145 buffer accesses** | **≈ 9.9 ms** |

Run 1 times: before 82.8 / 40.9 / 39.6 / 40.2 ms; after (first pass after building the indexes) 49.5 / 0.26 / 0.20 / 0.19 ms.

### How to read these numbers

- **Bytes are buffer accesses, not disk reads.** Each buffer is an 8 KB page. 131,693 buffers ≈ 1.0 GB of pages *touched* per page load before; 7,145 ≈ 56 MB after. `hit` means the page was found in PostgreSQL's `shared_buffers`. `read` means it was not, and was requested from the operating system, which may have served it from its own page cache or from disk. `track_io_timing` was off, so physical disk reads were **not** measured or distinguished.
- **Cache conditions.** Before: the KioskAttempt heap (478 MB) is larger than `shared_buffers` (128 MB), so the full scan reports the same ~61k `read` buffers on both runs. With ~15.6 GiB host memory, those pages were very likely in the OS page cache, so these are warm-OS-cache timings. A cold disk would be slower; that was not measured. After: run 2 was entirely `shared_buffers` hits.
- **Scope of the claim.** These are isolated timings of four queries on one local container with a synthetic, uniformly distributed dataset and no concurrent load. They show that the plans change from full-table scans to index range scans, and that the work per page load stops scaling with total table size. They are **not** a statement about production latency, whole-page response time, or application capacity.
- **Index build cost here.** `CREATE INDEX` took 971 ms on 3,000,000 kiosk rows and 923 ms on 1,000,000 audit rows (local container). Plain `CREATE INDEX` blocks writes to the table while it builds. Index sizes: 64 MB and 46 MB.

### Migration isolation

The migration was generated with `prisma migrate diff` against a disposable shadow database. It was applied only to the isolated test database (`alliance_bjj_test`, port 5433) and to the disposable databases above. `db:check-drift` against the isolated test database: schema vs history clean; history vs database clean. It has **not** been applied to the normal dev database or to production; applying it is part of a separate deployment decision.

---

## Browser verification

### Environment

- Dev server (`next dev --turbopack`, port 3100) pointed at a separate disposable database `monitoring_browser_test` (isolated container; migrated and seeded; dropped afterwards). `RESEND_API_KEY` was blank for that server and the CLI, so no email was sent anywhere.
- Playwright (Chromium) with **emulated** viewports: 1280, 960, 390, 320 CSS px wide. These are viewport emulation, not real window sizes.
- The Next.js dev-tools overlay (`nextjs-portal`, present only under `next dev`) was hidden with injected CSS in screenshots only.
- The theme was set through the app's own `localStorage.theme` value (the theme toggle's storage). The first light captures came out dark because a `theme=dark` value was left from an earlier session. They were retaken, and the body background was checked per capture (light `rgb(245, 243, 236)`, dark `rgb(20, 29, 25)`).

### User

A real owner created through the product flow, not a seed account:
1. Registered "Monitoring Verification Dojo" at `/en/register-academy`.
2. Approved with `scripts/approve-organization.ts`. It calls the same `approveOrganization()` as the platform panel, and it prints the invitation link, which the panel does not display.
3. Accepted the invitation and set a password.
4. The seeded superadmin granted that owner platform admin through `/en/platform/admins`.
5. The owner logged in.

| Access check | Result |
|---|---|
| Owner before grant | `/en/platform/monitoring` → HTTP 404, "Page not found" |
| Owner after grant | HTTP 200, all panels |
| Same owner after `active = false` (disposable DB) | HTTP 404 |

The 404 HTML contains the page's translation *templates* (e.g. "Kiosk activity") because the app serializes all messages into every page, including public ones. No monitoring data (run status, actor ids, organization names) was present.

### States

Each state was produced with labeled fixtures in the disposable database (`evidence/browser-state-fixtures.sql`), except where noted. Real UI-generated audit rows (`organization.approve`, `user.superAdminGranted`) appear in the privileged-changes list.

| State | How produced | What the page showed |
|---|---|---|
| Populated | Fixtures: 50 kiosk rows in window (41 / 3 / 6) + 7 outside, 12 payment events, 3 denials, one `SUCCEEDED` run 4 days old | Counts 41 / 3 / 6, 12 payments, 3 denials, 2 privileged changes; job SUCCEEDED, On schedule |
| Zero activity | Fixtures removed; real audit rows moved 3 days back; job run 4 days old kept | Zeros, both empty-list messages, no "Could not load"; job still SUCCEEDED / On schedule |
| No job history | All `JobRun` rows removed | "No history", "No recorded run" (amber card), "None recorded", "—" for run-only fields, never-ran caption |
| Job overdue | One `SUCCEEDED` run 9 days old | SUCCEEDED + **Overdue** (red card), "Overdue since" = run start + 192 h |
| Recent failed, not stale | `SUCCEEDED` 9 days ago, `FAILED` 2 days ago (3 failed items, heartbeat failed) | FAILED + On schedule, Stuck No, failed items 3, latest success = the 9-day-old run |
| One panel failed | **Fault injection, disposable DB only:** `KioskAttempt` table renamed for the capture and renamed back immediately | Kiosk card alone: "Could not load / This panel could not load. Refresh to try again."; every other panel kept its data; server logged `[monitoring] panel query failed { panel: 'kiosk' }` |

The primary evidence for one-panel failure is two tests:
- the harness test `tests/unit/platform-monitoring-page.test.tsx`, which renders the real page component and messages with the loader mocked to return one `unavailable` panel;
- the loader isolation test in `monitoring-loader.test.ts`.

The browser capture is supporting visual evidence. There is no failure-injection switch in production code.

The "Not reachable" database state was not rendered in the browser (see the outage limitation above).

### Overflow measurement

`scrollWidth` vs `clientWidth` plus every element's right edge vs the viewport, per state:

| State | Combinations | Overflow |
|---|---|---|
| Populated | light + dark × EN + ES × 1280/960/390/320 = 16 | 0 |
| Zero activity | 16 | 0 |
| No job history | 16 | 0 |
| Job overdue | 16 | 0 |
| Recent failed | 16 | 0 |
| One panel failed | light × EN + ES × 4 widths = 8 | 0 |

### Keyboard

From `/en/platform`, Tab reaches Overview, Organizations, Platform admins, then **Monitoring** (4th stop). Each shows a 2 px solid `rgb(29, 57, 43)` outline. Enter opens the page, and that link carries `aria-current="page"`. The page body is read-only and has no interactive controls, so Tab continues to Theme and Sign out. At 390 (ES), the menu button opens the sheet from the keyboard and lists "Monitoreo" marked current.

### Fixes made during verification

- The jobs card showed "Freshness" twice (pill row and a fact row). The fact row is now labelled "Fresh until" / "Overdue since".
- Event timestamps wrapped ("12:06 / AM") in the 9.5 rem column at 1280; the column was widened to 11 rem. All captures above were taken after both fixes.

### Screenshots (`screenshots/`)

| File | State |
|---|---|
| `populated-en-1280.png`, `populated-en-960.png`, `populated-en-390.png`, `populated-en-320.png` | Populated, light, EN |
| `populated-es-390.png` | Populated, light, ES |
| `populated-en-1280-dark.png`, `populated-es-320-dark.png` | Populated, dark |
| `zero-activity-en-1280.png`, `zero-activity-en-320.png` | Zero activity |
| `no-job-history-en-1280.png`, `no-job-history-es-320.png` | No job history |
| `job-overdue-en-1280.png`, `job-overdue-en-390-dark.png` | Job overdue |
| `job-failed-recent-en-1280.png`, `job-failed-recent-es-390.png` | Recent failed, not stale |
| `panel-failure-kiosk-en-1280.png`, `panel-failure-kiosk-es-390.png` | One panel failed (fault injection, disposable DB) |
| `keyboard-focus-monitoring-link-1280.png` | Focus ring on the Monitoring nav link |
| `mobile-menu-es-390.png` | Phone menu, ES |

---

## Translations

Spanish follows existing terms where they exist (Organizations → Academias). New terms chosen for clarity: Monitoreo, Conexión a la base de datos, Tareas programadas, Vigencia, A tiempo, Atrasada, Sin ejecuciones registradas, Pulso. Left untranslated as machine values: job status (`SUCCEEDED`, `FAILED`, …), job name `weekly-digest`, audit action names, ids, the zone name `America/Costa_Rica`.

---

## Limitations

- Not an outage alert (above). External alerting is a later requirement.
- Payment refusals and kiosk lockouts are not persisted, so neither is shown.
- Kiosk and audit counts are exactly what the tables record; see the plan §1c for why each label carries its caveat.
- Index timings are isolated local measurements, not capacity claims.
- Real-device (Android/iOS) checks were not part of this work.
- The proposal folder remains local and unchanged; it is not part of this PR.
