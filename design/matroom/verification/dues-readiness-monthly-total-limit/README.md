# Dues readiness — MONTHLY preview total above one column's limit — verification

**Base:** main `e8da86301b87628446a0bfc4ceaedd83c17c5f7e` (stage 8c merged).

**Defect.** Recorded in `design/matroom/verification/dues-stage8c-actions/README.md`, finding 1.
- **Where:** `evaluate.ts` formatted each branch's per-currency MONTHLY `wouldCreate` total with `minorToDecimal`.
- **Why that breaks:** `minorToDecimal` deliberately accepts at most one column's value, 99,999,999.99.
- **Effect:** individually valid monthly charges whose sum for one branch and currency exceeds that made
  `getDuesReadinessForOwner` throw for the whole organization, roughly 4,000 students at ₡25,000.

**Fix (one call site).**
- The total is now formatted with `totalToDecimal`, the aggregate formatter `evaluate.ts` already uses for opening-draft
  totals (stage 8c). It is exact for any safe integer of minor units and throws on a non-safe or negative sum.
- The now-unused `minorToDecimal` import was dropped. One comment in `tests/unit/dues-ledger-not-exposed.test.ts` that
  named it was corrected; the allow-list itself is unchanged.
- No new dependency or abstraction.

**Unchanged:**
- individual amount validation and the database column limits;
- each student's eligibility, pricing, outcome and amount, and every charge count;
- per-branch and per-currency separation;
- `decimalToMinor` summation in exact minor units;
- opening-draft totals, fingerprints and every readiness check;
- `ready` (false).

No financial writer, schema, migration or activation change.

## Regression (red before green)

New `describe` in `tests/unit/dues-readiness.test.ts`, with three tests. Each individual price is at most 99,999,999.99;
only the sum crosses the limit.

| Test | Main `e8da863` (unfixed) | With the fix |
|---|---|---|
| Branch total exactly **99,999,999.99** (99,999,999.98 + 0.01 USD) | passes (within the column limit) | passes |
| Total **above** the limit to the exact cent: 99,999,999.98 + 0.05 = **100,000,000.03** USD. Other branch separate: CRC 99,999,999.99. Two maximum charges: **199,999,999.98** | **fails**: `RangeError: Minor units must be a whole number from 0 to 9999999999, got 10000000003` | passes |
| Student outcomes and amounts unchanged; checks 10–12 `notImplemented`; `ready` false | **fails** (same RangeError) | passes |

The existing ordinary-totals test, "totals are per branch and per currency, in exact minor units, never summed across
currencies", is unchanged and passes. So is the 8a equivalence test with the real monthly writer.

## Checks (isolated test databases only)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm lint` | 0 errors, 23 warnings (identical to the base) |
| `pnpm check:guard-usage` / `check:pending-callers` | pass |
| `pnpm test:unit` | 131 files, 1939 tests passed |
| `pnpm test:integration` | 169 files, 2250 tests passed (isolated test database) |

## Limitations

- **Overflow rejection is not newly tested.** `totalToDecimal`'s safe-integer rejection is the stage 8c code, unchanged,
  and is reached only by a sum above 2^53 − 1 minor units (about 90 trillion). No test drives it.
- **Formatting only.** The fix changes how a total is formatted, not how it is summed. Summation was already exact and
  is unchanged.
- **Other ledger callers** of `minorToDecimal` (per-row values) are untouched; they format single column values, for
  which the limit is correct.
