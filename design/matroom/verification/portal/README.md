# Student portal redesign: verification

The portal page phase (approved preview direction P1-P4, T1; the kiosk is a separate PR). Everything below was run in a real Chrome browser against a development server, **as genuinely registered users**, not seeded accounts.

## How the fixtures were made

- Two organizations were registered at `/register-academy`, approved as platform super-admin (`scripts/approve-organization.ts`), and their owners accepted the invitation and set a password: **`verify-portal-default`** (the stored default colours, gold and near-black, untouched) and **`verify-portal-tenant`** (brand `#c2410c`, sidebar `#123b4a`, saved in Branding).
- One student per organization signed up through the public student form (`/o/<slug>/signup`) and was approved by the owner in the roster. The screenshots are taken after a real student login (`/o/<slug>/login`).
- Data the product flow does not create by itself was added straight to the development database: today's classes (two open right now with overlapping windows, one later, one closed that does not count toward promotion), a weekly schedule, 46 attendance rows (class check-ins, an unmatched tap, staff days), one promotion, and the accounting mode. The default organization ran **Per-interval**; the tenant organization was switched to **Cumulative** (43 / 60 against 30 / 30), so both accounting modes are shown. For the time-based screenshots the same student was temporarily set to a black belt with a last-award date, then restored.
- The fixture rows were removed afterwards.

## What ran

| Check | Result |
|---|---|
| Screenshots | 52 in the run (kept here: 16 selected, JPEG): Home on phone 390, tablet 768 and desktop 1280; Attendance and Schedule views; account menu; keyboard focus; the black-belt state; light and dark; default and tenant; English and Spanish |
| Rendered-page audit | 4,170 rendered elements measured (text contrast on the colour actually painted behind it, control boundaries, empty controls): **0 findings** |
| Horizontal overflow, console errors | none on any of the 52 loads |
| Keyboard, pointer, responsive layout | `tests/browser/portal.test.ts` (CI): widths 360 / 390 / 768 / 1280, two columns from 1024, compact class rows and progress reachable on the first phone screen, check-in buttons >= 48px and tabs / menu >= 44px under a coarse pointer, arrow-key tabs, Tab into the panel, hash and back button, "View full history" focus, theme switch |
| Component behaviour | `tests/unit/portal-tabs.test.tsx`, `portal-cards.test.tsx`, `todays-classes-card.test.tsx` (English and Spanish; both accounting modes' numbers; time-based ranks show no attendance-decides-eligibility wording) |

## What changed and what did not

- **Preserved:** every existing feature and rule: who can reach the portal, the check-in window and explicit per-class check-in, both accounting modes, promotion display through the shared `buildProgressView`, payment status, promotion history, the weekly schedule, staff link and sign-out, history pagination and its focus handling (the history section is unchanged and stays mounted while another view is shown, so what it has loaded is kept).
- **Tenant colours (T1):** unchanged. The banner, the action colour and the progress colour near completion come from the stored colours through `BrandingScope` exactly as before; the check-in button keeps the default variant it always had. Changing new-organization defaults is separate.
- **Navigation:** Home / Attendance / Schedule are accessible tabs (WAI-ARIA tabs pattern) mirrored in the URL hash. They are tabs, not anchors, because they are separate views; every view is rendered on the server and stays mounted.
- **Progress card:** an attendance count line ("N attendances counted toward your next promotion") is shown only where an attendance target exists (attendance and hybrid ranks). A time-based degree shows its due date (or that the date is needed) and the lifetime total, and the check-in result no longer says attendance counts toward it.
- **Compact class rows:** name / time / type / "Open now" on two lines and the action on the right, about 70px per class instead of about 190px per open class on a phone.
- **Small differences from the preview:** the Attendance view shows the progress card beside the history but not the promotion history (which stays on Home); rows keep the app's own timestamp format instead of the preview's date block.

## Not tested

Real devices (the coarse-pointer runs are emulation in desktop Chrome), OS text scaling, a screen reader, and production data.
