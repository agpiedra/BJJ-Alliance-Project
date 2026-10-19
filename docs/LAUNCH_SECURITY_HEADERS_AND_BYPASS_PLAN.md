# Launch security: HTTP headers and test-bypass exclusion — plan

Against main `4c898b3`. Read-only inspection; nothing implemented, nothing deployed or probed.
Next 15.5.25, Turbopack build (`package.json`: `"build": "next build --turbopack"`), Auth.js with `trustHost: true`.

**Implemented with review corrections:** `no-referrer` on the reset-password and accept-invitation pages (both locales
and the unprefixed redirect); headers verified on real servers instead of a config-object test; the bypass proven on
the compiled build with a `next dev` negative control. Evidence and limitations:
`design/matroom/verification/security-headers-bypass/README.md`. `/dev/belts` and `/dev/components` unchanged;
production gating for them is a separate follow-up.

Evidence labels: **[source]** read in this repo · **[next-src]** read in installed `node_modules/next` ·
**[unverified]** depends on hosting/deployment, not checked.

---

## 1. Security headers

### Current state

- **Repository sets none.** `next.config.ts` has no `headers()` and no `poweredByHeader` setting; `vercel.json` has only
  `crons`; `src/middleware.ts` returns redirects / next-intl responses without adding headers; no route handler under
  `src/app/api` sets security headers **[source]** (grep for `X-Frame`, `frame-ancestors`, `Content-Security`,
  `Strict-Transport`, `X-Content-Type`, `Referrer-Policy`, `Permissions-Policy`, `headers.set`: no hits).
- **Next adds `X-Powered-By: Next.js`** by default (no `poweredByHeader: false`) **[source + Next default]**.
- **Deployed environment:** headers the host adds (e.g. HSTS on Vercel domains) are **[unverified]**. Nothing here
  was observed on a live response.
- `docs/LAUNCH_CRITICAL_PATH_ASSESSMENT.md:96` already lists this gap; it is consistent with the source.

### Constraints found

| Area | Finding | Effect on headers |
|---|---|---|
| Framing | No `<iframe>`, `postMessage` or `window.parent` in `src` **[source]** | Nothing in-app needs to be framed. Whether an academy embeds the kiosk in a frame/wrapper is **[unverified]**. |
| Clipboard | `navigator.clipboard.writeText` in `admin/locations/location-forms.tsx:61` (kiosk URL) and `admin/staff/staff-forms.tsx:176` (invite link) **[source]** | Permissions-Policy must not restrict `clipboard-write`. |
| Camera/mic/geo | None used **[source]** | Safe to disable. |
| Token URLs | `/reset-password?token=` (`password-reset.ts:66`), `/accept-invitation?token=` (`approve-organization.ts:226`, `staff-service.ts:237`) **[source]** | Referrer-Policy matters: the full URL must not go cross-origin. |
| External origins | Only `https://wa.me` links (`dashboard/whatsapp-link.ts`) in app code; fonts via `next/font` **[source]** | Relevant for a later CSP, not for this baseline. |
| Middleware matcher | Excludes `api`, `_next`, files (`middleware.ts:47`) **[source]** | Set headers in `next.config.ts`, not middleware, so API and static responses are covered too. |

### Proposed baseline (smallest compatible)

In `next.config.ts`: `poweredByHeader: false`, and `headers()` with source `/:path*`:

| Header | Value | Why this value |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | No compatibility cost. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Cross-origin requests get only the origin, so reset/invitation tokens in the query never leave the site. |
| `X-Frame-Options` | `DENY` | Clickjacking on login, staff and kiosk pages. |
| `Content-Security-Policy` | `frame-ancestors 'none'` **only** | Modern equivalent of the line above. Deliberately no `script-src`/`default-src`: that is the separate CSP rollout. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Unused features; clipboard left untouched. |

**Not in this baseline:**
- **HSTS:** **[unverified]** hosting/domain decision (whether the host already sends it, `includeSubDomains` / preload
  across the academy's domain). Recorded as a deployment check, not added to the repo.
- **Full CSP** (`script-src`, nonces for Next's inline scripts, `img-src` for logo storage): separate rollout.
- COOP/CORP: no current need found.

**Decision for review:** if any academy must frame the kiosk, replace `DENY` / `'none'` with an explicit allow-list
for the kiosk path only. Nothing in the repo indicates this.

### File scope

`next.config.ts` (config), one new unit test, one addition to the existing smoke suite (`tests/smoke/…`). Nothing else.

### Acceptance tests

1. **Unit:** import `next.config.ts`, await `headers()`, and assert the exact header set for `/:path*` and
   `poweredByHeader === false`. Fails on current main (no `headers`).
2. **Smoke (CI dev server, already started by the job):** for `/`, `/en/login`, a kiosk page, `/api/health`, and one
   `/_next/static` asset, assert each header is present with the exact value and that `x-powered-by` is absent. Fails on
   current main.
3. Existing smoke and browser suites stay green (login, kiosk keypad, clipboard copy unaffected).

---

## 2. Test-only session bypass

### Entry points

Exactly one: `POST /api/e2e-auth-bypass` (`src/app/api/e2e-auth-bypass/route.ts`) **[source]**. It mints an Auth.js
session cookie for a caller-chosen active user. Callers: `tests/helpers/smoke.ts:46` (smoke suites) and manual
Playwright verification. `src/auth.ts` and `sign-in-jwt-callback.ts` only reference it in comments **[source]**.

Not a session bypass, but noted: `src/app/[locale]/dev/belts` and `dev/components` are unauthenticated pages with
no environment gate, so they ship to production (the rank catalog of `alliance-cr` and a component showcase)
**[source]**. Out of this task's scope; listed for a separate decision.

### Enabling conditions (all must hold; any failure returns the same 404)

1. `process.env.NODE_ENV !== "production"` (`route.ts:37`).
2. `E2E_AUTH_BYPASS_SECRET` set and non-empty (`route.ts:38`).
3. `Host` header hostname is `localhost` or `127.0.0.1` (`route.ts:41-44`).
4. Request `secret` equals it (timing-safe, `route.ts:46-50`).
5. `userId` names an existing active user; an optional `organizationId` must be a real active membership.

### Does a production build reject it even with test env vars set?

**By source, yes, independent of runtime env:**

- `next build` compiles server code with `process.env.NODE_ENV` defined as the literal `'production'` unless built in
  dev mode or with `experimental.allowDevelopmentBuild` (`node_modules/next/dist/build/define-env.js:77`). The
  Turbopack path uses the same `getDefineEnv` (`node_modules/next/dist/build/swc/index.js`) **[next-src]**. This repo
  sets neither **[source]**. So gate 1 becomes `"production" === "production"` in the build output, and a runtime
  `NODE_ENV=test` or a leaked `E2E_AUTH_BYPASS_SECRET` cannot re-enable it.
- At runtime, `next start` keeps a user-provided `NODE_ENV` (`node_modules/next/dist/bin/next:68`), which is why the
  build-time inlining, not the runtime value, is the guard that matters **[next-src]**.

**What would re-enable it:** deploying `next dev` (dev mode), or adding `allowDevelopmentBuild` — combined with a set
secret. Gate 3 is defense in depth only: `Host` is client-controlled and is spoofable on a self-hosted server.

### Existing tests

- `tests/integration/e2e-auth-bypass.test.ts`: inert for `NODE_ENV=production`, missing secret, non-local Host, wrong
  secret, unknown/inactive user; mints a working cookie when every gate passes; org-membership handling **[source]**.
- `tests/integration/e2e-auth-bypass-equals-real-login.test.ts`: the minted session equals real login **[source]**.

### Gaps (missing proof, not a demonstrated defect)

- **G1 — No proof on compiled output.** The integration test changes `process.env.NODE_ENV` at runtime against the
  *source* module; it cannot show what the *built* route does. The inlining claim above is from reading Next's
  source, not observed. CI builds (`parity-check.yml` "Build") with `E2E_AUTH_BYPASS_SECRET` set in job env, but
  nothing then calls the built route.
- **G2 — Inaccurate CI comment.** `parity-check.yml` says the production "`pnpm build`/`pnpm start` pair" is "also
  exercised later in this job"; the job runs `pnpm build` only, never `pnpm start` **[source]**.
- **G3 — Runbook framing.** `DEPLOYMENT_RUNBOOK.md:90-92` says the route's "entire defense rests on [runtime
  NODE_ENV] evaluating correctly". Per the source above, the defense is build-time; the runtime check matters
  only if dev mode is deployed. Clarify, don't weaken.

### Recommended correction (smallest)

No change to the route. Add proof:
- **CI step after "Build":** `pnpm start` on a local port with `NODE_ENV=test` explicitly exported and the job's
  `E2E_AUTH_BYPASS_SECRET` present, then `POST /api/e2e-auth-bypass` with `Host: localhost`, the correct secret and a
  seeded user id. Expect 404 and no `Set-Cookie`. Stop the server. Local CI process only — no live system. It can also
  assert the section 1 headers under `next start`.
- Fix the G2 comment and the G3 runbook wording.

Deleting the route before launch remains a product choice: it would break the smoke and browser suites' session
minting. Not recommended on current evidence.

### Acceptance tests

1. New CI step: 404, no session cookie, against the production build with the secret set and `NODE_ENV=test`.
2. **Negative control (local, once, not committed):** build with `experimental.allowDevelopmentBuild` (or run
   `next dev`) and confirm the same request mints a cookie, proving the step can fail.
3. Existing integration and smoke suites unchanged and green.

---

## 3. Deployment checks (hosting-dependent, not repository facts)

1. On the first deployed response, confirm the section 1 headers are present and that no proxy or CDN strips or
   duplicates them.
2. HSTS: whether the host already sends it; decide max-age / `includeSubDomains` with the domain owner.
3. Production is built with `next build` (Vercel's default) and never served by `next dev`;
   `E2E_AUTH_BYPASS_SECRET` is unset in production and preview environments.
4. Whether to send a `POST /api/e2e-auth-bypass` to the deployed site at all. A POST is a state-changing request,
   not a read-only probe; any live probing is a separate, explicitly approved step outside the implementation PR.
5. Whether any academy frames the kiosk.

## Demonstrated vs unverified

- **Demonstrated from source:** no security headers configured in the repo; `X-Powered-By` emitted; the bypass is
  gated by a build-time-inlined `NODE_ENV` check; G1–G3.
- **Not demonstrated:** compiled-output behavior (G1 is exactly that); any header on a deployed response; HSTS
  status; hosting mode; kiosk framing.

Kept separate and out of scope: historical invitation repair, PostgreSQL compatibility, ledger work, monitoring
expansion, unattributed incidents, and the `/dev/*` pages decision.
