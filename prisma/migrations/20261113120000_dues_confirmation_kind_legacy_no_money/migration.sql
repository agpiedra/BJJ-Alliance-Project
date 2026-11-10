-- Stage 9, PR 9-3 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md, A8 resolution b): the owner's per-row acknowledgement "no money
-- was received for this row" is a readiness confirmation of its own kind. Its own migration: PostgreSQL refuses to use a new
-- enum value in the transaction that adds it, and 20261113120100 uses it in a CHECK.
ALTER TYPE "DuesReadinessConfirmationKind" ADD VALUE 'LEGACY_NO_MONEY';
