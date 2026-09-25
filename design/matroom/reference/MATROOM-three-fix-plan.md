# MATROOM — three functional fixes before the redesign

Work in `C:\Users\iGaming\Desktop\BJJ Project\BJJ Alliance Project`.

Investigate and fix the following issues as three separate PRs, in the order below. This is functional work, separate from the approved MATROOM visual redesign. MATROOM is the approved platform name, but do not turn these fixes into a broad branding or styling change.

## Working rules

- Read applicable repository instructions, inspect git status, and preserve unrelated work. Branch before editing; nothing directly on main.
- Start with PR 1 only. For each PR, report the current behavior, root cause, relevant tests, and proposed scope before implementing. Continue on confirmed, unambiguous fixes without asking for redundant approval. Ask for decisions where this brief explicitly leaves policy unresolved or where investigation materially contradicts the proposal.
- Open one PR per fix, with relevant checks passing and truthful browser-verification evidence. Do not merge it yourself. Do not start implementation of the next PR until the previous one is confirmed merged. If you cannot verify merge status, ask rather than assume.
- Findings below came from a read-only review of commit `e3d2929`; verify the current checkout. Neither live database settings nor Supabase connectivity were verified. Do not treat source comments, seed data, or previous green tests as proof of deployed behavior.
- Keep tenant isolation, branch scope, role enforcement, existing localization, and audit behavior intact. All visible copy belongs in the existing translation system.
- Use an isolated development/test environment for browser verification. Never seed, migrate, change settings, create accounts, upload files, or send invitations against production to test these changes. Do not expose credentials in output. If required environment access is unavailable, say exactly what remains unverified.
- Discover and use relevant installed investigation, testing, and browser skills. Do not invoke every installed plugin indiscriminately. Read their actual instructions and report capabilities actually used.
- Update `docs/MULTI_ACADEMY_AND_KIDS_BELTS.md` in the PR that changes the behavior it documents. Supersede contradictory old rules explicitly; do not leave competing requirements.
- If tests passed while preserving a defect, explain whether coverage was missing, dependencies were mocked, or the tests encoded an obsolete policy. Add meaningful regression coverage. Do not claim an action-unit test proves the browser works.

## PR 1 — Logo upload permissions, validation, and storage failures

Inspect the branding page and actions, `LogoUploader`, `logo-constraints.ts`, `validate-logo.ts`, `logo-storage.ts`, translation keys, and their tests.

Previously confirmed:

1. The branding page admits ADMIN and DIRECTOR, but logo upload/removal actions are ADMIN-only. A director upload throws FORBIDDEN. **The intended behavior for this fix is that authorized directors can upload and remove their organization's logo**, as well as admins. Preserve organization scope and deny instructors, students, and unrelated users. Do not broaden the shared authorization helper globally.
2. Empty upload returns `invalid` plus a required-file field error, but the uploader ignores the field error and falls back to “Something went wrong.”
3. Changing the selected file clears client validation but not the previous server error. Both empty-submit handling and stale-error handling need correction.
4. Storage failures throw without an actionable upload-result taxonomy.

Investigate the actual development storage setup: confirm the selected bucket, existence, public-logo read behavior, credential validity, and relevant write permissions. Local `.env` entries existed, but that proves none of those things. The adapter defaults to `org-branding` when no override is set and uses a server-only service-role credential. Do not expose it to the browser or weaken policies globally to make an upload work.

Keep the existing shared 512 * 1024-byte file limit unless evidence justifies a separately explained change. Client and server already import the same constant. Next's 2 MB request-body cap is intentionally larger for multipart overhead; these numbers should not be identical. The validator downsizes large dimensions to fit 1024 pixels and rejects aspect ratios above 5:1; do not replace resizing with a new dimension restriction by accident.

Provide distinct, localized, actionable feedback for no file, oversized file, unsupported format, invalid image bytes, rejected aspect ratio, unavailable/misconfigured storage, missing bucket, permission denial, and rate limiting. Keep infrastructure details and secrets out of user-facing copy. Log failures server-side with operation, organization, safe error classification, and enough context to diagnose them. For configuration problems, tell the user to contact an administrator rather than change a valid image.

Preserve upload → database commit → old-object deletion ordering and audit records. Preserve the old logo on failure. Reset stale feedback appropriately on file changes, and revoke temporary object URLs when no longer needed.

Tests must cover rendered error messages and replacement-file state, real role differences, and storage failure mapping. Existing integration tests mock storage and explicitly expect directors to fail; revise the obsolete expectation. A test titled “a director can remove a logo” previously instantiated an ADMIN: correct the fixture, not only the title.

Browser acceptance: as a genuine development director, upload a real PNG; confirm it appears on the settings page and sidebar after reload. Exercise empty submission, oversized file, renamed non-image, extreme aspect ratio, and supported-format success. Verify infrastructure error presentation through controlled development failure injection where necessary; distinguish injected checks from actual network/bucket checks. Confirm unauthorized users cannot modify another organization's branding.

## PR 2 — Promotion-anchored progress and correct target wording

This is an explicit change from the old cumulative-through-stripes policy, not a four-number correction.

Intended adult policy:

- White: 30 qualifying attendances per interval.
- Blue: 65.
- Purple: 75.
- Brown: 85.
- Four stripes, then one additional full interval to become eligible for the next belt exam. That fifth interval does not grant a fifth stripe or automatically award a belt.
- Black: use the owner's academy policy of one degree per ten years, with time-based display and no attendance denominator. Do not describe this as an externally verified universal federation rule.
- Eligibility requires instructor review. Attendance or elapsed time must never grant a promotion automatically.

These adult attendance values already exist in the seed catalog. Runtime rules are organization-owned BeltRank/PromotionConfig records, and a configuration UI already exists. Inspect real development values. Preserve that architecture and use one authoritative evaluation path; do not create a competing hardcoded runtime rule table, remove existing configuration blindly, or claim organization configuration is a future feature.

New accounting policy:

- A manually entered student keeps their stated starting rank and stripe count with zero fabricated attendance history.
- Store an explicit qualifying-attendance snapshot and promotion/start date when the starting rank is entered and whenever a stripe or belt is awarded.
- Calculate progress from eligible attendance accrued after the current anchor, not `(stripes + 1) * interval` against the belt-period total. A cumulative qualifying ledger counter may be used only as a snapshot-delta implementation; raw lifetime attendance is not interchangeable with promotion-eligible attendance.
- Reset at the actual promotion award. Attendance accumulated while waiting for that award does **not** carry into the next interval under this requested model. Explain this consequence in the investigation report and document the policy.
- Examples: a newly entered three-stripe white belt starts at 0/30 toward stripe four; a four-stripe white belt starts at 0/30 toward blue-belt exam eligibility; 20 qualifying attendances since the current anchor means 20/30 and 10 remaining.

Inspect attendance summaries, promotion engine, staff awards, corrections, track changes, initial student creation, promotion credits, kiosk/portal consumers, analytics, and automation. Anchor writes and promotion writes must be atomic and safe under concurrent check-ins and repeated requests. Preserve real attendance history and audit records.

Before implementing the migration, propose how to backfill students whose last promotion date or attendance snapshot cannot be reliably recovered. Do not silently reset earned progress, fabricate historical attendance, or assume every seeded student represents a real onboarding case. Ask the owner to decide genuinely ambiguous backfill/credit treatment.

Inspect the scheduled auto-award path as well as check-in. Previously check-in only notified eligibility, but a cron could award stripes when requiresCoachApproval was false. Enforce instructor approval for Alliance and prevent configuration from silently re-enabling automatic awards against that policy. Inventory any other organizations before changing automation globally; do not change unrelated tenants' policies without authorization.

Black progression requires an actual degree representation and a trustworthy date anchor, not merely a hidden progress bar. Report how rank-specific time rules fit the existing track-level configuration. Ask for the starting-degree/date and maximum-degree policy where the current data/model cannot establish it; do not invent them or convert every adult belt to time mode.

Kids currently seed 10 attendances per degree plus 10 for belt eligibility, explicitly prescribed in the old spec. Report that provenance without claiming it was verified with Anny. Ask for the real kids rules; preserve current kids behavior pending that answer, and keep adult changes from silently altering it.

Fix stripe-versus-exam wording in the portal, check-in results, kiosk, and other affected consumers. Render black progress as elapsed time/due date once the degree policy is resolved. No NaN, undefined, Infinity, divide-by-zero, or misleading attendance bar may reach the UI.

Regression coverage: initial nonzero stripes with no history; interval boundaries for all adult belts; stripe/belt anchor writes; four-stripe exam eligibility; delayed instructor awards; nonqualifying classes; corrections/credits; concurrency; no automatic promotion; black-degree rendering. Existing cumulative-policy tests must be deliberately updated rather than contradicted by a second suite.

Browser acceptance: use a student created through a real supported registration/approval or staff-entry flow, not solely a seeded account. Verify known progress and remaining counts before and after a real staff award. Check imported three-stripe white, four-stripe white, and black-degree cases. Confirm attendance remains truthful and no promotion occurs without staff action.

## PR 3 — Explicit class check-in and accessible attendance history

Inspect the portal, `self-check-in-action.ts`, `perform-check-in.ts`, kiosk handlers, class matching, date helpers, and history queries.

Previously confirmed:

- The portal already calls the shared kiosk domain core. Keep channel-specific authentication wrappers; do not force an anonymous kiosk through the portal's authenticated server action.
- With no active match but classes that day, the core returns a class picklist; the portal discards it.
- With no classes that day, it can save UNMATCHED attendance, excluded from promotion progress but present in the ledger.
- An explicitly picked class was consulted only when there was no automatically matched class. Sending an ID from a new button alone would not fix wrong-class attribution.
- The automatic window is start minus 30 minutes through start plus 30 minutes, inclusive; duration is ignored. The kiosk's manual fallback can select outside that window.

Before changing availability policy, report that current behavior and propose one shared rule for the new portal rows. Ask the owner whether to retain ±30 minutes around start or extend through a defined interval after class end, and whether kiosk outside-window/unmatched fallback should remain. Do not silently remove fallback or advertise strict “closed” states while the same channel still accepts arbitrary late selection.

Once settled, show today's classes for the student's authorized academy with time, name, and actual modality/type. Preserve Kids/Striking/Open Mat distinctions where present rather than relabeling everything GI/No-Gi. Each row must show its honest state: open, already checked in, not open yet with opening time, or closed. Explain days with no classes.

Validate the explicitly selected class first in the shared domain flow when supplied. Check organization, academy, active state, occurrence/date, and the agreed policy server-side. A valid explicit selection must not be overridden by a different nearest-time match. Preserve automatic matching for kiosk requests without a selection and any approved, explicitly modeled fallback policy. The UI must not be the security or eligibility boundary.

Use Luxon with explicit `America/Costa_Rica` for today, occurrence dates, boundaries, and displayed opening times. Do not expand this PR into organization-timezone configuration. `new Date()` is fine as an instant; server-local calendar boundaries are not.

Existing tests already set TZ=Pacific/Kiritimati. Add a daily-list integration test proving that at 18:55 Costa Rica time, that day's 19:00 class appears and is eligible under the approved rule. Include midnight boundaries and explicit-selection conflicts. Prove the timezone test catches a deliberately wrong server-local boundary via a temporary mutation, then restore the correct code; do not claim an existing zoned implementation must first fail.

After successful check-in, update the selected row and related progress/history without a full browser reload. Refuse duplicate attendance server-side, including concurrent attempts. Attributed attendance already has a database uniqueness constraint; inspect the weaker UNMATCHED duplicate path if that behavior remains.

Move attendance into a dedicated tab or section with a full, clearly defined count. The query already defaults to 50 records, so add stable pagination/load-more access to older history rather than merely capping it. Do not use the loaded-page length as the full count. Distinguish actual check-ins, signed ledger adjustments, and promotion credits when defining that count. Preserve the portal's existing payments, promotion history, schedule, and account actions.

Browser acceptance: with two classes on the same day, select the later eligible class and confirm that exact class ID is recorded, including a case where automatic matching would prefer another class. Confirm row state updates, duplicate refusal, persistence after reload, and older-history loading. Use a genuine registered/approved development student and test unauthorized/tampered selections.

## Completion report for each PR

Provide the root cause, relevant old-versus-new policy, changed behavior, migration impact where applicable, tests actually run, browser evidence, remaining limitations, and PR link. A green unit suite is not equivalent to successful browser verification. Stop after opening each PR until it is confirmed merged; leave the broad MATROOM visual redesign for its separate approved brief.
