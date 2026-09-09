-- Separate "this attempt happened" (audit) from "this attempt counts toward the
-- lockout anchor" (security).
--
-- `success: false` was doing both jobs, and it is too coarse for the second
-- one: `already_checked_in` and `no_active_class` are VALID-code outcomes, and
-- a gate-rejected attempt never had its code evaluated at all. Because
-- `evaluateRateLimit` re-derives its 5th-failure anchor from whatever is in the
-- trailing window, any of those could extend an academy-wide lockout
-- indefinitely — five late arrivals, five double-taps, or a scripted flood of
-- requests the gate itself was already refusing.
--
-- Additive and append-only: no existing column or index is touched. The default
-- is TRUE so the provisional row claimed BEFORE a code is evaluated still caps
-- concurrent reservations at five; `finalizeKioskAttempt` clears it for the
-- non-guess outcomes. Existing rows inherit TRUE, which is the conservative
-- direction (it can only tighten the limiter, never loosen it) and in any case
-- ages out of the 60-second window immediately.

-- AlterTable
ALTER TABLE "KioskAttempt" ADD COLUMN "countsAsFailure" BOOLEAN NOT NULL DEFAULT true;
