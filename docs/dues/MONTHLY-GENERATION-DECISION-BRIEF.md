# Monthly generation: remaining decisions (D3, D5) and the next implementation boundary

**Status:** decision brief, revision 3, planning only. Written against main `50ff5084d1ce04c6b0d036f58741db6b95df7b26` (G1
merged; complete in code only). Nothing is implemented, scheduled, migrated outside isolated test databases, deployed or
activated. Every code claim below was checked at this commit.

## 0. Recorded owner answers (revision 3)

| Item | Status | Owner's answer |
|---|---|---|
| **D3: older months** | **Approved policy** | **Reopen.** Every month since S remains eligible for repeated processing. The owner understands this does not guarantee billing completeness (§1.2) |
| **Historical charges** | **Approved policy** | **Accept the existing behavior** (§1.3): a missing obligation created late keeps its original due date and grace deadline, and the existing payment rule assesses the late fee when payment is received after the grace deadline. Existing obligations remain unchanged. No different treatment is requested |
| **Hosting** | **Unknown** (a missing deployment fact) | Whether production Vercel and Supabase projects exist is not recorded either way until it is verified (§2.3) |
| **Expected initial load** | **Unknown** (a missing input) | Organizations, students per organization and branches per organization: not given. Revision 2's illustrative counts are **not** requirements |
| **Schedule** | **Provisional, not approved** | **Daily at 07:00 UTC,** subject to hosting verification. For a branch in `America/Costa_Rica` that is 01:00 local, after that timezone's month boundary (06:00 UTC on the 1st). Valid for other branches only once their stored timezones are verified (§2.5) |
| **Monitoring setup, and a hosted staging measurement** | **Pending** | Waiting until the target environment and access are confirmed |
| **D5 overall** | **Pending** | Waiting on hosting verification and the load |

**What these answers leave unchanged:**
- **O4** remains undecided.
- **`ready`** stays false.
- **Activation** stays off.
- **D3 = Reopen authorizes no implementation.** G2 still waits on D5 (§3).

**Revision 2 corrects revision 1 on five points:**
1. Reopen does not guarantee completeness.
2. Creating a missing obligation is distinguished from changing an existing one.
3. Due date, grace deadline and late fee are separated.
4. An unsupported throughput estimate and a UTC scheduling promise are removed.
5. Hosting facts are separated by source, and `runScheduledJob`'s bookkeeping becomes a G2 requirement.

---

## 1. D3: what happens to older months

### 1.1 What the existing code does (verified)

- **Generation only ever creates a *missing* `MONTHLY` obligation.** If one already exists for that student and month,
  the writer returns it unchanged: no snapshot edit, no coverage row, no audit row (`create-monthly-obligation.ts`, the
  duplicate check before any write). If the month is already covered by a package or prepayment, it refuses
  `coverageTaken`, which G1 counts as COVERED.
- **Generation never changes, voids or re-prices an existing obligation.** That holds under both options. A later price or
  status correction therefore never alters a charge that already exists; that remains a separate staff action.
- **G1 keeps every month from S onward open,** and nothing closes a month. A "clean pass" means only that the job saw no
  outstanding work when it visited each student, not that the month is complete now.

### 1.2 The two options

| | **Close** | **Reopen** |
|---|---|---|
| In one sentence | A month stops being processed once a pass finds it clean, with no relevant change during that pass, and the month is at least 2 months old | Every month since S **remains eligible for repeated processing** |
| A *missing* obligation discovered later for an old month | Created automatically only while the month is open. After closing: never, unless a manual path is used, and that path **does not exist** | Created automatically at a later pass, if that pass reaches the student and the student is eligible and priced then |
| An *existing* obligation | Never changed | Never changed |
| Completeness | Not guaranteed. Closing additionally makes later changes permanently invisible to the job | **Not guaranteed either.** Configuration gaps (missing price, inactive branch), repeated failures and processing capacity can leave work unresolved indefinitely. Reopen only keeps the month *eligible* to be retried |
| Unresolved work | An unclean month never closes; it stays open and alerting | Stays visible and alerting |
| Cost over time | Bounded: roughly 2–3 open months per organization | Grows without limit: one more month per organization every month, and each pass re-walks every student of every open month |
| Required safeguards | A per-organization change counter, incremented by every writer of generation inputs, and serialized with the close (§1.5) | None beyond G1 |
| Manual recovery needed | Yes: a reviewed path for closed months, plus optional automatic flagging of later changes. Neither exists | No |

### 1.3 Dates and fees of an obligation created late (verified)

**What the dates are.** Both dates come only from the coverage month and the policy version effective for it (existing
writer rule; `calendar.ts`):
- **Due date:** the policy's due day **in the coverage month**, clamped to that month's length.
- **Grace deadline:** the policy's grace day **in the following month**, clamped, and **inclusive**. A payment received on
  that date is on time.

**What generation does about fees.** Generation **does not create a late fee.** It snapshots the policy's late-fee *amount*
onto the obligation and writes no `DuesLateFee` row.

**Where a late fee row can come from (existing code):**
- **The payment writer.** `recordDuesPayment` assesses the fee, inside the same transaction, when the payment's received date
  is after the grace deadline (`assessLateFeeInTx` via `lateFeeApplies`). The fee becomes assessable from the day after the
  grace deadline.
- **The proactive late-fee runner** (`assessLateFeesForStudent`). It has **no production caller** and is not scheduled; its
  own trigger is a separate plan.
- D7 (no automatic late fee on opening debt) concerns opening items, not generated `MONTHLY` obligations.

**Example:** a February obligation, due day 20, grace day 5. The dates are fixed whenever it is created: due February 20,
grace deadline March 5.

| Created on | State at creation | A payment recorded the same day |
|---|---|---|
| February 10 | Not yet due | On time |
| March 1 | **Past due**, within grace | On time (≤ March 5): no fee |
| June 20 (a late assignment, Reopen) | **Past due and past grace** | Late: the existing payment writer assesses the snapshotted fee |

So under Reopen, any missing obligation created after its grace deadline is born past due and past grace. The first payment
recorded against it will carry the late fee under the **existing** payment rule. The same holds under Close for anything
created while the month is still open, for example after an outage.

**The owner decision inside D3:** whether to allow automatic creation of missing historical obligations **using those
original dates**, which is today's writer behavior. Any different treatment would be a separate policy change, not part of
D3 or G2, and is not proposed here:
- shifted due dates;
- a grace period counted from creation;
- waiving the fee for job-created historical charges.

### 1.4 Concrete examples

S = February 2027; prices present unless stated; Close needs a month to be at least 2 months old.

| Event | Close | Reopen |
|---|---|---|
| **A late assignment.** On 20 June, an owner enters a February assignment for a student who had none | February has already closed: **no obligation**, and nothing flags it | A February obligation is created at a later pass, with the original dates (§1.3): born past grace |
| The same assignment entered **during** February's closing pass | The counter changes, so no close; the next pass creates it | Created at a later pass |
| **A student added after a pass,** with an id sorting behind the cursor | If the month later closes, never created for that month. Normal enrollment creates its own month's charge (`enrollment-charge.ts`), so this mostly affects back-dated students | Created at a later pass |
| **A price added** for a month that had none (an existing configuration gap) | The month could not close while unpriced, so the obligation is created once the price exists, with original dates | Same |
| A **price correction** for a month **already billed** | No change to the existing obligation | Same |
| A **status correction** making a student retroactively ACTIVE for an old month | If closed: no obligation | Created at a later pass, original dates |
| A status correction making a student retroactively INACTIVE (obligation exists) | Not changed; correcting it is a separate staff action | Same |
| **A multi-month outage** (no successful run from February to July) | Missing months are created at no more than 3 new month rows per visit. Their obligations are created as passes reach them, with original dates, so most are born past grace. Months close only after clean, unchanged passes | Same creation; nothing closes |

### 1.5 What choosing Close adds ("G1-close")

1. **Schema (an extension of D2):** a per-organization generation-input counter, and `closedAt` with a partial index on
   open rows.
2. **Writer changes:** every writer of generation inputs increments the counter in its own transaction. The writers cover:
   - student creation, branch move and status;
   - `StudentStatusChange`;
   - `StudentPlanAssignment`;
   - plan, terms and policy saves;
   - `Academy.active` and timezone;
   - any void or removal of a `DuesObligation` or `DuesCoverage`.

   A structural test must keep this inventory complete. **This touches many existing staff writers, including financial
   ones.**
3. **The closure check** at pass end, with the counter row locked after the progress row. Plus race and deadlock tests.
4. **Known weaknesses:**
   - busy organizations may rarely close a month;
   - changes after closure are not detected unless writers also check `closedAt`.
5. **A separate plan** for the reviewed manual path.

### 1.6 Recommendation (revision 2), now decided

**Decided in revision 3 (§0):** Reopen, with the original-date behavior accepted. The reasoning below is kept as the record.

**Reopen, provided you accept the original-date behavior in §1.3.**

**Why:**
- It is G1's existing behavior: no new schema and no changes to other staff writers.
- It never makes a later correction *permanently* invisible to the job.

**What it does not do:** it does not guarantee completeness (§1.2), and its cost grows without limit. Revisit D3 when
measured pass times show open months no longer being revisited within an acceptable time (§2.4).

**If you do not accept original dates for historical charges,** that is a separate policy change. It would need its own
writer decision before either option could create such charges.

---

## 2. D5: hosting and scheduling

### 2.1 Verified in the repository at 50ff508

| Fact | Where |
|---|---|
| One cron: the weekly digest, `0 13 * * 1`. **No monthly-generation entry** | `vercel.json` |
| No `maxDuration` export anywhere; cron routes use the Node runtime | `src/app/api/**` |
| Next.js 15.5.25 | `package.json` |
| The job wrapper: bearer `CRON_SECRET`; `JobRun` create, finalize and heartbeat-status writes; a Healthchecks ping with a 5 s abort and a per-job URL environment variable | `src/lib/jobs/run-scheduled-job.ts`, `heartbeat.ts` |
| Registry `JOB_NAMES = ["weekly-digest"]`. Stale after 8 days (digest); stuck after 30 minutes `RUNNING` | `src/lib/jobs/job-names.ts`, `job-health.ts` |
| pg pool: default max 10 **per function instance**; `idleTimeoutMillis` 5 s; `attachDatabasePool` (inert off Vercel) | `src/lib/prisma/database-pool.ts` |
| **Branch timezones:** `America/Costa_Rica` (UTC−6, no daylight saving) is the **application default**. It is the schema default, and neither creation path (`location-service.ts`, `approve-organization.ts`) sets a timezone. No application path edits it. The column accepts any IANA name, which seeds, imports or direct edits could store. **The values actually stored in the intended environment are unverified** | `prisma/schema.prisma`, the two creation paths |
| **G1 limits:** deadline T = 45 s, lease L = 600 s; short transaction worst case 4 s (1 + 2 + 1); student transaction 8 s (2 + 5 + 1), plus its failure record 4 s | `monthly-generation-progress.ts` |

### 2.2 Documented intent in the repository (not verified against any provider)

`docs/DEPLOYMENT_RUNBOOK.md` plans this stack for the **first** production deploy:
- **Vercel Pro and Supabase Pro.**
- **Regions:** functions in `iad1`, the database in AWS `us-east-1`.
- **Connections:** `DATABASE_URL` is Supavisor's transaction-mode pooler (port 6543); migrations go over the direct
  connection.
- **Function type:** Fluid compute.
- **Crons** take effect only on production deployments.

These are plans, not observed configuration.

### 2.3 What read-only discovery found, and what it could not reach

- **No Vercel CLI** is installed, and the repository has no `.vercel` project link. There is no read-only provider access
  from this machine.
- **GitHub has zero deployments** and no environments for this repository, so there is no evidence that a production Vercel
  project is connected yet. Listing the GitHub integration returned 401 (not permitted).
- **No Supabase access** was used or available. The local `.env` points at local and development resources, not production.

**Unavailable with current access**, each needed to validate T, L and the schedule:
1. The real plan tier and this project's **maximum function duration** for a cron route (default and configurable).
2. The function's memory/CPU size and cold-start time.
3. **Cron limits** on that plan: how many jobs, the minimum interval, timing precision, and the timezone.
4. **Cron invocation behavior:** retries, overlapping or duplicate invocations, and whether deployment protection applies
   to cron requests.
5. The **actual regions**, or a measured function-to-database round trip.
6. **Connection limits:**
   - Supavisor's pool size and client limit;
   - the server's `max_connections`;
   - how many function instances can run at once.
7. **Whether Supavisor honors `SET LOCAL statement_timeout`/`lock_timeout` per transaction,** and any role- or server-level
   `statement_timeout`.
8. The **Postgres version** (an earlier PR's open deployment check: PostgreSQL 12+).
9. **Whether the production `CRON_SECRET` and a Healthchecks check** for this job exist, and whether alert delivery has been
   tested (E7).

### 2.4 The deadline and throughput: what is and is not known

**What is known:**
- **The 40 s admission budget is enforced.** Before discovery and each claim, the run requires `elapsed + 40 s < 45 s`
  (discovery 4 s + claim, gate, rollover, page and marker at 4 s each + one student at 8 + 4 s + the release at 4 s). So a
  run that has not started its first discovery within **5 s of the runner starting** claims nothing.
- **After admission,** each further student needs `elapsed + (marker) + 12 s + 4 s < 45 s`. These are **worst-case
  admission rules**, not predictions. A fast student takes a small fraction of its budget, and the admission check uses
  real elapsed time.
- **Measured** (isolated test database only, local Docker):
  - the protocol's behavior under real lock waits and pool exhaustion;
  - that a run with every student blocked until its 300 ms statement timeout returned before a 9 s deadline.

**What is not known:** **hosted throughput is not measured.** No figure exists for students per run or per day on the real
stack. Test-database and CI timings do not establish it, and a configured cron does not prove successful execution (E2/E3
versus E4/E5). It needs one measured run on the hosted stack, which is a person's action outside this repository.

### 2.5 Scheduling against branch-local month boundaries

- **How a month is reached:**
  - A month's progress row is created only once **every** branch of the organization has reached that month in its own
    timezone (`current_min`).
  - The runner refuses a month a student's branch has not reached (the future-month check, under the branch lock).
  - So any schedule is correct; the hour only changes how soon after a branch-local month boundary work starts.
- **The application default** is `America/Costa_Rica`, whose month boundary is **06:00 UTC on the 1st** (no daylight
  saving). The provisional 07:00 UTC run (§0) is 01:00 there, inside the new month. **Whether the intended environment's
  branches actually store that timezone is unverified;** check the stored values in that environment's database before the
  schedule is approved.
- **No single UTC time is after local midnight on the same date in every timezone.** If a branch stores another timezone,
  the time to first processing grows by up to the spread between the organization's timezones, plus up to one schedule
  interval. The design tolerates this; it only delays the work.

**The schedule needs these facts:**
- **Facts 1–4 (§2.3):** whether the interval and duration you choose are allowed.
- **The measured throughput (§2.4):** whether one run a day keeps up, including after an outage (no more than 3 new month
  rows per visit).
- **Your expected load:** organizations, students and branches.

---

## 3. The next implementation boundary

### 3.1 G2 design requirement: the whole-route budget (not only the runner)

**The runner's deadline T bounds only `runMonthlyGeneration`, not the route.** At 50ff508, `runScheduledJob`:
1. checks the bearer;
2. runs `prisma.jobRun.create`, a plain query that waits for a pool connection **with no bound** (measured in G1's review:
   plain queries wait indefinitely under pool exhaustion);
3. runs the job;
4. runs `prisma.jobRun.update` to finalize (also unbounded);
5. sends the Healthchecks ping (5 s abort);
6. runs the `heartbeatStatus` update (unbounded; its failure is caught).

**G2 must:**
- **Bound or budget every bookkeeping step,** so that cold start + the `JobRun` insert + T + the finalize + the heartbeat
  (≤ 5 s) + the status update + margin < the host's maximum function duration (fact 1). For example, bounded transactions
  with `maxWait`/`timeout`, or a smaller T. The choice is a G2 engineering item.
- **Define failure reporting for each step:**
  - **The `JobRun` insert fails:** no run happens. The missing ping is the alert.
  - **The finalize fails:** the row stays `RUNNING` (reported stuck after 30 minutes), and no ping is sent.
  - **The heartbeat request fails:** recorded in `heartbeatStatus` when that update succeeds.
- **Keep lease recovery valid:**
  - If the host kills the function mid-visit, the segment's lease remains until L expires.
  - L must exceed the real maximum function duration.
  - A killed student transaction is rolled back by the database.
  - The crash marker counts that visit.
- **Not change `runScheduledJob`'s behavior for the weekly digest** without that change being reviewed for the digest too
  (it is a shared wrapper).

### 3.2 What G2 can contain, once D3 is decided and the D5 facts are in

- the route `GET /api/cron/monthly-generation` through the wrapper (bearer authentication; no request inputs);
- registry, stale threshold and heartbeat entries;
- the `vercel.json` entry;
- readiness check 10 (trigger health only);
- the runbook;
- the D3 production value of `closurePolicy`;
- the §3.1 bookkeeping budget;
- dark-run tests.

### 3.3 What must stay disabled until stage 9

- `inactiveLedgerActivation` stays the activation;
- `generationStart` stays `null`;
- nothing inserts an organization's first progress row;
- no organization is activated;
- checks 11–12 stay `notImplemented`; O4 stays undecided; `ready` stays false.

Until then a scheduled G2 writes only `JobRun` rows and sends a heartbeat (the plan's dark-run disclosure).

### 3.4 D3 timing

| D3 choice | Before G2 | Before stage 9 activation |
|---|---|---|
| **Reopen** (decided, §0) | Nothing more for D3: the decision is recorded and G2 will set the production value. G2 still waits on D5 | Nothing more |
| **Close** | The decision only. G1-close need not precede G2: with no segments before stage 9, closure can never run | **G1-close merged.** Strictly, it is needed before the first possible closure (S + 2), but activating without it would bill under Reopen behavior first and then switch policy |

**The dependencies, not a fixed order:**
- G2 needs D3 decided, the D5 facts and §3.1.
- Production scheduling needs D5 approval and a person's checks (E3, E5, E7).
- G1-close (only if Close) needs the D2 extension, and must come before activation.
- Stage 9 needs its own approvals and O4.

G2 and G1-close are independent of each other.

### 3.5 Remaining blockers (revision 3)

1. **Hosting existence and limits (§2.3, facts 1–9):** unknown, and they need provider access.
2. **Stored branch timezones** in the intended environment: unverified.
3. **Expected load:** unknown.
4. **Hosted throughput:** unmeasured. It needs the target environment.
5. **Monitoring** (the production `CRON_SECRET`, a Healthchecks check, E7): pending.
6. **D5 approval**, which depends on 1–5.
7. **G2's whole-route budget (§3.1):** not yet designed.
8. **Stage 9 and O4** for any activation.

**The smallest next task that needs no provider access:** a planning-only design for §3.1, the whole-route budget of
`runScheduledJob`, worked from the repository alone:
- bounding or budgeting the `JobRun` writes and the heartbeat;
- failure reporting at each step;
- lease recovery when the host kills a run;
- the effect on the shared weekly-digest wrapper.

Every number in it would be a parameter of the unknown maximum function duration, not a value. It is a precondition for
G2, and blockers 1–6 do not block it.

**Separate from this brief:** other launch work (the security-header hosting checks, the first production deploy itself,
and the remaining launch-readiness items) is tracked in its own documents.
