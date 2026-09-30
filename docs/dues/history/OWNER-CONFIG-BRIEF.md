# Implementation brief: owner configuration for student dues (PR 3)

Status: **brief only, nothing implemented.** Written 2026-09-26 from main `c22dcd1` (PR 1 library and PR 2A configuration tables are merged). Ledger PR 2B is not started.

## 1. Scope

Let an **owner** save, per branch, the dues configuration the merged tables hold, by **extending the existing Manage Plans page and its branch cards**:

| Setting | Table | Versioned by |
|---|---|---|
| plan price (for the whole offer), currency, **plan duration** (months covered) | `PaymentPlanTerms` | effective month, per plan |
| **due day**, **grace day** (next-month day, inclusive), **late fee** amount and currency, **prepayment limit** (nullable) | `DuesPolicyVersion` | effective month, per branch |

**Not in this PR:** selling, renewing or assigning anything (no student picker, no `StudentPlanAssignment` writer), any ledger table, any job, exchange rates, activation, seeds, prices, or any change to legacy billing.

## 2. Verified starting point

- Manage Plans is `/payments/plans` (`page.tsx`, `plan-forms.tsx`, `src/lib/payments/plan-actions.ts`): one card per branch; create, edit, deactivate, reactivate; plans are never deleted. Both the page and the actions currently allow **`ADMIN` and `DIRECTOR`** (a director within their own branches).
- Each action calls `resolveActionContext(organizationId, [roles])`, re-reads the plan by id **scoped to the organization**, checks `isAcademyInTenantScope`, writes in a transaction, and writes an `AuditLog` row with before and after snapshots. A role mismatch returns `{ error: "notFound" }`.
- **Money input today is not exact:** `parseDefaultAmount` uses `Number(raw)` and `Math.round(amount * 100) / 100`. That is floating-point and **silently rounds** (`"1.005"` is accepted and stored). It must **not** be reused for prices or fees. Its behaviour is legacy and out of scope to change here.
- Branch-level owner-only precedent: `/admin/locations` uses `requireTenantContext(["ADMIN"])`.
- The legacy plan picker `listSelectablePlans` returns **every active plan of a branch** and `recordPayment` records one calendar month against the chosen plan.
- The PR 1 library (`src/lib/dues`) already computes due dates, grace deadlines and effective prices, and can drive previews.

## 3. Screens (per branch card on `/payments/plans`)

1. **Plans** (existing list) gains a **Terms** section per plan: the current terms, scheduled future terms, the history, and an **Add terms** form: effective month, price, currency, months covered (1 = the ordinary monthly plan, more = a package).
2. **Dues settings** (new card per branch): current and scheduled versions and an **Add version** form: effective month, due day, grace day, late fee and its currency, prepayment limit (blank = not entered).
3. Both sections show **"Saved here. Billing still follows the current rules until the new billing is switched on."** Nothing on the screen implies activation.
4. **Previews from the PR 1 library:** the due date and grace deadline for a sample month, and the effective price per month. **Students assigned to this plan: N** is read from `StudentPlanAssignment`; it is **0** until an assignment PR exists, and says so.
5. `defaultAmount` and the organization-currency form are **untouched**; `defaultAmount` keeps its legacy meaning (a suggested amount for the current payments screen), labelled as such.
6. English and Spanish, both themes, tenant colours; money and day inputs are `type="text"` with `inputMode="decimal"` or `numeric` (not `type="number"`, whose value is a browser-locale float).

## 4. Server-side authorization

- New actions (in `src/lib/dues/`) each begin with **`resolveActionContext(organizationId, ["ADMIN"])`**: a required role list, no omission form, matching the guard rules. A director, an instructor or a non-member gets `{ error: "notFound" }` and nothing is written.
- **Owners only for every write in this PR** (prices and policy values that affect money). Directors keep today's access to plan name, description and active flag, **unchanged**. **The new sections are not rendered for directors** until D5 says otherwise (fail closed).
- The page keeps `["ADMIN", "DIRECTOR"]` for the existing content and adds an owner-only check for the new sections.

## 5. Tenant and branch validation (never trust submitted ids)

- Every write re-reads the plan or branch by id **scoped to `context.organizationId`**; a foreign or unknown id is `notFound`. `isAcademyInTenantScope` is applied to the plan's branch or the submitted branch.
- The composite foreign keys added in PR 2A are the backstop, and the tenant guard already rejects unscoped queries on these three models.
- The **plan's terms stay in one currency** (a rule the database cannot enforce): adding terms whose currency differs from the plan's existing terms is refused ("create a new plan to price in another currency"). The **fee currency must equal the currency of every plan in that branch** (the calculation library prices tuition and fee in one currency); saving either side that would break this is refused with a message.
- **Effective month:** a real year and month, and **not before the current month in the branch's own timezone** (`Academy.timezone`). A version for a month that already has one is refused (the database also rejects it).

## 6. Exact monetary and numeric input

- Amounts are parsed **as strings, with no floating point and no rounding**: price `^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$` and greater than zero; fee the same and zero allowed. More than two decimals, an exponent, a sign, spaces, thousands separators and a comma decimal are **rejected with a message, never rounded**. The validated string goes to Prisma as a `Decimal`.
- Integers (`dueDay`, `graceDay` 1 to 31; `monthsCovered`, `maxPrepaidMonths` at least 1) are parsed as digit strings and range-checked. A sanity ceiling on months (for example 120) is a typo guard, not a business rule, and is adjustable.
- The range matches `Decimal(10,2)` (up to 99,999,999.99) by digit count, so no value can overflow the column.
- A table-driven unit test covers each accepted and rejected shape, including `"1.005"`, `"0.1"`, `"10."`, `".5"`, `"1e2"`, `"1,5"`, `" 5"`, `"-1"`, `"99999999.99"`, `"100000000.00"`.

## 6b. Preserving existing versions

- The new actions **only insert**. They never update or delete a row that has taken effect, and there is no edit or delete endpoint for a version.
- The tables are append-only **by convention only** (no trigger); the actions and the tests are what keep it so. A test asserts that after adding a version every earlier row is byte-identical and the row count grew by exactly one.
- Every insert writes an `AuditLog` row (the log is written, never read back by code).
- Correcting a mistake in a **not-yet-effective** version is decision D25 below.

## 7. Configuring a package is not selling or renewing one

Configuring a package means saving `PaymentPlanTerms` with `monthsCovered` greater than 1. **Selling, assigning and renewing** need obligations, coverage, payments and an explicit purchase action, which belong to later PRs (2B onward). This PR has **no student picker, no purchase button, no renewal, no assignment writer and no automatic anything**. A saved package is inert data.

**One legacy interaction needs your approval (engineering, section 9):** a package plan is a `PaymentPlan` row, and the legacy picker lists every active plan, so a package would appear in the current payment form and could be chosen for a one-month legacy payment.

## 8. Saving while legacy billing stays unchanged

- **What reads the new tables (corrected 2026-09-26; the earlier text said "nothing reads the three tables", which was inaccurate):**
  1. **Configuration reads:** the owner's Manage Plans sections list and edit terms and policy versions, and the owner actions read them to validate (one currency per branch, one duration kind per plan, one version per month, the revision token).
  2. **The approved legacy package guards**, which ask only "does this plan have multi-month terms": `listSelectablePlans`, `recordPayment` (a package plan id is `invalidPlan` and nothing is written), the two plan lookups inside `markPaymentPaid`, the "last active plan" rule and the director-visibility rule in `plan-actions`, and `listPlansForManagement`.
  Nothing else reads them: `isOverdue`, `getCurrentPaymentPeriod`, the payments page, the portal, the roster, the dashboard and the digest are not modified, and no obligation, coverage, payment or assignment is created.
- **Existing monthly plans, recorded payments and overdue calculations keep their behaviour.** Saving future monthly terms on an existing monthly plan does not remove it from the legacy picker; only a plan with multi-month terms is excluded, and a plan is monthly or a package for its whole life (a package is created by its own action, as a plan plus its first terms in one transaction).
- **Tests prove it:** with terms and policy versions saved, `listSelectablePlans`, `isOverdue` and a legacy `recordPayment` on an ordinary plan behave exactly as before, package plans are refused on every legacy path, and the existing payment and plan integration suites pass unchanged.
- No feature flag is needed for the configuration itself; activation remains a later, explicit, last step.

## 9. Decisions

### Blocking the settings

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D24** | **What an unset prepayment limit allows once prepayment is introduced.** The screen saves blank as "not entered", but the helper text and later validation depend on this. | (a) **prepayment unavailable until an owner enters that branch's limit**; (b) **no limit until one is entered** | **APPROVED (2026-09-26): (a).** Once prepayment is introduced it is unavailable until the owner explicitly enters the branch's prepayment limit. Blank means not configured (stored as NULL). **No Alliance limit is invented** and no default is applied to any behaviour. |
| **D25** | **Correcting a wrong version before it takes effect.** A version cannot be edited by convention, and a second version for the same month is refused. | (a) **none**: a typo in a scheduled price stands; (b) the owner may **replace a version whose effective month is still in the future**, as an audited update with before and after, never one that has taken effect | **APPROVED with safeguards (2026-09-26): (b),** owners only. Effective and past versions stay immutable. **Correction of the earlier rationale:** the brief claimed nothing can depend on a not-yet-effective version. That is wrong for the design as a whole: a future prepayment can depend on a future version. It holds for this PR only because no financial writer exists yet. Safeguards: owners may correct a version whose effective month is still in the future in that branch's timezone; the change and its before/after audit are saved atomically; stale edits are detected (a revision token compared inside the transaction) so concurrent owners cannot silently overwrite each other; current and past versions remain immutable. **Before any financial writer ships (ledger PR 2B onward), versions referenced by a sold, assigned or prepaid obligation must be protected from correction, and paid prices and coverage must remain frozen.** |

### Engineering approval (not owner policy)

| Choice | Options | Recommendation |
|---|---|---|
| **Legacy picker vs multi-month plans** | (1) leave the legacy picker unchanged, so a package can appear in the old payment form; (2) exclude, in `listSelectablePlans` only, plans whose terms include `monthsCovered` greater than 1 | **(2).** It changes legacy reads only for new package plans; every existing plan and every existing payment behave as before. It reads the new table from one legacy function, so it needs your approval. |

### Not blocking, handled without inventing a default

- **Who else may edit (D5):** owners only now; directors see nothing new.
- **Effective month:** the current month is allowed (no obligations exist), later months freely.
- **Students affected preview:** shows 0 until assignments exist.
- Rounding, quotes, refunds, returning students and coverage release are not touched.

## 10. Tests and PR shape

- **Unit:** the money and integer parsers (table above); the effective-month rule in the branch timezone; preview arithmetic through the PR 1 library.
- **Real-database integration:** owner accepted; director, instructor and non-member refused with nothing written; foreign organization's plan or branch refused; branch scope; audit rows; insert-only (earlier rows unchanged, count +1); duplicate month refused; mixed currency refused; exact-money rejections stored nothing; legacy behaviour unchanged.
- **Rendered-browser check as a genuinely registered owner** (register, platform approval, invitation, no seeded account), English and Spanish, both themes, default and tenant colours; keyboard and labels; mocked data clearly distinguished from real.
- Mutation-check the decision points (role list, tenant scope, money parser, effective-month floor, insert-only).
- One focused PR; no schema change, no migration, no seed, no job; CI normal, no retriggering.

## 11. Order after this brief

PR 3 (this) then PR 2B (ledger schema, still needing its own approvals) then the ledger core and the rest per `PROPOSAL.md`. Subscription billing, onboarding and contact-email changes remain deferred.
