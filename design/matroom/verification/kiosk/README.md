# Kiosk redesign: verification

Approved direction: K1 landscape two-column kiosk, K2 offline indicator, in-flow sync banner and digit-count status; any timeout indicator follows the actual timeout; T1 tenant colours preserved. Portrait keeps one column.

## How the screenshots were made

- **Real server flows** (no `MOCKED` in the name): two organizations created through the product flow (register, platform approval script, invitation acceptance, tenant colours saved in Branding for one; a student signed up at `/o/<slug>/signup` and approved by the owner). The kiosk was driven with the organization's real kiosk token and the student's real 4-digit code against the running dev server. Not a seeded account.
  Data the product flow does not create by itself (today's classes, two open with overlapping windows, attendance rows) was added to the development database, and removed afterwards.
- **MOCKED** (`default-MOCKED-*`): the threshold-visitor result, the time-based and attendance success screens (see the correction below) and the org-unavailable / server-JSON-error screens are `route.fulfill` responses in the browser, because the real flow cannot produce them without changing data policy. They show layout only.
- **Touch is emulation.** Coarse-pointer runs are desktop Chrome with `hasTouch`, not a real tablet. Viewports are emulated sizes (1024x768 landscape, 768x1024 portrait, 390x844 phone). Not tested: a real tablet, OS text scaling, a screen reader.
- The round "N" badge in the corner of each shot is the Next.js dev-server indicator, not part of the page.

## What ran

| Check | Result |
|---|---|
| Real-server captures | 47 per organization (default colours, tenant colours), landscape and portrait, light and dark, English and Spanish: entry, two-class picker, success, invalid-code refusal, plus the flows below |
| Flows | one class auto-matched, two open (picker), correction ("Not this class?") with result, second attempt same day, no open class, invalid token, real lockout (5 failures, countdown), offline indicator, offline save and replay, sync warning |
| Rendered-page audit | about 650 elements measured per organization (text contrast on the colour actually painted behind it): **0 failures**; no vertical scroll and no horizontal overflow on any capture |
| Console | only the expected `400`/`403` responses the real API returns for refusals; nothing else |
| Offline replay | a tap made offline while two classes were open replayed as before: no attendance counted, one staff-review row (`SEVERAL_CLASSES_OPEN`, `PENDING`); the queue, event ids and replay logic are unchanged |
| Rendered-browser tests | `tests/browser/touch-targets.test.ts` (CI), mouse and coarse pointer at phone, tablet portrait and tablet landscape: key sizes, large keys stay large, picker rows and Cancel / "Not this class?" keep their minimums, multi-line text (long class names) fits its control, layout placement and no scroll, digit-count status, timeout bar duration, offline chip |
| Component tests | `tests/unit/kiosk-redesign.test.tsx` (fake timers): the timeout bar's duration equals the timeout actually armed and is cleared with it, digit-count status, sync banner in flow, headings, English and Spanish |

## Dimensions

| | Before | After |
|---|---|---|
| Keys, tablet landscape | 112 x 112 | 132 x 108 |
| Keys, tablet portrait | 112 x 112 | 156 x 124 |
| Keys, phone | 80 x 80 | 80 x 80 |
| Picker row | >= 44 | >= 104 |
| Cancel, "Not this class?" | auto / 44 | >= 60 |

PR #62's rule is kept: the shared 44px touch target is a minimum, and the kiosk passes `pointer-coarse:` twins for its larger minimums (tailwind-merge lets them replace the shared one).

## Preserved

Class windows and explicit selection before saving, one counted attendance per day and promotion resets, both accounting modes and time-based degree wording, corrections, cancellation, lockout and rate limiting, the offline queue (persistence, event ids, replay, staff-review evidence), authentication and privacy boundaries, tenant branding, English and Spanish. The state machine and every request are unchanged; the timeout indicator reads the same timer that resets the screen (hidden on the entry screen and under reduced motion).

## Noted, not changed

- The Spanish copy mixes tú and vos forms (as before).

## Correction after review: the success view's progress area

The first version of this PR kept the old fallback that showed the bare attendance count (for example "12") under the belt for any rank without an attendance target. That number is unexplained, and the count does not decide a time-based degree. Now:

- The fraction and progress bar appear **only when an attendance target exists** (attendance and hybrid ranks).
- **time_pending**: "Your next degree is based on time. See your student portal for the details." (new key `kiosk.timePendingSeePortal`). No due date: the kiosk is not given one and the API is unchanged.
- **time_anchor_missing** and **not_configured**: the portal's existing wording (`portal.progress.timeAnchorMissing`, `notConfigured`).
- **eligible** (time-based): "Eligible for instructor review" is kept, without a count or bar.
- A terminal belt or a manual rank (no next target) also shows no bare number; it had the same unexplained count (a small extension of the request, one line to revert).
- Kept: the check-in confirmation heading, belt, saved class and "Not this class?".

Screenshots `MOCKED-time-*` and `MOCKED-attendance-progress-*` are **mocked check-in replies** (`route.fulfill`) on the real kiosk page of the seeded academy `escazu`, in a desktop Chrome with touch emulation; the layout is real, the student and numbers are not. They replace the earlier `default-MOCKED-time-based-degree` screenshot, which showed the bare "12". Tests: `tests/unit/kiosk-redesign.test.tsx` (EN and ES: time_pending, time_anchor_missing, not_configured, eligible time-based, attendance in progress, attendance eligible, hybrid), `tests/unit/kiosk-success-view.test.tsx`, and the rendered-browser test in `tests/browser/touch-targets.test.ts` (both pointers, three viewports: no bar, no bare number, no fraction, context fits, correction control kept, no scroll).
