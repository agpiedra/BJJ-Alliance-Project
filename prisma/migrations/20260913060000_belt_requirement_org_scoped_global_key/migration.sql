-- MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 1 (1c) bug fix.
--
-- The `init` migration's "BeltRequirement_belt_global_key" partial unique
-- index — `ON "belt" WHERE "academyId" IS NULL` — predates multi-tenancy: it
-- enforced "at most one global-default BeltRequirement row per belt" back
-- when there was only ever one implicit organization. The 1b constrain
-- migration added `organizationId` and `@@unique([organizationId, academyId,
-- belt])`, but that plain unique constraint does NOT close the gap on its
-- own — Postgres never treats two NULLs as equal, so two rows with the same
-- (organizationId, belt) and academyId = NULL would NOT violate it. The old
-- global partial index was never re-scoped to include organizationId, so it
-- was silently still enforcing the WRONG, pre-multi-tenant invariant:
-- blocking two different organizations from each having their own
-- global-default requirement for the same belt.
DROP INDEX "BeltRequirement_belt_global_key";

CREATE UNIQUE INDEX "BeltRequirement_organizationId_belt_global_key" ON "BeltRequirement"("organizationId", "belt") WHERE "academyId" IS NULL;
