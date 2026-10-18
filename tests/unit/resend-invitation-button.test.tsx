/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * Component-level mapping from the action's email outcome to the rendered message. The action is MOCKED here — this
 * proves the component's wiring only; tests/integration/platform-resend-invitation.test.ts proves which outcome the real
 * action returns for each provider response.
 */
const approveOrganizationAction = vi.fn();
vi.mock("../../src/app/[locale]/platform/organizations/actions", () => ({
  approveOrganizationAction: (...args: unknown[]) => approveOrganizationAction(...args),
}));

const { ResendInvitationButton } = await import("../../src/app/[locale]/platform/organizations/[id]/resend-invitation-button");

const en = enMessages.platform.organizations.detail.members;
const es = esMessages.platform.organizations.detail.members;

function renderButton(locale: "en" | "es") {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <ResendInvitationButton organizationId="org-1" />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? en.resendInvitation : es.resendInvitation }));
}

beforeEach(() => {
  approveOrganizationAction.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

const CASES = [
  { outcome: "accepted", key: "resendInvitationAccepted", failed: false },
  { outcome: "rejected", key: "resendInvitationRejected", failed: true },
  { outcome: "not_configured", key: "resendInvitationNotConfigured", failed: true },
  { outcome: "unknown", key: "resendInvitationUnknown", failed: false },
  { outcome: "notIssued", key: "resendInvitationNotIssued", failed: false },
] as const;

describe("ResendInvitationButton renders the email outcome, never a blanket success", () => {
  for (const { outcome, key, failed } of CASES) {
    for (const locale of ["en", "es"] as const) {
      it(`${outcome} (${locale}) → ${key}${failed ? ", styled as a failure" : ""}`, async () => {
        approveOrganizationAction.mockResolvedValue({ ok: true, invitationEmail: outcome });
        renderButton(locale);

        const message = await screen.findByText((locale === "en" ? en : es)[key]);
        expect(message.className).toContain(failed ? "text-destructive" : "text-muted-foreground");
        if (outcome !== "accepted") expect(screen.queryByText((locale === "en" ? en : es).resendInvitationAccepted)).toBeNull();
      });
    }
  }

  it("an action error still shows the existing error message", async () => {
    approveOrganizationAction.mockResolvedValue({ error: "notFound" });
    renderButton("en");
    expect((await screen.findByText(en.resendInvitationError)).className).toContain("text-destructive");
  });

  it("the old blanket success copy is gone from both locales", () => {
    expect("resendInvitationSent" in en).toBe(false);
    expect("resendInvitationSent" in es).toBe(false);
  });
});
