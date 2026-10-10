"use client";

import { createContext } from "react";

/**
 * DESIGN.md §7.10 fix — the DOM node `Sheet`'s portal should render into when
 * mounted inside a `BrandingScope`, so a portaled popup (e.g. the mobile
 * sidebar sheet) stays a real DOM descendant of the `[data-branding="org-…"]`
 * wrapper and picks up its `--sidebar-*`/`--brand-gold*` overrides, instead of
 * escaping to `document.body` (Base UI `Dialog.Portal`'s default) and falling
 * back to the unthemed defaults. `null` outside any `BrandingScope` — callers
 * fall back to Base UI's own default (`document.body`) in that case.
 */
export const BrandingPortalContext = createContext<React.RefObject<HTMLDivElement | null> | null>(null);
