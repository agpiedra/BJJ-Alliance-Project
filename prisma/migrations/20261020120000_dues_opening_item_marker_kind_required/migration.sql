-- Stage 8b review fix (PR #147, unmerged). Forward migration: migrations are append-only and
-- 20261019120000_dues_readiness_drafts_and_confirmations is already applied to test databases, so it is not edited.
--
-- The finding: with "withdrawalKind" NULL, both `"withdrawalKind" = '...'` comparisons are UNKNOWN, so the original
-- "DuesOpeningItem_withdrawal_marker_complete" evaluated to NULL for a row with withdrawnAt, withdrawnById and a reason set
-- but no kind. PostgreSQL accepts a CHECK that is NULL, so the malformed row left the one-active index, and the set-once
-- marker trigger then refused any correction.
--
-- The fix: the complete-marker branch requires "withdrawalKind" IS NOT NULL explicitly. Every remaining term is then an
-- IS [NOT] NULL test or a comparison of a non-null value, so the predicate is always TRUE or FALSE, never UNKNOWN. Valid
-- states are unchanged: all-null (active); EDITED with a successor; WITHDRAWN with a reason and no successor. The shared
-- dues_set_once_marker trigger is not touched. Drop and add run in one ALTER TABLE, so the table is never unconstrained;
-- ADD validates existing rows (none are written before stage 8c).
ALTER TABLE "DuesOpeningItem"
  DROP CONSTRAINT "DuesOpeningItem_withdrawal_marker_complete",
  ADD CONSTRAINT "DuesOpeningItem_withdrawal_marker_complete" CHECK (
    ("withdrawnAt" IS NULL AND "withdrawnById" IS NULL AND "withdrawalKind" IS NULL AND "withdrawalReason" IS NULL AND "supersededById" IS NULL)
    OR ("withdrawnAt" IS NOT NULL AND "withdrawnById" IS NOT NULL AND "withdrawalKind" IS NOT NULL AND (
         ("withdrawalKind" = 'EDITED' AND "supersededById" IS NOT NULL)
         OR ("withdrawalKind" = 'WITHDRAWN' AND "supersededById" IS NULL AND "withdrawalReason" IS NOT NULL)
       ))
  );
