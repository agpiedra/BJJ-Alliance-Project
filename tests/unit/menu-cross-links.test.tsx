/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * One account, both surfaces: a coach who also trains reaches the portal from the
 * staff menu ("My training") and the staff app from the portal menu ("Staff") — and
 * a person with only one of the two sees NO link to a place they cannot go. The
 * flags are DATABASE-derived (the layout and the portal page pass them from their
 * resolved context, never from the session claim); these pin what each menu does
 * with them.
 */
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/en/dashboard", useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/sign-out-actions", () => ({ signOutStaff: vi.fn(), signOutStudent: vi.fn() }));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/components/theme/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/brand/brand-banner", () => ({
  BrandBanner: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));

const { StaffTopBar } = await import("../../src/components/staff-sidebar/staff-top-bar");
const { PortalTopBar } = await import("../../src/app/[locale]/portal/portal-top-bar");

function within(locale: "en" | "es", children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

function staffBar(hasPortal: boolean, locale: "en" | "es" = "en") {
  return within(
    locale,
    <StaffTopBar locale={locale} navItems={[]} userEmail="coach@example.com" role="INSTRUCTOR" academyLabel="Heredia" hasPortal={hasPortal} />,
  );
}
function portalBar(hasStaff: boolean, locale: "en" | "es" = "en") {
  return within(locale, <PortalTopBar locale={locale} firstName="Real" lastName="Coach" hasStaff={hasStaff} />);
}

async function openMenu() {
  const trigger = screen.getAllByRole("button").at(-1)!;
  fireEvent.pointerDown(trigger);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

describe("the staff menu's link to the portal", () => {
  afterEach(() => {
    cleanup();
    push.mockReset();
  });

  it("REQUIRED: a staff member with a linked, active student record gets 'My training', and it goes to the portal", async () => {
    render(staffBar(true));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "My training" }));
    expect(push).toHaveBeenCalledWith("/en/portal");
  });

  it("REQUIRED: staff without a student record get no link to a page that would refuse them", async () => {
    render(staffBar(false));
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "My training" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("is translated, and goes to the portal under the Spanish locale", async () => {
    render(staffBar(true, "es"));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mi entrenamiento" }));
    expect(push).toHaveBeenCalledWith("/es/portal");
  });
});

describe("the portal menu's link to the staff app", () => {
  afterEach(() => {
    cleanup();
    push.mockReset();
  });

  it("REQUIRED: someone with staff access gets 'Staff', and it goes to the staff dashboard", async () => {
    render(portalBar(true));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Staff" }));
    expect(push).toHaveBeenCalledWith("/en/dashboard");
  });

  it("REQUIRED: a student-only member gets no staff link", async () => {
    render(portalBar(false));
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Staff" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("is translated, and goes to the staff dashboard under the Spanish locale", async () => {
    render(portalBar(true, "es"));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Staff" }));
    expect(push).toHaveBeenCalledWith("/es/dashboard");
  });
});

/**
 * The props are REQUIRED, so tsc refuses a caller that leaves them out — but a caller
 * could still pass a lie: `true`, or the session claim (which is a hint, not a fact, and
 * stale for as long as the token lives). Both callers must pass the answer derived from
 * THIS request's database-resolved context.
 */
function passesFromContext(source: string, prop: string, field: "portal" | "staff"): boolean {
  const expression = new RegExp(String.raw`\b${prop}=\{\s*accessFromContext\(\s*context\s*\)\.${field}\s*\}`);
  return expression.test(source);
}

describe("the flags come from the database-resolved context, never a literal or the session claim", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("REQUIRED: the staff layout passes hasPortal from accessFromContext(context)", () => {
    expect(passesFromContext(read("src/app/[locale]/(staff)/layout.tsx"), "hasPortal", "portal")).toBe(true);
  });

  it("REQUIRED: the portal page passes hasStaff from accessFromContext(context)", () => {
    expect(passesFromContext(read("src/app/[locale]/portal/page.tsx"), "hasStaff", "staff")).toBe(true);
  });

  it("positive controls: a literal, the session claim, or another field would each be caught", () => {
    expect(passesFromContext("<StaffTopBar hasPortal />", "hasPortal", "portal")).toBe(false);
    expect(passesFromContext("<StaffTopBar hasPortal={true} />", "hasPortal", "portal")).toBe(false);
    expect(passesFromContext("<StaffTopBar hasPortal={authSession?.access?.portal} />", "hasPortal", "portal")).toBe(false);
    expect(passesFromContext("<PortalTopBar hasStaff={accessFromContext(context).portal} />", "hasStaff", "staff")).toBe(false);
    expect(passesFromContext("<PortalTopBar hasStaff={accessFromContext(context).staff} />", "hasStaff", "staff")).toBe(true);
  });
});
