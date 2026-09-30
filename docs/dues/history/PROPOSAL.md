# Proposal v6: student dues (obligations, late fees, settlements, coverage, exchange rates)

**Proposal only. No application code, no migration, no deployment, no fixture or seed creation, no payment or attendance accounting activation.** Revised 2026-09-26 from main `4a97e27`. Supersedes `PROPOSAL-v1-superseded.md` to `PROPOSAL-v5-superseded.md`.

**What v6 changes (everything else is as in v5):** the owner's newest decisions (A6) are folded in. **Late fees are per branch** (USD 20 at Escazú and Escalante today, never in code). **One payment may settle several obligations**, oldest outstanding first, each in full including its fee. **Future months may be paid in full**, applied to explicitly named coverage periods, and the "paying ahead is refused" rule is removed. **Manage Plans is extended** so a plan can be a multi-month offer with an owner-set package price. The **coverage rule** (B5) keeps monthly plans, prepaid months and packages from duplicating or overlapping. The validation (B6), examples (Part D), decision register (Part C), questionnaire (Part E) and PR dependencies (Part F) are updated. Multi-month package policies the owner has not decided are listed as concrete examples, not assumed.

**Update (package and prepayment policies approved, A7):** the package and prepayment questions are decided, and the two proposals from the earlier clarification (consecutive future coverage; calendar-month coverage rows) are now **confirmed**. The decision register (Part C) drops D17 to D23; Part E now lists only what still needs an answer.

How to read this document: **Part A** is what the owner has confirmed. **Part B** is the *proposed* technical design that implements Part A; it contains no approved choice beyond Part A. **Part C** lists what is still pending, with **no default** assumed for any of it. Where the design needs an answer that Part A does not give, it says so and names the first PR that is blocked by it.

Student dues are separate from MATROOM subscription billing (Part B, section 12).

---

# Part A. Confirmed rules

## A1. Alliance's current rules

| Rule | Confirmed |
|---|---|
| Frequency | monthly |
| Tuition | **USD 100** (Alliance's current *setting*) |
| Due date | the **20th** |
| Grace deadline | the **5th of the following month, inclusive** |
| Late fee | from the **6th**: **one USD 20** fee per overdue monthly obligation (current *setting*). *(v5: there are no partial payments, so an obligation is either settled in full or overdue in full.)* |
| Never repeated | the same obligation is never charged again. Two overdue months = **USD 40** in fees, plus the unpaid tuition |
| First month | **full price, no proration** |
| Confirmed example | joins **September 25**, pays **USD 100 at signup**. Next USD 100 is due **October 20**, payable without penalty through **November 5**. From **November 6** that obligation incurs its USD 20 fee if the obligation is unpaid (v5: there are no partial payments) |
| Payment currencies | **USD or CRC** |
| USD paid in CRC | converted at **BCR's USD sell rate on the payment date**; the applied rate is **preserved permanently** with the payment |
| Removing a wrongly assessed fee | **only a payment received on time that settles the tuition in full** can remove it. *(v5: partial receipts do not exist; an insufficient or unconverted receipt cannot.)* |

## A2. Everything above is a setting, never a constant

Each academy configures its own tuition, late fee, due date, grace rule and accepted currencies. USD 100 and USD 20 are Alliance's *current settings*. **The next-month grace deadline is supported as a rule of its own** ("day 5 of the following month, inclusive"); it is not replaced by a fixed number of days (a "days after due" rule may exist beside it for other academies).

Changes to settings:
- The owner can change tuition and choose its **effective month**, with a **preview of affected students**.
- Changes are **prospective**. Existing obligations, fees, payments, balances and applied exchange rates keep their historical values.
- **A correction to an existing obligation is a separate, audited action**, never an automatic consequence of editing a setting.

## A3. Constraints from the owner's corrections

1. A CRC receipt without a verified rate preserves its tender amount and received date but **does not prove full settlement**.
2. Recovery from a missed job uses **historical** student status, assignments and policy versions; jobs are idempotent, never duplicate obligations, and never charge inactive or archived periods by accident.
3. **Activation comes last:** all consumer and payment-write integration is complete before any organization can be activated; no organization creates ledger obligations while its screens still use the old overdue rules.
4. **Archiving preserves** existing obligations, fees and payments. What happens to future charges or fee assessment after archiving stays pending.
5. Five states are kept distinct (section B4). Missing information never invents debt or implies settlement.
6. **BCR's USD sell rate on the payment date is confirmed as the rule.** Automatic sourcing, a manual fallback, weekend/holiday handling and rounding are **not approved**. BCCR's reference rate is **never** substituted, and a quote is never guessed.

## A4. Confirmed 2026-09-26 (signup, recurring payments, branch pricing)

**Signup and recurring tuition**

| Joins | At signup | Recurring monthly payments |
|---|---|---|
| **Sep 12** | pays **USD 100** | **another USD 100 on Sep 20**, grace through **Oct 5**; then Oct 20 |
| **Sep 20** | pays **USD 100** | next due **Oct 20** |
| **Sep 25** | pays **USD 100** | next due **Oct 20** |

- **General rule:** joining **before the 20th**, the next recurring payment falls on **that month's 20th**. Joining **on or after the 20th**, it falls on **the next month's 20th**.
- Signup is **full price, no proration**.
- **Signup and recurring monthly tuition are distinct obligations** and may both occur in the same month (Sep 12: a signup charge and September's recurring charge). Each creation path must be idempotent with uniqueness appropriate to its own type.
- **The recurring late-fee rule is not applied to an unpaid signup charge** unless the owner explicitly decides so. No such decision exists.

**Branch pricing**
- Existing Alliance branches are **Escazú** and **Escalante**. Both currently charge **USD 100 monthly for everyone**.
- **Each branch has independently configurable prices and future price changes.** USD 100 is never hardcoded (not in code, migrations or seeds); the owner enters it as a setting.
- Historical charges and payments keep their amounts when prices change.
- **Heredia was hypothetical.** No Heredia branch, seed record or configuration is created or proposed. (The word appears only as free-text city values in existing test fixtures.)
- **Deadlines, grace rules and the late-fee amount may all differ by branch, independently (confirmed; A6).**

The previously confirmed rules in A1 to A3 stand unchanged.

## A5. Confirmed 2026-09-26 (settlement, permissions, rates, leavers, follow-up)

1. **Owners only** may change prices, waive fees and reverse payments. ("Owner" is the organization's `ADMIN` role; a location Director is not an owner.)
2. **Branch deadlines may differ** (due day and grace deadline). Escazú and Escalante currently use the same due date and grace deadline.
3. **BCR USD sell rates are entered manually by an owner, for the payment date.**
4. **Payments settle the oldest unpaid monthly obligation first.**
5. **Each monthly obligation must be settled in full, including its applicable late fee.** **No partial payments and no overpayment credit.** Alliance currently charges **USD 100 tuition, or USD 120 including its late fee**, both **calculated from editable settings**, never hardcoded.
6. **Paused or left:** marking a student paused or left **stops future monthly charges from the following month.** Existing debt stays visible and payable.
7. A **"Students needing follow-up"** section on the dashboard and in analytics shows last attendance, time absent, paused/left status and contact actions. **Nonattendance never infers departure and never stops billing.**
8. **Owners identify existing unpaid periods and amounts, then manually record full settlement** with currency, received date, method and any applied exchange rate. **Debt is never inferred from missing records.**

**Superseded by item 5:** the partial-payment requirement of v3/v4 (allocations, explicit-allocation workaround, "partly paid still gets the fee", the partial-payment worked example) and the pending allocation-order and overpayment decisions. Also settled by items 1 to 3 and 6: parts of the old D1 (manual entry by an owner), D4 (allocation order, overpayments), D5 (owners for prices, waivers, reversals), D6 (branch deadlines) and D9 (paused and left).

**Still not settled (see Part C):** whether the signup price always follows tuition; which date determines joining, unpaid-signup treatment and returning-student treatment; CRC rounding; missing-date or weekend quote handling; correction procedures; the smaller points listed in Part C; and the **multi-month package policies** in A6.

## A6. Confirmed 2026-09-26 (branch fees, multi-obligation and future payments, plans)

1. **Late fees are independently configurable per branch.** Escazú and Escalante currently charge **USD 20**. Owners may change the amount **prospectively**. USD 20 is never hardcoded and existing fee terms are never rewritten.
2. **One payment may settle several monthly obligations** (for example two overdue months totalling USD 240 by one USD 240 payment), **oldest outstanding first**. Each selected obligation is settled **completely, including its applicable fee**. **No partial settlements and no unallocated overpayment credit.**
3. **Future months may be paid in full.** The earlier "paying ahead is refused" rule is **removed**. Payment is applied to **explicitly identified future coverage periods**, never to an unspecified credit balance. The **agreed price and coverage of prepaid periods are preserved** when prices later change.
4. **Manage Plans supports multi-month offers** (for example three months for an owner-configured package price). The existing Manage Plans capability is **reused and extended**. Not every plan costs USD 100 or covers one month. Pricing stays **branch-specific and versioned**, with historical terms preserved.

**Confirmed versus proposed (updated).** *Oldest outstanding obligations first*, *consecutive future coverage* and *calendar-month package coverage* are all **confirmed** (A7). Nothing in this section remains a proposal.

**Package and prepayment policies:** decided in A7. Nothing about them is pending except the small items noted in Part C (D24, and the reading of "owner selects" flagged in A7).

## A7. Confirmed 2026-09-26 (package and prepayment policies)

1. **Packages are paid fully upfront; no instalments.**
2. **The first uncovered calendar month starts the package**, which covers its **configured number of consecutive calendar months**.
3. **Never overlap or replace existing paid coverage silently.** Older outstanding obligations are settled first.
4. **No unpaid package is ever created.** A package purchase becomes effective **atomically** with its payment and its coverage reservation. Ordinary monthly debt keeps its own late-fee rules.
5. **Pausing or leaving does not extend prepaid coverage.** A refund is an **owner-approved exception** and must preserve payment and coverage history. **An approved refund does not automatically release all package coverage, and months already consumed must never become billable again.** The refund amount, the affected months and any coverage release are **pending (D4)**; no refund is implemented until they are decided.
6. **Renewal requires an explicit purchase;** there is no automatic renewal.
7. **Ordinary prepaid months use the price version effective for each covered month; a package uses the quoted package price.** Agreed amounts and coverage are **frozen on payment**.
8. **Prepayment limits are configurable per branch.** No initial Alliance limit is stated or assumed.
9. **Future coverage must be consecutive after existing obligations are accounted for.**

*Reading to confirm:* "the owner selects the first uncovered calendar month" is read as **the start is always the first uncovered month** (choosing a later one would create a gap, contradicting item 9) and the owner confirms it at purchase. Who may record a package purchase stays under D5.

---

# Part B. Proposed technical design

## B1. What the code does today (verified, main `4a97e27`)

1. One `PaymentPeriod` per student per month with one `status` (`PAID / PENDING / PROMO / EXEMPT`), one `amount` and a `currency` snapshot. **No due date, grace, fee, partial payment, exchange rate or schedule.**
2. Overdue is derived: `isOverdue(period, today, cutoffDay = 5)` is false while day <= 5, otherwise `!period || status === "PENDING"`. **A missing row is treated as debt**; one constant for every academy; only the current month is looked at.
3. "Today" uses a hardcoded Costa Rica zone rather than `Organization.timezone`.
4. `Currency` is `CRC | USD`; `Organization.currency` is one per organization. `PaymentPlan` (per location) has `defaultAmount` with **no currency of its own and no price history**; it is described as a suggestion that never touches recorded payments.
5. There is **no student status history**: only `Student.status` (`PENDING / ACTIVE / INACTIVE / ARCHIVED`) and `statusBeforeArchive`. There is no `archivedAt`. Past status is not recoverable from the schema.
6. A recurring promo is carried forward by **inserting a PENDING row when a page is read**.
7. `AuditLog` and a scheduled-job runner with heartbeats already exist. Project rule (from B5 restore): **behaviour must never depend on reading audit rows**; state a later action needs is stored on a row.
8. Consumers of the overdue rule that must move together: roster, portal, payments page, dashboard panel, weekly digest, contact list, and the record/mark-paid actions.
9. A **branch is an `Academy`** (Escazú and Escalante are seeded as `seed-academy-escazu` and `seed-academy-escalante`). A student's branch is `Student.homeAcademyId`. `PaymentPlan` already belongs to one branch (`academyId`, unique per branch and name); the seed creates plans for both branches **with no amount**, so no price is hardcoded today. `Academy` also has its own `timezone` (default Costa Rica) beside `Organization.timezone`; which one governs dues dates is a technical choice (Part E, T5).
10. There is **no concept of a signup charge** anywhere: the first payment is an ordinary monthly `PaymentPeriod`.
11. **Manage plans** (`/payments/plans`, linked as "Manage plans" from the payments page) already lets a branch create, edit, deactivate and reactivate plans: `name`, `description`, `defaultAmount` (mutable, no currency, no duration, described as a suggestion), unique per branch including deactivated ones, never deleted, referenced by past payments. The create and update actions allow **`ADMIN` and `DIRECTOR`**. The seed creates `Mensualidad`, `Promoción` and `Becado` for each branch with no amount.
12. **Recording window:** `recordPayment` refuses a period **more than one month in the future** (`isPeriodMoreThanOneMonthInFuture`, error `periodTooFarInFuture`, "The period cannot be more than one month in the future."), and `PaymentPeriod` is unique per student, year and month, so today's model cannot hold a payment for months further ahead, or one payment covering several months.

## B2. Principles

1. Money facts are **append-only**: obligations, fees, payments, settlements, exchange-rate quotes, adjustments. Mistakes are corrected by reversal rows with reason and actor.
2. **Snapshot at creation**: an obligation stores its dates, amount, currency and fee terms as they were.
3. Debt exists only as an **obligation row** created by rule or deliberately by staff. **Absence of a row is never debt.**
4. Status is **derived** from rows and dates in the organization's timezone by **one pure calculation library** shared by every consumer.
5. Nothing turns on by itself (B10).

## B3. Settings, pricing and tuition changes

**Versioned academy policy** (`DuesPolicyVersion`, append-only, each with an `effectiveFrom` month): `dueDay` (clamped to the month's last day), grace rule (`NEXT_MONTH_DAY {day, inclusive}` or `DAYS_AFTER_DUE {n}`), late fee (amount, currency, once per obligation), accepted currencies, rate-source and rounding settings (pending, C-list), and the pending policy switches in Part C. **Scope.** Prices, **due day, grace rule and late-fee amount are all per branch and independently configurable (confirmed)**. Escazú and Escalante currently hold the same values (USD 20 fee), entered as settings and never in code. The policy version is per branch, and a fee change is **prospective**: obligations already created keep the fee terms they were created with. **Only owners may change prices and policy values that affect money (A5).**

**Where the tuition amount comes from (branch pricing confirmed).**
- Tuition comes from the student's **assigned plan**, and a plan already belongs to one branch. **This reuses and extends the existing Manage Plans page (`/payments/plans`) and its create, update, deactivate and reactivate actions** rather than adding a second place to set prices. A plan gets **versioned terms** (append-only: `effectiveFrom` month, the **price for the whole offer**, currency, and **months covered**), so a plan may be the ordinary monthly plan (1 month) or a **multi-month offer**, such as three months for an owner-configured package price. Nothing assumes USD 100 or one month. **Escazú and Escalante each have their own terms history**, and a change in one never touches the other. Today's mutable `defaultAmount` is left in place for the legacy payment form until activation and is not used for dues; existing plan rows are not rewritten. **The owner enters each branch's terms in Manage Plans at rollout; no migration, seed or code carries an amount.** No branch other than the two that exist is created. Today the create and update actions allow Directors as well as Owners: **price and coverage terms become owners only (A5)**, and who may edit a plan's name, description and active flag stays as it is today until decided (D5).
- The **signup charge** has its **own versioned setting per branch** (amount, currency, `effectiveFrom`). Today it equals tuition (USD 100); whether it must always equal tuition is **pending (D14)**.
- An **individual amount** for one student is an **audited exception** (amount, currency, effective range, reason), never the normal path. Resolution for month M: individual exception covering M, else the plan's price effective for M. Both branches charge USD 100 for everyone today, so exceptions are needed only if the owner wants them (D8, remainder).
- A student's price follows their **home branch's plan**; moving a student to another branch is a new assignment effective from a chosen month (the old branch's obligations keep their amounts).

**Changing tuition (or the fee) for a future month:**
1. The owner enters the new amount and the **effective month** (no past months).
2. **Preview, no writes**: students whose price will change; students on an individual exception (unchanged); students with no plan (not affected); **obligations that already exist for that month or later** (listed, unchanged, with count and totals per currency).
3. On confirmation a **new price version** is inserted. Obligations created afterwards for months on or after the effective month use it; every existing obligation, fee, payment, balance and rate is untouched.
4. Bringing an existing obligation to the new price is a **separate audited adjustment**, reviewed per student. No setting edit ever does it.

## B4. Distinct states (never conflated)

| # | State | Detected when | Staff see | Student sees | Must **not** imply |
|---|---|---|---|---|---|
| 1 | **Academy does not track dues** | organization setting off | no dues UI | no payment card | any debt or settlement |
| 2 | **Student has no assigned schedule/amount** | tracking on, no assignment covering the month, or no price resolvable | "Payment schedule not assigned" to-do list | wording pending (D12) | debt, fee, or that they are paid |
| 3 | **Expected obligation is missing** | tracking on and activated, student was eligible on the month's generation date (from **trusted** stored status history, B8), assignment and price exist, but no `MONTHLY` row exists; or an enrollment after activation has no `SIGNUP` row | integrity warning with a "create it / explain it" action | nothing that implies debt or settlement | debt |
| 4 | **Payment receipt awaits conversion** | a CRC receipt exists whose USD value cannot yet be computed (no verified rate) | tender amount, received date, "awaiting conversion" | "payment received, being confirmed" (wording pending, D12) | that the obligation is settled, or that it is plainly unpaid |
| 4b | **Receipt cannot be applied** | after conversion the USD value does not equal an acceptable full amount (short or excess). It cannot settle anything and is **not** a partial payment or a credit | the receipt in an owner **exception queue** with the reason | wording pending (D12) | settlement, a partial payment, or credit |
| 5 | **Confirmed unpaid or overdue** | an obligation row exists, is **not settled in full**, and its grace deadline has passed (before it: upcoming or in grace) | balance, fee, dates | their obligations and balances | anything about missing information |

Other derived states of an obligation: `UPCOMING` (through the due date), `IN_GRACE` (after the due date through the grace deadline, inclusive, no fee), `SETTLED`, `COVERED` (a future coverage month, or the months of a package, already settled in advance), and terminal `WAIVED` or `CANCELLED` rows created by audited actions. There is **no** partly-paid state.

## B5. Obligation types, identities, signup and no double charging

*(v4 correction: v3 assumed one obligation per student per month. Signup and recurring tuition are distinct and may share a month.)*

| Type | What it is | Created by | Identity (database uniqueness) | Late fee |
|---|---|---|---|---|
| **`SIGNUP`** | one-time joining charge, full price, no proration | the enrollment path only | one per student **enrollment** (unique on student + enrollment key). Today an enrollment is the student's first approval; whether a returning student is a new enrollment is pending (D9) | **none.** Not applied without an explicit policy decision, and none exists |
| **`MONTHLY`** | recurring tuition for a coverage month | the monthly job; the enrollment path (first cycle, below); a **prepayment** of a future month; staff (deliberate, audited) | one per student per coverage month within type `MONTHLY`, **prepaid months included** (unique on student + type + coverage month). This is the **confirmed** monthly identity and **does not depend on any package decision** | yes (A1) |
| **`PACKAGE`** | a multi-month offer bought under a plan whose terms cover more than one month: **one obligation for the whole package price**, covering that plan's configured number of **consecutive calendar months** | staff, deliberately: a purchase, effective **atomically** with its payment and coverage reservation; **never by the monthly job**, and **never created unpaid** | its months are reserved by the coverage rows below | **none**: it is never late, because it does not exist until paid in full |
| **`OPENING`** | an **existing unpaid period the owner identifies** at switch-over: amount and currency typed by the owner, never inferred; optionally linked to the legacy `PaymentPeriod` it came from | owners, in the staged opening-items screen (B10) | one per student per coverage month within type `OPENING` | only if the owner marks it so at entry (D7) |

- **Ordinary monthly billing (confirmed rules; unaffected by any package decision).** A `MONTHLY` obligation is unique per student per coverage month, whether it was created by the monthly job, the enrollment path or a **prepayment**. That single key is what stops the job and a prepayment from charging the same month twice: the job's insert does nothing when the month already has an obligation, so a prepaid month makes the job skip it. `SIGNUP` covers no month and has its own key, so it may share a month with a `MONTHLY` (Sep 12: a `SIGNUP` and September's `MONTHLY`). Every creation path is an insert that does nothing on conflict, so every path can be re-run safely.
- **Coverage and overlap (confirmed).** `MONTHLY`, `PACKAGE` and `OPENING` obligations reserve the calendar months they cover as rows `(obligation, student, coverage month, released on)`, with a partial unique index: **at most one unreleased row per student and month**. A package covers its configured number of consecutive calendar months from the **first uncovered month**. Its purchase, its payment and its coverage reservation happen in **one transaction**: if any month is already covered the whole purchase fails and nothing is stored, so **existing paid coverage is never overlapped or silently replaced**. Older outstanding obligations are settled first (B6). Coverage rows are never deleted, so payment and coverage history is preserved. **Whether and which rows a refund releases is pending (D4):** a refund does not automatically release all of a package's coverage, and a consumed month must never become billable again. Ordinary monthly billing keeps its own confirmed identity (unique per student and coverage month within `MONTHLY`) and its rules are unchanged; the coverage rows are an added guard, not a change to them.
- Every obligation records its **origin** (`ENROLLMENT`, `SCHEDULED_JOB`, `STAFF`), its type, and its snapshots (amount, currency, dates, and for `MONTHLY` the fee terms).

**Coverage dates, payment deadlines and late-fee assessment are three different things.**

| | Coverage dates | Payment deadline | Late-fee assessment |
|---|---|---|---|
| **What it is** | the calendar months the payment buys | the due date and grace deadline by which payment is expected | the fee row the fee job creates the day after the grace deadline if the obligation is still unsettled |
| **Ordinary `MONTHLY`** | its own month | due on the branch's due day of that month, grace through the branch's grace day of the next month | once per obligation (confirmed) |
| **Prepaid month** | a future month named on the receipt | the same dates as any month of that kind, but it is **already settled**, so it never becomes overdue | **never**, because it was settled before the deadline |
| **`PACKAGE`** | its configured number of consecutive calendar months, from the first uncovered month | none: the payment **is** the purchase (no deadline, never unpaid) | none (never late) |

A prepaid or package obligation **keeps its agreed price and coverage, frozen on payment**. An **ordinary prepaid month uses the price version effective for that month**; a **package uses its quoted package price**. A later price change never alters either.

**Enrollment path** (one transaction, on approval and assignment, at enrollment date **E**; what counts as E is pending, D13). The thresholds use the policy's **due-day setting**, not a literal 20:
1. **Always** create the `SIGNUP` obligation at the signup price effective at E (full price). The signup receipt settles it in full.
2. If E is **before the due day**: also create the `MONTHLY` obligation for **E's month**, due on that month's due day, grace through the next month's grace day (dates from the policy version effective for that month, snapshotted).
3. If E is **on or after the due day**: create **no** `MONTHLY` now. The next one is the following month's, created by the job on the 1st of that month.

**The monthly job** creates only `MONTHLY` obligations, under the recovery rules in B8, and never `SIGNUP`. A student who joined Sep 12 already has September's `MONTHLY` from the enrollment path; on Oct 1 the job creates October's. If the job and the enrollment path ever both try September, the second insert conflicts on the `MONTHLY` key and does nothing.

**Unpaid signup charge.** The `SIGNUP` obligation exists and is visibly open; **when it counts as late and what follows is pending (D3)**. No late fee is assessed on it. The design does not leave it silently open: it needs a recorded payment or an explicit, audited due date.

**Existing students at rollout** receive **no** `SIGNUP` obligation and no back-billing: they enrolled before the ledger existed. Only approvals made after activation use the enrollment path.

## B6. Late fees and full-settlement payments (one payment, one or several whole obligations)

*(v6: one payment may settle several obligations and identified future periods. Still no partial settlements and no credit.)*

**Amount due for one obligation** is calculated from that obligation's snapshotted settings, never hardcoded: **tuition plus, if the fee applies, the fee**. For Alliance today that is **USD 100, or USD 120** with the fee (USD 20 is Escazú's and Escalante's current fee setting). The fee applies when the payment's **received date is after the obligation's grace deadline**; a payment received on or before it owes tuition only. A **prepaid** period is settled before its deadline and owes tuition only.

**Fee (`DuesLateFee`).** Only `MONTHLY` obligations (an `OPENING` one only if the owner marked it, D7; never a `PACKAGE`, which is never created unpaid). A separate row, **unique per obligation** (`(obligationId, kind = LATE)`), so reruns and races cannot add a second one. Assessed from the day after the grace deadline if the obligation is **not settled**: only **full settlements received on or before the deadline** count. **Amount and currency come from that obligation's own snapshot of its branch's fee terms**, so a later fee change never touches it. The fee is **never paid on its own**; it is settled together with its tuition. **Waiving is owners only** (audited). A fee assessed while an on-time receipt was unresolved is **voided** (never deleted) when a full on-time settlement is later established.

**Payment (`DuesPayment`, immutable).** Student, **received date** (calendar date in the branch's timezone; backdating limit pending, D4), tender currency and amount, method, actor, **the coverage periods it was intended for**, and, for a USD obligation paid in CRC, the applied rate, its quote reference and date, copied on **permanently**.

**Settlement (`DuesSettlement`, append-only).** A payment settles **one or more whole obligations**, including obligations for identified future periods created in the same transaction. Each obligation has **at most one active settlement**, recording its tuition part, fee part, currency and received date. Nothing is ever split.

**One validation function, used by every entry path:**
1. Build the student's **ordered list**: (a) every **unsettled obligation, oldest first** by coverage start (`MONTHLY`, `OPENING`), each at its amount due for the received date, with its fee where applicable (**confirmed**); then (b) **future coverage periods**, starting at the **first month not covered by anything** and **consecutive after existing obligations are accounted for** (**confirmed**). An **ordinary prepaid month is priced at the price version effective for that month**; a **package at its quoted package price**; amounts are frozen on payment. The number of future months is capped by the branch's **prepayment limit**, a per-branch setting with no value assumed. A future period is a prepaid `MONTHLY`, or a `PACKAGE` when the plan's terms cover several months.
2. The receipt must equal the **sum of a prefix of that list**, and the prefix is **chosen explicitly** on screen as a list of named coverage periods. An older unsettled obligation cannot be skipped in favour of a later one, and future periods can only follow all outstanding ones (**oldest outstanding first is confirmed**).
3. Any other amount is **refused at entry**, with a message showing the selectable totals (for example USD 120, 240, 340, 440). Too little would be a partial payment, and an amount between or beyond totals would be an unallocated credit; neither exists. Nothing is stored.
4. **Prepayment:** the future obligation for each named period is created and settled **in the same transaction**, at its frozen price, with its coverage reserved in the same transaction (a `MONTHLY` per prepaid month, or one `PACKAGE`): **effective atomically with the payment, or not at all**, and a package is never created unpaid. The receipt records the periods, so no balance is ever held for "later".
5. **Concurrency:** the unique active settlement and the unique `MONTHLY` key and the coverage rows make a second attempt on the same obligation or month fail. Two staff cannot settle or prepay the same thing twice.
6. **CRC paid for a USD obligation:** the required CRC amount is the selected total times the owner-entered rate for the received date, rounded by a rule that is **pending (D1)**; the tender must equal it, subject to any pending tolerance. **Until the rounding rule is decided the CRC-for-USD entry path cannot be enabled.**

**Rate-pending receipts and full-settlement-only validation.** A CRC receipt for USD obligations with **no owner-entered rate for its received date** cannot be validated, because its USD value is *unknown*, and **unknown never becomes a partial payment, a credit, or a settlement.**
- The money was received, so the receipt is **recorded** as `AWAITING_RATE` with tender, received date, method and the **periods staff intended it for**. It settles nothing and reduces nothing; any future periods it names are **not yet created**, so nothing is covered. The obligations stay open and show state 4.
- **When an owner enters the rate for that date**, the conversion is computed and validated by exactly the same function, at the receipt's received date, against **the periods it was recorded for**:
  - it equals that selection's total: everything is **settled** (and prepaid periods created), and any fee that did not apply on that received date is voided;
  - it does not (short or excess): the receipt becomes an **`EXCEPTION`** in an owner queue with the reason. The obligations **stay open**, fees stay applicable, and it is **not** a partial payment and **not** a credit. Only an owner can resolve it; the procedure is **pending (D4)**.
- **Fee while waiting:** on the day after the grace deadline an unsettled obligation gets its fee by the normal rule, flagged "linked to an unresolved receipt", and it is removed only if the receipt later converts to a full on-time settlement of that obligation. A receipt received after the deadline must convert to the full amount **including the fee**, or it becomes an `EXCEPTION`.
- Whether that removal is automatic once the rate is entered, or owner-confirmed, is **pending (D2)**.

**Recording-window restrictions that conflict with prepayment (current code).** (1) `recordPayment` refuses any period more than one month ahead (`periodTooFarInFuture`, `payment-actions.ts`); (2) `PaymentPeriod` allows one row per student per month and one period per payment; (3) the roster, portal and payments page look only at the **current month**, so a month paid ahead would be invisible. The ledger path **does not reuse** rule (1); the legacy path is unchanged until an organization is activated; consumers must show `COVERED` (B4). The ledger's **maximum months ahead is a per-branch setting** (A7); no value is assumed, and what a branch without one may do is D24.

**Corrections.** Payment reversal, fee waiver and price change are **owners only**. A reversal is an append-only row that reopens its obligations; a **refund of prepaid coverage is an owner-approved exception** that preserves payment and coverage history (A7). It does **not** automatically release all package coverage, and **consumed months never become billable again**; the refund amount, the affected months and any coverage release are **pending (D4)** and no refund is implemented before they are decided. Correction procedures beyond that (a mistyped rate, exception receipts, corrections after settlement, and whether a fee applies when a reversal reopens an obligation whose deadline has passed) are **pending (D1, D4)**.

**Signup.** The `SIGNUP` obligation is settled by the signup receipt, in full, by the same validation.

## B7. Exchange rates (BCR USD sell rate)

**Verified source capabilities (checked 2026-09-26):**

| Source | What is verified | What is not |
|---|---|---|
| **BCR website** | A live USD buy/sell widget. Its data call is an internal portal proxy that answers automated requests with a **bot-protection captcha** (Radware). It is a widget, not a documented API, with no published terms for automated use | any API, agreement, history, holiday behaviour, or publication time |
| **BCCR "tipos de cambio en ventanilla"** (`sdd.bccr.fi.cr`, table 1015, linked from BCCR's home page) | It exists and is the official place where per-bank window rates are republished | **its contents**: the page is a JavaScript application that returns no data without one, so I could not read a BCR row, a date, an update time, or a way to query history. A search-engine summary quoting numbers for BCR is **unverified and is not evidence** |
| **BCCR web service** (indicators, subscription and token) | documented by third parties: codes 317/318 are the **BCCR reference** buy/sell | that a per-bank indicator exists; the old service address returned 503 and its documentation address 404 |

**Consequences:**
- **BCCR's reference rate is never used in place of BCR's**, by any code path.
- Whether a BCR rate as republished by BCCR counts as "BCR's rate" is an **owner decision (D1)**.
- **A quote is never guessed, averaged, estimated or carried over silently.**

**Confirmed:** BCR USD sell rates are **entered manually by an owner, for the payment date.** Automatic sourcing is not approved and none is built; the table above is kept for a possible later importer, which would need written confirmation from BCR or BCCR first.

**Design.** `ExchangeRateQuote` (append-only): provider (BCR), pair, side (sell), `quoteDate` (the payment date it is for), `value` exactly as typed, **entered by an owner** (nobody else can), entered at, source note; unique per provider, side and date. A conversion needs a stored quote for the receipt's received date; **if none exists the system does not convert**, and the receipt is `AWAITING_RATE` (B6). Payments copy the quote onto themselves, so a later correction never changes payments already made. BCCR's reference rate is never used in its place.

**Pending, no assumed answer (D1):** rounding of USD to colones and any tolerance; what to do when no quote exists for the exact date (weekend or holiday: use the latest earlier owner-entered rate, or wait); and how a mistaken quote is corrected (who, and what happens to receipts already converted with it).

## B8. Recovery from missed jobs, and archived or inactive students

**History the design requires.** Because past status is not in the schema (B1.5), eligibility must be **stored, not reconstructed**: an append-only `StudentStatusChange` (student, status, `effectiveOn`, actor) written **in the same transaction as every status-changing action** (approve, deactivate, archive, restore, reactivate). It is **not** derived from audit rows. History is never invented: a period the records do not reliably support produces **no obligation**. How existing students enter this history, without inventing the past and without leaving unchanged students ineligible, is the baseline below.

**Baseline for existing students (v4).** Two additions to the history table and the organization: each row has a `source` (`EVENT` or `BASELINE`), and the organization has a **`statusHistoryTrustedFrom`** date, empty until a baseline is taken.
1. `EVENT` rows are written by the status-changing actions from the day the history table ships (PR 2).
2. A **baseline** is an **explicit, owner-reviewed action** during rollout preparation, never a migration. For **every existing student** it records one `BASELINE` row asserting their **current** status, effective on the **baseline date B** (the organization-local date it is confirmed), and sets `statusHistoryTrustedFrom = B`. It asserts only "this is the status now"; it says nothing about any earlier date.
3. **Eligibility as of a date G is the latest row with `effectiveOn` on or before G, and only for G on or after `statusHistoryTrustedFrom`.** A student who never changes status keeps their baseline row and **stays eligible for every later G**: no periodic event is required, so unchanged existing students are **not** permanently ineligible.
4. For G **before** `statusHistoryTrustedFrom` eligibility is unknown, so nothing is generated. Any `EVENT` rows written before B are kept as history but are **not trusted** for generation.
5. Recovery uses **only** periods supported by reliable records: a month M is generated for a student only if G(M) is on or after `statusHistoryTrustedFrom`, on or after the start month (below), the student's status at G is eligible, **and** an assignment effective for M exists. Existing students' assignments are entered by the owner at rollout with `effectiveFrom` no earlier than the start month.
6. After the baseline, actions keep writing rows in the same transaction. A **consistency check** compares each student's `Student.status` with their latest row and reports any mismatch; it never auto-corrects. It is a readiness check and an ongoing integrity warning.
7. A student who is `PENDING` at baseline is recorded as such and is not eligible; on approval they get an `EVENT` row and use the enrollment path (B5).

**Generation.** For coverage month M the *generation date* G is the first day of M in the organization's timezone. The job creates an obligation only for students who, **as of G**, were eligible per the stored history (eligible: `ACTIVE`; a paused or left student stops being charged from the following month, A5), had an assignment covering M, and have a price resolvable for M from the **policy and price versions effective for M**, not the current ones. Insert is `ON CONFLICT DO NOTHING` on the unique key, and **a month that already has an obligation (a prepaid month included) is skipped** (B5); package overlap is prevented by the coverage rows (B5).

**Idempotence and recovery.**
- A job run for M on any later date D produces the same result as on G (it always evaluates *as of G*). Several missed months are processed one by one, each with its own G, policy version and price.
- A run record is informational; **correctness comes from the unique keys**, so two overlapping runs cannot duplicate anything.
- Students who became eligible after G within M are handled by the enrollment path or a staff-created obligation, never by a catch-up run.
- **Fees:** the fee job evaluates each obligation past its deadline against `receivedOn` dates and converted, full settlements; the unique key prevents repeats. A late run records `assessableFrom` (original) and `assessedAt` (actual).
- No obligation is created for a month before the organization's **start month** (B10), before `statusHistoryTrustedFrom`, or before the student's assignment takes effect.

**Paused or left students (confirmed).** Marking a student paused or left **stops future monthly charges from the following month**: a month's obligation is created only if the student is eligible at that month's generation date (the 1st), so a student marked on Oct 25 keeps October's obligation and gets none for November. **Existing debt stays visible and payable**; pausing or leaving never cancels, waives, hides or edits obligations, fees or payments, and the profile shows "with balance". Mapping (to be confirmed, D9): **paused = `INACTIVE`, left = `ARCHIVED`**. **Prepaid coverage is not extended** by a pause or departure, and any refund is an owner-approved exception that preserves payment and coverage history (A7). **Not decided (D9):** whether the late fee is still assessed on debt that existed when the student left, and what a returning student owes and whether it is a new enrollment (a new signup charge). **Attendance never changes billing:** nonattendance neither marks a student paused or left nor stops obligations (B13).

## B9. Audited adjustments

`DuesObligationAdjustment` (append-only): obligation, field (`AMOUNT`, `DUE_ON`, `GRACE_ENDS_ON`), before, after, **required reason**, actor, time, plus an `AuditLog` entry (audit rows are written, never read back by code). Also `WAIVE`, `CANCEL`, fee `VOID` and payment `REVERSAL`, each with reason and actor. **Price changes, fee waivers and payment reversals are owners only (confirmed).** Who may perform the other actions (rescheduling, cancelling an obligation, price exceptions, recording ordinary payments, assigning students) is **pending (D5)**. If a reschedule makes an assessed fee no longer due, the fee is voided in the same audited action.

## B10. Activation order and rollout

**Nothing is activated until everything it touches is integrated.** Order:
1. Additive schema, calculation library, settings and ledger code ship **dark**.
2. **Payment-write integration:** for an activated organization the payments page, the student profile and the old record/mark-paid actions use the ledger; the old actions **refuse server-side** for activated organizations.
3. **Consumer integration:** portal, roster, payments page, dashboard panel, contact list, weekly digest and analytics read the ledger for activated organizations. A test enumerates every use of the old overdue rule.
4. **Only then** does the activation control exist. It is refused unless a readiness check passes (policy approved by the owner, prices and assignments reviewed, opening balances confirmed, rate approach decided, every consumer integrated).
5. Until an organization is activated, the obligation, enrollment-obligation and fee code paths create nothing, so **no organization creates ledger obligations while its screens still use the old rules**.
6. **No historical balance is guessed, and debt is never inferred from missing records.** Legacy `PaymentPeriod` rows are never deleted, edited or reinterpreted; they stay as history. **Owners identify existing unpaid periods and amounts** in a staged, reviewed screen; each becomes an `OPENING` obligation (student, coverage month, amount and currency typed by the owner, an optional link to the legacy row, and whether the late fee applies to it, D7). The owner then **manually records full settlement** of each (currency, received date, method and, where a USD amount was paid in CRC, the applied rate). Anyone not listed shows internally as "opening balance not confirmed", with no debt or fee visible to anyone.
   **Legacy partial payments.** The old model has no partial payment: a `PAID` row with a smaller amount may be a discount or a partial, and the system never decides which. If the owner says a past month was partly paid, the owner enters the **remaining** amount as an `OPENING` obligation (which is then settled in full like any other) or declares the month settled or waived through an audited action. The original rows stay untouched, referenced only by a link and a note.
7. A **dry-run preview** (no writes) shows what activation would create: obligations and totals per currency **and per branch**, unassigned students, students without a price, students with unknown eligibility.
8. Activation is a deliberate owner action, recorded with actor, time and **start month S**.
9. Payment accounting activation and attendance accounting activation remain **separate and untouched**.

**Activation-month treatment (v4).** The owner picks a **start month S**. Activation **takes effect at the start of S** (`ledgerStartsOn` = S's generation date G(S), in the organization's timezone):
- **Before `ledgerStartsOn`** the organization behaves entirely as it does today: old screens, old payment actions, no ledger rows. **On and after it**, the ledger is authoritative for every screen and every payment write. There is **no period in which screens and obligations disagree**, and enrollments before that date use the old path (no `SIGNUP` obligation).
- **Constraints enforced:** G(S) is not in the past, and is on or after `statusHistoryTrustedFrom`. So the first generated cycle is never a back-dated one and nothing is invented for the month in progress at switch-over.
- **The month in progress at switch-over stays in the old records** (`PaymentPeriod`, shown as history). Bringing an unpaid current month into the ledger happens only through **owner-entered opening items** (D7, D15), never by inference.
- Before `ledgerStartsOn`, cancelling the activation has **no effect on data**, because nothing has been created yet.

**Readiness checks (all must pass; the activation control refuses otherwise):**
1. Baseline taken and reviewed (counts by status), `statusHistoryTrustedFrom` on or before G(S), no student without a baseline or event row, consistency check clean.
2. S valid as above.
3. A policy version effective for S, **approved by the owner** (due day, grace rule, fee, currencies); the rate approach (D1) recorded.
4. **Every branch** has a plan price and a signup price effective for S (no branch without one; nothing created for a branch that does not exist).
5. Every baseline-`ACTIVE` student is assigned, or explicitly acknowledged as unassigned; students without a resolvable amount are listed.
6. Opening items entered and confirmed, or explicitly "none".
7. **Integration ready:** every consumer and payment-write path is ledger-aware and the old actions refuse for ledger-active organizations (a test enumerates every remaining use of the old overdue rule).
8. A dry-run preview was generated and reviewed.
9. The scheduled-job runner is enabled for the organization (heartbeat healthy).

## B11. Current-code limitations this exposes
Missing row equals debt; one cutoff for all academies; one row per month (no partials, fees, rates); current month only; constant timezone; no price currency, history or duration on plans, and plan prices editable by Directors; a legacy recording window that refuses periods more than one month ahead, and one row per month that cannot represent prepaid months or packages; no status history; write-on-read carry-forward (must never create ledger obligations); the audit-log-is-never-state rule requires the new history tables.

## B12. Separate from MATROOM subscription billing
Separate tables, names (`dues*`), settings, screens (under Payments), jobs, and exchange-rate table. Nothing reads or writes `Organization.graceDays`, `OrganizationInvoice`, invoice statuses or platform billing. Subscription pricing stays deferred.

## B13. Students needing follow-up (dashboard and analytics)

**Today (verified):** the dashboard has "Alumnos por contactar" (every staff role; `ACTIVE` students only; absent 7 days or more or never attended; shows phone, last attendance, days absent and a payment status computed with the old overdue rule), and the analytics page has a director-only retention list (30, 60 and 90-day buckets). **There are no contact actions** (no call, WhatsApp or email links) anywhere.

**Proposed:** one shared "Students needing follow-up" query and section used by both places, with **last attendance, time absent, status (active, paused, left) and contact actions** (links that open the user's phone, WhatsApp or mail app from the stored phone and email; the app sends nothing itself). Paused and left students appear with their status so staff can see who has an open balance or may be returning. The payment column keeps the old rule until activation, then reads the ledger.

**Boundaries:** it is **read-only and independent of the payment ledger**, so it can ship first. **Nonattendance never infers departure and never stops billing:** only a person marking a student paused or left changes status, and the section may offer that existing action but never performs it. It reads attendance records only and does not touch promotion or attendance accounting. Which students are listed, the day thresholds (today fixed in code at 7 and 30/60/90) and the contact channels are **pending (D16)**.

---

# Part C. Decision register

**Confirmed and retired (do not ask again):** signup timing and the general rule; signup and recurring tuition as distinct obligations; branch-specific prices, **due days, grace rules and late-fee amounts (each independently per branch)**; owners only for price changes, fee waivers and payment reversals; BCR rates entered manually by an owner for the payment date; oldest-first settlement; full settlement only (no partial payments, no credit); **one payment may settle several obligations**; **future months may be paid in full, for explicitly identified periods**; **Manage Plans supports multi-month offers with versioned, branch-specific terms**; paused or left stops charges from the following month; the follow-up section and its rule that nonattendance never bills or ends a student; owner-identified opening items with manually recorded full settlement. **Package and prepayment policies (A7) are decided.** Old D6, D10, D11 and D17 to D23 no longer exist.

## C1. Pending owner decisions (no defaults assumed)

| ID | Decision | Blocks |
|---|---|---|
| D1 | CRC rounding and tolerance; the quote to use when none exists for the exact date; how a mistyped quote is corrected | ledger PR (CRC payments) |
| D2 | A wrongly assessed fee once a receipt converts to a full on-time settlement: removed automatically, or owner-confirmed | ledger PR |
| D3 | Unpaid signup charge: when it is late, any consequence, and its order against monthly obligations. (No late fee unless decided.) | ledger PR |
| D4 | Backdating limit for the received date; how a short or excess receipt (an `EXCEPTION`) and other post-settlement corrections are resolved, including which months and what amount an owner-approved refund covers, and which coverage (if any) it releases (consumed months never become billable again) | ledger PR |
| D5 | Who besides owners may record ordinary payments, assign students, move a due date, cancel an obligation, grant a price exception, or edit a plan's name, description and active flag (today Directors can); who records a **package purchase** and how the owner confirms the start month | settings PR |
| D7 | Whether the late fee applies to past unpaid months the owner lists | readiness PR |
| D8 | Individual exceptions (scholarship, sibling, promo, legacy PROMO/EXEMPT): needed at all, and from day one | schema PR (can defer) |
| D9 | Mapping (paused = Inactive, left = Archived); fee on debt of someone who left; returning student and a new signup charge | ledger PR |
| D12 | Student-facing wording | consumers PR |
| D13 | Which date counts as "joined" (form date or the day staff approve and take payment) | ledger PR |
| D14 | Whether the signup price always follows tuition | settings PR |
| D15 | Switch-over: start at the next 1st of a month, or mid-month with an owner-confirmed list for the month in progress | readiness PR |
| D16 | Follow-up section: which students are listed, thresholds, contact channels | follow-up PR |
| D24 | **A branch with no prepayment limit entered yet:** prepayment unavailable until an owner sets that branch's limit, or unlimited until then. (No Alliance value is assumed.) | ledger PR |

## C2. Implementation choices (engineering, not owner policy; Part E, T1 to T17)

---

# Part D. Worked examples

All amounts follow the confirmed Alliance settings. **Rates in example 4 are made up for illustration only; they are not BCR quotes, and the rounding shown is not approved.**

### D-1. September 25 signup (confirmed)
| Date | Event | Ledger |
|---|---|---|
| Sep 25 | Approved and assigned; pays USD 100 | `SIGNUP` obligation USD 100 (origin ENROLLMENT) settled in full by the receipt. **No September `MONTHLY`**: the 25th is on or after the due day |
| Oct 1 | Monthly job | `MONTHLY` October, USD 100 (the student's branch price effective for October), due Oct 20, grace through Nov 5, fee terms USD 20 snapshotted |
| Oct 20 to Nov 5 | | past due but `IN_GRACE`; **no fee**; amount to settle: **USD 100** |
| Nov 1 | Monthly job | `MONTHLY` November, due Nov 20 |
| Nov 6 | Fee job, if October is still unsettled | fee USD 20 for October (once); amount to settle is now **USD 120** |

The `SIGNUP` obligation never receives a late fee, even if it were unpaid (D3 decides what unpaid means). Neither creation path can produce a second row: `SIGNUP` is keyed on the enrollment, `MONTHLY` on (student, coverage month).

### D-2. Full settlement only (replaces the v3/v4 partial-payment example)
October obligation, USD 100 tuition, USD 20 fee, grace through Nov 5. The student pays in USD:
| Pays | Received | Result |
|---|---|---|
| USD 100 | Nov 3 | **settles** October (on time: tuition only) |
| USD 100 | Nov 8 | **refused**: from Nov 6 the amount due is USD 120. Nothing is stored |
| USD 120 | Nov 8 | **settles** October: tuition 100 plus fee 20 |
| USD 60 | any date | **refused**: it would be a partial payment |
| USD 150 | Nov 3 | **refused**: it would be an overpayment, and there is no credit. The message shows the selectable totals (for example USD 100, then 200 if November is also selected) |
The fee is assessed once on Nov 6 and never again; it stops being owed only when the obligation is settled, or an owner waives it.

### D-3. Two overdue months paid together (one USD 240 payment)
On Dec 6, October and November are both unpaid. October: due Oct 20, grace Nov 5, fee Nov 6 (amount due **USD 120**). November: due Nov 20, grace Dec 5, fee Dec 6 (**USD 120**). December's obligation (created Dec 1, due Dec 20) is outstanding but not late (**USD 100**). The ordered list and its selectable totals on Dec 6:

| Select through | Total |
|---|---|
| October | USD 120 |
| October and November | **USD 240** |
| October, November and December | USD 340 |
| ... and January prepaid (D-10) | USD 440 |

**One USD 240 payment on Dec 6 settles October and November together,** each completely with its own fee. December stays due Dec 20. USD 200, 230 or 250 are **refused**: 200 would leave November partial, 250 would be an unallocated credit. No fee is ever added to October or November again; only a new obligation can produce a new fee.

### D-4. A USD obligation paid in CRC (illustrative numbers; not BCR quotes, and the rounding shown is not approved)
Required CRC = amount due x the owner-entered rate for the received date, rounded by the rule pending in D1 (shown here to the whole colon).
- **Rate already entered.** Oct 18: the owner has entered 500.00 for Oct 18. Amount due USD 100 (on time), required 50,000 CRC. The receipt of 50,000 CRC **settles** October; the payment stores the tender, rate, quote reference and date.
- **Rate not yet entered (rate-pending).** Nov 5 (last grace day): 50,000 CRC received, no owner-entered rate. It is recorded `AWAITING_RATE`; October stays open, **not settled, not partial, no credit**. Nov 6: October is unsettled, so the fee USD 20 is assessed, flagged "linked to an unresolved receipt". **Nov 8:** the owner enters 500.00 for Nov 5. Converted value USD 100.00 equals tuition due on Nov 5 (on time): October **settles**, the fee is removed (mechanism: D2).
- **Same, but the owner enters 520.00.** Required 52,000 CRC; the receipt is 50,000 (about USD 96.15). It is **short**, so it becomes an **`EXCEPTION`**: October stays open, the fee stays, and the 96.15 is **not** applied as a partial payment. An owner resolves it (procedure: D4).
- **Same, but 480.00.** Required 48,000; the receipt of 50,000 is **excess**: an **`EXCEPTION`**, **no credit**.
- **Received Nov 8, 50,000 CRC at 500.00.** Converts to USD 100, but USD 120 is due on Nov 8: **short**, an **`EXCEPTION`**.
No rate or amount ever changes for a payment already settled.

### D-5. Owner changes tuition for a future month
Oct 15: the owner sets the **Escazú** branch's tuition from USD 100 to USD 110 **effective December** (Escalante stays at USD 100, and no other branch is involved). Preview: the students on Escazú's plan whose price will change (illustrative count: 84), any students on individual exceptions, if the owner allows them (D8), who will not change, 0 December obligations exist yet, and the Oct and Nov obligations (all unchanged) are listed. On confirmation a new price version is inserted (owners only). Oct and Nov keep USD 100, including anyone who pays them in December, and **a student who prepaid December before the change was entered keeps USD 100 for it** (agreed price and coverage are frozen at purchase). **Dec 1:** the job creates December obligations at USD 110 (USD 130 with the fee if paid after Jan 5); the fee stays USD 20 unless changed the same way. If the owner later wants one student's already-created November obligation raised to USD 110, that is a **separate audited adjustment** with a reason, not something the tuition change does.

### D-6. The three confirmed joining cases
Same settings (due day 20, grace through the next month's 5th, USD 100 signup, USD 100 tuition, USD 20 fee).

| Joins | Enrollment path creates | Payments and dates | Monthly job later |
|---|---|---|---|
| **Sep 12** (before the 20th) | `SIGNUP` USD 100 **and** `MONTHLY` September USD 100 | signup USD 100 on Sep 12; **another USD 100 due Sep 20**, grace through **Oct 5**, fee Oct 6 if a balance remains as of Oct 5. **USD 200 in September** | Oct 1: `MONTHLY` October, due Oct 20 |
| **Sep 20** (on the 20th) | `SIGNUP` USD 100 only | signup USD 100 on Sep 20 | Oct 1: `MONTHLY` October, due **Oct 20**, grace Nov 5 |
| **Sep 25** (after the 20th) | `SIGNUP` USD 100 only | signup USD 100 on Sep 25 | Oct 1: `MONTHLY` October, due **Oct 20**, grace Nov 5 |

Rule in one line: **E before the due day: `SIGNUP` plus that month's `MONTHLY`. E on or after the due day: `SIGNUP` only.** Re-running the enrollment path, or the Oct 1 job any number of times, creates no second row of either type. A Sep 12 student archived on Sep 15 keeps their September obligations (B8). Which date counts as E (online form or approval and payment) is D13.

### D-7. A legacy partial payment (owner-entered opening item)
Under the old system a student paid part of September: a legacy row exists, and the owner says USD 40 is still owed. The owner enters an **`OPENING` obligation** for September of **USD 40**, linked to the legacy row, and decides whether the late fee applies (D7). The legacy row is **not changed**, and the system never works out the 40 itself. The student later pays exactly USD 40 (the whole of that obligation), and the owner or staff record it with currency, received date and method. If the owner instead says the month is settled, an audited action records it. If the owner lists nothing, **nothing is owed**: a missing record is never debt.

### D-8. A student is marked paused
Marked paused on Oct 25 with October unpaid: October's obligation (created Oct 1) stays and remains payable (USD 100 through Nov 5, USD 120 after if the fee still applies to a student who left, D9). On Nov 1 the job creates nothing for this student, because they are not eligible at that date. If they are marked left on Nov 3 after November's job already ran, November stays and December is not created.

### D-9. Follow-up never bills or ends a student
A student has not attended for 45 days. They appear in "Students needing follow-up" with last attendance, days absent, status (still active) and contact actions. **Their status does not change and November's obligation is created as usual.** Only when someone marks them paused on Nov 12 does December's obligation stop.

### D-10. One future month prepaid
Oct 10: a student whose October is settled pays for November, naming the period on the receipt. November's `MONTHLY` obligation is created, settled and its coverage reserved **in one transaction**, at the **price version effective for November** (USD 100 while no change is scheduled; if the owner had already entered USD 110 effective November, the student pays USD 110). That amount is **frozen on payment**: a later change never alters it. On Nov 1 the job **skips** November (already covered), so nothing is charged twice. November shows `COVERED`; it never becomes overdue and never gets a fee. **Gaps are refused (confirmed):** paying for December while November is uncovered is not allowed. If the student paid November and December together, the receipt names both periods and each month uses the price effective for it. The number of prepaid months cannot exceed the branch's **prepayment limit** (a per-branch setting; no value assumed).

### D-11. A multi-month package (illustrative price, not an approved Alliance price)
A branch owner sets a plan **"Three months"** in Manage Plans: **months covered 3, package price USD 270 (illustrative), effective October.** Decided policies apply: paid **fully upfront**, covering **three consecutive calendar months from the first uncovered month**, **never created unpaid**.

| Situation on Oct 12 | What the payment covers | Result |
|---|---|---|
| October **already paid**; nothing later covered | first uncovered month is **November** | pays **USD 270**: one `PACKAGE` for **Nov, Dec, Jan**, created atomically with payment and coverage reservation. The job skips those months. |
| October **billed but unpaid** (USD 100 due Oct 20, received before the grace deadline) | October is an **older outstanding obligation**, settled first; the package then starts at **November** | one payment of **USD 370** (100 + 270) settles October and buys Nov to Jan. **Nothing is cancelled or replaced.** |
| Any of Nov to Jan **already covered** | | the **whole purchase is refused** and nothing is stored: coverage is never overlapped or silently replaced |

- The package keeps its **USD 270 and its three months** even if the owner later changes the plan's price to USD 300 from December (frozen on payment).
- **Pausing or leaving does not extend coverage.** A refund is an **owner-approved exception** that preserves payment and coverage history. It does not automatically release all coverage, consumed months never become billable again, and the amount, affected months and coverage release are pending (D4).
- **No automatic renewal.** After January nothing is billed for this student until staff record another purchase; a student with no coverage is a staff to-do state ("coverage ended"), **never debt**, since a missing record does not create debt.

---

# Part E. Remaining owner decisions

## E1. Blocking the first implementation PR
The first implementation PR is **PR 1, the calculation library (no schema)**. **No open owner decision blocks it:** rounding, tolerance, the backdating limit, fee-removal mechanism and similar items enter as **injected parameters**, and every rule PR 1 needs is confirmed (Part A). One reading is confirmed before coding, not blocking: the package start is **always the first uncovered month** (A7).

## E2. Needed before later PRs (kept in the single register, Part C)
D14 signup price (PR 2/3); D24 no-limit behaviour and D5 who records purchases and edits plans (PR 3/4); D1 to D4, D9, D13 (PR 4); D7, D15 (PR 8); D16 follow-up section (PR 0, independent); D12 wording (PR 7); D8 special amounts (can defer).

## E3. Implementation choices (engineering; proposals for review, not owner policy)
- **T1 Obligation storage:** one table with a `type` column (`SIGNUP`, `MONTHLY`, `PACKAGE`, `OPENING`), or separate tables.
- **T2 `SIGNUP` identity:** unique on (student, enrollment key), recorded on approval.
- **T3 Plan terms:** an append-only terms table hanging off the existing branch-owned `PaymentPlan` (`effectiveFrom`, price, currency, months covered); today's plan rows and `defaultAmount` untouched. The Manage Plans page and actions are extended, not duplicated. (Months covered is a count of consecutive calendar months.)
- **T4 Baseline:** `source` column plus `statusHistoryTrustedFrom` on the organization; consistency check as a readiness check and daily.
- **T5 Timezone:** `Academy.timezone` (branch) governs each branch's dates.
- **T6 Numeric storage:** exact decimals for amounts and rates; the rate scale set with the rounding rule (D1).
- **T7 Legacy coexistence:** one per-request gate, "ledger active for this organization today", used by every screen and write path; old actions refuse server-side when it is true. The legacy one-month-ahead rule is not carried into the ledger path.
- **T8 Jobs:** reuse the existing scheduled-job runner and heartbeats; correctness comes from database keys.
- **T9 Settlement:** one active `DuesSettlement` per obligation; a receipt covering several obligations is one payment with several settlements.
- **T10 Exception queue:** a receipt status (`AWAITING_RATE`, `EXCEPTION`) plus a filtered owner view.
- **T11 Follow-up query:** one shared function replacing the two existing list queries, swapped in one step.
- **T12 Owner-only enforcement:** the existing `ADMIN` gate on each action, tested with a director attempting it.
- **T13 Coverage rows:** calendar-month rows `(obligation, student, coverage month, released on)` with a partial unique index (one unreleased row per student and month), shared by `MONTHLY`, `PACKAGE` and `OPENING`. **No wallet, credit or generic offer table is added.**
- **T14 Purchase transaction:** prepaid months and packages are created, settled and covered in one transaction with the payment; any conflict fails the whole purchase.
- **T15 Plan-action permissions:** price and coverage fields gated to `ADMIN` inside the existing create and update actions; other fields unchanged until D5.
- **T16 Packages:** purchased only by an explicit staff or owner action; the job never creates one; no renewal logic exists.
- **T17 Prepayment limit:** a per-branch setting read by the validator as a parameter; no default value exists in code, migrations or seeds.

---

# Part F. Focused PR sequence (activation last)

Each PR: failing tests first, mutation-checked decision points, registered-user browser checks where UI changes, CI green. **No activation, no fixtures or seeds carrying prices, fees or package prices, no branch other than Escazú and Escalante, and no guessed historical balances or debts.**

0. **Follow-up section** (independent of payments; can ship first): read-only, never changes status or billing. *Needs D16.*
1. **Calculation library, no schema:** amount due (tuition plus fee when the received date is after the grace deadline, per branch fee terms); the **prefix-sum full-settlement validator over outstanding obligations (oldest first, confirmed) and identified future periods** (refuses partial and unallocated excess; **consecutive future coverage after existing obligations is confirmed**); the **coverage-overlap and all-or-nothing package-purchase check**; rate-pending and `EXCEPTION` state machine; enrollment-path rule; baseline eligibility; `ledgerStartsOn` gate; conversion and rounding as injected policy. Exhaustive tables (Nov 5 / Nov 6, 100 vs 120, USD 240 both months, refusals of 200, 230, 250, a December-without-November gap, a package over already-covered months, ordinary prepaid months priced per covered month, and a package at its quoted price).
2. **Additive schema and tenant-guard registration:** obligation types (`SIGNUP`, `MONTHLY`, `PACKAGE`, `OPENING`), with the **confirmed `MONTHLY` unique key (student, coverage month)**; **coverage rows (calendar months, one unreleased row per student and month)**; a **per-branch prepayment-limit setting (no value seeded)**; settlements (one active per obligation); payments with receipt statuses and intended periods; owner-entered quotes; **per-branch policy including the fee**; **plan terms (price, currency, months covered) versions**; signup price versions (**no amounts or fees in migration or seed**); status history and `statusHistoryTrustedFrom`; `ledgerStartsOn`. Nothing reads it yet.
3. **Manage Plans extension and owner settings (dark), owners only for money fields:** terms per plan (price, currency, months covered, effective month, preview of affected students), per-branch policy (due day, grace, currencies, **fee**), tracking on/off, assignments and the unassigned list, rate entry by date. A plan with several months can be **saved** but no package can be **sold** until PR 5. *Needs D5, D14.*
4. **Ledger core (dark):** enrollment path, monthly job (skipping covered months), fee job, payment entry with the validator (**several obligations and prepaid months**; USD first, CRC after D1), rate-pending reconciliation, exception queue, owners-only reversal and waiver, audited adjustments. Runs only where `ledgerStartsOn` has arrived (none). *Needs D1 to D4, D9, D13, D24.*
5. **Packages (dark):** purchase (atomic with payment and coverage reservation; never unpaid), quoted package price, refunds as owner-approved exceptions preserving history, explicit renewal only. Must not alter monthly billing. *No open owner decision beyond D5 (who records a package purchase).*
6. **Payment-write integration:** payments page, student profile, and the old record and mark-paid actions (refusing server-side for ledger-active organizations, so the legacy one-month-ahead window never applies to the ledger).
7. **Consumer integration:** portal, roster, payments page, dashboard, contact list, weekly digest, analytics, the follow-up payment column, with the states (including `COVERED`) and EN/ES wording. *Needs D12.*
8. **Baseline, assignments, opening items and readiness:** baseline action, bulk assignment, owner-entered `OPENING` items and their manual settlements, dry-run preview per branch, readiness checks (B10). No activation yet. *Needs D7, D15.*
9. **Activation control**, shipped last, refused unless every readiness check passes; it schedules `ledgerStartsOn`. Then the owner-executed Alliance activation, and after all organizations have moved, a cleanup PR removing the legacy overdue path.

---

## Later milestone (recorded, not scheduled)
A **full-codebase bug, security and unnecessary-code review**, after the payment work and the remaining UI work are complete. Deferred and unchanged: academy/branch onboarding, contact-email policy, MATROOM subscription pricing.
