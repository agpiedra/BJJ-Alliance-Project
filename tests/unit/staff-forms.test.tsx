/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

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
const { InviteForm, InvitationRowActions, LatestInvitationLink, MemberRowActions, StaffLinkProvider } = await import(
  "../../src/app/[locale]/(staff)/admin/staff/staff-forms"
);

const inviteStaff = vi.mocked(actions.inviteStaff);
const resendInvitation = vi.mocked(actions.resendInvitation);
const updateStaffMember = vi.mocked(actions.updateStaffMember);

const ACADEMIES = [{ id: "academy-1", name: "Alajuela" }];
const en = enMessages.staffManagement;
const LINK = "http://localhost/accept?token=new";
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

/** An action result for an issued invitation `inv-new`; settled with a provider-accepted send unless overridden. */
function delivery(overrides: Record<string, unknown>) {
  return {
    ok: true,
    invitationId: "inv-new",
    invitationLink: LINK,
    expiresAt: FUTURE,
    emailOutcome: "accepted" as const,
    settlement: "settled" as const,
    ...overrides,
  } as Awaited<ReturnType<typeof actions.resendInvitation>>;
}

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
      inviteStaff.mockResolvedValue(delivery({ invitationId: "inv-first", invitationLink: "http://localhost/accept?token=first", emailOutcome: "rejected" }));
      render(withProviders(<><InviteForm organizationId="org-1" academies={ACADEMIES} /><LatestInvitationLink usableIds={["inv-first"]} /></>));

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Coach@Example.com" } });
      fireEvent.click(screen.getByLabelText("Alajuela"));
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

      const link = (await screen.findByDisplayValue("http://localhost/accept?token=first")) as HTMLInputElement;
      expect(link.readOnly).toBe(true);
      expect(screen.getByText(/Invitation link · coach@example.com/)).toBeTruthy();
      expect(screen.getByText(en.link.outcome.rejected)).toBeTruthy();
      // A first invite has no earlier links, so it says nothing about them.
      expect(screen.queryByText(en.link.resend.kept)).toBeNull();
      expect(screen.queryByText(en.link.resend.retired)).toBeNull();
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    });
  });

  describe("resending", () => {
    it("REQUIRED: the resent link is shown, and survives the refresh that replaces the invitation row", async () => {
      resendInvitation.mockResolvedValue(delivery({ invitationId: "inv-2", invitationLink: "http://localhost/accept?token=resent", emailOutcome: "unknown" }));
      const { rerender } = render(
        withProviders(<><LatestInvitationLink usableIds={["inv-1"]} /><InvitationRowActions key="inv-1" organizationId="org-1" invitation={invitation("inv-1")} /></>),
      );

      fireEvent.click(screen.getByRole("button", { name: "Resend" }));

      // The refresh after a resend lists the NEW invitation too (an unknown send leaves the earlier one listed as well).
      rerender(
        withProviders(<><LatestInvitationLink usableIds={["inv-1", "inv-2"]} /><InvitationRowActions key="inv-2" organizationId="org-1" invitation={invitation("inv-2")} /></>),
      );

      expect(await screen.findByDisplayValue("http://localhost/accept?token=resent")).toBeTruthy();
      expect(screen.getByText(en.link.resend.kept)).toBeTruthy();
    });

    it("REQUIRED: a newer link REPLACES an older one — one panel, the newest link", async () => {
      inviteStaff.mockResolvedValue(delivery({ invitationId: "inv-1", invitationLink: "http://localhost/accept?token=original" }));
      resendInvitation.mockResolvedValue(delivery({ invitationId: "inv-2", invitationLink: "http://localhost/accept?token=replacement" }));
      render(
        withProviders(
          <>
            <InviteForm organizationId="org-1" academies={ACADEMIES} />
            <LatestInvitationLink usableIds={["inv-1", "inv-2"]} />
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

  /**
   * docs/STAFF_INVITATION_RESEND_PLAN.md §3 — the panel reports the email outcome, what THIS resend did to earlier links,
   * and the link only while it may work, labelled for what is actually known.
   */
  describe("outcome × settlement copy", () => {
    async function showResend(result: Awaited<ReturnType<typeof actions.resendInvitation>>, usableIds: string[], messages: typeof enMessages, locale: string) {
      resendInvitation.mockResolvedValue(result);
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <StaffLinkProvider>
            <LatestInvitationLink usableIds={usableIds} />
            <InvitationRowActions organizationId="org-1" invitation={invitation("inv-1")} />
          </StaffLinkProvider>
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: messages.staffManagement.resend.button }));
      return screen.findByTestId("invitation-link-panel");
    }
    const status = () => screen.getByTestId("invitation-link-status").textContent;

    for (const [locale, messages] of [["en", enMessages], ["es", esMessages]] as const) {
      const m = messages.staffManagement;
      describe(locale, () => {
        it("accepted + settled: provider acceptance (never 'delivered'), earlier links replaced, link usable when checked", async () => {
          await showResend(delivery({ emailOutcome: "accepted" }), ["inv-new"], messages, locale);
          expect(screen.getByText(m.link.outcome.accepted)).toBeTruthy();
          expect(screen.getByText(m.link.resend.retired)).toBeTruthy();
          expect(status()).toContain(m.link.checked.split("{expiresAt}")[0]);
          expect(screen.getByDisplayValue(LINK)).toBeTruthy();
        });

        for (const [outcome, key] of [["rejected", "rejected"], ["not_configured", "notConfigured"], ["unknown", "unknown"]] as const) {
          it(`${outcome} + settled: this resend invalidated nothing; the manual link is offered`, async () => {
            await showResend(delivery({ emailOutcome: outcome }), ["inv-new"], messages, locale);
            expect(screen.getByText(m.link.outcome[key])).toBeTruthy();
            expect(screen.getByText(m.link.resend.kept)).toBeTruthy();
            expect(screen.queryByText(m.link.resend.retired)).toBeNull();
            expect(screen.getByDisplayValue(LINK)).toBeTruthy();
          });
        }

        it("acceptedMeanwhile: no link, says the new link was accepted", async () => {
          await showResend(delivery({ settlement: "acceptedMeanwhile", invitationLink: undefined }), [], messages, locale);
          expect(status()).toBe(m.link.acceptedMeanwhile);
          expect(screen.queryByDisplayValue(LINK)).toBeNull();
        });

        it("unavailable: no link, neutral wording (no cause claimed), and this resend invalidated nothing", async () => {
          await showResend(delivery({ settlement: "unavailable", invitationLink: undefined }), [], messages, locale);
          expect(status()).toBe(m.link.unavailable);
          expect(screen.getByText(m.link.resend.kept)).toBeTruthy();
          expect(screen.queryByDisplayValue(LINK)).toBeNull();
        });

        it("REQUIRED: settle failed: the link is offered as UNVERIFIED — never with the 'usable when checked' wording", async () => {
          await showResend(delivery({ settlement: "failed" }), ["inv-new"], messages, locale);
          expect(status()).toBe(m.link.unverified);
          expect(screen.getByText(m.link.resend.kept)).toBeTruthy();
          expect(screen.getByDisplayValue(LINK)).toBeTruthy();
          expect(screen.getByText(m.link.outcome.accepted).className).toContain("text-warn"); // never success styling
        });
      });
    }
  });

  describe("REQUIRED: a refresh hides a link that can no longer be used", () => {
    const panel = (usableIds: string[]) =>
      withProviders(
        <>
          <LatestInvitationLink usableIds={usableIds} />
          <InvitationRowActions organizationId="org-1" invitation={invitation("inv-1")} />
        </>,
      );

    it("no longer pending (accepted, revoked or replaced) → hidden, with the no-longer-usable notice", async () => {
      resendInvitation.mockResolvedValue(delivery({}));
      const { rerender } = render(panel(["inv-new"]));
      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await screen.findByDisplayValue(LINK);

      rerender(panel([]));

      expect(screen.queryByDisplayValue(LINK)).toBeNull();
      expect(screen.getByTestId("invitation-link-status").textContent).toBe(en.link.noLongerUsable);
    });

    it("STILL LISTED but expired → hidden: the page passes only unexpired ids, and the panel checks its own expiresAt", async () => {
      // (a) The page left it out of the usable set because listStaff flagged it expired (see usableInvitationIds,
      // proven against real listStaff data in staff-invitation-resend-lifecycle.test.ts).
      resendInvitation.mockResolvedValue(delivery({}));
      const { rerender } = render(panel(["inv-new"]));
      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await screen.findByDisplayValue(LINK);
      rerender(panel(["inv-1"]));
      expect(screen.queryByDisplayValue(LINK)).toBeNull();
      expect(screen.getByTestId("invitation-link-status").textContent).toBe(en.link.noLongerUsable);
      cleanup();

      // (b) Still in the usable set from the last render, but its own expiry has passed since.
      resendInvitation.mockResolvedValue(delivery({ expiresAt: new Date(Date.now() - 1000) }));
      render(panel(["inv-new"]));
      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await screen.findByTestId("invitation-link-panel");
      expect(screen.queryByDisplayValue(LINK)).toBeNull();
      expect(screen.getByTestId("invitation-link-status").textContent).toBe(en.link.noLongerUsable);
    });

    it("REQUIRED (found in the real browser): a fresh result is NOT hidden before the page refresh that lists it arrives", async () => {
      resendInvitation.mockResolvedValue(delivery({}));
      const { rerender } = render(panel(["inv-1"])); // the list as it was before the resend — no inv-new yet
      fireEvent.click(screen.getByRole("button", { name: "Resend" }));

      // The action's result renders against the OLD list: settlement's own check stands, so the link is shown.
      expect(await screen.findByDisplayValue(LINK)).toBeTruthy();
      expect(screen.getByTestId("invitation-link-status").textContent).toContain("Usable when checked");

      // A refresh then arrives (a NEW list) without inv-new — now, and only now, it is hidden.
      rerender(panel(["inv-1"]));
      expect(screen.queryByDisplayValue(LINK)).toBeNull();
      expect(screen.getByTestId("invitation-link-status").textContent).toBe(en.link.noLongerUsable);
    });

    it("pending and unexpired → still shown", async () => {
      resendInvitation.mockResolvedValue(delivery({}));
      const { rerender } = render(panel(["inv-new"]));
      fireEvent.click(screen.getByRole("button", { name: "Resend" }));
      await screen.findByDisplayValue(LINK);
      rerender(panel(["inv-1", "inv-new"]));
      expect(screen.getByDisplayValue(LINK)).toBeTruthy();
    });
  });
});

/**
 * "Student only" — taking staff access away from someone who also trains, and keeping
 * the training. Only the EDIT form offers it (an invitation makes someone staff; it is
 * never how a person becomes "student only"), it needs no locations, and a refusal is
 * said in words (someone with no student record has nothing to keep).
 */
describe("Student only", () => {
  const coach = { membershipId: "m1", userId: "u1", email: "coach@example.com", role: "INSTRUCTOR" as const, active: true, academies: ACADEMIES };
  const optionsOf = () => [...(screen.getByRole("combobox") as HTMLSelectElement).options].map((option) => option.textContent);

  afterEach(() => {
    cleanup();
    updateStaffMember.mockReset();
  });

  it("REQUIRED: the edit form offers it; the invite form does not", () => {
    render(withProviders(<InviteForm organizationId="org-1" academies={ACADEMIES} />));
    expect(optionsOf()).not.toContain("Student only");
    cleanup();

    render(withProviders(<MemberRowActions organizationId="org-1" member={coach} academies={ACADEMIES} isSelf={false} organizationName="Alliance" />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(optionsOf()).toContain("Student only");
  });

  it("REQUIRED: choosing it hides the locations (it needs none) and saves role STUDENT with no academies", async () => {
    updateStaffMember.mockResolvedValue({ ok: true });
    render(withProviders(<MemberRowActions organizationId="org-1" member={coach} academies={ACADEMIES} isSelf={false} organizationName="Alliance" />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Alajuela")).toBeTruthy(); // an instructor is scoped to locations

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "STUDENT" } });

    expect(screen.queryByLabelText("Alajuela")).toBeNull();
    expect(screen.getByText("Loses the staff app and keeps their own training.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const submitted = updateStaffMember.mock.calls[0][2] as FormData;
    expect(submitted.get("role")).toBe("STUDENT");
    expect(submitted.get("membershipId")).toBe("m1");
    expect(submitted.getAll("academyIds")).toEqual([]);
  });

  it("a refusal for someone with no student record is said in words", async () => {
    updateStaffMember.mockResolvedValue({ error: "noStudentRecord" });
    render(withProviders(<MemberRowActions organizationId="org-1" member={coach} academies={ACADEMIES} isSelf={false} organizationName="Alliance" />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "STUDENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("This person has no active student record here, so there is nothing to keep. Deactivate them instead.");
  });

  it("deactivating tells the Owner that Student only keeps their training", () => {
    expect(enMessages.staffManagement.deactivate.confirm).toMatch(/Student only/);
  });
});
