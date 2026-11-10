-- Stage 9, PR 9-2: the OPENING obligation type (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md, PR 9-2).
-- Its own migration on purpose: PostgreSQL refuses to USE a new enum value in the transaction that adds it, and the next
-- migration's constraints use 'OPENING'. A single statement: nothing can be left half-applied.
ALTER TYPE "DuesObligationType" ADD VALUE 'OPENING';
