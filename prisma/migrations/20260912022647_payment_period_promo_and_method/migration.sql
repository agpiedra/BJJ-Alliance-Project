-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('SINPE', 'TRANSFERENCIA', 'EFECTIVO', 'TARJETA');

-- AlterTable
ALTER TABLE "PaymentPeriod" ADD COLUMN     "method" "PaymentMethod",
ADD COLUMN     "promoName" TEXT,
ADD COLUMN     "promoReason" TEXT,
ADD COLUMN     "promoRecurring" BOOLEAN NOT NULL DEFAULT false;
