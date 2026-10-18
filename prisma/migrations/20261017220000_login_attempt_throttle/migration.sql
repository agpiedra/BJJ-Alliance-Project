-- docs/LOGIN_THROTTLING_PLAN.md: login throttle. Additive only: a new table and four indexes, no change to any existing
-- table or row. Keys are HMAC digests, never raw emails or IPs.

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "accountDigest" TEXT NOT NULL,
    "ipDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginAttempt_accountDigest_createdAt_idx" ON "LoginAttempt"("accountDigest", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipDigest_createdAt_idx" ON "LoginAttempt"("ipDigest", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_accountDigest_ipDigest_createdAt_idx" ON "LoginAttempt"("accountDigest", "ipDigest", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");
