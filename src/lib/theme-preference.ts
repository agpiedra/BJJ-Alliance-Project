/**
 * Flips light/dark exactly as the staff toggle always has: `<html>`'s "dark" class (already set before hydration by the inline
 * script in the root layout, which reads localStorage and falls back to prefers-color-scheme) and the stored preference. Shared by the
 * staff `ThemeToggle` button and the student portal's account-menu item so the two can never drift. Client-only (touches `document`).
 */
export function toggleTheme(): "dark" | "light" {
  const isDark = document.documentElement.classList.toggle("dark");
  const theme = isDark ? "dark" : "light";
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Private browsing / storage disabled: the theme just won't persist.
  }
  return theme;
}
