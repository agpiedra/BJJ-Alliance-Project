/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * Component-level mapping from the action's email outcome + settlement to the rendered message. The action is MOCKED
 * here — this proves the component's wiring only; tests/integration/platform-resend-invitation.test.ts and
 * invitation-lifecycle.test.ts prove which outcome and settlement the real code returns.
 */
const approveOrganizationAction = vi.fn();
vi.mock("../../src/app/[locale]/platform/organizations/actions", () => ({
  approveOrganizationAction: (...args: unknown[]) => approveOrganizationAction(...args),
}));

const { ResendInvitationButton } = await import("../../src/app/[locale]/platform/organizations/[id]/resend-invitation-button");

const en = enMessages.platform.organizations.detail.members;
const es = esMessages.platform.organizations.detail.members;
type Key = keyof typeof en;

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

const CASES: Array<{ outcome: string; settlement?: string; keys: Key[]; failed: boolean }> = [
  { outcome: "accepted", settlement: "settled", keys: ["resendInvitationAccepted", "resendInvitationSettledAccepted"], failed: false },
  { outcome: "rejected", settlement: "settled", keys: ["resendInvitationRejected", "resendInvitationSettledWithdrawn"], failed: true },
  { outcome: "not_configured", settlement: "settled", keys: ["resendInvitationNotConfigured", "resendInvitationSettledWithdrawn"], failed: true },
  { outcome: "unknown", settlement: "settled", keys: ["resendInvitationUnknown", "resendInvitationSettledUnknown"], failed: false },
  { outcome: "accepted", settlement: "acceptedMeanwhile", keys: ["resendInvitationAccepted", "resendInvitationAcceptedMeanwhile"], failed: false },
  { outcome: "accepted", settlement: "unavailable", keys: ["resendInvitationAccepted", "resendInvitationUnavailable"], failed: false },
  { outcome: "rejected", settlement: "unavailable", keys: ["resendInvitationRejected", "resendInvitationUnavailable"], failed: true },
  { outcome: "accepted", settlement: "failed", keys: ["resendInvitationAccepted", "resendInvitationSettleFailed"], failed: true },
  { outcome: "unknown", settlement: "failed", keys: ["resendInvitationUnknown", "resendInvitationSettleFailed"], failed: true },
  { outcome: "notIssued", keys: ["resendInvitationNotIssued"], failed: false },
  { outcome: "legacyUnresolved", keys: ["resendInvitationLegacyUnresolved"], failed: true },
];

describe("ResendInvitationButton renders the email outcome and what settlement found — never a blanket success", () => {
  for (const { outcome, settlement, keys, failed } of CASES) {
    for (const locale of ["en", "es"] as const) {
      it(`${outcome}${settlement ? ` + ${settlement}` : ""} (${locale}) → ${keys.join(" + ")}${failed ? ", styled as a failure" : ""}`, async () => {
        approveOrganizationAction.mockResolvedValue({ ok: true, invitationEmail: outcome, invitationSettlement: settlement });
        renderButton(locale);

        const messages = locale === "en" ? en : es;
        const message = await screen.findByText(keys.map((key) => messages[key]).join(" "));
        expect(message.className).toContain(failed ? "text-destructive" : "text-muted-foreground");
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

  it("no copy claims an earlier link stopped working unconditionally (false for rejected, unconfigured and unknown sends)", () => {
    expect(JSON.stringify(en)).not.toMatch(/previous link no longer works|invalidates any previous/i);
    expect(JSON.stringify(es)).not.toMatch(/enlace anterior ya no funciona|invalida cualquier enlace/i);
    expect(en.confirmResendInvitation).toMatch(/only if the email provider accepts/);
  });

  it("an unavailable invitation is described neutrally — no cause claimed from revokedAt alone", () => {
    expect(en.resendInvitationUnavailable).not.toMatch(/newer|replac|withdrawn|revok|resend happened/i);
    expect(es.resendInvitationUnavailable).not.toMatch(/reciente|reemplaz|retir|revoc/i);
  });

  it("provider acceptance is never described as delivery", () => {
    for (const messages of [en, es]) {
      for (const [key, text] of Object.entries(messages)) {
        if (!key.startsWith("resendInvitation")) continue;
        expect(text, key).not.toMatch(/\bdelivered\b|\bentregad[oa]\b/i);
      }
    }
  });
});
