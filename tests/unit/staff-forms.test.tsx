/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Two bugs only a real browser showed (the integration tests call the actions
 * directly, so neither could have failed there):
 *
 * 1. A REFUSED invitation wiped the form: React resets an uncontrolled form
 *    after every action, so an Owner who forgot to choose a location retyped
 *    the email.
 * 2. A RESENT invitation's new link was never shown. A resend replaces the
 *    invitation (new id) and the refresh that follows unmounts the row that
 *    triggered it, so a link held in that row's own state vanished — while the
 *    panel from the ORIGINAL invite went on showing a link that no longer worked.
 *    When email fails (dev, or a production outage) the link is the whole point.
 */
vi.mock("@/lib/staff/staff-actions", () => ({
  inviteStaff: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  updateStaffMember: vi.fn(),
  deactivateStaffMember: vi.fn(),
  reactivateStaffMember: vi.fn(),
}));

const actions = await import("@/lib/staff/staff-actions");
const { InviteForm, InvitationRowActions, LatestInvitationLink, StaffLinkProvider } = await import(
  "../../src/app/[locale]/(staff)/admin/staff/staff-forms"
);

const inviteStaff = vi.mocked(actions.inviteStaff);
const resendInvitation = vi.mocked(actions.resendInvitation);

const ACADEMIES = [{ id: "academy-1", name: "Alajuela" }];

function invitation(id: string) {
  return {
    id,
    email: "pending@example.com",
    role: "INSTRUCTOR" as const,
    academies: ACADEMIES,
    expiresAt: new Date("2026-10-01T00:00:00Z"),
    expired: false,
    createdAt: new Date("2026-09-21T00:00:00Z"),
  };
}

function withProviders(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaffLinkProvider>{children}</StaffLinkProvider>
    </NextIntlClientProvider>
  );
}

describe("staff forms", () => {
  afterEach(() => {
    cleanup();
    inviteStaff.mockReset();
    resendInvitation.mockReset();
  });

  describe("the invite form", () => {
    it("REQUIRED: a refused invitation keeps what was typed and chosen", async () => {
      inviteStaff.mockResolvedValue({ error: "academyRequired" });
      render(withProviders(<InviteForm organizationId="org-1" academies={ACADEMIES} />));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "coach@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

      await screen.findByText("Choose at least one location for a director or instructor.");
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("coach@example.com");
    });

    it("clears the form after a successful invitation and shows the link to copy, labelled with who it is for", async () => {
      inviteStaff.mockResolvedValue({ ok: true, invitationLink: "http://localhost/accept?token=first", emailSent: false });
      render(withProviders(<><InviteForm organizationId="org-1" academies={ACADEMIES} /><LatestInvitationLink /></>));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Coach@Example.com" } });
      fireEvent.click(screen.getByLabelText("Alajuela"));
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

      const link = (await screen.findByDisplayValue("http://localhost/accept?token=first")) as HTMLInputElement;
      expect(link.readOnly).toBe(true);
      expect(screen.getByText(/Invitation link · coach@example.com/)).toBeTruthy();
      expect(screen.getByText(/couldn't be sent/)).toBeTruthy(); // emailSent: false says so
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    });
  });

  describe("resending", () => {
    it("REQUIRED: the resent link is shown, and survives the refresh that replaces the invitation row", async () => {
      resendInvitation.mockResolvedValue({ ok: true, invitationLink: "http://localhost/accept?token=resent", emailSent: false });
      const { rerender } = render(
        withProviders(<><LatestInvitationLink /><InvitationRowActions key="inv-1" organizationId="org-1" invitation={invitation("inv-1")} /></>),
      );

      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await screen.findByDisplayValue("http://localhost/accept?token=resent");

      // The refresh after a resend swaps the row for one with a NEW id — the old row unmounts.
      rerender(withProviders(<><LatestInvitationLink /><InvitationRowActions key="inv-2" organizationId="org-1" invitation={invitation("inv-2")} /></>));

      expect(screen.getByDisplayValue("http://localhost/accept?token=resent")).toBeTruthy();
    });

    it("REQUIRED: a newer link REPLACES an older one — a dead link is never left on screen", async () => {
      inviteStaff.mockResolvedValue({ ok: true, invitationLink: "http://localhost/accept?token=original", emailSent: false });
      resendInvitation.mockResolvedValue({ ok: true, invitationLink: "http://localhost/accept?token=replacement", emailSent: false });
      render(
        withProviders(
          <>
            <InviteForm organizationId="org-1" academies={ACADEMIES} />
            <LatestInvitationLink />
            <InvitationRowActions organizationId="org-1" invitation={invitation("inv-1")} />
          </>,
        ),
      );

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pending@example.com" } });
      fireEvent.click(screen.getByLabelText("Alajuela"));
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
      await screen.findByDisplayValue("http://localhost/accept?token=original");

      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await waitFor(() => expect(screen.queryByDisplayValue("http://localhost/accept?token=original")).toBeNull());
      expect(screen.getByDisplayValue("http://localhost/accept?token=replacement")).toBeTruthy();
      expect(screen.getAllByTestId("invitation-link-panel")).toHaveLength(1);
    });
  });
});
