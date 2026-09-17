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
