# Promotion progress: decided accounting (PR 2)

**Status: DECIDED and implemented in PR 2 (branch `feat/promotion-reset-accounting`), not merged.**
The academy's decisions were confirmed through the owner on 2026-09-23. They **supersede** the
earlier proposal that this file used to hold (carryover between awards, head-start credits, signed
progress adjustments, date-only and unknown start anchors, reconciliation states, a carry table and
carry-correction workflows, time-anchor blocking, and automatic promotion as an open question). None
of those is built and none is planned. What remains open is listed in section 7 and is explicitly
**PENDING**.

The questions the academy answered, and the answer recorded for each, are in
[PROMOTION_DIRECTOR_QUESTIONNAIRE.md](PROMOTION_DIRECTOR_QUESTIONNAIRE.md). The requirement to
supersede the old cumulative text in `docs/MULTI_ACADEMY_AND_KIDS_BELTS.md` was carried out in that
document (revision 45).

Attendance-based examples below (30 classes per stripe, 10 for kids) describe the attendance-based
adult belts and kids ranks. They do **not** describe the black belt, which is time-based (section 4.5).

## 1. Decision register

| # | Decision | Status |
|---|---|---|
| 1 | A student receives at most **one** qualifying attendance per America/Costa_Rica calendar day. Kiosk, portal and coach-added attendance share the limit. The day's first class counts as 1; more classes that day add 0. A promotion does not clear the limit. Recorded participation is preserved; only the single daily contribution counts toward progress. | DECIDED |
| 2 | Progress **resets to 0 after every promotion** (adults and kids; stripes/degrees and belts). The exact promotion timestamp is saved. The class attended before the award belongs to the completed interval. No carryover, including classes attended while waiting for an award. Late-recorded attendance from before the award stays in history and adds nothing toward the next interval. | DECIDED |
| 3 | Students keep their entered rank and stripes but start academy progress at **0**. No head-start credits and no arbitrary positive or negative progress credits. Missing historical promotion dates never block attendance progress. The system tracking baseline is recorded separately from the historical belt date; no historical promotion is ever invented. Where a historical date-only boundary is intentionally used, that day's classes are excluded. | DECIDED |
| 4 | The assumed policy of moving old credit corrections into current progress is **withdrawn**. Duplicate daily contributions are prevented instead. Legitimate attendance correction and audit remain; they are not unrestricted progress credit. A later correction never revokes a promotion; a coach explicitly corrects an award. | DECIDED |
| 5 | Adult thresholds: white 30, blue 65, purple 75, brown 85 per stripe, and the same interval again for belt eligibility after the final stripe. Kids: 10 qualifying days per degree, then 10 more for the belt. Adults and kids both reset after every award. | DECIDED |
| 6 | Black belt is **time-based**: black to degree 1 = 36 months, 1 to 2 = 36, 2 to 3 = 36, 3 to 4 = 60, 4 to 5 = 60, 5 to 6 = 60. Intervals may differ per degree. Eligibility is configured through degree 6 only; later degrees are unconfigured, not impossible. Existing black belts show rank and attendance without a due date until their real last-award date is supplied. Future awards save the real award timestamp. No dates are fabricated and no fictional black belts are seeded. | DECIDED (the roster of existing black belts is PENDING, section 7) |
| 7 | **No automatic promotions**, for any academy, enforced on the server including the scheduled path. Historical promotion records are kept. Reaching a threshold means eligible for instructor review. | DECIDED |
| 8 | One shared evaluation path for staff, student portal, kiosk and analytics. Eligible = full bar, zero remaining, no overflowing fraction. Staff see the reconstructed threshold-reaching date, labelled as recalculated from current records. After a promotion the new rank shows 0 toward the next target. An additional same-day check-in is explained without presenting it as another progress contribution. | DECIDED |

## 2. What was removed from the earlier proposal

Nothing below is implemented or planned; it is recorded so it is not re-proposed by accident.

- Carryover, surplus carry rows, carry corrections and their review queue (decision 2).
- Head-start credits, signed `PromotionCredit`/`ADJUSTMENT` progress rows, interval attribution
  (`intervalSeq`), reconciliation objects and the `RECONCILIATION_NEEDED` state (decisions 3 and 4).
- `EXACT` / `DATE_ONLY` / `UNKNOWN` anchor kinds, the anchor CHECK constraint, historical-row trust
  rules for backfill, and the `ANCHOR_UNSET` state that blocked progress (decision 3).
- The compare-and-swap revision token and the sequence lock protocol for signed rows (nothing signed
  remains to attribute).
- Automatic promotion as an open question (decision 7).
- Any "start date needed" state for attendance ranks. Attendance progress never waits on a date.

## 3. Verified facts about the code before this change

Read from `main` at commit `e94fad0`, with the development database treated as seed-synthetic
(mechanics only, never production behavior). Figures from the earlier investigation were not refreshed
except where section 6 says so.

- Progress was `sum(delta)` of promotion-relevant attendance since `Student.beltAwardedAt` plus
  credits for that belt; stripe N needed N x the threshold (`engine.ts:111`) and a stripe award did
  not move the anchor (`award.ts:232`). That already carried over classes, the behavior decision 2
  removes.
- Adult thresholds 30/65/75/85 and kids 10/10 were seed defaults
  (`default-belt-ranks.ts:56-59`, `seed-defaults.ts:66-67`); the kids numbers had no recorded
  academy confirmation until decision 5.
- No configuration UI existed (`updateTrackConfig` had no production caller,
  `scripts/pending-callers.ts`). Configuration therefore changes through seed defaults, the platform
  creation path and operational scripts, not through screens.
- `Student.timeAnchorAt` was documented as reset by every award but no award wrote it; only the
  manual correction could (`correction.ts:71-73`). A TIME-mode student with no anchor made the engine
  throw, and `performCheckIn` did not catch it (`perform-check-in.ts:280,309`).
- `AttendanceRecord.date` is the class occurrence's own Costa Rica day for a matched check-in
  (`perform-check-in.ts:207-214`); `occurredAt` is the tap instant, or the tablet's `queuedAt` for an
  offline replay (12 hour cap, `queued-at.ts`). Staff adjustments were free signed numbers stamped
  "now" (`adjustment-actions.ts:107`).
- An automatic path existed (`src/app/api/cron/promotion-auto-award/route.ts`,
  `automation.ts`), stripes only, for tracks with approval off; nothing was deployed and the
  development database had no automatic promotions and no job runs.
- Seven display sites duplicated the target arithmetic (`portal/page.tsx`, `students/page.tsx`,
  `dashboard/page.tsx`, `contact-list.ts`, `kiosk-client.tsx`, `promociones-card.tsx`, analytics
  progression) and printed `count / (count + remaining)`, which reads `42/42` once a student passes
  the threshold. `earnedStripe` copy said "New stripe!" although a check-in never awards anything.

## 4. What PR 2 builds

### 4.1 Data model (additive migration `20260923214031_promotion_reset_accounting`)

| Table | Column | Meaning |
|---|---|---|
| `PromotionConfig` | `stripeAccounting` (`CUMULATIVE` default, `PER_INTERVAL`) | The accounting per track. `CUMULATIVE` is the old counting rule, so a deploy does not change how an existing organization's progress is COUNTED (it does change other things immediately: see section 5). New organizations are created `PER_INTERVAL`. |
| `PromotionConfig` | CHECK `requiresCoachApproval = true` | The database refuses automatic approval for every writer. |
| `Student` | `progressBaselineAt` (default now), `progressBaselineKind` (`SYSTEM_BASELINE` default, `AWARD`) | Start of the current interval, and whether it is the system's tracking start or a real award instant. Defaults fill for old writers. |
| `AttendanceRecord` | `voidedAt`, `voidedById`, `voidReason` (nullable) | An ADMIN/DIRECTOR invalidated this entry as a mistake (section 4.7). The row is never deleted; every reader ignores a voided row. |
| `BeltRank` | `progressionMode` (nullable), `stripeIntervalMonths` (int array, default empty) | Per-rank mode override (black belt = TIME) and months per degree, indexed by the current degree count. |

`Student.timeAnchorAt` now means "the instant of this student's last promotion" for time-based ranks:
written by every award, and by an explicit manual correction when an existing black belt's real
last-award date is supplied. `Student.beltAwardedAt` keeps its historical meaning and is never read by
`PER_INTERVAL`.

### 4.2 The daily rule (derived, not claimed)

A qualifying row has a positive `delta` and is either a class-less staff-added day that is not an
`UNMATCHED` tap, or belongs to a class flagged `countsTowardPromotion`. A student's contribution for a
Costa Rica ledger day is the **earliest qualifying row of that day** (by `occurredAt`, then id); every
other row of the day stays in the history and adds 0. Because the contribution is derived from the
rows rather than stored as a claim, the limit holds for concurrent requests, retries, offline replays
and every entry channel with no lock: however rows land, the same rows give the same day set.
Reassigning an unmatched tap to a counting class, or flipping a class's flag, needs no bookkeeping.
`src/lib/promotion/progress-days.ts` is the single definition.

The day is the ledger `date`: for a matched check-in the class occurrence's own Costa Rica day; for an
unmatched or portal tap the Costa Rica day of the tap; for a coach-added day the Costa Rica day being
recorded. Never the UTC date and never the replay's arrival date.

A day belongs to the interval its **first** qualifying row falls in: `baseline <= firstAt < award
instant`. So a promotion does not clear the daily limit, and a late-recorded row from before an award
keeps its own `occurredAt` and adds nothing to the next interval.

### 4.3 Award protocol

`writeAward` (the single transactional writer for awards, corrections and track changes) now:

1. refuses `source: AUTO` before touching the database (`AutomaticPromotionError`);
2. locks the student row (`SELECT ... FOR UPDATE`, organization pinned by hand because raw SQL is
   outside the tenant guard) and confirms it is still active and in the expected rank and stripes;
3. chooses the award instant while holding the lock: the application clock, but strictly after the
   previous boundary. It is **not** the commit time;
4. re-evaluates eligibility inside the transaction against the evidence as of that instant (qualifying
   days strictly before it), and refuses when the student is no longer eligible for the same target;
5. writes the promotion with that instant as `awardedAt`, sets `progressBaselineAt` and `timeAnchorAt`
   to it (kind `AWARD`) for a real promotion, and writes the audit row with the boundary instant and
   the evidence (the qualifying days and the record that made each one count).

A correction (`progress: "keep"`) never restarts progress. A track change restarts it. A later
correction to attendance never revokes an award already written; the coach explicitly corrects it.

### 4.4 One evaluation path

`evaluateStudentProgress` (`attendance-summary.ts`) is the only function that produces a student's
progress; `getAtBeltSummary`, the promotion queue, the award, the impact report and every screen use it.
The engine returns the target in the same units as the count, so no screen rebuilds it, and
`src/lib/promotion/progress-view.ts` turns a summary into the one display model (state, capped current,
target, percent, remaining, real count, due date, reached-on date) that every screen renders. An
eligible student shows a full bar, zero remaining, and no overflowing fraction; the real count is shown
separately. The threshold-reaching date (`reachedOn`) is the ledger day of the day that reached the
target, recalculated from current records on every read, never stored, and never used to decide an
award.

### 4.5 Black belt (time-based, not attendance-based)

Rank `BLACK` has `progressionMode = TIME`, `maxStripes = 6` and
`stripeIntervalMonths = [36, 36, 36, 60, 60, 60]`. The due date is the last-award instant plus the
interval for the student's **current** degree (calendar months; month ends clamp). Attendance never
influences a black-belt degree. Degrees beyond the configured list (a rank whose `maxStripes` exceeds
its list) report "not configured yet" - never eligible, never impossible, never an error. At the
highest configured degree the target is none. A black belt with no known last-award date shows rank and
attendance progress with no due date and cannot be awarded; the coach supplies the real date through
the existing manual-correction form (`timeAnchorAt`), and every later award saves the real timestamp.

None of the attendance examples in this document applies to the black belt.

### 4.6 Manual awards only

Enforced in four independent places, each tested alone: the scheduled route, the automation module and
the `vercel.json` cron entry no longer exist, and the job is no longer registered (`JOB_NAMES`, health
endpoint, heartbeat); `writeAward` refuses `AUTO`; `updateTrackConfig` refuses
`requiresCoachApproval: false`; and the database CHECK refuses it for any other writer. Historical
`AUTO` promotion rows are kept.

### 4.7 Coach-added attendance, and correcting a mistaken entry

**Adding a day.** The coach records one Costa Rica day (default today, never a future day) with a required
reason; the form has no number field and a posted `delta` is refused. The entry shares the daily limit, and
the coach is told when it was recorded but added nothing. Because interval membership follows the day's
earliest qualifying row, and a coach supplies only a DAY, no after-award time is ever invented:

- a day AFTER the promotion's day counts (stamped at the moment for today, midday for a past day);
- a day BEFORE it belongs to the completed interval and adds nothing;
- **the promotion's own day** cannot be placed before or after the award, so it is history only
  (`promotionDayHistoryOnly`): stamped just before the award instant, or, if that day already has a valid
  row, just after that row, so it can never become the day's earliest row and displace a real class. A
  class after the award counts when checked in at the kiosk or portal.

**Correcting a mistaken entry (void).** "No arbitrary credit" never meant "a mistake cannot be corrected".
An ADMIN or DIRECTOR (scoped to the entry's academy) can void ONE entry, with a required reason
(`voidAttendanceEntry`, audited as `attendance.void`). The row is never deleted and never edited beyond the
void marker (who, when, why); there is no number to enter, so it cannot become a progress balance. Every
reader ignores a voided row (progress, lifetime attendance, the attendance history, analytics, the weekly
digest). Because the daily contribution is derived from the remaining valid rows, voiding recomputes it
correctly: if another valid entry exists that day it becomes the day's contribution (which can move the day
into the current interval), and if none exists the day stops counting. **A void never revokes a promotion or
changes a rank**; a coach explicitly corrects an award. The staff student page lists recent entries with the
void control (ADMIN/DIRECTOR only). There is no "un-void": to restore a day, record it again.

Head-start credit entry (student creation form, credit correction action) is removed; the `PromotionCredit`
table and its history are kept, unread by `PER_INTERVAL`.

### 4.8 Moving an existing organization

An existing organization stays `CUMULATIVE` after deploy (its progress is still counted the old way). It
moves only through `pnpm promotion:accounting`:

1. `report --org=<slug>`: read-only. Per student it shows what they see today and what they WILL see after
   activation, computed by the same engine with the proposed configuration (not assumed): attendance ranks
   start at 0; a time-based black belt is evaluated from its known last-award date (eligible, pending with a
   due date, or "date needed"); a track already on `PER_INTERVAL` is reported exactly as it is now, not reset.
   The totals list students eligible today who will not be after, students eligible after (for example a
   black belt already past due), legacy credits (kept, ignored), arbitrary adjustments and extra same-day rows
   (kept as history, adding 0), black belts with and without a due date, and historical automatic promotions.
   It prints a `reportId`: a hash of those material outcomes (who, before, after, target, due date, the
   configuration being applied), so approval is bound to what was reported.
2. `activate --org=<slug> --report=<id> --activated-by=<email>` is a dry run; `--apply` writes. **Validation
   and application are one serializable transaction.** An advisory lock keyed by the organization serializes
   activations (a second waits, then finds the tracks already flipped and refuses); row locks on the
   organization's students, promotion configs and belt ranks make any award, correction, track change or
   configuration edit in flight finish first or wait; the report is REBUILT inside the transaction and its id
   compared with the approved one; only then are the legacy tracks flipped, every student of a flipped track
   baselined at the activation instant, the black-belt catalog completed (kept manual under a MANUAL adult
   track), and one audit row written. A concurrent change the locks do not cover (new attendance) makes the
   transaction fail as `conflict`: re-run the report. It never edits attendance, promotions, credits or belt
   dates, never invents a promotion, and never re-baselines a track that is already `PER_INTERVAL`.

## 5. Deployment: what changes immediately, what changes only at activation

The migration is additive (new columns with defaults, one CHECK), and old code inserting students, ranks or
attendance still works. Beyond that, "deploying" and "activating" are different events with different effects.

**Changes immediately on deploy, for EVERY organization (including existing ones still on `CUMULATIVE`):**

- Automatic promotion is gone: the scheduled route, the automation module, the job registration and its
  health/heartbeat entries are removed; `writeAward` refuses `AUTO`; a database CHECK refuses turning approval
  off. The migration first sets any `requiresCoachApproval = false` row to `true`.
- Head-start credit entry is removed (student creation form and the credit correction action). Existing
  credits stay in the table.
- Coach-added attendance becomes one day with a reason (no number), with the promotion-day rule above.
- A mistaken attendance entry can be voided (ADMIN/DIRECTOR); voided rows are ignored by every reader.
- Every award now locks the student, saves the exact award instant as the promotion time and the new progress
  baseline / last-promotion date, re-verifies eligibility inside the transaction and audits the evidence.
- The shared progress display and its wording ("Ready for review", capped bars, the recalculated threshold date,
  the same-day and pre-award explanations) replaces the old per-page arithmetic and copy.
- A time-based student with no last-award date no longer crashes check-in.
- The staff pages refresh after an award, correction, track change or attendance entry.
- **Not changed on deploy:** how progress is counted (still cumulative since the belt date, credits still read),
  the daily limit, the reset at every award, and the black-belt catalog of an existing organization
  (`maxStripes` stays as it is).

**New organizations (created after deploy):** start on `PER_INTERVAL` with the decided black-belt catalog.

**Changes only at activation, per organization (reviewed report, then `--apply`):** the one-attendance-per-day
rule and reset-to-0 counting for that organization's legacy tracks; a system tracking baseline for every
student of those tracks (so everyone starts at 0, and a student eligible under the old rule that day reads
0); legacy credits and arbitrary adjustments stop counting; extra same-day rows stop counting; and the
black-belt catalog is completed (degrees 1-6, time-based).

**Rolling back behavior.** Switching a track from `PER_INTERVAL` back to `CUMULATIVE` keeps every row but
changes progress and eligibility (a student at 0 of 30 reads their cumulative total again, possibly eligible,
possibly not). Reverting the deploy while a track is `PER_INTERVAL` is the same behavior change, because older
code has no such accounting - and reverting the deploy also brings back the removed workflows. It is therefore
a decision, not a switch: pause awards, run the report both ways, decide with the owner, set `CUMULATIVE`
(audited), and only then revert code. Schema compatibility is separate: additive columns are retained and
dropped only in a later, separately approved step. The database CHECK on `requiresCoachApproval` would refuse
an older writer that tried to turn approval off; none exists.

## 6. Verification

Tests added or changed are listed in the PR description with the commands and results; the mutation
results (each decision point mutated and shown to fail a test) and the browser evidence are recorded
there as well, because they describe a specific run. Observations from the development database
(seed-synthetic, taken with the read-only report before any activation): 39 students; 3 eligible
today under the old rule who would read 0; 1 legacy credit of 45 classes; 1 non-unit adjustment; 20
extra same-day rows; 1 black belt without a last-award date; 0 automatic promotions in history.

## 7. Open items and limitations

Policy items are **PENDING** until the academy answers; the rest are limitations of this change.

1. **Roster of existing black belts (PENDING).** Which degree each holds and the date of the last award.
   Until supplied, each shows rank and attendance and no due date. Nothing is estimated.
2. **Correcting a mistaken attendance entry - implemented (owner's review of PR 2).** An ADMIN/DIRECTOR can
   void one entry with a reason (section 4.7). Still open, small: whether an INSTRUCTOR should also be able to
   void an entry they made themselves (today only ADMIN/DIRECTOR), and whether an "un-void" is wanted (today a
   day is restored by recording it again).
3. **Activation on a live organization (PENDING decision before running it).** Students who are
   eligible today under the old rule read 0 after activation (3 in the development data). The owner must
   decide whether to award those promotions first or accept the reset.
4. **Late-arriving earlier class.** Because the day's contribution is the earliest row, a tablet replay
   of an earlier same-day class that arrives after a later class can move that day's contribution to
   the earlier row. If an award happened between the two, a day that already showed as progress in the
   new interval can drop out of it. Counts are always consistent with the rows; the transient
   confirmation message on the later row may have said "counted". (A replay that arrives after an award
   and belongs to before it is told so: `before_last_promotion`.)
5. **The platform "TIME" preset** for new organizations still leaves month thresholds unset (unchanged
   from before), so it is not usable; only attendance-based creation is exercised.
6. **No configuration screen** exists; thresholds and black-belt intervals change through seed defaults
   and operational scripts.
7. **Kids' 10/10 rule** is now academy-confirmed (decision 5); adult and kids numbers are seed defaults
   applied to new organizations, and an existing organization keeps whatever its rank rows hold.
