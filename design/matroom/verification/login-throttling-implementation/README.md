# Login throttling — implementation evidence

Implements `docs/LOGIN_THROTTLING_PLAN.md` rev 2 (a local plan document). Branch `feat/login-throttling` from `main` @ `49fa1bc`.

**Limits:** 5 per account + IP pair, 20 per account and 50 per IP, over a sliding 15-minute window. These are **provisional initial settings, not production-validated capacity figures.**

**Unchanged:**
- roles and tenant access;
- session duration;
- the session callbacks and PR #134's credentials-version check;
- the password-reset, registration and kiosk limiters;
- middleware;
- the login form and the academy login page.

---

## What changed

| Piece | Where | What |
|---|---|---|
| Table | `prisma/schema.prisma`, migration `20261017220000_login_attempt_throttle` | `LoginAttempt { id, accountDigest, ipDigest?, createdAt }` plus 4 indexes. Additive. HMAC digests only; no foreign key to `User` |
| Limiter | `src/lib/auth/login-throttle.ts` (new) | `reserveLoginAttempt`, `releaseLoginReservation`, `sweepExpiredLoginAttempts`, `authorizeCredentials`, allow-listed logging |
| Enforcement point | `src/auth.ts` | The Credentials `authorize` is now `authorizeCredentials`. Every password check reaches it: login action, academy login (same action), invitation sign-in, and direct `POST /api/auth/callback/credentials` |
| Same-cost check | `src/lib/auth/verify-credentials.ts` | A missing or inactive account runs one bcrypt compare (cost 12) against a fixed dummy hash. `credentialsVersion` is still read in the same query as the password hash |
| Pre-sign-in boundary | `src/app/[locale]/login/actions.ts` | The landing lookups (user, then `landingPathForUser`) get their own `try`. On failure: `invalidCredentials`, no password checked, `login.preauth_lookup_failed { error }`. The `signIn` catch still rethrows everything but `AuthError`, so `NEXT_REDIRECT` and the session cookie are untouched |
| Invitation | `src/app/[locale]/accept-invitation/actions.ts` | Only an `AuthError` from the auto sign-in **after acceptance has committed** now redirects to `/{locale}/login` instead of returning `invalidToken` |

### Behavior
- **Reserve before verifying.**
  - **Reserve:** one short transaction takes advisory locks (account key, then IP key, always in that order), counts pair, account and IP rows in the window, and inserts this attempt's row if all three are under their limits.
  - **Verify:** bcrypt runs afterwards, outside any transaction and lock.
- **A row counts from the moment it exists.** A counted row is any of:
  - an attempt still verifying;
  - a failed verification (wrong password, unknown address or inactive account);
  - a row left behind by an error, or by a failed release after success.

  Rows are not all confirmed wrong passwords.
- **Success removes only its own reservation.** Other in-flight reservations and earlier counted rows stay until they age out, so nothing resets a counter.
- **Recovery:** a key is allowed again once enough of its rows are older than 15 minutes. That is recovery *after the relevant attempts stop*. A sustained attack keeps the account blocked, so it is not a maximum wait.
- **Missing IP:** the pair and IP limits are skipped, and the account limit still applies.
- **Failures:**
  - reservation failure → fail closed (refused);
  - verification failure → refused, and the row stays;
  - release failure after success → login proceeds, and the row stays;
  - sweep failure → logged only.
  - `authorize` never throws. A thrown error would become Auth.js `Configuration` and log its cause, which can include the address.
- **Uniform errors:**
  - login action: `invalidCredentials`;
  - direct endpoint: `302 /login?error=CredentialsSignin&code=credentials`.

  These are the same for unknown, inactive, wrong-password, throttled and failure cases. There is no "too many attempts" message.
- **Logs:**
  - `[login] { event, keyKind }` for throttling;
  - `[login] { event, error }` for failures, where `error` comes from `safeErrorCode()` (a Prisma `P####` code or an allow-listed class name).

  No email, IP, password, digest or error message is logged.

---

## Evidence

### Integration tests (isolated `alliance_bjj_test`)

`tests/integration/login-throttle.test.ts`: **25/25 pass**.

**Real code driven:**
- the direct endpoint, through the real `handlers.POST /api/auth/callback/credentials` with CSRF from the real `handlers.GET /api/auth/csrf`;
- the real `login` and `acceptInvitation` actions, whose real `signIn("credentials")` runs the real `authorize`.

**Replaced:**
- `next/headers`, which supplies the request headers and a cookie jar;
- `auth()` only, for fixture-building actions (staff invite, student approval);
- a passthrough wrapper around `bcryptjs.compare`, which counts calls and holds one deterministically;
- email and notification side effects;
- a Prisma proxy that injects failures on request.

| # | Requirement | Result |
|---|---|---|
| 1a | Action failures throttle the direct endpoint | 5 wrong passwords through the **action**, then the **correct** password through the **endpoint** → uniform failure redirect, no session cookie. The same password from another IP signs in |
| 1b | Endpoint failures throttle the action | 5 wrong through the **endpoint**, then correct through the **action** → `invalidCredentials`, no redirect, no cookie |
| 2 | Academy login uses the same action | The page imports the global `LoginForm` and has no action, `@/auth` import or `signIn` call of its own (structural check, plus the browser run below) |
| 3 | Pair threshold | The 6th attempt from one IP is refused **before bcrypt** (`keyKind: "pair"`); another IP is still checked |
| 4 | Account threshold | 5 failures from each of 4 IPs (20) → the next attempt from a 5th, unsaturated IP is refused as `account` |
| 5 | IP threshold | 5 failures against each of 10 addresses from one IP (50) → an 11th address is refused as `ip` |
| 6 | Missing IP | Only the account limit applies: 20 allowed, the 21st refused |
| 7 | Simultaneous failures | 20 concurrent wrong attempts on one pair → exactly 5 bcrypt compares, exactly 5 rows |
| 8 | **Mixed success/failure (deterministic)** | Starts with 2 rows. A (wrong) reserves and is held in bcrypt (3 rows); B (correct) succeeds and removes only its own row (still 3, A's present); two more fit (5) and the next is refused before bcrypt; A then fails and its row stays (5); the correct password is still refused |
| 9 | No counter reset on success | After 4 failures and a success, 4 are still counted: one more attempt fits, then even the correct password is refused |
| 10 | Expiry | Rows older than 15 minutes stop counting (correct password signs in); rows 14 minutes old still count |
| 11 | Cleanup | One sweep deletes exactly 100 of 120 rows older than 24 h; repeated sweeps remove the rest; rows 23 h old are never touched |
| 12 | Uniform responses | Unknown, inactive, wrong-password and throttled give an identical action result and an identical endpoint redirect |
| 13 | Reservation failure | Fails closed: the correct password is refused with the uniform redirect. Only `{ event: "login.throttle_failed", error: "P1001" }` is logged. The injected error message, which contains the address and IP, appears nowhere, and neither does `Configuration` |
| 14 | Verification failure | Uniform refusal, the row stays counted, only the code is logged |
| 15 | Release failure after success | Login succeeds (session cookie set), the row stays counted, `login.reservation_release_failed` |
| 16 | Log scan | Across refusal paths, console output contains no submitted email, IP, password or key digest |
| 17 | Same-cost branch | Missing and inactive accounts each run exactly one bcrypt compare (structural, not timed) |
| 18 / 18b | Pre-sign-in failures through the real action | A user lookup failure or a landing (membership) query failure → `invalidCredentials`, no bcrypt, no row, only `login.preauth_lookup_failed { error: "P1001" }` logged |
| 19 | Redirects preserved | Staff → `/en/dashboard`, approved student → `/en/portal`, `callbackUrl` → `/en/students`, each with a session cookie |
| 20 | Invalid invitation token | Still `invalidToken`, no session |
| 21 | Invitation sign-in destinations preserved | Owner → `/es/onboarding`, staff invitee → `/es/dashboard`, each with a session cookie |
| 22 | Throttled sign-in after acceptance commits | `NEXT_REDIRECT` to `/es/login`, no session. The invitation is consumed (`usedAt` set) and the chosen password works from an unthrottled IP |
| 23 | PR #134 | A login that recovered after throttling carries the account's current `cv` (3) and id |

**The tests fail when the safeguards are removed.** Each mutation was applied, the file was run, and the source was restored. A SHA-256 check confirmed all four files byte-identical afterwards.

| Mutation | Tests that fail |
|---|---|
| Reservation moved after verification | 3, 4, 5, 6, 7, 8, 9, 14 |
| Throttle removed from `authorize` | 1a, 1b, 3–10, 12–16, 22 (16 tests) |
| Success deletes all of the account's rows | 8, 9 |
| Reservation failure fails open | 13 |
| Dummy compare removed | 3, 17 |
| Pre-sign-in boundary removed | 18, 18b |
| Invitation branch returns `invalidToken` again | 22 |
| Invitation branch catches every error, including `NEXT_REDIRECT` | 21 |

**Existing suites:** see "Full checks" below.

### Real HTTP and browser (local, disposable database `login_throttle_browser_test`, dropped afterwards)

**Setup:**
- `next dev` on port 3100 with email unconfigured.
- The owner was created through the product flow: the real register-academy form in the browser → `scripts/approve-organization.ts` → invitation accepted in the browser.
- The invitation link went through a local redirect helper, so the token was never printed.
- The invitation acceptance auto-signed in and landed on `/en/onboarding`. That success left **0** `LoginAttempt` rows: it released its own reservation.
- The local dev server supplied a client IP: every row had an `ipDigest`, and browser and curl requests shared one.

**Run:**
1. **Global login, browser:** 5 wrong passwords, then the **correct** password.
   - **Result:** "Incorrect email or password.", no session cookie.
   - **Server log:** `[login] { event: 'login.throttled', keyKind: 'pair' }`.
   - **Same text** as for an unknown address.
2. **Direct endpoint, curl** (CSRF token and cookie from `/api/auth/csrf`, then `POST /api/auth/callback/credentials`) with the **correct** password, right after (1).
   - **Result:** `302 /login?error=CredentialsSignin&code=credentials`, no session cookie, `keyKind: 'pair'`.
   - **Shows:** browser login-form failures throttle the direct endpoint.
3. **Recovery:** rows aged by 16 minutes in SQL, standing in for the window passing. The correct password through the endpoint → `302 /en/dashboard` with a session cookie.
4. **Reverse:** 5 wrong passwords through the endpoint (curl), then the **correct** password in the browser.
   - **Academy page** `/en/o/throttle-browser/login`: refused, same message, no cookie.
   - **Global** `/en/login`: refused, same message, no cookie.
5. **Academy login after recovery** (rows aged again): `/en/dashboard` with a session cookie.

**Screenshots (`screenshots/`):**
- `global-login-throttled-correct-password-1280.png`
- `global-login-unknown-address-1280.png`
- `academy-login-throttled-after-endpoint-failures-1280.png`

The recovered academy login (step 5) is recorded by its final URL and session cookie only. Its screenshot was taken mid-render, came out blank, and was discarded rather than kept as evidence.

### Timing (descriptive, local only)

Direct endpoint `POST` through the dev server, 9 samples per case, attempt rows cleared before each unthrottled sample:

| Case | Median | Range |
|---|---|---|
| Active account, wrong password | 0.263 s | 0.257–0.276 |
| Missing address | 0.263 s | 0.255–0.280 |
| Inactive account | 0.259 s | 0.254–0.370 |
| Throttled | 0.029 s | 0.028–0.039 |

**What this shows:** with the same-cost compare, the three unthrottled cases were indistinguishable in this local sample.

**What this does not show:**
- that account enumeration is eliminated;
- deployed latency, or behavior under load or across networks.

**Residuals:**
- **Throttled responses are visibly faster.** This was accepted in the plan: the key comes from the submitted address and IP, so the speed reveals "throttled", not whether an account exists.
- **Landing lookups in the login action:** run only for an address that has an account, before sign-in. **Not measured** (server action), and not claimed to be hidden by network variation.

---

## Full checks (isolated test database)

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | Clean |
| Lint | 0 errors (23 warnings) |
| `check:guard-usage` | OK |
| Unit | 125 files / 1773 tests pass |
| Integration (includes the new file, `session-revocation`, `e2e-auth-bypass-equals-real-login`, `derive-access`, password reset) | 159 files / 2071 tests pass |
| Migration drift (test database vs `schema.prisma`) | Empty diff |

---

## Deviations from the plan

- **One test file instead of two.** `vi.mock` must be declared in each file, and the action and endpoint tests share one harness, so everything lives in `login-throttle.test.ts`. Test numbers differ from the plan table; all planned cases are present.
- **Real `signIn` ran under vitest.** With only `next/headers` replaced, the planned fallback (mocking `signIn`) was not needed. No action test mocks `signIn`.
- **Mutation "throttle in the server action instead of `authorize`"** was run as "throttle removed from `authorize`", which is the property that test 1 guards.
- **The sweep runs on every attempt**, refusals included, after the reservation decision. This is the same shape as the reset limiter.

## Limitations

- **Client IP is best effort until the deployed platform is verified** to replace a client-supplied `x-forwarded-for`. This remains under the existing "deployment verification: trusted client IP" item.
  - **If a client can set the header:** it can rotate its pair and IP keys.
  - **What still holds:** the account limit does not depend on the IP.
  - **Not tested locally:** whether `next dev` passes a client-supplied value through.
- **Deliberate lockout of another person's account** is possible from at least 4 IPs (20 per 15 minutes) and lasts as long as it is sustained. This is accepted, not solved, and visible as `login.throttled { keyKind: "account" }`.
- **Shared IPs:** a busy shared IP (for example, an academy network) can reach the IP limit of 50 counted attempts per 15 minutes. Only attempts that pass the throttle are counted, and successes remove their own rows.
- **Prisma interactive-transaction defaults** (`maxWait` 2 s to obtain a connection, `timeout` 10 s set here) mean extreme concurrency on one key could make some reservations fail. These fail closed. Not observed with 20 concurrent attempts; not load-tested.
- **Bounds:** rows inside the 24-hour retention have no fixed ceiling, the same as `PasswordResetRequest`.
- **A throttled invitee lands on the login page with no specific message.** The invitation is consumed and the password set, so they can sign in once allowed.
- **Not deployed.** The migration was applied only to isolated test databases.
