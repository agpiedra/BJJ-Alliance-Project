/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * Phase 2.6 PR 3 - the password field's show/hide toggle. Never submits the form (type="button"),
 * never clears the typed value, keeps focus on the password field itself (not the toggle) after
 * each click, and starts concealed.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({ locale: "en" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../src/app/[locale]/login/actions", () => ({ login: vi.fn() }));

const { LoginForm } = await import("../../src/app/[locale]/login/login-form");

function renderForm(locale: "en" | "es" = "en") {
  const messages = locale === "en" ? enMessages : esMessages;
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <LoginForm />
    </NextIntlClientProvider>,
  );
}

function passwordInput() {
  return screen.getByLabelText("Password") as HTMLInputElement;
}

describe("login password show/hide toggle", () => {
  afterEach(cleanup);

  it("REQUIRED: password starts concealed", () => {
    renderForm();
    expect(passwordInput().type).toBe("password");
  });

  it("REQUIRED: toggling flips the input's type between password/text and back", () => {
    renderForm();
    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(passwordInput().type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput().type).toBe("password");
  });

  it("REQUIRED: toggling preserves the exact typed password value", () => {
    renderForm();
    fireEvent.change(passwordInput(), { target: { value: "s3cr3t!" } });
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput().value).toBe("s3cr3t!");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput().value).toBe("s3cr3t!");
  });

  it("REQUIRED: toggling does not submit the form", () => {
    renderForm();
    const form = passwordInput().closest("form") as HTMLFormElement;
    const submitSpy = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submitSpy);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("REQUIRED: the toggle button is type=button, never type=submit", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Show password" }).getAttribute("type")).toBe("button");
  });

  it("REQUIRED: the accessible label changes between Show password/Hide password as state changes, not a static label", () => {
    renderForm();
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
  });

  it("REQUIRED: after toggling, focus stays on the password input, not the toggle button", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(document.activeElement).toBe(passwordInput());
  });

  it("REQUIRED: the password input is accessible by its localized label, and the toggle follows it in DOM order and is programmatically focusable", () => {
    renderForm();
    const emailInput = screen.getByLabelText("Email");
    const toggle = screen.getByRole("button", { name: "Show password" });
    // DOM order only (email -> password -> toggle -> ... -> "Forgot it?"), not a claim of real Tab-key
    // navigation - that's proven separately by this PR's real-browser evidence (see
    // design/matroom/verification/phase2.6-login-toggle/README.md), not by jsdom here.
    const label = emailInput.closest("form") as HTMLFormElement;
    const focusables = Array.from(label.querySelectorAll("input, button, a"));
    expect(focusables.indexOf(toggle)).toBeGreaterThan(focusables.indexOf(passwordInput()));
    expect(focusables.indexOf(passwordInput())).toBeGreaterThan(focusables.indexOf(emailInput));
    const forgotLink = screen.getByRole("link", { name: "Forgot your password?" });
    expect(focusables.indexOf(forgotLink)).toBeGreaterThan(focusables.indexOf(toggle));
    // Programmatic focusability only - not a simulated Tab keypress.
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });

  it("is translated, under the Spanish locale", () => {
    renderForm("es");
    expect(screen.getByRole("button", { name: "Mostrar contraseña" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(screen.getByRole("button", { name: "Ocultar contraseña" })).toBeTruthy();
  });
});
