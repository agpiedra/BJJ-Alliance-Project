# Session revocation on password reset — implementation evidence

Owner decision (2026-10-17): a successful password reset invalidates every existing session for that user. The reset does not sign the user in; a fresh login is required. Design: `docs/PASSWORD_RECOVERY_PLAN.md` §2.9 (credentials version), a local plan document. Branch `feat/session-revocation` from `main` @ `8ba798d`.

**Unchanged:** roles, tenant access rules, session duration (Auth.js default: 30 days idle, renewed on use), login throttling (none exists; separate work), middleware routing.

---

## How it works

| Piece | Where | What |
|---|---|---|
| Version column | `prisma/schema.prisma`, migration `20261017200000_user_credentials_version` | `User.credentialsVersion Int @default(0)`. Additive; PostgreSQL 11+ adds a constant-default column without rewriting the table |
| Increment | `src/lib/auth/password-reset.ts` (redemption transaction) | `credentialsVersion: { increment: 1 }` in the **same** `UPDATE` as the new password hash, inside the existing User-locked transaction. Both commit together or neither does |
| Capture at sign-in | `src/lib/auth/verify-credentials.ts` | The version is selected in the **same query** as the password hash that is verified, and returned with the verified user |
| Claim | `src/lib/auth/sign-in-jwt-callback.ts` | At sign-in, `token.cv` = the captured version, never re-read from the database. A sign-in without a captured version is refused |
| Enforcement | `src/lib/auth/session-credentials.ts`, called first in `signInJwtCallback` on every non-sign-in call | Reads `{ active, credentialsVersion }` by primary key. Returns no session if the user is missing, inactive, has a different version, or the read fails |
| Legacy tokens | `tokenCredentialsVersion` | A token without `cv` counts as 0, so existing sessions survive deployment until that user's first reset |
| e2e bypass | `src/app/api/e2e-auth-bypass/route.ts` | Passes the version like `authorize` does; refuses if the callback returns no token |

**Why not `iat`:** Auth.js re-encodes the JWT on every session refresh with a new `iat`, `exp` and `jti` (`@auth/core` `jwt.js` `encode`). Custom claims such as `cv` are carried through unchanged.

**Why the version is captured with the password:** if `cv` were read separately after the password check, a reset committing in between would hand an old-password login the new version. Reading both in one statement means the old password always travels with the old version.

### Node-side inventory: where revocation is enforced

Every server-side session read in this app goes through `auth` (or `handlers` / `unstable_update`) from `src/auth.ts`, whose `jwt` callback is `signInJwtCallback`, so the check runs before any of these see a session:

| Importer of `@/auth` | Use |
|---|---|
| `src/lib/tenant/context.ts` | `getTenantContext` / `resolveActionContext`, the gate for every staff and portal page and action |
| `src/lib/auth/require-super-admin.ts` | Every `/platform` page and platform action |
| `src/app/[locale]/(staff)/layout.tsx` | Staff shell |
| `src/app/[locale]/select-organization/page.tsx`, `actions.ts` | Organization selection and `unstable_update` |
| `src/app/[locale]/accept-invitation/page.tsx`, `actions.ts` | Invitation flow |
| `src/app/[locale]/login/actions.ts`, `src/lib/auth/sign-out-actions.ts`, `platform/sign-out-action.ts` | Sign-in and sign-out |
| `src/app/[locale]/no-access/page.tsx`, `no-organization-access/page.tsx` | Access-state pages |
| `src/app/api/access/refresh/route.ts` | Access-claim refresh (redirects to login without a session) |
| `src/app/api/auth/[...nextauth]/route.ts` | Auth.js handlers, including `/api/auth/session` |

- No source file decodes the session JWT itself. `next-auth/jwt` is imported only for types and, in the e2e bypass, to `encode`.
- The kiosk uses its own token, not sessions.
- The Edge middleware (`src/middleware.ts`) **is not an enforcement point**. It cannot reach the database, keeps refreshing a revoked cookie, and routes on the access claim, which can refuse but never grant. A revoked request therefore passes middleware, and is then refused by the first server-side `auth()`.

---

## Evidence

### Automated (isolated test database `alliance_bjj_test`)

`tests/integration/session-revocation.test.ts`: 12/12 pass. It uses the real entry points:
- **Node session read:** the real `/api/auth/[...nextauth]` `GET` handler.
- **Middleware refresh:** the real `src/middleware.ts` default export.
- **Sign-in:** `verifyCredentials` plus the shared callback and `encode`, as `authorize` and the bypass do.
- **Mocked:** only `next-intl`'s locale middleware (it cannot load under vitest; it is replaced by a pass-through, and the `auth(...)` wrapper that refreshes the cookie is real) and, in one case, a failing database read.

| # | Requirement | Result |
|---|---|---|
| 1 | Existing sessions stop after a reset | A session works before, and returns no session after (version 0 → 1); Auth.js also clears the cookie in that response |
| 2 | Middleware refresh cannot revive | The middleware re-encodes the revoked cookie (new `iat`/`jti`, `cv` still 0); the Node read of the refreshed cookie returns no session |
| 3 | Organization/session updates cannot revive | An update on a stale token returns `null`, even with `{ cv: 1, credentialsVersion: 1 }` in the payload. A current session's update keeps its claim (payload `cv: 99` ignored) in both the Node and the Edge callback |
| 4 | Fresh login works; old password fails | The old password is refused. The new password signs in with `cv = 1`, survives a middleware refresh and reads back |
| 5 | Concurrent sign-in/reset | Lock-gated: with the reset blocked on the user lock, the old password verifies with version 0; the reset then commits (version 1); a token issued afterwards carries `cv = 0` and is refused. After the commit the old password cannot sign in |
| 6 | Failed and rolled-back resets do not revoke | An unknown token, and a reset rolled back by an injected failure on the password write, leave the version at 0 and the session valid |
| 7 | Legacy tokens without the claim | Valid while the version is 0 (including after a middleware refresh); refused after the user's first reset |
| — | No access on missing data or failures | Inactive user → refused. Missing user → refused. Database failure during the check → refused, logged as `{ event: "session.credentials_check_failed", error: "P1001" }` with no message text. Sign-in without a captured version → refused |
| — | Login reachable | Middleware passes `/en/login` with a revoked cookie (status < 300, no redirect) |

**The tests fail when the safeguards are removed** (each change reverted afterwards; files restored byte-identical):

| Mutation | Failing tests |
|---|---|
| Enforcement check disabled | 8 of 12 |
| Version re-read from the database at sign-in instead of the captured one | (5) the concurrent sign-in/reset test |
| Increment removed from the reset transaction | 6 of 12 |

**Existing tests:**
- `e2e-auth-bypass-equals-real-login.test.ts`: its "real login" helper now supplies the version exactly as `authorize` does, and the compared claims now include `cv`. 3/3.
- `derive-access.test.ts`: its sign-in calls now pass `credentialsVersion: 0`, the stored value for those never-reset users, because a sign-in without a captured version is refused. 11/11.
- `password-reset*.test.ts` and `platform-admin.test.ts`: unchanged, and pass.
- Full suites on the isolated test database: integration 158 files / 2046 tests, unit 125 files / 1773 tests, all passing. Typecheck clean; lint 0 errors.

### Real browser (local, disposable database `session_revocation_browser_test`, dropped afterwards)

**Setup:** `next dev` on port 3100 with email unconfigured. The owner was created through the product flow: register academy → approved with `scripts/approve-organization.ts` → invitation accepted. Invitation and reset links went through a local redirect helper, so raw tokens were not printed.

**Run:**
1. **Context A** (signed in by accepting the invitation, password P1) and **context B** (a separate browser context, signed in with P1) both reach the protected `/en/onboarding`.
2. **Reset in a third, signed-out context C:** "Your password has been reset. You can now sign in." That context has **no session cookie** afterwards, and a protected page sends it to `/en/login`. The reset did not sign it in.
3. **After the reset:** contexts A and B both land on `/en/login` (HTTP 200, login form rendered) when opening `/en/onboarding` and `/en/dashboard`. There is no redirect loop.
4. **Login afterwards:** P1 stays on `/en/login`; P2 signs in and reaches `/en/onboarding`.

**Screenshots (`screenshots/`):**
- `reset-success-not-signed-in-1280.png`: the reset confirmation.
- `session-a-after-reset-1280.png`: context A sent to the login page.
- `old-password-refused-1280.png`: the old password refused.

### Query overhead

| Measurement | Result |
|---|---|
| Statements for one protected page load (`/en/onboarding`, signed in), statement logging on the disposable database | **7 statements, of which 1** is the new check: `SELECT id, active, credentialsVersion FROM "User" WHERE id = $1 LIMIT 1`. React's per-request `cache` collapses the layout's and page's `auth()` calls into this one read |
| `EXPLAIN (ANALYZE, BUFFERS)` of the check | `Index Scan using "User_pkey"`, about 0.05 ms, 4 shared buffer hits (7-row table) |

**What this does not show:**
- Production latency. The real cost is one extra round trip to the database per server-side request, at the deployed network distance.
- Server actions and route handlers outside a React render. There, `cache` does not memoize, so each `auth()` call performs its own read.

---

## Limitations

- **A revoked cookie is not cleared on page navigations.** Server components cannot set cookies. Auth.js clears it when `/api/auth/session` is called, and it is overwritten by the next sign-in. Until then it is inert: refused by every server-side check.
- **The middleware still treats a revoked cookie as a session for routing.** The page then sends the request to login. No protected data is served.
- **Deactivating a user now also ends their sessions** at the next server-side check (`active` is part of the check). Today no product flow deactivates an active user.
- **Version 0 is shared by every user who has never reset.** A legacy token without `cv` stays valid until that user's first reset, as specified.
- **Not deployed;** nothing here verifies production behavior or latency.
- **Migration** applied only to isolated test databases.
