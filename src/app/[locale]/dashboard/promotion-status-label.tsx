"use client";

import { useTranslations } from "next-intl";
import type { PromotionCandidate } from "@/lib/students/promotion-queue";

/**
 * Maps a `PromotionCandidate.status` to its `dashboard.promotionQueue.status.*`
 * message key. Typed as `Record<PromotionCandidate["status"], string>` — NOT
 * an `as "stripe-eligible" | "exam-eligible"` cast — so TypeScript requires a
 * real entry for every value the type can actually take. This is the exact
 * site of a real shipped bug (Phase 4 Task 4 fix round 1): a wrong namespace
 * prefix here rendered a raw dotted path
 * ("dashboard.status.stripe-eligible") as visible UI text instead of "Stripe
 * eligible", in both locales, undetected by every automated check until a
 * reviewer manually exercised the real translator. A future added
 * `EligibilityStatus` value now fails to compile here instead of silently
 * resolving to `undefined` at runtime.
 *
 * `approaching` is included even though this component's only caller
 * (`page.tsx`'s promotion-queue table) never actually renders it —
 * `listPromotionQueue` filters "approaching" candidates out before this
 * component ever sees one, and the separate Approaching section renders no
 * status column at all. A real, correct message is cheaper and safer than a
 * type-level exclusion that would just reintroduce a cast (or an equivalent
 * unsafe narrowing) at the call site the moment `PromotionCandidate.status`
 * is read from data whose exact filtering this component has no way to see.
 */
export const QUEUE_STATUS_KEY: Record<PromotionCandidate["status"], string> = {
  "stripe-eligible": "promotionQueue.status.stripe-eligible",
  "exam-eligible": "promotionQueue.status.exam-eligible",
  approaching: "promotionQueue.status.approaching",
};

export function PromotionStatusLabel({ status }: { status: PromotionCandidate["status"] }) {
  const t = useTranslations("dashboard");
  return <>{t(QUEUE_STATUS_KEY[status])}</>;
}
