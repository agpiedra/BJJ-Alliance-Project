-- MULTI_ACADEMY_AND_KIDS_BELTS.md rev 19: rank labels are per-organization
-- data (labelEs/labelEn), not translation-file keys. Alliance's 5 existing
-- ADULT rows get a temporary default so the column can be added NOT NULL
-- against non-empty data; prisma/seed.ts immediately overwrites them with
-- real values on the next seed run, and the default is dropped in this same
-- migration so the final schema carries no lingering default, matching the
-- Prisma schema's own plain `String` (no @default) declaration.
ALTER TABLE "BeltRank" ADD COLUMN "labelEn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BeltRank" ADD COLUMN "labelEs" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BeltRank" ALTER COLUMN "labelEn" DROP DEFAULT;
ALTER TABLE "BeltRank" ALTER COLUMN "labelEs" DROP DEFAULT;
