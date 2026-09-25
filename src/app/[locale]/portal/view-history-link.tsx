"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { usePortalTabs } from "./portal-tabs";

/**
 * Home's "View full history": opens the Attendance view and moves focus into it. It is a real link to `#attendance`, so it also works
 * (and can be copied, opened in a new tab) without the tabs around it: the hash is what the tabs read on load.
 */
export function ViewFullHistoryLink({ children }: { children: ReactNode }) {
  const tabs = usePortalTabs();
  return (
    <a
      href="#attendance"
      onClick={(event) => {
        if (!tabs) return;
        event.preventDefault();
        tabs.select("attendance", { focus: "panel" });
      }}
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
    >
      {children}
      <ArrowRight aria-hidden="true" className="size-4" />
    </a>
  );
}
