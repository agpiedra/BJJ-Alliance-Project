# Phase 1 preview (frozen)

The visual preview the owner approved on 2026-09-24 for identity, tokens, typography, navigation pattern and controls. Open `index.html` (offline; `fonts/` holds copies of the app's font files, plus Archivo for the "today vs proposed" heading specimen on page 1, since Archivo was retired from the app in the same PR).

**Only the palette, tokens, typography and control states were approved.** The page layouts here (portal, dashboard, phone navigation) are illustrative and were explicitly not approved: see `../DESIGN.md` section 7 for what each page phase must fix. All names, counts, classes, dates and the "Harbor Jiu-Jitsu" tenant are invented; progress values come from the app's real `getAtBeltSummary` and `buildProgressView` on throwaway data.

`tokens.css` here is the preview's own generated copy (scoped to `[data-theme]`). The app's tokens are `../tokens.css`; where they differ, `../tokens.css` wins. `contrast-report.md` is the audit of these pages on rendered surfaces (1,792 measurements, 0 below threshold).
