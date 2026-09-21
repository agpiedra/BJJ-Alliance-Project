/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * The kiosk token is the one thing an Owner cannot get back: only its hash is
 * stored, so the plaintext exists solely in the response to "add a location".
 * These pin what only a real browser could show (the integration tests call the
 * action directly):
 *
 * - the token panel lives in ONE provider above the page's list, so the refresh
 *   that follows a creation cannot unmount it (the same shape as the staff
 *   invitation link, whose loss was a real bug);
 * - a REFUSED add keeps what was typed (React resets an uncontrolled form after
 *   every action, failed ones included);
 * - adding a second location never hides the first one's token — it still works,
 *   and it cannot be shown again.
 */
vi.mock("@/lib/locations/location-actions", () => ({ createLocation: vi.fn() }));

const actions = await import("@/lib/locations/location-actions");
const { AddLocationForm, IssuedKioskTokens, LocationTokenProvider } = await import(
  "../../src/app/[locale]/(staff)/admin/locations/location-forms"
);

const createLocation = vi.mocked(actions.createLocation);

function withProviders(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LocationTokenProvider>{children}</LocationTokenProvider>
    </NextIntlClientProvider>
  );
}

function added(name: string, slug: string, kioskToken: string) {
  return { ok: true as const, academyId: `id-${slug}`, name, slug, kioskToken };
}

describe("location forms", () => {
  afterEach(() => {
    cleanup();
    createLocation.mockReset();
  });

  it("REQUIRED: a successful add shows the kiosk link ONCE, built with the new token and slug, and clears the form for the next", async () => {
    createLocation.mockResolvedValue(added("Alajuela", "org-alajuela", "tok-first"));
    render(withProviders(<><AddLocationForm organizationId="org-1" /><IssuedKioskTokens /></>));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alajuela" } });
    fireEvent.change(screen.getByLabelText("Address (optional)"), { target: { value: "Centro" } });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));

    const link = (await screen.findByDisplayValue(/\/en\/kiosk\/org-alajuela\?token=tok-first$/)) as HTMLInputElement;
    expect(link.readOnly).toBe(true);
    expect(screen.getByText(/Kiosk link · Alajuela/)).toBeTruthy();
    expect(screen.getByText(/will not be shown again/)).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Address (optional)") as HTMLInputElement).value).toBe("");
  });

  it("REQUIRED: a refused add keeps what was typed and shows no link", async () => {
    createLocation.mockResolvedValue({ error: "duplicateName" });
    render(withProviders(<><AddLocationForm organizationId="org-1" /><IssuedKioskTokens /></>));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alajuela" } });
    fireEvent.change(screen.getByLabelText("Address (optional)"), { target: { value: "Centro" } });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));

    await screen.findByText("You already have a location with that name.");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alajuela");
    expect((screen.getByLabelText("Address (optional)") as HTMLInputElement).value).toBe("Centro");
    expect(screen.queryByTestId("kiosk-token-panel")).toBeNull();
  });

  it("REQUIRED: the link survives the page refresh that follows a creation (a sibling re-rendering must not unmount it)", async () => {
    createLocation.mockResolvedValue(added("Alajuela", "org-alajuela", "tok-first"));
    const page = (rows: string[]) =>
      withProviders(
        <>
          <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>
          <AddLocationForm organizationId="org-1" />
          <IssuedKioskTokens />
        </>,
      );
    const { rerender } = render(page(["Heredia"]));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alajuela" } });
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    await screen.findByDisplayValue(/token=tok-first$/);

    // The server re-renders the page with the new location in the list.
    rerender(page(["Heredia", "Alajuela"]));

    expect(screen.getByDisplayValue(/token=tok-first$/)).toBeTruthy();
  });

  it("adding a second location does NOT hide the first one's token — both still work and neither can be shown again — and each can be dismissed", async () => {
    createLocation
      .mockResolvedValueOnce(added("Alajuela", "org-alajuela", "tok-first"))
      .mockResolvedValueOnce(added("Cartago", "org-cartago", "tok-second"));
    render(withProviders(<><AddLocationForm organizationId="org-1" /><IssuedKioskTokens /></>));

    for (const name of ["Alajuela", "Cartago"]) {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "Add location" }));
      await screen.findByDisplayValue(new RegExp(`org-${name.toLowerCase()}\\?token=`));
    }

    expect(screen.getAllByTestId("kiosk-token-panel")).toHaveLength(2);
    expect(screen.getByDisplayValue(/token=tok-first$/)).toBeTruthy();
    expect(screen.getByDisplayValue(/token=tok-second$/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "I've saved it" })[0]);
    expect(screen.getAllByTestId("kiosk-token-panel")).toHaveLength(1);
  });

  it("nothing is shown before anything has been added — the token is never rendered from stored state", () => {
    render(withProviders(<IssuedKioskTokens />));
    expect(screen.queryByTestId("kiosk-token-panel")).toBeNull();
  });
});
