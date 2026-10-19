# Platform Approve / New organization — email-outcome feedback — verification

## What changed

Both flows run through the same `approveOrganization()`, which already classifies the owner's invitation email
(`EmailSendOutcome`) and reports what settlement found (`InvitationSettlement`). Before this change:

| Flow | Action result | UI |
|---|---|---|
| Approve (pending queue) | already `{ ok, invitationEmail, invitationSettlement }` | **discarded**. The row only showed errors, and an approved organization leaves the queue, so the row unmounted on refresh |
| New organization | `{ ok: true }` — the outcome was **dropped** | redirected to the list with no word on the email |

After this change:

- **Shared module.** `src/lib/organizations/invitation-feedback.ts` is a pure module (types-only imports):
  - `invitationReportOf(result)` — the approve action's existing mapping, moved verbatim and now shared by both
    actions;
  - `invitationFeedbackCopy(report)` — chooses message keys and whether the result needs attention;
  - `invitationReportQuery` / `parseInvitationReport` / `createdOrganizationNotice` — carry the report across the New
    organization redirect, accepting fixed values only.

  **Nothing is classified anew.**
- **`createOrganizationManually`** also returns `organizationId` and the report beside `ok`.
- **The notice.** `InvitationFeedbackNotice` states the operation first ("X was approved / created"), then the email
  outcome, then what settlement found, and links to the organization's page (where **Resend invitation** lives). **It
  never shows an invitation link.**
- **Approve.** A page-level `ApprovalFeedbackProvider` keeps the latest approval's notice after its row leaves the queue.
- **New organization.** Same redirect target (`/platform/organizations`), plus `?created=…&invitationEmail=…&invitationSettlement=…`.
  The list shows the notice only for an organization it actually lists; anything outside the fixed values is dropped.

**Unchanged:** authorization, the approval/creation transactions, the invitation lifecycle, the manual-link exposure
rules (the panel shows no link), every existing action, the resend button and its copy, and the existing error
displays. There is no new resend workflow.

### Copy (EN/ES, `platform.organizations.invitationFeedback`)

A first invitation has no earlier links, so — unlike the resend copy — nothing mentions them.

- **Provider acceptance** is stated as acceptance, never delivery.
- **Rejected / not configured:** the platform withdraws that first link (existing policy), so the copy says the owner
  has no working invitation, that **the organization is saved — do not approve or create it again**, and to use
  "Resend invitation".
- **Unknown:** "still open when checked after sending".
- **Unavailable:** no cause is claimed.
- **Settle failure:** "not known whether its link works".

None of these promise a working link.

## Reachability and evidence

| State | Approve | New organization | Evidence |
|---|---|---|---|
| accepted + settled | reachable | reachable | **rendered** (A, E) · integration · unit |
| rejected + settled (link withdrawn) | reachable | reachable | **rendered** (B; F in ES) · integration · unit |
| not_configured + settled (link withdrawn) | reachable | reachable | **tested only** (integration + unit). Rendering needs a server restart without a key |
| unknown + settled | reachable | reachable | **rendered** (C, ES) · integration · unit |
| accepted meanwhile | reachable | reachable (unlikely) | **rendered** (D: the owner accepted the emailed link while the email was held) · integration · unit |
| unavailable | reachable | reachable | **rendered** (G: the invitation revoked by a labelled DB fixture while the email was held) · integration (both flows) · unit |
| settle failed | reachable | reachable | **tested only** (integration: injected transaction failure; unit) |
| notIssued / legacyUnresolved | not reachable from the pending queue or a new organization (no earlier invitations exist) | not reachable | **tested only** (mapping + notice, unit) |

## Tests

### `tests/integration/platform-org-email-feedback.test.ts` — 14 tests, all new

These run through the real `approveOrganizationAction` and `createOrganizationManually` on the isolated test database,
with the email helper mocked per classified outcome.

- **Approve:**
  - each of accepted / rejected / not_configured / unknown → `{ ok, invitationEmail, invitationSettlement: "settled" }`,
    the organization ACTIVE with its academy and owner membership, and the first link withdrawn only for rejected /
    not_configured;
  - `unavailable` (held email, revoked meanwhile);
  - `acceptedMeanwhile` (held email, real `acceptInvitation`);
  - `failed` (injected settle failure — still approved, the invitation untouched);
  - failure handling intact: not approvable → error; unknown id → notFound; non-super-admin → notFound, untouched,
    nothing sent.
- **New organization:**
  - each outcome → `{ ok, organizationId, invitationEmail, invitationSettlement }`, ACTIVE with 18 ranks and 1 academy;
  - `unavailable`;
  - failure handling intact: invalid form and taken slug create nothing and carry no email report; non-super-admin →
    notFound, nothing sent.

### `tests/unit/platform-org-email-feedback.test.tsx` — 28 tests, all new

- the mapping;
- the copy for every state;
- the fixed-value query round trip and dropping of unknown values;
- the notice only for a listed organization;
- EN/ES key parity;
- the notice text and styling for 9 states × EN/ES (no link, no delivery claim);
- the failed-send copy pointing to "Resend invitation";
- the pending notice surviving its row's removal, and an action error shown exactly as before;
- the New organization redirect target plus report, and a refused creation staying on the form with no redirect.

### Fails before, passes after

With main's versions of the 6 changed source files put back, keeping the new module and copy, then restored (sha256
checked):

- **5 integration failures:** New organization returned only `{ ok: true }`.
- **3 unit failures:** no provider (the outcome was discarded), and the redirect carried no report.

The Approve integration tests **pass on main**: that action already returned the report. Its gap was the UI, shown by
P3 below.

### Targeted mutations — each applied alone, then restored (sha256 checked; tree unchanged after the run)

| # | Mutation | Caught by |
|---|---|---|
| P1 | New organization drops the report | 5 integration |
| P2 | redirect drops the report | redirect test |
| P3 | pending approval not lifted to the page | survives-row-removal |
| P4 | rejected / not_configured: no "withdrawn" sentence | 6 (copy, notice EN/ES, pending) |
| P5 | missing outcome treated as accepted | copy |
| P6 | URL values not allowlisted | query round trip |
| P7 | notice shown for an unlisted id | listed-only |
| P8 | unavailable styled as neutral | 3 |
| P9 | Approve drops the report | 7 integration |
| P10 | already-accepted mapped to accepted | mapping |
| P11 | settle failure stated as nothing | 3 |

## Rendered check — real browser, real dev server, **local fake provider (mocked)**

- **Database:** disposable `platform_feedback_browser_test` on the test Postgres, migrated, **dropped afterwards**.
- **Server:** `next dev` on port 3100 with `RESEND_BASE_URL` pointing at the fake provider. Stopped afterwards; ports
  confirmed free.
- **Provider:** a local fake (accepted / 422 with free text / dropped socket / held). It serves captured links only as
  local redirects and never prints bodies. **No real email.**
- **Fixtures:**
  - The super-admin was inserted directly (no UI path exists).
  - The four pending organizations were **registered through the public registration form**. The owner in D accepted
    the **real emailed link** in a separate browser context.
  - New organizations were created through the platform form.
  - G's invitation was revoked by a direct DB update while its email was held (labelled fixture).

| Screenshot | Scenario | Provider | DB afterwards |
|---|---|---|---|
| `01-en-approve-accepted` | Approve | accepted | ACTIVE, invitation live |
| `02-en-approve-rejected-withdrawn` | Approve; the queue empties — the notice stays | 422 | ACTIVE, invitation revoked |
| `03-es-approve-unknown` | Approve, Spanish page | socket dropped | ACTIVE, invitation live |
| `04-en-approve-accepted-meanwhile` | Approve; email held; owner accepted; released | held → accepted | ACTIVE, invitation accepted |
| `05-en-create-accepted` | New organization → redirected to the list | accepted | ACTIVE, invitation live |
| `06-es-create-rejected-withdrawn` | New organization, Spanish page | 422 | ACTIVE, invitation revoked |
| `07-en-create-unavailable` | New organization; email held; revoked (fixture); released | held → unknown | ACTIVE, invitation revoked |
| `08-en-create-slug-taken-unchanged` | taken slug | — | stays on the form, **no redirect, no email** (existing behavior) |

Each notice was asserted against the exact EN/ES message text, and none contained an invitation link. A forged URL
naming an unknown organization rendered **no** notice (scenario I).

**Log scan (final run).**

- **Fake provider log:** 0 matches for its free text, `example.test` or `token=`.
- **Dev-server log:** 0 matches for the provider's free text, `example.test`, `[Resend API Error]`, `RESEND_API_KEY`
  or the fake key.
- **`token=`:** 2 matches, both `next dev`'s own request lines for the accept page in scenario D. That is pre-existing
  framework logging.
- **Application lines:** only the sanitized `[approve-organization] …` / `[register-academy] … outcome` lines from PRs
  #138/#139.

**Incident during the first browser run (recorded, not app code).** The first run wrote its screenshots into this
repo folder. The dev server's watcher recompiled, and a request during that recompile got Next.js's own dev-mode error
*"Invariant: Expected clientReferenceManifest to be defined. This is a bug in Next.js."* (HTTP 500 on the registration
page), so the run stopped after scenario C. The final run wrote screenshots outside the repo and copied them in
afterwards, from a fresh database. That run had 0 invariant errors and 0 HTTP 500s.

## Checks (isolated test database only)

`tsc --noEmit` clean · eslint clean on changed files · `check:guard-usage` OK · unit **1846/1846** (1818 + 28 new) ·
integration **2162/2162** (2148 + 14 new).

## Limitations

- **Snapshot.** The notice reports the result at the moment of approval or creation; it does not track later changes.
  On the list page it comes from the URL, so reloading that URL repeats the same snapshot.
- **Crafted URLs.** The list page's notice can be produced by a crafted URL, but only for an organization the list
  shows, only with fixed values, and only for a platform super-admin who can open the page.
- **Out of scope, unchanged:**
  - if `approveOrganization` itself throws after New organization committed (a database error, not an email outcome),
    the existing error path applies;
  - the pending row's existing error display shows the raw error key.
- **No real provider.** Provider acceptance is never verified as delivery.
- **Tracked separately, not touched:** the remaining raw-exception logging, the historical invitation repair, the
  launch-verification items, and the two unattributed test failures tracked separately (including the password-reset
  cleanup sweep failure recorded in PR #140).
