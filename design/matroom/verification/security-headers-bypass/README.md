# Security-header baseline and production-build bypass proof — verification

Plan: `docs/LAUNCH_SECURITY_HEADERS_AND_BYPASS_PLAN.md`. Base: main `4c898b3`. The bypass route
(`src/app/api/e2e-auth-bypass/route.ts`) is unchanged. `/dev/belts` and `/dev/components` are unchanged (production
gating for them is a separate follow-up).

Evidence labels: **observed** = seen on a locally running server built from this branch · **source** = read in code ·
**unverified** = deployment/hosting, not checked.

## Changes

- `next.config.ts`: `poweredByHeader: false`; `headers()` adds, on `/:path*`:
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `X-Frame-Options: DENY`;
  - `Content-Security-Policy: frame-ancestors 'none'` (this directive only);
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
  
  A later rule sets `Referrer-Policy: no-referrer` on `/:locale(es|en)/:page(reset-password|accept-invitation)` and the
  unprefixed `/:page(reset-password|accept-invitation)`. Clipboard is not restricted. No HSTS, no full CSP.
- `scripts/verify-production-build.ts` (`pnpm verify:production-build`) plus a CI step after "Build".
- CI comment and `docs/DEPLOYMENT_RUNBOOK.md` corrected (see below).

**What `no-referrer` does and does not do.** It stops the browser sending these pages' URLs (which carry the reset or
invitation token in the query) as a `Referer` to any other request, same-origin or cross-origin. It does **not** remove
the token from the original request URL, browser history, or any hosting, proxy or access logs that record request
URLs.

## How it was verified

`pnpm verify:production-build`, after `pnpm build` (locally run with `DATABASE_URL` pointed at the guarded test
database). It:

1. creates one active synthetic user in the isolated test database (deleted in `finally`; 0 left afterwards, checked
   with `psql`);
2. starts `next start` on :3101 with `NODE_ENV=test` and a random synthetic `E2E_AUTH_BYPASS_SECRET`;
3. POSTs the bypass with that user, the correct secret and a `localhost` Host, and requires **404 and no
   `authjs.session-token` cookie**;
4. checks headers (below), then stops the server;
5. starts `next dev` on :3102 with the **same env** and sends the **same request**, requiring **200 and a session
   cookie** — the negative control, so a missing user, wrong secret or wrong URL cannot pass step 3;
6. checks the same headers on the dev server.

Startup waits are bounded (60 s / 180 s), every request has a timeout, and servers are killed as a process tree in
`finally` (no listeners left on :3101/:3102 after every run, checked with `netstat`). Secrets and cookies are never
printed. Server stderr is shown only on failure, with the secret redacted. A scan of all run logs found neither the
secret pattern nor a cookie.

**Header cases**, each checked for every baseline header with its exact value and for the absence of
`x-powered-by`. Redirects are not followed.

| Path | Kind | Status | Referrer-Policy |
|---|---|---|---|
| `/en/login` | page | 200 | strict-origin-when-cross-origin |
| `/` | locale redirect | 307 | strict-origin-when-cross-origin |
| `/en/dashboard` (no session) | auth redirect | 307 | strict-origin-when-cross-origin |
| `/en/kiosk/no-such-academy-synthetic` | kiosk tree | 404 | strict-origin-when-cross-origin |
| `/api/health` | API | 200 | strict-origin-when-cross-origin |
| `/api/e2e-auth-bypass` (production) | API | 404 | strict-origin-when-cross-origin |
| `/icon-192.png` | public static file | 200 | strict-origin-when-cross-origin |
| `/_next/static/…js` (taken from the login HTML) | build asset | 200 | strict-origin-when-cross-origin |
| `/{es,en}/reset-password?token=…`, `/{es,en}/accept-invitation?token=…` | token pages | 200 | **no-referrer** |
| `/reset-password?token=…`, `/accept-invitation?token=…` | token redirects | 307 | **no-referrer** |

**Precedence observed:** on the token paths the value is exactly `no-referrer`, not a merged value, on both
`next start` and `next dev`. The later rule overrides the general one, as the config comment states.

## Results (local, Windows, Next 15.5.25, Turbopack build)

| Run | Build | Result |
|---|---|---|
| A — this branch | `pnpm build` | **194 ok, 0 fail**: production bypass 404 with no cookie; dev control 200 with cookie; every header case passes on both servers |
| B — `next.config.ts` from main (headers mutation) | `pnpm build` | **147 fail**: every security-header check (null), and `x-powered-by` present on pages; the bypass checks still pass. The header checks detect missing headers |
| C3 — route with the `NODE_ENV` line removed (guard mutation) | `pnpm build` | **production bypass: status 200, session cookie set: FAIL**. The production check detects an enabled bypass, so its 404 comes from the guard, not from a fixture or secret problem |
| C2 — route reads `NODE_ENV` through an alias (`const runtimeEnv = process.env`) | `pnpm build` | production still 404, all pass (see "Not established") |
| C — `experimental.allowDevelopmentBuild` | `NODE_ENV=development pnpm build` | not usable as a control: `next start` refuses to run it under `NODE_ENV=test` ("requires NODE_ENV to be explicitly set to 'development'"), and the script reports "server exited early" |

The mutations were local and temporary: `next.config.ts` and `route.ts` were restored byte-identical (sha256 checked)
and are not part of this PR.

## What is source expectation, what is observed, what is unverified

- **Source:** `next build` defines `process.env.NODE_ENV` as `"production"` for server code
  (`node_modules/next/dist/build/define-env.js:77`, also used by the Turbopack path). The router server assigns
  `NODE_ENV` at runtime only when it is unset (`server/lib/router-server.js:101-104`), so under `NODE_ENV=test` the
  runtime value stays `test`.
- **Observed:** a production build served by `next start` with `NODE_ENV=test` and the bypass secret set rejects the
  bypass (404, no cookie), while the same request on `next dev` mints a session. All baseline headers are present with
  exact values on pages, API routes, middleware redirects, public files and build assets, under both servers.
- **Unverified (deployment):** what the hosted environment serves; whether a proxy or CDN adds, strips or duplicates
  these headers; HSTS; that production is built with `next build` and never served with `next dev`; that
  `E2E_AUTH_BYPASS_SECRET` is unset in production and preview. No live system was probed. A POST to a deployed bypass
  would be a state-changing request, not a read-only check, and is out of scope for this PR.

## Not established

- **C2:** the aliased read also produced 404. The compiled output was not inspected, so whether Turbopack replaced the
  aliased access at build time or something else applied is not established. C3 shows the 404 depends on the guard
  line.
- `next dev` writes into `.next`, so the build is not intact after the script. In CI it runs right after "Build"; the
  only later steps (parity check, snapshot upload) do not use `.next`.

## Checks

`tsc --noEmit` clean · lint clean · `check:guard-usage` OK · unit and integration suites (results in the PR). The smoke
and browser suites need the seeded dev-role database and a dev server, so they were not run locally; they run in CI
unchanged.
