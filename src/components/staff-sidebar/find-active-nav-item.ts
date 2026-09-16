import type { StaffSidebarNavEntry } from "./staff-sidebar";

/**
 * Shared by StaffSidebar (nav highlight) and StaffTopBar (breadcrumb label)
 * so the "which item is active" rule lives in exactly one place. Prefers the
 * most specific href when routes nest (e.g. "/dashboard" vs.
 * "/dashboard/analytics") so only one item ever matches.
 */
export function findActiveNavItem(
  pathname: string,
  locale: string,
  navItems: StaffSidebarNavEntry[],
): StaffSidebarNavEntry | undefined {
  const withFullHref = navItems.map((item) => ({ item, fullHref: `/${locale}${item.href}` }));

  function matches(fullHref: string): boolean {
    return pathname === fullHref || pathname.startsWith(`${fullHref}/`);
  }

  return withFullHref.find(({ fullHref }) => {
    if (!matches(fullHref)) return false;
    return !withFullHref.some(
      ({ fullHref: other }) => other !== fullHref && other.startsWith(fullHref) && matches(other),
    );
  })?.item;
}
