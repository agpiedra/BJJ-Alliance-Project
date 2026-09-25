"use client";

import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * A small "Offline" indicator in the banner, so staff can see at a glance that the tablet has lost its connection. It only REPORTS what
 * the browser knows (`navigator.onLine` and the `online` / `offline` events): the kiosk's own behaviour is unchanged (an offline tap is
 * still queued on the device and replayed later; a request that fails while the browser still thinks it is online is queued too, without
 * this chip). The live region always exists so the change is announced when it appears; server rendering assumes online.
 */
export function OfflineChip() {
  const t = useTranslations("kiosk");
  const offline = useSyncExternalStore(subscribe, () => !navigator.onLine, () => false);
  return (
    <span role="status" className="ml-auto shrink-0">
      {offline && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-current px-3 py-1 text-sm font-medium">
          <WifiOff aria-hidden="true" className="size-4" />
          {t("offline")}
        </span>
      )}
    </span>
  );
}
