-- MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b: real per-row color data on
-- BeltRank. Temporary default so the 18 existing rows accept the new NOT
-- NULL columns; prisma/seed.ts immediately overwrites them with real
-- values, and the default is dropped here so the final schema carries none.
ALTER TABLE "BeltRank" ADD COLUMN "isSplit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "splitColor" TEXT,
ADD COLUMN "barColor" TEXT NOT NULL DEFAULT '',
ADD COLUMN "primaryColor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BeltRank" ALTER COLUMN "barColor" DROP DEFAULT;
ALTER TABLE "BeltRank" ALTER COLUMN "primaryColor" DROP DEFAULT;
