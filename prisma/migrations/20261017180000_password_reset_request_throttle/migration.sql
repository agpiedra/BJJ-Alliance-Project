-- docs/PASSWORD_RECOVERY_PLAN.md §2.4: password-reset request throttle. Additive only: a new table and two indexes,
-- no change to any existing table or row. Keys are HMAC digests, never raw emails or IPs.

-- CreateTable
CREATE TABLE "PasswordResetRequest" (
    "id" TEXT NOT NULL,
    "keyKind" TEXT NOT NULL,
    "keyDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordResetRequest_keyKind_keyDigest_createdAt_idx" ON "PasswordResetRequest"("keyKind", "keyDigest", "createdAt");

-- CreateIndex
CREATE INDEX "PasswordResetRequest_createdAt_idx" ON "PasswordResetRequest"("createdAt");
