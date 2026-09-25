# BJJ Alliance project: code and defect-brief analysis

Reviewed September 22, 2026. Repository: `C:/Users/iGaming/Desktop/BJJ Project/BJJ Alliance Project`. HEAD at inspection: `e3d2929`.

This was a read-only source review. No project files, databases, branches, permissions, or PRs were changed. The supplied defect brief was analyzed as reference material, not executed. Tests were inspected but not run; browser behavior, live database values, and Supabase bucket configuration remain unverified. Existing `.review-shots/` was untracked before this review.

## Main conclusion

The brief identifies real problems, but mixes existing defects with proposed changes to product policy and assumptions that no longer match the repository. Correct it before implementation. In particular, PR 2 changes the progression model, not just four numeric thresholds. PR 3 changes existing kiosk fallback behavior as well as adding a better portal.

The stack already supports the redesign: Next.js 15.5.25, React 19.1, Tailwind 4, Base UI/shadcn components, next-intl, Prisma 7, Luxon, Recharts, and Vitest. There is no reason to replace the stack.

## 1. Logo upload

### Confirmed defects

- `src/app/[locale]/(staff)/admin/branding/page.tsx` admits ADMIN and DIRECTOR and renders the uploader for both.
- `src/app/[locale]/(staff)/admin/branding/actions.ts:159` restricts upload to ADMIN. A genuine DIRECTOR role mismatch throws `FORBIDDEN` through the tenant access helper. This is separate from an inline validation error; a browser run is needed to identify which path produced the screenshot.
- Empty upload returns `error: "invalid"` plus `fieldErrors.logo = ["required"]`. `src/components/branding/logo-uploader.tsx` does not display that field error. `messages/en.json` has no `branding.logo.error.invalid`, so it displays the generic fallback.
- Choosing a new file clears client validation state but does not clear `uploadState.error`. Consequently a prior server error can remain visible after selecting a valid replacement. Both empty-submit handling and stale-error handling need attention; a screenshot alone cannot distinguish which occurred.
- `src/lib/branding/logo-storage.ts` throws for non-successful storage responses; the upload action does not translate storage failures into actionable results. Missing credentials, missing bucket, authorization failures, and network errors are not distinguished for the user.

### Limits are already consistent

- Client precheck imports `MAX_LOGO_BYTES`.
- Server validator imports the same constant: `512 * 1024` bytes.
- Next's request-body cap is `2mb`, intentionally larger to accommodate the file plus multipart overhead.

These limits serve different purposes and should not be made identical. The shared 512 KiB constant is the application upload limit; the request-body limit is a transport cap.

The validator downsizes images exceeding 1024 pixels instead of rejecting them merely for that dimension. It rejects aspect ratios greater than 5:1. The brief's “dimensions rejected” case should explicitly target the actual aspect-ratio rule.

The local `.env` contains nonempty entries for SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_LOGO_BUCKET. Their values were not printed. Presence does not prove validity, connectivity, a public bucket, or correct access. The code uses the configured bucket or defaults to `org-branding`; bucket existence was not queried.

### Test evidence

`tests/integration/branding-actions.test.ts` mocks storage and authentication. It explicitly expects a DIRECTOR upload to throw FORBIDDEN. A test titled “a director can remove a logo” actually creates an ADMIN. The suite therefore both misses live storage failures and preserves the role mismatch described in the new brief.

Add rendered uploader tests for empty input, stale errors, and field-error mapping; role tests that instantiate the named role; adapter tests for storage failure classification; and a real browser upload/reload check against the development bucket.

## 2. Progression

### Existing numbers are correct for the old model

`src/lib/organizations/default-belt-ranks.ts` already seeds 30/65/75/85 attendances per stripe, four stripes, and one additional equal interval for exam eligibility. Runtime evaluation reads organization-owned BeltRank records, so seed values do not prove current database values.

`src/lib/promotion/engine.ts:105` computes the next stripe target as `(currentStripes + 1) * interval`. `src/lib/students/attendance-summary.ts` sums promotion-relevant attendance since `beltAwardedAt` plus promotion credits. It does not use lifetime attendance as the progression numerator.

Thus White / 1 stripe / 20 of 60 is consistent with the current cumulative model. For a newly entered student already holding one stripe, it is inconsistent with the proposed “one fresh interval after entry or promotion” policy. A three-stripe white belt with zero recorded attendance currently targets 120, absent promotion credits; the proposed policy would target 30.

Manual stripe awards preserve the belt attendance anchor. Belt awards reset `beltAwardedAt`; the separate time anchor supports time-based progression. There is no equivalent stored attendance-count snapshot for each new stripe in this path.

### This is a policy and migration change

The main specification explicitly states that attendance remains cumulative through stripe awards. It also already defines per-organization BeltRank and PromotionConfig models and editing behavior. Do not introduce a competing hardcoded runtime rule table or describe organization configuration as a future feature that does not exist.

Keep one authoritative engine and one authoritative runtime configuration path. A migration must cover initial rank entry, stripe and belt awards, rank corrections, track changes, promotion credits, and concurrent attendance/promotion operations. A default catalog alone is not the runtime source of truth.

Specify what happens to attendance accumulated while a student waits for an instructor to approve a promotion. Resetting at the actual award discards that surplus for the next interval; cumulative carryover does not. Also specify how existing students with uncertain promotion dates are backfilled. Do not fabricate historical attendance to make totals look correct.

### Other confirmed gaps

- The portal uses “remaining to next stripe” whenever remainingAttendance is non-null, including before exam eligibility. Both the main portal and check-in success display need target-specific wording.
- Black is seeded as terminal with zero stripes and null attendance thresholds. The current engine returns NONE; it does not implement a degree every ten years. Treat that interval as the requested academy policy, not an externally verified universal rule. Adding it requires a usable degree representation, time-based evaluation for the relevant rank, and an established initial time anchor.
- `ProgressToNextGrade` does not sanitize non-finite displayed values. The normal terminal-black portal path omits the bar, but that is not a general NaN safeguard. Existing kiosk render tests already cover terminal ranks without NaN; extend coverage to portal states and the new degree model.
- Check-in itself records attendance and notifies eligibility; it does not award a stripe. However, `src/lib/promotion/automation.ts` can award stripes when `requiresCoachApproval` is false. Alliance seeding and new-organization defaults set it true. Current live settings were not checked. If the new policy means “never auto-promote,” address the cron and configuration path, not just check-in.
- Kids ranks seed 10 attendances per degree and 10 additional for the next belt in both `prisma/seed.ts` and `src/lib/organizations/seed-defaults.ts`. The existing spec explicitly calls for those values. That establishes their repository provenance, not their correctness for Anny's academy. Obtain confirmation rather than assuming they were guessed or replacing them with adult rules.

### Test implications

Existing promotion-engine tests intentionally validate cumulative thresholds, including the 149/150 attendance boundary at four white stripes. They are testing the old policy correctly. New acceptance tests should cover imported starting ranks with no history, each award resetting the agreed anchor, credits/corrections, exam wording, and black-degree rendering. Revise conflicting old expectations rather than adding contradictory tests.

## 3. Portal check-in and history

`src/app/[locale]/portal/self-check-in-action.ts` already calls `performCheckIn`, the shared kiosk core. The shared core is not itself the same authenticated server action used by both channels; retain distinct authentication boundaries while sharing domain logic.

Current behavior in `src/lib/kiosk/perform-check-in.ts:198`:

1. If a class matches the window, choose the nearest start, then earlier start, then stable ID.
2. If no class matches but the academy has classes that day, return `no_active_class` and a class picklist.
3. The portal action returns only the error and discards the picklist. Its form has no class-selection input.
4. If no classes exist that day, save an UNMATCHED attendance. Such rows are excluded from promotion progress but still contribute to the physical-attendance ledger.

The submit button is disabled only while pending. Therefore it cannot reflect class availability before the request.

An important implementation trap: `pickedClassSessionId` is currently considered only in the no-active-occurrence branch. Adding a class ID to the portal form alone would not guarantee that the explicitly selected class wins when another class is active. Fix selection precedence in the shared core and validate the selected class's organization, academy, date, active state, and applicable check-in policy server-side.

The current automatic window is **30 minutes before through 30 minutes after the class START**, inclusive. It intentionally ignores duration. Existing kiosk fallback allows a manual selection outside that automatic window. The brief's proposed closed rows and “after it ends” wording therefore imply a policy change. Explicitly settle how the strict portal availability and kiosk fallback should coexist before claiming they follow one eligibility rule.

Core date calculations already use Luxon with `America/Costa_Rica`. `vitest.config.ts` already sets `TZ=Pacific/Kiritimati`, and check-in-window tests cover evening and midnight behavior. The new daily list still needs its own timezone regression and mutation check. One presentation helper, `shortWeekdayLabel`, formats a Date with Intl without an explicit timeZone; it should be included in the calendar-label audit.

`src/lib/students/attendance-history.ts` already uses a default limit of 50 and the portal does not override it. The issue is a long visible list and lack of access to older entries, not an unbounded query. Add tabs and pagination with stable ordering, preserving payments, promotion history, and schedule features currently below the attendance list. The tab count should come from the intended full count, not the length of the loaded page; distinguish ledger entries from summed attendance credits/adjustments.

Attributed duplicate check-ins use a database uniqueness constraint. UNMATCHED duplicates use an application precheck with a documented race. If unmatched behavior remains, include concurrent retry coverage rather than claiming every duplicate path is equally protected.

## Design and installed capabilities

The narrow student page is directly explained by `max-w-md` on its main container and `max-w-[220px]` on progress. Change responsive composition and information order, not merely colors.

`docs/REDESIGN_BRIEF.md` already marks a previous redesign implemented and calls `design/alliance-mock.html` the visual source of truth. A new redesign brief should explicitly supersede its visual direction where they conflict while preserving unrelated behavior and tenant branding. Otherwise an agent may correctly follow the old document and recreate the style the owner wants to replace.

Local Claude skill files exist for `design-taste-frontend` and `impeccable`. The installed-plugin registry lists `ui-ux-pro-max`, Impeccable, frontend-design, and other plugins. User skills also include web-design-guidelines and webapp-testing. Installation evidence does not prove every plugin is enabled or connected in a particular Claude session.

Recommended division: one skill leads visual direction, UI UX Pro Max supports component/accessibility choices, Impeccable handles audit and refinement, and browser testing verifies actual flows. Do not invoke unrelated plugins merely to use everything installed.

## Recommended next brief

Keep three defect PRs, correcting their scope: (1) upload permissions, validation state, and storage failure handling; (2) an explicit change from cumulative to promotion-anchored progression, including configuration and migration reconciliation; (3) explicit class selection and agreed availability policy plus paginated portal history. Then perform the visual redesign against settled behaviors.

Amend the prompt to acknowledge existing configuration, history limits, timezone tests, kiosk fallback, and old policy tests. Do not merge or implement solely from the original diagnosis. Real browser evidence remains essential for final acceptance.
