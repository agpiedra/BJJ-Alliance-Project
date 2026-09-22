/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * After an existing account joins an organization the page told everyone "Sign in with the
 * password you already have" — nonsense for the usual case, a student promoted to instructor
 * who is ALREADY signed in as themselves in the browser holding the link. The server says
 * whether the visitor's own session is the invitee's (`alreadySignedIn`); that visitor is
 * offered the app (their next click refreshes their access from the database), everyone else
 * is still told to sign in.
 */
vi.mock("../../src/app/[locale]/accept-invitation/actions", () => ({
  acceptInvitation: vi.fn(async () => ({ ok: true })),
}));

const { AcceptInvitationForm } = await import("../../src/app/[locale]/accept-invitation/accept-invitation-form");

function summary(alreadySignedIn: boolean) {
  return { valid: true as const, mode: "join" as const, organizationName: "Alliance Heredia", role: "INSTRUCTOR", alreadySignedIn };
}

function joined(alreadySignedIn: boolean, locale: "en" | "es" = "en") {
  const messages = locale === "en" ? enMessages : esMessages;
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <AcceptInvitationForm locale={locale} token="t" summary={summary(alreadySignedIn)} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Join" : "Unirme" }));
}

describe("the page shown after an existing account joins", () => {
  afterEach(cleanup);

  it("REQUIRED: someone already signed in as the invitee is offered the app, not told to sign in", async () => {
    joined(true);
    await waitFor(() => expect(screen.getByRole("heading", { name: "You've joined Alliance Heredia" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "Open the app" }).getAttribute("href")).toBe("/en/dashboard");
    expect(screen.queryByText(/password you already have/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("REQUIRED: anyone else is still told to sign in with the password they already have", async () => {
    joined(false);
    await waitFor(() => expect(screen.getByRole("heading", { name: "You've joined Alliance Heredia" })).toBeTruthy());
    expect(screen.getByText("Sign in with the password you already have.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/en/login");
    expect(screen.queryByRole("link", { name: "Open the app" })).toBeNull();
  });

  it("is translated, under the Spanish locale", async () => {
    joined(true, "es");
    await waitFor(() => expect(screen.getByRole("link", { name: "Abrir la app" }).getAttribute("href")).toBe("/es/dashboard"));
    expect(screen.queryByText(/contraseña que ya tienes/i)).toBeNull();
  });
});
