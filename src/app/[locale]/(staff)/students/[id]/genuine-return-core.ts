import { inactiveLedgerActivation } from "@/lib/dues/ledger/activation";

/**
 * Deliberately NOT a "use server" file — mirrors `create-student-core.ts`'s own `isEnrollmentBillingActive`
 * precedent exactly, for the identical reason: `page.tsx` must never import directly from `src/lib/dues/ledger/`
 * (`tests/unit/dues-ledger-not-exposed.test.ts`'s own authorized-caller allow-list), so this tiny, non-"use server"
 * sibling module is what it imports instead. `genuineReturnChargeInTx` itself (imported directly by `actions.ts`,
 * already an authorized caller) performs the real activation check again on its own — this is only the read
 * `page.tsx` uses to decide whether to render the "Return to training" button and its hidden `archiveEventId`
 * field at all, never from request data.
 */
export async function isGenuineReturnBillingActive(organizationId: string): Promise<boolean> {
  return inactiveLedgerActivation.isActive(organizationId);
}
