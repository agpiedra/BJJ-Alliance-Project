-- Move the kiosk rate-limit / lockout key from the client-spoofable
-- `ipAddress` to the server-verified kiosk token digest.
--
-- Additive and append-only: the existing `ipAddress` column is KEPT (it stays
-- as best-effort audit metadata), only the lookup index changes. Existing rows
-- predate the new key, so they get an empty-string placeholder via a temporary
-- column default which is then dropped, keeping the column NOT NULL without
-- requiring a backfill query.

-- AlterTable
ALTER TABLE "KioskAttempt" ADD COLUMN "kioskTokenHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "KioskAttempt" ALTER COLUMN "kioskTokenHash" DROP DEFAULT;

-- DropIndex
-- `ipAddress` is no longer part of any lookup, so it is dropped from the index
-- rather than left as a leading no-op column.
DROP INDEX "KioskAttempt_academyId_ipAddress_createdAt_idx";

-- CreateIndex
CREATE INDEX "KioskAttempt_academyId_kioskTokenHash_createdAt_idx" ON "KioskAttempt"("academyId", "kioskTokenHash", "createdAt");
