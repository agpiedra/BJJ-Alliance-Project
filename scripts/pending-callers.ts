/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2a design-approval fix 3: symbols
 * built ahead of their caller, tracked honestly instead of becoming an
 * orphan discovered two phases later. Deliberately NOT part of
 * `check:guard-usage` — that script's job is "every security guard is
 * exercised by at least one caller," and a dead guard is a false-safety bug.
 * This list is domain logic waiting on a UI that hasn't been built yet, which
 * is a normal, tracked state, not a defect — but "normal" only stays true
 * while it's visible, so CI prints this list every run (`pnpm
 * check:pending-callers`, non-blocking, always exits 0). Anything still
 * listed when its `dueBy` phase closes is a finding, not a footnote.
 *
 * Phase 2c extended this file with a second list, KNOWN_LIMITATIONS: design
 * gaps deliberately deferred during a behavior-preserving migration, not
 * unwired symbols. Same reasoning, same fix — a limitation noted only in a
 * code comment dies there; this file is the one place both kinds of
 * "don't forget this" survive past the commit that found them.
 *
 * Usage: tsx scripts/pending-callers.ts
 */
interface PendingCaller {
  symbol: string;
  file: string;
  dueBy: string;
  reason: string;
}

/**
 * A known, deliberately-deferred limitation — not an unwired symbol, but the
 * same problem this file already solves: a design gap noted in a code
 * comment dies there. Recorded here instead so it survives past the commit
 * that introduced it.
 */
interface KnownLimitation {
  description: string;
  foundIn: string;
  dueBy: string;
  reason: string;
}

const KNOWN_LIMITATIONS: KnownLimitation[] = [
  {
    description: "The \"approaching\" threshold (5 remaining attendances) is a hardcoded literal that doesn't generalize.",
    foundIn: "src/lib/students/promotion-queue.ts (APPROACHING_THRESHOLD)",
    dueBy: "Phase 4 settings candidate",
    reason:
      "5 remaining attendances is ~17% of a white belt's 30-per-stripe block and ~6% of brown's 85 — \"close to promotion\" means something different per belt, more so across academies with their own thresholds. Preserved exactly as today during the Phase 2c migration (behavior-preserving, not a redesign). Candidate fix: director-configurable, or proportional to the current block size.",
  },
  {
    description: "progression.ts's projected due date is derived from remainingToNextStripe and a recent attendance rate — meaningless for a TIME or HYBRID academy.",
    foundIn: "src/lib/analytics/progression.ts (getProgressionPlanningList)",
    dueBy: "Whenever a non-ATTENDANCE academy becomes real",
    reason:
      "Alliance is ATTENDANCE-only today, so nothing breaks. The engine (src/lib/promotion/engine.ts) already returns a real dueDate for TIME/HYBRID — progression.ts should prefer that when mode is TIME/HYBRID and fall back to its own attendance-rate projection only for ATTENDANCE.",
  },
  {
    description:
      "A skipped MissingTimeAnchorError student is only console.warn'd (student id + an aggregate count) — the director has no way to see \"N students couldn't be evaluated\" in the UI.",
    foundIn: "src/lib/students/promotion-queue.ts (classifyActiveStudents)",
    dueBy: "When a TIME-mode academy becomes real",
    reason:
      "Alliance is ATTENDANCE-only today, so this path never fires in production — deliberately not built out further in 2c-i (no UI plumbing for a mode with zero real users). But log-only means the count is invisible to the person who owns the data; surfacing it requires changing listPromotionQueue/listApproachingStudents's return shape (candidates + a skipped count) and updating dashboard/page.tsx and progression.ts to render it. Tracked here so it isn't rediscovered later as \"the queue is silently short.\"",
  },
  {
    description:
      "evaluatePromotion's BELT target is grounded in a boolean (isTerminal), not the catalog fact it's meant to represent (\"a rank exists at order + 1\") — the engine never receives hasNextRank at all.",
    foundIn: "src/lib/promotion/engine.ts (resolveNextTarget), src/lib/promotion/award.ts (the InvalidPromotionConfigError guard that covers the gap today)",
    dueBy: "Not scheduled — cheaper defensive fix in place instead",
    reason:
      "isTerminal and \"a rank exists at order + 1\" are two independently edited facts kept aligned only by validateTrackConfig at config-update time, not a database constraint — a gap in order, a catalog whose highest rank was never flagged terminal, or a hand-edited row can desync them. Phase 2c-ii deliberately did NOT fix this by threading hasNextRank into EngineInput (reopens 2b's input shape); instead award.ts throws InvalidPromotionConfigError when the order+1 lookup returns null on a BELT target. Sufficient and cheaper for now. The deeper fix — passing hasNextRank so BELT is grounded in the catalog rather than a flag — is cleaner if this ever needs revisiting.",
  },
  {
    description:
      "The student-detail Promociones card's HYBRID progress line concatenates the ATTENDANCE and TIME dimensions (\"3 of 10 asistencias · vence 2026-01-01\") instead of picking the one that actually gates the next award.",
    foundIn: "src/app/[locale]/(staff)/students/[id]/promociones-card.tsx (progressLine)",
    dueBy: "Whenever a real HYBRID-mode academy exists",
    reason:
      "Alliance is ATTENDANCE-only today, so HYBRID never renders in production. evaluatePromotion itself doesn't expose which dimension is binding for a HYBRID rank (attendance count vs. due date, whichever comes first/last per the track's rule) — showing both avoided guessing at that semantics with no real academy to validate against. Candidate fix: have the engine return which dimension is binding, then show just that one.",
  },
  {
    description:
      "A field present in an upsert's `create` branch but missing from `update` is frozen at whatever it was when the row was first written. Reseeding cannot fix it — no number of `pnpm db:seed` runs will ever rewrite that column on an existing row.",
    foundIn: "prisma/seed.ts — every upsert in the file (found via seedBeltRanks's stripeColors/visibleStripeSlots)",
    dueBy: "Resolved — every upsert in prisma/seed.ts now builds one `data` object shared by both its create and update branches",
    reason:
      "This caused several rounds of confusion in Phase 3b: adult tapes and kids tape colours were corrected in the seed source and reseeded repeatedly, and stayed wrong, because stripeColors and visibleStripeSlots existed only in the create branch — an update-only reseed of an already-existing row is a silent no-op for any field missing from that branch. The dev database looked broken and the test database looked fine purely because the test database's rows happened to have been recreated more recently, not because either seed was more correct. Fixed by auditing every upsert in the file (not just BeltRank) and making create/update share one object, so the divergence can't be reintroduced field by field. tests/integration/seed-idempotence.test.ts (seed a second time, snapshot before and after, assert identical) guards against a future edit reintroducing a value MISMATCH between the two branches — it is a determinism/parity check, not a substitute for the shared-object shape: a field that's purely omitted from update (rather than set to a different value) doesn't itself change between two same-source runs, so the shared-data-object shape is what actually prevents this specific bug from recurring.",
  },
  {
    description:
      "tests/integration/seed-repairs-drift.test.ts deliberately writes a wrong value directly into a real, shared seed-owned row (e.g. the WHITE BeltRank's stripeColors, Organization.name, a seeded Student's firstName) before reseeding to prove the repair. Any other test file reading that same row while it's briefly wrong races against it — this is NOT the kiosk-rate-limit.test.ts race (that one was in that file's own fixture resolution and is fixed at the source by an exact slug lookup, independent of parallelism). This one is concealed, not fixed, by vitest.integration.config.ts's `fileParallelism: false`.",
    foundIn: "tests/integration/seed-repairs-drift.test.ts (the corrupting side); confirmed collision with tests/integration/perform-check-in.test.ts (the reading side, which hardcodes WHITE-rank color assertions) — other files reading the same seeded rows (kids-belt-catalog.test.ts, tenant-context.test.ts, deterministic-seed.test.ts, and anything constructing a student/promotion/payment against the shared Alliance org) are equally exposed in principle, just not empirically triggered yet",
    dueBy: "Not scheduled — serial execution is the workaround in place, not a fix",
    reason:
      "Confirmed by direct experiment: with file-level parallelism on, perform-check-in.test.ts failed only when run alongside seed-repairs-drift.test.ts, and passed every time in isolation. Setting fileParallelism: false makes every file run one at a time, so the corruption window never overlaps another file's read — but the corruption itself still happens, and the race is real again the moment parallelism is re-enabled for speed (a change that looks purely like a performance tweak and would not obviously reintroduce a correctness bug to whoever makes it). A real fix would need the drift test to corrupt rows no other file ever reads (hard to guarantee given how many files touch the shared Alliance seed data) or per-test database isolation (a bigger infrastructure change than this phase's scope). Flagged here specifically so re-enabling parallelism is never treated as a free performance win.",
  },
  {
    description:
      "A dev-only session-minting backdoor exists for Playwright/manual screenshot verification. A test-only auth path that exists at all is a standing risk, regardless of how tightly it's gated today.",
    foundIn: "src/app/api/e2e-auth-bypass/route.ts",
    dueBy: "Re-read before launch — not scheduled for removal before then, since Phase 4/5's UI-heavy work still needs it",
    reason:
      "Gated on NODE_ENV!==\"production\" AND E2E_AUTH_BYPASS_SECRET both required (no default value), localhost-only, constant-time secret comparison, and it mints sessions only for an existing user via the exact same activeOrganizationId-resolution function real login uses (src/lib/auth/sign-in-jwt-callback.ts) — proven structurally identical to a real login session by tests/integration/e2e-auth-bypass-equals-real-login.test.ts, not just \"both work.\" None of that changes the shape of the risk: it is a code path whose entire job is minting authenticated sessions without a password, shipped in the same codebase that will eventually run in production. Before launch: confirm the env-var gate is genuinely unreachable in the deployed environment (not just unset by convention), and consider whether it should be deleted outright once it's no longer needed for screenshot verification rather than left in place indefinitely.",
  },
];

const PENDING_CALLERS: PendingCaller[] = [
  // evaluatePromotion (src/lib/promotion/engine.ts) removed from this list —
  // Phase 2c-i gave it a real production caller (getAtBeltSummary). It's no
  // longer "built ahead of its caller"; promotion-actions.ts and
  // students/page.tsx still using eligibility.ts directly instead is
  // tracked as its own KNOWN_LIMITATIONS entry above, not here.
  {
    symbol: "updateTrackConfig",
    file: "src/lib/promotion/config.ts",
    dueBy: "Phase 4",
    reason: "Writes a track's BeltRank/PromotionConfig; Phase 4 builds the director-facing config screen that calls it.",
  },
  {
    symbol: "validateTrackConfig",
    file: "src/lib/promotion/config.ts",
    dueBy: "Phase 4",
    reason: "Pure validation `updateTrackConfig` calls internally; also due Phase 4 once a caller can invoke it standalone (e.g. a live-preview check before submit).",
  },
  // Student dues, PR 1 (calculation library only: pure functions, no schema, jobs or UI). Every export below is used only by its unit
  // tests until the ledger PR wires it in; the payment proposal's PR sequence (docs outside the repo) names that PR.
  {
    symbol: "dueDateFor / graceDeadlineFor / enrollmentTiming (and the calendar helpers)",
    file: "src/lib/dues/calendar.ts",
    dueBy: "student-dues ledger PR (proposal PR 4)",
    reason: "Due dates, inclusive next-month grace deadlines and signup-versus-recurring timing; the ledger's enrollment path and monthly job call them.",
  },
  {
    symbol: "amountDueMinor / lateFeeToAssessMinor / outstandingItems / settleReceipt",
    file: "src/lib/dues/settlement.ts",
    dueBy: "student-dues ledger PR (proposal PR 4)",
    reason: "Once-per-obligation late fee and oldest-first whole-obligation settlement totals; the fee job and payment entry call them.",
  },
  {
    symbol: "firstUncoveredMonth / planPrepaidMonths / planPackage / monthsToCreate / priceFor",
    file: "src/lib/dues/coverage.ts",
    dueBy: "student-dues ledger PR (proposal PR 4); packages proposal PR 5",
    reason: "Consecutive prepaid and package coverage, overlap detection and per-month price versions; payment entry and the monthly job call them.",
  },
  // Student dues, PR 4a (the first ledger writers: plain library functions, closed by default). The monthly-generation runner
  // (below) is now `createMonthlyObligationInTx`'s one authorized caller — but the PUBLIC `createMonthlyObligation` wrapper and
  // `recordDuesPayment` still have none: tests/unit/dues-ledger-not-exposed.test.ts fails if anything else outside
  // src/lib/dues/ledger imports either.
  {
    symbol: "createMonthlyObligation (the public wrapper) / recordDuesPayment (and the exact minor-unit conversion)",
    file: "src/lib/dues/ledger/ (create-monthly-obligation.ts, record-payment.ts, minor-units.ts)",
    dueBy: "payment-write integration stage (proposal PR 6)",
    reason:
      "The ledger's obligation-creation and payment-settlement writers, deliberately unreachable from live billing until activation: the injected activation defaults to inactive and is NOT authorization. The first caller must take activation from trusted organization state, never from request data. (createMonthlyObligationInTx, the transaction-aware core the public wrapper now delegates to, has its first real caller — the monthly-generation runner, below — but the public function itself still awaits payment-write integration.)",
  },
  // Monthly-generation brief: the function that finally connects eligibleAndAssigned and createMonthlyObligationInTx. No
  // production caller exists on purpose — not a route, not a server action, no scheduler entry (vercel.json's crons array is
  // untouched). tests/unit/dues-ledger-not-exposed.test.ts and dues-eligibility-not-exposed.test.ts both name this file as the
  // one authorized caller of the ledger and the eligibility reader respectively.
  {
    symbol: "generateMonthlyObligationForStudent",
    file: "src/lib/dues/monthly-generation.ts",
    dueBy: "activation / scheduler rollout stage",
    reason:
      "Per student, per branch, per month: reads status and assignment history under one held student lock, decides via eligibleAndAssigned, and calls createMonthlyObligationInTx inside that same transaction. Closed by the same LedgerActivation default (inactive) createMonthlyObligationInTx itself checks. Built and tested ahead of a route/action/scheduler entry, deliberately, so activation stays a single later decision rather than something this PR has to make.",
  },
  // Late-fee-assessment brief: the proactive runner that finally makes an overdue fee assessable before anyone tries to pay.
  // No production caller exists on purpose — not a route, not a server action, no scheduler entry (vercel.json's crons array is
  // untouched). tests/unit/dues-ledger-not-exposed.test.ts names this file, alongside monthly-generation.ts, as an authorized
  // caller of the ledger.
  {
    symbol: "assessLateFeesForStudent",
    file: "src/lib/dues/late-fee-assessment.ts",
    dueBy: "activation / scheduler rollout stage",
    reason:
      "Per student: locks the student row, reads open MONTHLY obligations, and calls assessLateFeeInTx (record-payment.ts, the transaction-aware core recordDuesPayment's own inline fee logic was extracted into) for each, by id. That helper re-reads obligation/settlement/fee state itself under the lock and repeats the activation check itself, so this runner trusts nothing but the id, today's date and actorId: null (the existing 'automated system action' convention). Built and tested ahead of a route/action/scheduler entry, deliberately, so activation stays a single later decision. Genuinely flagged, not blocking: no waiver/void writer exists yet, so recordDuesPayment's existing feeAlreadyAssessed refusal becomes reachable in ordinary use once this ships — an activation prerequisite, not something this PR needs to resolve.",
  },
  // Late-fee-correction brief: the owner-only writer that resolves exactly that reachable feeAlreadyAssessed case — a fee wrongly
  // assessed before an on-time payment was recorded. No production caller exists on purpose — not a route, not a server action,
  // no scheduler entry, no UI. Lives inside src/lib/dues/ledger/ (it composes recordDuesPaymentInTx directly), so it needs no
  // entry in the ledger's own no-caller guard — that guard only restricts imports from OUTSIDE the ledger directory.
  {
    symbol: "correctLateFeeAndSettle",
    file: "src/lib/dues/ledger/correct-late-fee.ts",
    dueBy: "activation / scheduler rollout stage, and a UI for owners to use it",
    reason:
      "Voids a fee that was wrongly assessed given an owner-confirmed (not independently verified) receivedOn, and records the full settlement it was blocking, in one transaction: never a void without its matching settlement, never a settlement bypassing oldest-first validation. Composes recordDuesPaymentInTx directly (no nested transaction) via a throw-and-convert mechanism so any settlement refusal rolls back the provisional void too. Owner-only (context.organizationRole === 'ADMIN', checked here, not deferred to a caller); reuses the ordinary payment's maxBackdateDays limit unchanged (no separate correction allowance); VOID only — WAIVED, refunds and reversal remain exactly as undecided as before this PR.",
  },
  // Payment-reversal brief: reverses a recorded payment and every one of its active settlements atomically. No production caller
  // exists on purpose — not a route, not a server action, no scheduler entry, no UI. Lives inside src/lib/dues/ledger/ (it
  // composes lockStudent/inTenantScope directly), so it needs no entry in the ledger's own no-caller guard.
  {
    symbol: "reversePayment",
    file: "src/lib/dues/ledger/reverse-payment.ts",
    dueBy: "activation / scheduler rollout stage, and a UI for owners to use it",
    reason:
      "Reverses a payment and all its active settlements together, in one transaction, under the student lock, trusting nothing re-read before it. Two approved policy decisions: reversing a settlement with a valid, never-voided fee makes both the tuition and the fee owed again (no new logic — the fee row is untouched, so it's already correct); reversing a settlement whose obligation has a VOIDED fee is refused outright (voidedFeeBlocksReversal, a temporary restriction on the obligation's current fee state, not a claim the payment being reversed caused that void — no provenance field added). Refuses type !== MONTHLY (unsupportedObligationType) as a runtime scope boundary — MONTHLY does not distinguish an ordinary obligation from a future prepayment purchase, so supporting prepayment/package settlements later means revisiting this writer before either is exposed. Owner-only (context.organizationRole === 'ADMIN', checked here); refunds, fee restoration and cancellation remain out of scope.",
  },
  // Late-fee-waiver brief: an owner forgives a genuinely, correctly assessed fee anyway (policy, unlike VOID's factual
  // correction). No production caller exists on purpose — not a route, not a server action, no scheduler entry, no UI. Lives
  // inside src/lib/dues/ledger/ (it composes lockStudent/inTenantScope/versionRevision directly), so it needs no entry in the
  // ledger's own no-caller guard.
  {
    symbol: "waiveLateFee",
    file: "src/lib/dues/ledger/waive-late-fee.ts",
    dueBy: "activation / scheduler rollout stage, and a UI for owners to use it",
    reason:
      "Marks a fee WAIVED under the student lock, trusting nothing re-read before it — touches exactly one DuesLateFee row and its audit entry, no settlement/obligation/coverage write, ever (every reader already keys off removedAt alone, never removalKind, so a waived fee is excluded from amountDueMinor and never re-assessed for free). Refuses an already-paid fee outright (alreadyPaid: an active, unreversed DuesSettlement points at it) rather than silently crediting, refunding or rewriting history — a reversed settlement is history, not payment, and does not block a waiver. Refuses an already-removed fee (alreadyRemoved) without touching its existing removalKind/removalReason. Owner-only (context.organizationRole === 'ADMIN', checked here); does not extend reversePayment's VOIDED-only reversal restriction to WAIVED (deliberately unchanged — a waiver's premise isn't tied to any payment's timing or existence).",
  },
];

function main() {
  console.log("check:pending-callers — symbols built ahead of their caller:\n");
  for (const entry of PENDING_CALLERS) {
    console.log(`  ${entry.symbol} (${entry.file})`);
    console.log(`    due by: ${entry.dueBy}`);
    console.log(`    why: ${entry.reason}\n`);
  }
  console.log(`${PENDING_CALLERS.length} pending caller(s).`);

  console.log("\ncheck:pending-callers — known, deliberately-deferred limitations:\n");
  for (const entry of KNOWN_LIMITATIONS) {
    console.log(`  ${entry.description}`);
    console.log(`    found in: ${entry.foundIn}`);
    console.log(`    due by: ${entry.dueBy}`);
    console.log(`    why: ${entry.reason}\n`);
  }
  console.log(`${KNOWN_LIMITATIONS.length} known limitation(s).`);

  console.log("\nBoth lists are non-blocking — informational only.");
}

main();
