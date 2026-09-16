"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * Manual light/dark toggle (REDESIGN_BRIEF.md Phase 2). No next-themes
 * dependency — `<html>`'s "dark" class is set before hydration by the inline
 * script in the root layout (reads localStorage, falls back to
 * prefers-color-scheme), and this button only flips that same class + the
 * stored preference. Both icons render unconditionally (identical SSR/CSR
 * output — no hydration mismatch); CSS's `dark:` variant picks which one
 * shows, so the visible icon always matches the class the inline script
 * already applied.
 */
export function ThemeToggle() {
  const t = useTranslations("staffShell");

  function toggle() {
    const isDark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
      // Private browsing / storage disabled — theme just won't persist.
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle} aria-label={t("themeToggle")}>
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
      <span>{t("themeToggle")}</span>
    </Button>
  );
}
