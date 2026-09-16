-- MULTI_ACADEMY_AND_KIDS_BELTS.md revision 21: split belts are a centre
-- stripe, not two halves. Replaces isSplit + splitColor with a single
-- nullable centerStripeColor that says what it draws. prisma/seed.ts
-- reseeds all 13 kids ranks with the corrected column immediately after.
ALTER TABLE "BeltRank" DROP COLUMN "isSplit",
DROP COLUMN "splitColor",
ADD COLUMN "centerStripeColor" TEXT;
