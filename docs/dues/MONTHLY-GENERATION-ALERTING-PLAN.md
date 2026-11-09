# Monthly generation: four-check alerting — smallest implementation plan (FOR REVIEW)

**Status:** plan only, 2026-11-09, written against `origin/main` `a9d3dd4`. **Nothing is implemented.** No deployment, paid
resource, settings change, cron enabling or ledger activation is authorized by this plan. D5 implementation, O4 and production
activation remain unapproved.

**Implements the decisions in `D5-SCHEDULING-DECISION-BRIEF.md` §5–§6 (owner, 2026-11-09):** four Healthchecks checks
(1a scheduler, 1b urgent billing, 2 older-month billing data, 3 workload review); new-month warning W = 15 h; workload
thresholds alert separately and never affect billing or run status; a conservative **212 s** generation deadline.

**Not guaranteed, by design:** alert delivery; 24-hour billing completion; any response time.

---

## 1. Scope (one PR, smallest change)

| # | Change | Files (on `origin/main`) |
|---|---|---|
| S1 | **Detection read:** one bounded, read-only transaction at run start returning the inputs for conditions A–D and the §6 workload counts | new function in `src/lib/tenant/platform-lookups.ts` (beside `listClaimableGenerationSegments`, same bounding pattern); pure evaluator in a new `src/lib/dues/monthly-generation-alerts.ts` |
| S2 | **Alert pings:** a ping client per check URL; the wrapper sends the scheduler ping plus up to three alert pings, sequentially | `src/lib/jobs/heartbeat.ts`, `src/lib/jobs/run-scheduled-job.ts` (opt-in option; weekly digest unchanged) |
| S3 | **Recording:** one new nullable JSON column for the three extra outcomes; `heartbeatStatus` unchanged in meaning | `prisma/schema.prisma` + one migration |
| S4 | **Route budget:** reserve four pings and the detection read; generation deadline 212 s | `src/lib/dues/monthly-generation-route-budget.ts`, `src/lib/dues/monthly-generation-route.ts` |
| S5 | **Outcome mapping:** A, C, D (+ run-level errors) and B counted in `failed`; workload never counted | `summarizeMonthlyGenerationRun` in `monthly-generation-route.ts` |
| S6 | **Readiness check 10:** also fails when any of the three alert checks is not configured or its last ping was not accepted | `src/lib/dues/readiness/evaluate.ts`, `snapshot.ts` |
| S7 | **Runbook:** four checks, four variables, daily reminders, sole-responder note | `docs/DEPLOYMENT_RUNBOOK.md` |

**Not in scope:** the `vercel.json` entry (D5 implementation), stage 9, re-arming alerts (brief §5.8 option ii), per-organization
checks, persisting `stoppedBy`, any change to the weekly digest's behavior.

**Schema change:** S3 needs the owner's approval as a schema change (same category as D2). §3 gives the no-schema fallback.

---

## 2. Check-to-variable mapping (reconciling the count)

| Check | Environment variable | Existing or new | Ping semantics |
|---|---|---|---|
| **1a scheduler** | `HEALTHCHECK_MONTHLY_GENERATION_URL` | **Existing** name (`heartbeat.ts` `HEALTHCHECK_ENV`; runbook monthly-generation section). Currently unset everywhere: the canary's value was deleted from staging, and production does not exist | success whenever the run finalizes its `JobRun`, whatever the billing outcome; `/fail` when create or finalize fails |
| **1b urgent billing** | `HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL` | **New** | `/fail` on A, C, D, a thrown job or an infeasible budget; else success |
| **2 older-month data** | `HEALTHCHECK_MONTHLY_GENERATION_DATA_URL` | **New** | `/fail` on B; else success |
| **3 workload review** | `HEALTHCHECK_MONTHLY_GENERATION_WORKLOAD_URL` | **New** | `/fail` when any §6 threshold is reached; else success |
| (weekly digest, unchanged) | `HEALTHCHECK_DIGEST_URL` | Existing | unchanged |

**Count:** four check URLs = **one existing variable + three new variables**. (The earlier "two new variables" was for the
three-check design; it is superseded.) Each is Production-only and Sensitive, entered by the owner. Healthchecks checks used:
4 for monthly generation, plus the digest's if created: within the Free plan's 20 per account.

**Meaning change for 1a:** today `HEALTHCHECK_MONTHLY_GENERATION_URL` receives `/fail` whenever `failed > 0`. Under this plan it
becomes a pure liveness signal; billing failures move to 1b and 2. The variable was never set in production, so no live check
changes meaning.

---

## 3. Recording each ping outcome without breaking existing consumers

**Existing consumers of `JobRun.heartbeatStatus` (all on `origin/main`):**
- readiness check 10, `evaluate.ts:156` — `heartbeatStatus !== "ok"` → `heartbeatNotOk`;
- readiness snapshot, `snapshot.ts:143,171`;
- `/api/health/jobs`, `route.ts:16,52`;
- platform monitoring, `platform-lookups.ts:739,750` and `monitoring/page.tsx:231`.

They read **one string**: "ok" | "failed" | "not_configured", meaning **the ping request was accepted**, not that the run succeeded.

**Rule:** `heartbeatStatus` keeps exactly that meaning and type, and holds **check 1a's** request outcome. No consumer changes for it.

**New column (S3):** `JobRun.alertPings Json?` (nullable; null for every existing row and for the weekly digest):
```json
{ "urgent": "ok" | "failed" | "not_configured" | "not_sent",
  "data": "ok" | "failed" | "not_configured" | "not_sent",
  "workload": "ok" | "failed" | "not_configured" | "not_sent" }
```
- `not_sent` = the run did not evaluate that check (it never sends a default success).
- Written in the **same** heartbeat-status update that writes `heartbeatStatus` (one transaction, so no new bookkeeping
  reserve). If that write fails, both are `unknown` in the body, as today; no second ping.
- The value carries request outcomes only: no URL, no body, no organization data.

**Fallback if the schema change is not approved:** the three outcomes appear only in the HTTP response body and the logs
(Pro keeps logs for 1 day). Not recommended: the canary showed log-only evidence is lost within a day.

---

## 4. Behavior by path (scheduler versus billing status)

| Path | `JobRun.status` | 1a | 1b | 2 | 3 |
|---|---|---|---|---|---|
| Normal, billing clean, below thresholds | SUCCEEDED | success | success | success | success |
| A, C or D found (generation still runs) | PARTIAL / FAILED (`failed > 0`) | success | **/fail** | per B (D: not_sent) | per counts (D: not_sent) |
| B only | PARTIAL / FAILED | success | success | **/fail** | per counts |
| Workload threshold only | **SUCCEEDED, `failed` unchanged** | success | success | success | **/fail** |
| Job throws (incl. budget infeasible) | FAILED | success (finalized) | **/fail** | not_sent | not_sent |
| JobRun create fails | (unknown) | **/fail** | not_sent | not_sent | not_sent |
| JobRun finalize unconfirmed | (unknown) | **/fail** | not_sent | not_sent | not_sent |
| Cron does not fire / run killed | — | missed ping → alert | no ping (7-day period) | no ping | no ping |
| A ping request fails or times out | unchanged | recorded `failed`; the other pings are still sent | same | same | same |

**Detection failure never stops billing:** if the detection read fails (D), generation still runs; D is reported on 1b.

---

## 5. Route budget (conservative 212 s)

`planRouteBudget` gains two inputs, both with safe minimums: `heartbeatPings` (integer ≥ 1) and `preRunnerReadMs` (≥ 0). The
weekly digest does not use the budget. Formula: post = 2 × tx + heartbeatPings × `HEARTBEAT_TIMEOUT_MS`; generation deadline =
F − C − M − post; admission = tx + preRunnerReadMs + `admissionBudgetMs(generation)`.

| Input | Value |
|---|---|
| F | 300 s (`maxDuration`) |
| C, M | 30 s each (owner reserves, not measurements) |
| tx | 1 + 2 + 1 = 4 s |
| heartbeatPings | **4**, sequential (no concurrency assumed) |
| preRunnerReadMs | detection read bound: maxWait 1 s + timeout 2 s + statement 1 s = **4 s** |
| **post** | 8 + 20 = **28 s** |
| **Generation deadline** | 300 − 30 − 30 − 28 = **212 s** |
| **Admission** | 4 + 4 + 40 = **48 s** (< 212: feasible) |

The detection read runs before the runner; the route passes `elapsedMs` from the handler's start, so its actual duration is
already subtracted from the 212 s at run time.

---

## 6. Detection read (S1)

- **One transaction**, `SET TRANSACTION READ ONLY` plus the same `SET LOCAL` statement, lock and idle timeouts as discovery;
  maxWait 1 s, timeout 2 s, statement 1 s.
- **Reads:**
  - all `DuesGenerationProgress` rows (`organizationId`, year, month, `lastPassCompletedAt`, `lastPassClean`), `LIMIT cap + 1`;
  - for organizations with rows: branch timezones (under the existing branch cap), branch count, and student count (any status);
  - for C: the activated organizations. Until stage 9 defines the activation record, C has no source and is reported
    "not evaluable"; stage 9 must supply it.
- **Cap:** 500 progress rows (10× the review threshold). Overflow → D.
- **Pure evaluator** (no I/O, injected `now`):
  - computes `current_min` with the existing `currentMonthIn(timezone, now)` (`monthly-generation-progress.ts:595`);
  - computes T_open(M) as the latest branch's local midnight on the 1st;
  - evaluates conditions A–D and the §6 thresholds as constants: W = 15 h; rows ≥ 50; organizations > 4; students per
    organization > 100; students total > 280; branches > 2; any unaligned timezone.
- **Sanitized output:** ids, months, reason codes and counts only (trigger plan §10).

---

## 7. Tests (written before the code; all local, no hosted run)

**7.1 Bounded detection read** (integration, throwaway database):
1. The fixtures produce the expected A, B, C (when evaluable) and D sets, and the expected counts, including rows of a
   suspended organization and former students.
2. `cap + 1` rows → D (`overflow`), and generation still runs.
3. Tiny injected bounds (statement 1 ms) → timeout → D; the transaction ends; no connection is held.
4. The transaction is read-only: a write attempted inside it fails (structural test).
5. With an empty progress table (today's production state) → no A/B/C, counts 0, all three alert checks success.

**7.2 Evaluator** (unit, fixed clock):
6. A boundary: T_open + 14 h 59 m 59 s → not A; + 15 h 00 m 00 s → A.
7. T_open uses the **latest** branch's midnight (two timezones).
8. An unaligned timezone sets the workload timezone threshold; Costa Rica does not.
9. Every threshold at limit − 1 / limit / limit + 1.
10. A clears once the month has a clean finished pass; B persists until the month's last pass is clean.

**7.3 Independent ping failures** (unit, injected `fetch`, fake timers):
11. Each of the four URLs failing alone (HTTP 500, network error, 5 s timeout): the other three are still sent; `JobRun.status`
    and `failed` are unchanged; the outcomes are recorded per check.
12. Each variable unset alone → that check `not_configured`, the others unaffected.
13. Four sequential timeouts complete within 4 × 5 s, and the post-runner path fits the 28 s reserve.
14. No URL appears in any log or body (sentinel test, as in G2a).

**7.4 Scheduler versus billing status** (integration through `handleMonthlyGenerationRequest`):
15. One test per row of §4's table, asserting `JobRun.status`, `failed`, `heartbeatStatus`, `alertPings` and which URLs were
    requested (and with `/fail` or not).
16. **Workload threshold reached with clean billing → SUCCEEDED, `failed = 0`, only check 3 `/fail`.**
17. **Weekly digest regression:** one ping, the old success rule, `alertPings` null.
18. **Consumers unchanged:** `/api/health/jobs`, platform monitoring and readiness snapshots return the same shape; check 10
    gains the new reason only when an alert check is `not_configured` or `failed`.

**7.5 Deadline handling** (unit + integration):
19. `planRouteBudget` with 4 pings and a 4 s read → deadline 212 000 ms, admission 48 000 ms; 1 ping, no read → 227 000 ms
    (regression); invalid inputs (0 pings, negative read) refused.
20. Infeasible boundary: F lowered until admission ≥ deadline → `budgetInfeasible`, FAILED, 1a success, 1b `/fail`, inside the
    failure reserves.
21. The runner receives `deadlineMs = 212 000` and stops admitting work at it (the existing G1/G2a deadline tests, parameterized
    to 212 s); a detection read that uses its full 4 s still admits one visit.
22. Lease 600 s > F still enforced.

---

## 8. 227 s measured versus 212 s estimated, and the minimum validation

| | Status | Source |
|---|---|---|
| Stage 1 at **227 s**: k = 1 up to 37 rows; k = 2 from 41 to 61 rows; first call ~4.3 s per row | **Measured** (Free tier, synthetic, 15 months) | `PHASE2-MEASUREMENT-PROPOSAL.md` §10n |
| At **212 s**: k = 1 → 2 change at ~38 rows; two calls still cover 61 rows | **Estimate** (linear scaling of the 227 s data), NOT measured | this plan |

**Minimum validation for the 227 → 212 s change:**
- **Before merge (required):** tests 19–22. They prove the deadline is computed and enforced at 212 s. Correctness and
  financial safety do not depend on the deadline value: every unit is bounded, and work left at the deadline is resumed by the
  next run.
- **Before activation (not required):** no hosted re-measurement. The launch workload is 1 progress row, far below either
  crossover.
- **Required later:** when the review threshold (brief §6) is reached, the review must measure at **212 s**, not reuse the
  227 s figures.

**Alert validation at setup (a person, later, not now):** after deployment and before activation, one scheduled run must show
`heartbeatStatus = ok` and `alertPings` all `ok` (the requests reached the four checks). Delivery to the inbox is checked with
Healthchecks' per-integration test notification. This verifies configuration, not delivery under failure.

---

## 9. Recipient record (corrected 2026-11-09)

- **Sole responder: the owner.** Primary address: the one tested in the staging canary.
- **No second person is assigned.**
- **A separate backup inbox is planned but not created.** Until it exists, every alert has a single point of failure (one inbox,
  one person).
- **Response expectation:** urgent emails checked within one hour. This is an operator expectation, not a guarantee.
- **Daily reminders:** to be enabled at setup (an account setting; not now).

---

## 9a. Implementation status (local; draft PR; owner approval 2026-11-09)

Approved: the `JobRun.alertPings` column and migration; the §2 variable names; condition C reported "not evaluable" until
stage 9 (never passed, never covered by a success ping; its implementation and tests stay activation blockers); the readiness
reason for missing alert configuration. Branch `feat/dues-monthly-generation-alerting` from `origin/main` `a9d3dd4`.

Clarifications made while implementing (no scope change):
- **Readiness reason** `alertChecksNotConfigured`: a finalized run whose `alertPings` is null, lacks a check, or has any
  `not_configured`. Configuration only: `failed` or `not_sent` is not this reason (narrower than S6's draft wording, matching
  the approval "missing alert configuration").
- **The urgent success ping attests A, D and run-level errors only**, never C. C appears in every run body as
  `conditionC: "notEvaluable"`; the KNOWN_LIMITATIONS STAGE-9 BLOCKER entry now names C.
- **An unclean pass end in the current run** is still counted in `failed` (unchanged) but is not urgent by itself; once
  persisted it is reported by the next run's detection (B for an older month, A for the new month after 15 h).
- **Condition D also covers** an organization with progress rows but no branch, and an unknown branch timezone.
- **Unaligned timezone threshold**: a branch whose month opening is not on a 3-hour UTC boundary (`0 */3 * * *`).

Not done (unchanged): no hosted migration, deployment, environment variable, monitor, cron, ledger activation or merge.
The backup inbox remains pending.

## 10. Review questions for the owner (answered 2026-11-09: see 9a)
1. Approve S3's schema change (`JobRun.alertPings`), or accept the log-only fallback?
2. Approve the variable names in §2?
3. Condition C: report it as "not evaluable" until stage 9 supplies the activation record (proposed), or defer C entirely to stage 9?
4. Approve readiness check 10's new reason (S6)?
