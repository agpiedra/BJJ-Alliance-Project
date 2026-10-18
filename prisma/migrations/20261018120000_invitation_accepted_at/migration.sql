-- docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md: genuine acceptance, recorded by acceptInvitation only.
-- Additive and nullable; no backfill. Rows consumed earlier keep acceptedAt NULL and are never reinterpreted.
ALTER TABLE "Invitation" ADD COLUMN "acceptedAt" TIMESTAMP(3);
