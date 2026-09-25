"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "cn";

export type PortalTabId = "home" | "attendance" | "schedule";
const TAB_IDS: readonly PortalTabId[] = ["home", "attendance", "schedule"];

interface PortalTabsContextValue {
  /** Show a view. `focus: "panel"` moves focus into it (a link that jumps to another view); keyboard use moves it to the tab itself. */
  select: (id: PortalTabId, options?: { focus?: "panel" | "tab" }) => void;
}
const PortalTabsContext = createContext<PortalTabsContextValue | null>(null);

/** For a control inside a view that needs to open another one (Home's "View full history"). Falls back to a plain anchor when there are no tabs. */
export function usePortalTabs(): PortalTabsContextValue | null {
  return useContext(PortalTabsContext);
}

function idFromHash(hash: string): PortalTabId | null {
  return TAB_IDS.find((id) => hash === `#${id}`) ?? null;
}

/**
 * The portal's three views (Home, Attendance, Schedule) as ACCESSIBLE TABS (WAI-ARIA tabs pattern, automatic activation): a labelled
 * `tablist`, `role="tab"` buttons with `aria-selected`/`aria-controls` and a roving tabindex (Left/Right/Home/End move and activate,
 * Tab enters the panel), and `role="tabpanel"` regions labelled by their tab.
 *
 * Every view is rendered on the server and stays MOUNTED (inactive ones are just `hidden`), so nothing is refetched when switching and
 * a view keeps its own state: the attendance history keeps the pages already loaded, the "show older" position and its focus handling,
 * and the check-in card keeps its state. The active view is mirrored in the URL hash (`#attendance`, `#schedule`) so a view can be
 * linked to and the browser's back button steps through views; the server always renders Home first and the client switches after
 * hydration, so there is no hydration mismatch.
 */
export function PortalTabs({ listLabel, labels, panels }: { listLabel: string; labels: Record<PortalTabId, string>; panels: Record<PortalTabId, ReactNode> }) {
  const [active, setActive] = useState<PortalTabId>("home");
  const tabRefs = useRef<Partial<Record<PortalTabId, HTMLButtonElement | null>>>({});
  const panelRefs = useRef<Partial<Record<PortalTabId, HTMLDivElement | null>>>({});

  useEffect(() => {
    const fromHash = idFromHash(window.location.hash);
    if (fromHash) setActive(fromHash);
    const onHashChange = () => setActive(idFromHash(window.location.hash) ?? "home");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const select = useCallback((id: PortalTabId, options?: { focus?: "panel" | "tab" }) => {
    setActive(id);
    if (idFromHash(window.location.hash) !== id) window.location.hash = id;
    if (options?.focus === "tab") tabRefs.current[id]?.focus();
    // The panel is `hidden` until React commits the new state, and a hidden element cannot take focus: wait one frame.
    if (options?.focus === "panel") requestAnimationFrame(() => panelRefs.current[id]?.focus());
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TAB_IDS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    select(TAB_IDS[next], { focus: "tab" });
  }

  return (
    <PortalTabsContext.Provider value={{ select }}>
      <div role="tablist" aria-label={listLabel} className="-mx-4 mb-4 flex border-b border-border px-4 sm:mx-0 sm:px-0 lg:mb-5">
        {TAB_IDS.map((id, index) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`portal-tab-${id}`}
            aria-selected={active === id}
            aria-controls={`portal-panel-${id}`}
            tabIndex={active === id ? 0 : -1}
            onClick={() => select(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "-mb-px inline-flex min-h-11 flex-1 items-center justify-center border-b-[3px] border-transparent px-4 text-sm font-medium text-muted-foreground transition-colors sm:flex-none",
              "hover:bg-muted hover:text-foreground aria-selected:border-foreground aria-selected:font-semibold aria-selected:text-foreground",
            )}
          >
            {labels[id]}
          </button>
        ))}
      </div>

      {TAB_IDS.map((id) => (
        <div
          key={id}
          ref={(el) => {
            panelRefs.current[id] = el;
          }}
          role="tabpanel"
          id={`portal-panel-${id}`}
          aria-labelledby={`portal-tab-${id}`}
          hidden={active !== id}
          tabIndex={0}
          className="outline-offset-4"
        >
          {panels[id]}
        </div>
      ))}
    </PortalTabsContext.Provider>
  );
}
