export interface PlatformNavLink {
  href: string;
  label: string;
}

/**
 * Same "most specific href wins" rule as the staff shell's
 * find-active-nav-item.ts, so /platform/organizations/[id] (and
 * /platform/organizations/new, /pending) count as "Organizations" active,
 * never falling through to "Overview" matching every route as a prefix of
 * itself. Kept separate from the staff version rather than generalized
 * across them — different nav-link shape (href/label here vs. the staff
 * sidebar's href/labelKey/icon/group/badge), different domain.
 */
export function findActivePlatformLink(pathname: string, links: PlatformNavLink[]): PlatformNavLink | undefined {
  function matches(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return links.find((link) => {
    if (!matches(link.href)) return false;
    return !links.some((other) => other.href !== link.href && other.href.startsWith(link.href) && matches(other.href));
  });
}
