-- docs/PASSWORD_RECOVERY_PLAN.md §2.9 — session revocation on password reset. Additive: every existing user starts at
-- version 0, which is also how a session token without the claim is read, so no existing session ends because of this
-- migration. On PostgreSQL 11+ a constant default makes this a metadata-only change (no table rewrite).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "credentialsVersion" INTEGER NOT NULL DEFAULT 0;
