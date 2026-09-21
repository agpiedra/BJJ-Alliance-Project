-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CRC', 'USD');

-- AlterTable: every existing organization prices in colones (the UI hardcoded
-- "₡" until now), so CRC is the correct value for all of them.
ALTER TABLE "Organization" ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'CRC';

-- AlterTable: PaymentPeriod.currency is a SNAPSHOT with deliberately NO default
-- (a code path that forgets to set it must fail to compile, not silently write
-- colones for a dollar academy). Prisma's generated `ADD COLUMN ... NOT NULL`
-- cannot run on a table that already has rows, so it is added nullable,
-- backfilled from each row's own organization, and only then made NOT NULL —
-- leaving no default behind.
ALTER TABLE "PaymentPeriod" ADD COLUMN     "currency" "Currency";

UPDATE "PaymentPeriod" AS p
SET "currency" = o."currency"
FROM "Organization" AS o
WHERE o."id" = p."organizationId";

ALTER TABLE "PaymentPeriod" ALTER COLUMN "currency" SET NOT NULL;

-- AlterTable
ALTER TABLE "PaymentPlan" ADD COLUMN     "defaultAmount" DECIMAL(10,2);
