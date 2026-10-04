import { getTranslations } from "next-intl/server";
import { inactiveLedgerActivation } from "@/lib/dues/ledger/activation";
import { ReceiptQueueList } from "./awaiting-rate-receipt-list";

/**
 * Owner-only awaiting-rate receipt queue (this feature's own planning brief). Mounted once per organization (a
 * receipt's own branch is informational, not a per-academy scope here), from `page.tsx`'s own ADMIN-only branch.
 *
 * Two independent layers, deliberately not merged (same pattern as `ExchangeRateSection`'s own §2.3): `resolveReceipt`/
 * `cancelReceipt` themselves always refuse `"notActive"` when the real, unmodified `inactiveLedgerActivation` reports
 * inactive (unconditional server-side enforcement, unaffected by anything here) — this component's OWN read of the
 * same singleton is a read-only, advisory pre-check that hides the queue entirely when inactive, so the owner is
 * never shown a control that is guaranteed to fail.
 */
export async function AwaitingRateReceiptSection({ organizationId }: { organizationId: string }) {
  const t = await getTranslations("payments.plans.receipts");
  const active = await inactiveLedgerActivation.isActive(organizationId);

  if (!active) {
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("heading")}</h4>
        <p className="text-sm text-muted-foreground">{t("inactive")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold">{t("heading")}</h4>
      <p className="text-xs text-muted-foreground">{t("body")}</p>
      <ReceiptQueueList organizationId={organizationId} />
    </div>
  );
}
