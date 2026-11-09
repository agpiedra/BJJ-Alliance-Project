# D5 scheduling decision brief — scheduling system, interval, throughput (items 1–3)

**Status:** local, read-only brief, revision 3 (2026-11-09: alert channels, deduplication, timing and threshold definitions clarified). Nothing here provisions, deploys, schedules or tests anything.

**Owner decisions recorded 2026-11-09 (D5 planning decisions only):**
1. Keep **legacy Cron Jobs** for now (no Schedules canary).
2. Schedule **`0 */3 * * *` in UTC**.
3. **Accept Stage 1 evidence** for the stated launch and year-one workload; **defer Stage 2**, subject to the retesting triggers (§3) and the review threshold (§6).

The owner accepts **conditional evidence**: not a guaranteed 24-hour completion time and not production capacity.
**Not approved:** implementation of the schedule (the `vercel.json` entry), deployment, enabling crons, ledger activation, provisioning, settings changes, O4, production activation. Before implementation the owner asked for §5 (overdue-month detection and alert recipients) and §6 (a review threshold); §7 lists the remaining activation blockers.

Evidence used: `PHASE2-MEASUREMENT-PROPOSAL.md` §10d, §10h, §10n (Stage 1 and the closed staging canary); `design/matroom/verification/d5-cron-canary/CANARY-CLOSED.md`; official Vercel docs fetched 2026-11-09 (URLs below).

---

## 1. Scheduling system: legacy Cron Jobs vs a Schedules path target

### 1.1 What Vercel's docs state (verified 2026-11-09)

| Statement | Quote / source |
|---|---|
| Cron Jobs are legacy | "Cron Jobs are a legacy feature and will be migrated to Schedules in the future. You can migrate now with a configuration change." — [migrate-from-cron-jobs](https://vercel.com/docs/schedules/migrate-from-cron-jobs) (page dated 2026-10-09); same wording on [schedules/cron-jobs](https://vercel.com/docs/schedules/cron-jobs) |
| Schedules replace Cron Jobs | "Schedules replace Cron Jobs." — [schedules](https://vercel.com/docs/schedules) |
| Schedules are beta | "Schedules are in beta. Behavior, APIs, and limits may change before general availability." — [schedules](https://vercel.com/docs/schedules); the limits page says the same |
| Cron Jobs still available | "Cron Jobs are available on all plans" — [schedules/cron-jobs](https://vercel.com/docs/schedules/cron-jobs) |

### 1.2 Documented requirement vs speculation

- **Documented:** to migrate *now*, a project changes `vercel.json`: add a `schedules` entry (name key, same `path` and `schedule`, `"requestMethod": "GET"`), **remove the `crons` entry in the same change** ("If you keep both, your route runs twice for each occurrence"), and deploy to production ("Vercel creates the schedules when the deployment becomes your production deployment, and stops running the Cron Jobs you removed").
- **Not documented:** any date, deadline, or obligation to migrate; whether "will be migrated" means Vercel converts existing Cron Jobs automatically, and if so with which method (path schedules default to **POST**; our route is GET-only), jitter, or kill-switch semantics. **Anything about an automatic migration is speculation.** This brief does not rely on it.
- **Practical consequence of the unknown:** if Vercel ever converts the entry in a way the route rejects (e.g. POST), runs fail and the Healthchecks missed-ping alert fires (E7, proven by the canary). That is detection, not prevention.

### 1.3 Comparison for our route (`GET /api/cron/monthly-generation`, bearer `CRON_SECRET`)

| | Legacy Cron Jobs | Schedules, path target |
|---|---|---|
| Maturity | Legacy, generally available | **Beta**; behavior, APIs, limits may change |
| Our evidence | **Staging canary: 29/29 slots** SUCCEEDED + heartbeat ok, 0 missed, 0 duplicated; alert delivered; lateness at request start **17.1–17.7 s** (13 logged slots) | **None** |
| Timing on Pro | "At the scheduled minute" | "Within the jitter window, which defaults to 1 minute and can be set from 1 to 15 minutes" |
| Timezone | Always UTC | Any IANA timezone per schedule; **DST behavior not stated** |
| Late delivery | Best effort; misses and duplicates possible (§10n); no retry | Delivered late until the occurrence expires ("after its jitter window plus the shortest interval between the schedule's runs", interval counted as ≥ 10 min), then skipped; after a delay "a frequent schedule can run several times in quick succession" |
| Duplicates | Possible | "can't rule out a duplicate delivery" |
| Retries | None | None for path and function targets (queue targets retry) |
| Auth headers | `vercel-cron/1.0`, `x-vercel-cron-schedule`, `Authorization: Bearer <CRON_SECRET>` | Same three for **path** targets; **function** targets get no `authorization` |
| Method | GET | **POST by default**; must set `requestMethod: "GET"` |
| Route code change | None | None ("without changing your route code") |
| Config / test change | None | `vercel.json` `schedules` replaces `crons`; the unit test that pins the `vercel.json` entry to the job's stale threshold must follow |
| Initial state on production deploy | Runs while project crons are enabled | "Production schedules start active" immediately on deploy |
| Kill switch | Project-wide **Disable Cron Jobs**, persists across promotions and rollbacks | Per-schedule **Disable**, persists across deployments; **"Disable Cron Jobs … only pauses Cron Jobs. It doesn't affect schedules."**; no project-wide toggle stated |
| Time-boxed run | None (the canary overran by 5 slots because shutdown was manual) | `vercel schedules enable <name> --until <ISO time>` / `--for <duration>`; the schedule "becomes inactive again" |
| Rollback | Disable toggle persists | "rolling back production restores the schedules from the deployment you roll back to" |
| Observability | Function logs only (Pro keeps 1 day — the canary lost 16 slots of log coverage) | "Execution history — Per schedule, in the dashboard and CLI" (`vercel schedules executions list <name>`); **retention not stated** |
| Billing | Function invocation | "Function and path targets create Vercel Functions invocations"; the pricing page currently returns 404 |

Not verified in docs: Schedules DST handling, execution-history retention, Schedules pricing beyond function usage, the jitter section in full.

### 1.4 Safety-model differences that matter on staging

Our staging safeguards assume legacy semantics. Under Schedules:
1. A deployment that defines a schedule **starts it immediately** in production (staging is that project's production environment). The canary's "deploy with crons disabled, verify, then enable" sequence does not exist.
2. The **Disable Cron Jobs** toggle that currently guards the weekly digest on staging **does not stop a schedule**.
3. Rollback to `ff3ecd4` would remove a schedule (documented), which is a usable restore path.

### 1.5 Recommendation

**Choose legacy Cron Jobs for D5 now; do not run another canary now.**

- It is the only mechanism with evidence for this route (29/29), it is GA, and its kill switch and rollback behavior are known and were exercised.
- Schedules are beta; a decision built on beta behavior can be invalidated by the documented "may change before general availability".
- The route is already compatible with a Schedules path target (same bearer and headers), so a later migration is a configuration change plus one canary, not a redesign.

**Migration triggers (revisit this decision when any occurs):** Schedules reach GA; Vercel publishes a date or mechanism for migrating Cron Jobs; a per-branch-timezone schedule becomes necessary (§2.4); or the 1-day log retention becomes the binding monitoring gap.

**If the owner prefers Schedules instead,** another canary **is necessary** before D5, because no evidence exists for that mechanism. It would establish, and only these:
1. A static path schedule with `requestMethod: "GET"` registers on deploy and reaches the bearer-protected route (E3/E5 on Schedules), not a 405 from the POST default.
2. The lateness distribution inside the 1-minute jitter window (J on Schedules).
3. Execution history as a monitoring source: content and retention (would replace the 1-day log dependency if retention is longer).
4. Kill-switch behavior: per-schedule disable, `enable --until` auto-stop (prevents a repeat of the 5-slot overrun), that Disable Cron Jobs does **not** stop it, and that rollback to `ff3ecd4` removes it.
5. No double run when `crons` is removed in the same change.

It would **not** establish catch-up after a platform delay (cannot be induced), DST behavior, or production behavior. Its procedure would need redesign for §1.4 (the schedule is live from the moment of deploy).

---

## 2. The three-hour interval against launch and year-one workload

### 2.1 Workload (owner planning estimates, §10d; not limits)
- Launch: 1 organization, ~50–60 students typical, ~100 largest; 1 branch (2 for the largest); timezone America/Costa_Rica.
- Within 12 months: 4 organizations.
- Under Reopen every retained month row is re-walked; an organization adds one progress row per month from activation (R1: no pre-activation backfill).

| Point in time | Progress rows | Students (n = slices for the new month) |
|---|---|---|
| Launch month | 1 | 55–100 (n = 2) |
| Month 12, representative | 34 | 4 × 55 |
| Month 12, upper | 49 | 100 + 3 × 60 |
| Each month after | +1 per active organization | — |

### 2.2 What was observed (not a guarantee)
Stage 1, Free tier, synthetic §10d upper world, generator `a9d3dd4`, 15 sampled months:
- **k = 1** observed up to 37 progress rows; **k = 2** observed from 41 to 61 rows (the first call hit the 227 s deadline at ~4.3 s per row; a second call finished the pass). r3 ≤ 2 for every sampled month.
- **Observed k ≤ 2 is a sample, not a bound.** It covers ≤ 61 rows, Free-tier compute, one timezone, back-to-back calls, no former-student records, no real data. Production tier and real data may be faster or slower.
- J on legacy Cron Jobs: 17.1–17.7 s at request start (13 logged staging slots; no generation load).

### 2.3 The bound (§10h, sufficient under A1–A5; conditional on k)
D = time from T_open (local midnight on the 1st) until the new month is fully billed. n = 2 for every year-one estimate. P ≤ 300 s, J ≈ 18 s, f = 1 tolerated failed or missed run, I = 3 h.

| Alignment | Bound | k = 1 | k = 2 | k = 3 | k = 4 | Largest k that fits 24 h |
|---|---|---|---|---|---|---|
| **Aligned** (T_open on a slot: Costa Rica midnight = 06:00 UTC, which `0 */3 * * *` hits) | k = 1: f·I + J + P; else (2k + f)·I + J + P | 3 h 05 m ✓ | 15 h 05 m ✓ | 21 h 05 m ✓ | 27 h 05 m ✗ | **3** |
| **Unaligned** (T_open between slots, a ≤ I) | k = 1: (1 + f)·I + J + P; else (2k + 1 + f)·I + J + P | 6 h 05 m ✓ | 18 h 05 m ✓ | 24 h 05 m ✗ | — | **2** |

- **What is guaranteed:** *if* k ≤ 3 (all branches aligned, e.g. Costa Rica only) or k ≤ 2 (any unaligned timezone), *then* R2 holds under A1–A5 with one failed run. **k itself is not guaranteed**; it is only observed.
- A bound above 24 h does not prove failure (§10h.4). The only proven failure remains one run a day.
- Why 3 h: it is the largest divisor of 24 h that satisfies the unaligned k ≤ 2 bound (4 h gives 24 h + J + P, which misses). With Costa Rica only, 4 h would also satisfy k ≤ 2 aligned, but it loses both the margin to k = 3 and the unaligned case.
- Persistent student errors (UNPRICED etc.) are outside any bound (§10h.5).

### 2.4 Assessment
- **Launch:** 1 row; k = 1 is the only plausible case; 3 h leaves a large margin (3 h 05 m aligned with f = 1).
- **Year one:** the representative 34 rows sit inside the observed k = 1 range; the upper 49 rows sit inside the observed k = 2 range. Both fit 24 h at 3 h, aligned (k ≤ 3) and unaligned (k ≤ 2), **if production k matches the Free-tier observation.**
- **Alignment is a launch property, not a permanent one.** `0 */3 * * *` is aligned for any timezone whose midnight falls on a 3-hour UTC boundary (UTC−6 Costa Rica, UTC−3, UTC+0, …). A branch in, for example, UTC−5 is unaligned, and the tolerance drops from k ≤ 3 to k ≤ 2.

---

## 3. When further throughput testing becomes necessary

**Not necessary before a launch with the §2.1 workload:** launch is 1 row, far inside the observed range. Stage 2 (production tier) is not justified by the launch workload alone.

**Necessary before (or promptly upon) any of these:**
1. **Progress rows approach 61**, the largest measured. At +4 rows/month (4 organizations) the upper case reaches 61 about 15 months after launch and the representative case about 19 months; with fewer organizations, later.
2. **Workload beyond the §10d upper case:** more than 4 organizations, an organization above ~100 students, more than 2 branches, or a growing number of former-student records (each adds one student-visit per row).
3. **An unaligned timezone is added** while rows are in the k = 2 range (the margin to k = 3 disappears).
4. **A production observation of k rising:** a run stopping at its generation deadline, or the boundary pass needing more than 2 runs. **Gap:** `JobRun` does not persist `stoppedBy` or pass completion (the schema on `main` stores counts, breakdown, error summary and heartbeat only), so today k can only be reconstructed by SQL on progress rows or from 1-day logs. Closing this gap is a code change for a later approval, not part of this brief.
5. **Production infrastructure differs materially from Stage 1** (database tier or region, pooler settings, a different Vercel region): the observation does not transfer automatically.

---

## 4. Decisions (recorded 2026-11-09)

| # | Question | Owner decision |
|---|---|---|
| 1 | Scheduling system | **Legacy Cron Jobs**, for now; revisit on the §1.5 migration triggers |
| 2 | Interval | **`0 */3 * * *` UTC**; its 24 h guarantee is conditional on k ≤ 3 aligned / k ≤ 2 unaligned, which is observed, not guaranteed |
| 3 | Throughput | **Stage 1 accepted** for launch and year one; **Stage 2 deferred**, subject to §3 and §6 |

None of these approves D5 implementation, O4 or production activation.

**Alerting decisions (owner, 2026-11-09, later the same day):** four separate checks (scheduler, urgent billing, older-month billing data, workload review; §5.8); new-month warning W = 15 h after month opening (§5.3); daily reminders for unresolved problems; urgent emails checked within one hour; **corrected the same day: the owner is the sole responder, and a separate backup inbox is planned but not created** (§5.5). Implementation plan for review: `MONTHLY-GENERATION-ALERTING-PLAN.md` (one existing + three new variables). Route budget with four pings: generation deadline 212 s (§5.10). Alert delivery and 24-hour billing completion remain **not guaranteed**.

**Further owner answers (2026-11-09):** primary alert recipient = the email address tested in the staging canary; backup recipient and response time **undecided**; workload-review thresholds raise **alerts** (not display only), kept **separate** from billing-failure alerts, and reaching one must not stop billing or mark generation failed (§5.6, §6).

---

## 5. Overdue-month detection (stage-9 blocker): how it detects unfinished billing, and who is told

### 5.1 The gap in the current rule
- `scripts/pending-callers.ts` KNOWN_LIMITATIONS (on `origin/main`) registers the blocker: the route does not report an "overdue month" (trigger plan §8: "a processed month earlier than `current_min` whose last finished pass is not clean, or which has no finished pass"). It is due before stage 9.
- **That §8 rule is too late for R2.** It flags month M only once M is *earlier* than `current_min`, i.e. after the **next** month begins: up to ~30 days after T_open(M). R2 asks for M's dues within 24 h of T_open(M). The rule still matters for older months (configuration errors that persist), but it cannot detect a late **new** month in time.
- `JobRun` persists counts, a breakdown, an error summary and the heartbeat outcome only; `stoppedBy` exists only in the HTTP body and 1-day logs (schema and `monthly-generation-route.ts` on `origin/main`). Detection must therefore read **progress rows**, which persist pass state (trigger plan §5: `lastPassCompletedAt`, `lastPassClean`, the four `lastPass…` counts, the cursor).

### 5.2 Proposed rule (design only; implementation is stage-9 work, unapproved)
For each **activated** organization (stage 9's activation record), at each run:

| Condition | Meaning | Reported as |
|---|---|---|
| **A. New month at risk:** now ≥ T_open(M) + **W** (**W = 15 h, owner decision 2026-11-09**; was proposed as 18 h) and M = `current_min` has **no row**, or its row has **no finished pass**, or its last finished pass is **not clean** | The new month has not been observed fully billed within the planned bound; R2 (24 h) is at risk | `failed` (→ `PARTIAL` → heartbeat `/fail` → Healthchecks alert) |
| **B. Older month not clean** (the existing §8 rule) | A month before `current_min` whose last finished pass observed UNPRICED or PENDING students, or has never finished a pass | `failed` in the run record; alerted on its own check (check 2, §5.6) so it cannot mask A |
| **C. Activated organization with no progress row** | Stage 9's first-row insert did not happen (it is designed to be in the activation transaction, so this should be impossible; checked anyway) | `failed` (same path) |
| **D. Detection could not complete** (its bounded read overflowed its cap or timed out) | Unknown state is treated as failure, never as "nothing overdue" | `failed` (same path) |

Definitions: `current_min` = the earliest branch-local current month across the organization's branches (trigger plan §5); T_open(M) = when the **last** of the organization's branches reached local midnight on the 1st of M (the row is created only then). Detection is phrased as "the last finished pass observed outstanding work / no finished pass", never as "the month is incomplete now" (trigger plan §3, §8).

**Placement:** a **reserved, bounded read** at the start of every generation run (one query over activated organizations' progress rows and branch timezones, `LIMIT cap + 1`), before any generation work, so its result does not depend on generation finishing. This needs the G2a route budget to reserve that read (the KNOWN_LIMITATIONS entry names this option). A separate job would need its own cron, heartbeat and Healthchecks check; not recommended.

### 5.3 Why every failure mode reaches a person
| Failure | Signal |
|---|---|
| Cron never fires, route crashes before reporting, function killed | No ping → Healthchecks **missed-ping** alert after the 30 min grace (proven: canary E7) |
| JobRun create or finalize fails | `/fail` ping (`run-scheduled-job.ts` on `origin/main`) |
| Runs succeed but billing is unfinished (A, C, D above) | `failed > 0` → `PARTIAL` → `/fail` on check 1 → alert (today's path: `pingHeartbeat(…, false)`) |
| An older month stays unclean (B) | `/fail` on check 2 → alert (proposed routing, §5.6) |
| Healthchecks not configured | `heartbeatStatus = not_configured`; readiness check 10 fails (requires `ok`) — must be closed by the production setup checklist, since nothing pings |

**Detection timing (no response time is guaranteed).** Condition A is evaluated only when a run executes and reports. It is reported at the end of the first run that starts at or after T_open + W (**W = 15 h**, owner decision 2026-11-09). Times are from T_open; I = 3 h; J = cron lateness; P ≤ 300 s (the read happens at run start, the pings at run end).

| Case | First run that can report A | A's alert at about | Left before T_open + 24 h |
|---|---|---|---|
| Aligned (Costa Rica: T_open = 06:00 UTC is a slot), no missed run | slot at 15 h | 15 h + J + P | ≤ 9 h − J − P |
| Aligned, **that run missed** | slot at 18 h | 18 h + J + P | ≤ 6 h − J − P |
| Aligned, two consecutive runs missed | slot at 21 h | 21 h + J + P | ≤ 3 h − J − P |
| Unaligned (T_open between slots), no missed run | first slot in [15 h, 18 h) | up to 18 h + J + P | between ~9 h and ~6 h − J − P |
| Unaligned, **that run missed** | first slot in [18 h, 21 h) | up to 21 h + J + P | between ~6 h and ~3 h − J − P |
| Unaligned, two consecutive runs missed | first slot in [21 h, 24 h) | up to 24 h + J + P | **possibly none: the alert can arrive after the R2 limit** |

**False warnings with W = 15 h:** the k = 2 bounds are 15 h 05 m aligned and 18 h 05 m unaligned (§2.3), so a month that is still within its bound can trigger A. In the year-one upper case (k = 2 range), a warning in normal operation is possible. A warning is a request to look, not proof that R2 will be missed.

- **A missed run is alerted separately:** the scheduler check reports the missing ping 30 min after the slot (proven in the canary). That alert says "a run did not report", not "billing is late".
- **J is not bounded.** Legacy cron delivery is best effort; J was 17–18 s on 13 logged staging slots without load. A late delivery reduces the margin one-for-one; a very late one behaves like a missed run.
- **Not included:** Healthchecks' own processing and email delivery time (not documented; the canary's missed-ping email arrived at the expected minute once), and the time until a person reads and acts.
- **So W = 15 h gives a warning, not a response window.** The margin ranges from ~9 h down to none. The owner's one-hour email-check expectation (§5.5) leaves time to act in every case except two or more consecutive missed runs, but only if the alert is delivered, which is not guaranteed.
- Condition B repeats on every run until data is fixed. Repeated failure pings do not resend the alert (§5.6).

### 5.4 What it cannot detect (stated limits)
- A clean pass is not a snapshot: work created behind the cursor during a pass is seen only by a later pass (Reopen guarantees a later pass; trigger plan §3).
- It checks the generator's own accounting, not business truth: a student without a plan assignment is `INELIGIBLE` (no work) by the existing rule. Pricing and assignment completeness belong to readiness checks 2–9.
- It does not see Healthchecks itself failing, or an alert email not being read.

### 5.5 Who receives the alerts
- **Channel:** Healthchecks email integrations, as in the canary. The application sends no email; tenant notification is not proposed or authorized.
- **Primary recipient (owner, 2026-11-09):** the email address tested in the staging canary (address not written here), for all three checks in §5.6. It must be confirmed again with a test in the production Healthchecks project before activation.
- **Corrected (owner, 2026-11-09): the owner is the sole responder; no second person is assigned.** A separate **backup inbox** is planned but **not created**. Until it exists, every alert depends on one inbox and one person.
- **Response expectation (owner, 2026-11-09): urgent emails are checked within one hour.** This is an operator expectation, not a system guarantee: alert delivery is not guaranteed, and §5.3 shows the warning can leave ~9 h down to no time before the R2 limit.
- **Reminders (owner, 2026-11-09): daily** email reminders while any problem is unresolved (Account Settings › Email Reports). Enabling them is a settings change, done at setup, not now.
- **Who acts:** the platform operator triages. Condition B (UNPRICED) is fixed by the academy's owner (pricing/configuration), whom the operator contacts. Conditions A, C, D: the operator checks the run and the progress rows and follows the runbook.

### 5.6 Separate alert channels, deduplication and reminders (verified against Healthchecks.io docs, 2026-11-09)

**Healthchecks behavior relied on (documented):**
- "When a check transitions into the 'Down' state, Healthchecks.io sends alert messages via the configured integrations" ([docs](https://healthchecks.io/docs/)). A `/fail` ping to a check that is already down sends no new alert. **Deduplication is per check, by state.**
- `/log` "Sends logging information … without signaling success or failure … The check's status will remain the same" ([HTTP API](https://healthchecks.io/docs/http_api/)).
- Repeated reminders: "Healthchecks.io can send **hourly or daily email reminders** if any check is down in any of your projects" (Account Settings › Email Reports; [configuring notifications](https://healthchecks.io/docs/configuring_notifications/)). They are account-wide, not per check, and email only.

**Consequence: one shared check would mask alerts.** If a persistent condition B (an unpriced student in an older month) keeps the check down, a later urgent condition A on the same check produces **no new alert**. Hence three checks, each with its own ping URL (production-only env vars):

| Check | Signals | Schedule in Healthchecks | Affects the run's outcome? |
|---|---|---|---|
| **1. `monthly-generation`** (scheduler + urgent billing) | success, or `/fail` on: the run's own errors, condition **A**, **C**, **D** | cron `0 */3 * * *` UTC, grace 30 min (as tested) | Yes: these are billing failures (`PARTIAL`/`FAILED`) |
| **2. `monthly-generation-billing-data`** (persistent configuration/data) | success, or `/fail` on condition **B** (older month not clean: UNPRICED/PENDING) | simple, long period (e.g. 7 days, grace 1 day) so a stopped scheduler is alerted once, by check 1 | Yes: still a billing failure in the run record; only its **alert channel** moves |
| **3. `monthly-generation-workload-review`** | success below every §6 threshold; `/fail` when any is reached | simple, long period (e.g. 7 days, grace 1 day) | **No.** Never counted in `failed`, never changes `JobRun.status`, never stops or alters billing. A failed ping to this check is ignored by the run |

**Change this implies (unapproved):** today `summarizeMonthlyGenerationRun` counts unclean pass ends as `failed`, and `runScheduledJob` sends one heartbeat per run. Routing B to check 2 and the workload signal to check 3 is a route/wrapper change, as is the reserved read (§5.2).

**Deduplication rules:**
- One alert per check per transition into Down. While the condition persists, every run re-sends `/fail`: nothing is re-sent to people, and the check stays down.
- Recovery: the first run without the condition sends success and the check goes Up (an "up" notification, if the integration has it enabled).
- **Known noise source:** a transient PENDING student (lock contention under an overlapping or duplicate run) can turn check 2 down for one pass and up at the next. Progress rows keep only the **last** pass, so the app cannot require persistence across passes without new state. Accepted for now; revisit if it happens.

**Reminders (proposed):** enable the **daily** email reminder in Account Settings › Email Reports for the account that owns these checks. It lists every check that is down, so a long-running check 3 (review in progress) or check 2 (data not fixed) keeps reminding once a day. Hourly is not recommended (noise). Reminders are an account setting: enabling them is a settings change for the owner, not authorized here.

**Acknowledging a workload alert:** the review is recorded, then the threshold constants are raised in a reviewed change; the next run pings success and check 3 goes Up. Pausing check 3 as an acknowledgement is possible, but how a paused check reacts to later pings is not verified here and must be checked before relying on it.

### 5.7 The three checks, defined completely (proposal; supersedes the table above where more specific)

Common rules: each run evaluates conditions A–D and the §6 counts from one reserved, bounded read at run start. A check that the run cannot evaluate receives **no ping** that run (never a success by default). Healthchecks alerts only on a transition into Down; a later success ping returns the check to Up. Each ping is a separate request with the existing 5 s client timeout, so the route budget must reserve one ping per check (today it reserves one).

1. **Check 1 — `monthly-generation` (scheduler and urgent billing).** Healthchecks schedule: cron `0 */3 * * *` UTC, grace 30 min (as tested in the canary). **Triggers (Down):** (a) no success ping by slot + 30 min, meaning the cron did not fire, the run was killed, or it ended before pinging; (b) a `/fail` ping from a run that threw, failed to create or finalize its `JobRun`, failed outside a student transaction, or found condition **A** (new month at risk), **C** (activated organization without a progress row) or **D** (the detection read overflowed or failed). **Recovery (Up):** the first run that finalizes its `JobRun` with none of (b) present sends a success ping: A clears once the new month has a clean finished pass; C once the row exists; D once the read succeeds. **Effect on `JobRun`:** these are billing failures. They are counted in `failed`, so the run is `PARTIAL` when it also created or skipped work, `FAILED` when it did nothing else or threw (`run-scheduled-job.ts` status rule on `origin/main`).

2. **Check 2 — `monthly-generation-billing-data` (persistent data and configuration).** Healthchecks schedule: simple, period 7 days, grace 1 day, so a stopped scheduler is alerted by check 1 alone and only an outage of more than ~8 days also turns check 2 down. **Trigger (Down):** a `/fail` ping when condition **B** holds, meaning some month before `current_min` has a last finished pass that observed UNPRICED or PENDING students, or has never finished a pass. B is read from persisted progress rows, so it stays true between runs that do not revisit that month, and changes only when a pass of that month finishes. **Recovery (Up):** the first run in which no older month meets B sends a success ping, typically after the data is fixed and the month's next pass finishes clean. **Effect on `JobRun`:** still a billing failure, counted in `failed` (`PARTIAL`/`FAILED` as above). Only the alert channel differs from check 1.

3. **Check 3 — `monthly-generation-workload-review` (capacity review, not billing).** Healthchecks schedule: simple, period 7 days, grace 1 day. **Trigger (Down):** a `/fail` ping when any §6 threshold is reached, or no ping for ~8 days. **Recovery (Up):** a success ping once every count is below its threshold; in practice counts rarely fall, so recovery follows a recorded review and a reviewed change that raises the threshold constants. **Effect on `JobRun`:** **none.** Not counted in `failed`, never changes `JobRun.status`, never stops, slows or alters billing, and a failed request to this check is ignored by the run.

### 5.8 Can one persistent urgent problem suppress another within check 1? Yes

Check 1 has one state. While it is Down, nothing new is sent, whatever the reason:
- **A persistent A, C or D masks a second one,** for another organization, another month or another condition. Only the first transition alerts.
- **A billing `/fail` masks a scheduler outage.** If check 1 is already Down because of A and the cron then stops firing, the missing pings cause no new transition. The scheduler failure goes unnoticed until the check recovers, and it cannot recover without a run.
- The daily account reminder (§5.6) only repeats that the check is still Down; it does not report a new cause.

**Options (owner decision; none implemented):**
- **(i) Split check 1 into 1a and 1b.** Check 1a, scheduler liveness: a success ping whenever the run finalizes its `JobRun`, whatever the billing outcome; `/fail` only when bookkeeping fails; a missed ping alerts. Check 1b, urgent billing: success or `/fail` for A, C, D and run-level errors. A billing problem then cannot hide a scheduler outage. **Recommended.** It makes four checks.
- **(ii) Re-arm on a new cause.** The run remembers which urgent causes it has already reported and, when a new one appears, sends a success ping immediately followed by `/fail` to force a fresh transition. This needs new persisted state (a schema change) and is noisier.
- **(iii) Accept it.** Rely on the operator resolving a Down check 1 promptly and on the daily reminder, knowing new causes are not announced while the check is Down.

Even with (i), a persistent problem in 1b still masks a second urgent billing problem in 1b, and in check 2 likewise. Only (ii), or per-organization checks (which do not scale within the plan limit), removes that.

**Owner decision (2026-11-09): option (i), four separate checks:** **1a scheduler** (liveness: success whenever the run finalizes its `JobRun`, whatever the billing outcome; `/fail` on bookkeeping failure; missed ping alerts), **1b urgent billing** (A, C, D, run-level errors, budget infeasible), **2 older-month billing data** (B), **3 workload review** (§6). The §5.7 definitions apply, with check 1's triggers divided between 1a and 1b. The residual limit stays: a persistent problem in 1b (or 2) still masks a second one in the same check.

### 5.10 Route budget recalculated for four pings (before implementation)

Formula on `origin/main` (`monthly-generation-route-budget.ts`): generation deadline = F − C − M − post, with post = 2 × tx (finalize + heartbeat-status write) + heartbeat reserve. Values on `origin/main`: F = 300 s; C = 30 s and M = 30 s (owner-chosen reserves, not measurements); tx = 1 + 2 + 1 = 4 s (bookkeeping maxWait + timeout + statement); heartbeat reserve = `HEARTBEAT_TIMEOUT_MS` = 5 s per ping.

| Design | post | **Generation deadline** | Admission (must be below the deadline) |
|---|---|---|---|
| Today: one ping | 2·4 + 5 = 13 s | **227 s** | 44 s (tx 4 + discovery 4 + one visit's entry 36) |
| **Four pings, sequential (recommended reservation)** | 2·4 + 4·5 = 28 s | **212 s** (−15 s, −6.6%) | 44 s: feasible |
| Four pings, sent concurrently | 2·4 + 5 = 13 s | 227 s | 44 s |
| Four sequential pings + the §5.2 detection read (if bounded like a bookkeeping transaction, 4 s) | 28 s | **212 s** | 48 s: feasible. The read runs before the runner; the route passes `elapsedMs` from the handler's start, so its actual time is taken from the 212 s automatically, and only admission needs the extra 4 s |

Notes:
- **Recommended: reserve for sequential pings (212 s).** The concurrent figure holds only if the four requests are actually concurrent and each still aborts at 5 s; that is an implementation detail to be proven by tests, not assumed.
- **Failure paths** (create failed, finalize unconfirmed, budget infeasible) send at most the 1a/1b pings and are covered by post + M.
- **`JobRun.heartbeatStatus` stores one outcome.** Recording four needs a schema change or a combined representation (implementation decision).
- **Effect on throughput (extrapolation, NOT measured):** Stage 1 was measured with a 227 s deadline (first call ~4.3 s per progress row; k = 2 from 41 rows). Scaling linearly, a 212 s deadline would move the k = 1 → 2 change from ~41 to ~38 rows; two calls would still cover the measured 61 rows (~262 s of row work against 2 × 212 s). This does not change the §6 threshold (50 rows), but the accepted Stage 1 evidence was obtained at 227 s, not 212 s.

### 5.9 Healthchecks.io plan fit (verified 2026-11-09; no paid resource needed)
- **Free (Hobbyist): "Monitor 20 jobs"** and "100 log entries per job" ([pricing](https://healthchecks.io/pricing/)). The 20-check limit is per account and shared across all its projects ([projects and teams](https://healthchecks.io/docs/projects_teams/)). This proposal needs **3 checks, or 4 with option (i)**, plus any checks the owner already has (for example, one for the weekly digest if it is monitored). The current count in the owner's account is not known here and must be checked.
- **Email notifications:** not listed as a plan feature and no email quota is stated, but the canary's email alert was delivered on the owner's free account without a payment method.
- **Hourly/daily reminders:** documented under Account Settings › Email Reports, with no plan restriction stated.
- **SMS/WhatsApp/phone:** no free-plan quota stated; not proposed.
- **Next tier:** Supporter $5/month has the same limits; Business $20/month raises the limit to 100 checks. **Not needed** for this proposal.

---

## 6. Review threshold, before the measured workload is exceeded

The measured envelope (Stage 1): ≤ 61 progress rows, 4 organizations, 280 students (one of 100 students on 2 branches, three of 60), one timezone; k = 2 began at 41 rows.

**Proposed review threshold (any one triggers a review; a review decides between continuing, Stage 2 / a re-test, or a schedule change):**

**What is counted.** Every row the Reopen generator revisits. Discovery (`listClaimableGenerationSegments`, `src/lib/tenant/platform-lookups.ts:150` on `origin/main`) selects from **all** `DuesGenerationProgress` rows, filtered only by lease and the run's own exclusions: no `closedAt` filter and no organization-status filter. Under Reopen nothing closes. Rows of a suspended or deactivated organization are still claimed (the visit then refuses at the gate), so they still cost time and are counted.

| Measure (exact definition) | Threshold | Reason |
|---|---|---|
| **Progress rows:** `count(*)` of `DuesGenerationProgress`, every organization, every status | **≥ 50** | ~80% of the measured 61; at +4 rows/month (4 organizations) ≈ 3 months to finish a review or re-test before 61 |
| **Organizations with progress rows:** distinct `organizationId` in `DuesGenerationProgress` | **> 4** | Beyond the measured world |
| **Students in one organization:** `count(*)` of `Student` rows in an organization that has progress rows, **any status** (former and inactive students are visited by every pass; each is one student-visit per month row) | **> 100** | Beyond the measured largest organization (100 students) |
| **Students, all such organizations:** the same count summed over every organization that has progress rows | **> 280** | Beyond the measured world (100 + 3 × 60) |
| **Branches in one organization** (organizations with progress rows) | **> 2** | Beyond the measured world |
| **Timezone:** any branch, in an organization with progress rows, whose local midnight is not on a 3-hour UTC boundary | **any** | Tolerance drops from k ≤ 3 to k ≤ 2 (§2.3) |

**Separate from billing (owner, 2026-11-09):** a reached threshold raises an **alert** through check 3 (§5.6), not a display-only signal. It must **not** stop billing and must **not** mark generation failed: no effect on `failed`, `JobRun.status`, check 1 or check 2. The counts come from the same bounded read as §5.2; if that read fails, condition D reports it on check 1, and check 3 simply receives no ping that run.

**Also a review trigger, but alerted as billing:** any occurrence of condition A (§5.2). It already alerts on check 1; a review is recorded afterwards.

Projected dates (estimates, §10d): with only the launch organization, 50 rows are ~4 years away; in the upper year-one case, ~month 13 after launch; in the representative case, ~month 16.

---

## 7. Remaining activation blockers (status 2026-11-09)

| # | Blocker | Status |
|---|---|---|
| 1 | **D5 implementation:** the `vercel.json` `crons` entry `/api/cron/monthly-generation` `0 */3 * * *` and its stale threshold (the canary used 4 h) in one change, per the existing unit test | Planning decided; **implementation not approved** |
| 2 | **Weekly digest:** enabling project crons enables **every** `crons` entry; on staging that includes the weekly digest. Its own approval for the target environment must be confirmed before crons are enabled there | Open |
| 3 | **Production environment:** D5 discovery recorded (2026-10-21) that no production Vercel or database project existed; only staging has been created since. Production provisioning, the migrations there (including `DuesGenerationProgress`), `CRON_SECRET`, and the production Healthchecks check and env var | Not approved, not verified |
| 4 | **Production person checks:** E3 (cron registered), E5 (authenticated run), E7 (alert delivered) in production; stored branch timezones checked there | After 1–3 |
| 5 | **Stage 9:** the activation record behind `isActive` and `generationStart`; the first progress row for S inside the activation transaction; gate lock, legacy refusal, opening obligations | Not planned/approved |
| 6 | **Overdue-month detection (§5)**, three separate alert checks (§5.6), and the **workload review threshold (§6)** | Designed here. Decided: primary recipient = canary-tested address; workload thresholds alert (check 3), separate from billing. Decided 2026-11-09: four checks (§5.8), W = 15 h, daily reminders, one-hour email check; the owner is the sole responder. **Pending:** creating the planned backup inbox; review of `MONTHLY-GENERATION-ALERTING-PLAN.md`. Route budget with four pings: 212 s (§5.10). Free plan fits (§5.9). Implementation and settings unchanged |
| 7 | **O4** (payment-reversal policy): readiness checks 11–12 `notImplemented`, 13 `decisionPending`; `ready` false | Undecided |
| 8 | **Ledger activation:** `inactiveLedgerActivation` is the only production activation | Off; activation unapproved |
| 9 | **Late-fee runner** (`assessLateFeesForStudent`): no caller by design ("activation / scheduler rollout stage", KNOWN_LIMITATIONS) | Unscheduled |
| 10 | **Production activation** itself | Unapproved |

Engineering note (not a blocker): persisting `stoppedBy` or pass completion on each run would make k observable without 1-day logs; §6's row-count threshold does not depend on it.
