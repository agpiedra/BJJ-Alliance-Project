/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The platform's Approve and New organization feedback: the organization operation's success, then — separately —
 * the owner's invitation email outcome and what settlement found, worded from the EXISTING classification
 * (lib/organizations/invitation-feedback.ts). No outcome is shown as delivered, none promises a working link, and none
 * suggests approving or creating again.
 */
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }), useParams: () => ({ locale: "en" }) }));
vi.mock("../../src/app/[locale]/platform/organizations/actions", () => ({
  approveOrganizationAction: vi.fn(),
  rejectOrganizationAction: vi.fn(),
}));
vi.mock("../../src/app/[locale]/platform/organizations/new/actions", () => ({ createOrganizationManually: vi.fn() }));

const actions = await import("../../src/app/[locale]/platform/organizations/actions");
const newActions = await import("../../src/app/[locale]/platform/organizations/new/actions");
const { createdOrganizationNotice, invitationFeedbackCopy, invitationReportOf, invitationReportQuery, parseInvitationReport } = await import(
  "../../src/lib/organizations/invitation-feedback"
);
const { InvitationFeedbackNotice } = await import("../../src/app/[locale]/platform/organizations/invitation-feedback-notice");
const { ApprovalFeedbackProvider, LatestApprovalFeedback, PendingRowActions } = await import(
  "../../src/app/[locale]/platform/organizations/pending/pending-row-actions"
);
const { default: NewOrganizationPage } = await import("../../src/app/[locale]/platform/organizations/new/page");

const approve = vi.mocked(actions.approveOrganizationAction);
const createOrganization = vi.mocked(newActions.createOrganizationManually);
const en = enMessages.platform.organizations.invitationFeedback;
const es = esMessages.platform.organizations.invitationFeedback;

afterEach(() => {
  cleanup();
  push.mockReset();
  approve.mockReset();
  createOrganization.mockReset();
});

const withIntl = (children: React.ReactNode, locale: "en" | "es" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
    {children}
  </NextIntlClientProvider>
);

describe("the mapping reuses the existing results — no second classification", () => {
  it("invitationReportOf: issued → email outcome + settlement; already accepted → notIssued; legacy → legacyUnresolved", () => {
    expect(invitationReportOf({ invitationIssue: "issued", invitationEmailOutcome: "rejected", invitationSettlement: "settled" })).toEqual({
      invitationEmail: "rejected",
      invitationSettlement: "settled",
    });
    expect(invitationReportOf({ invitationIssue: "alreadyAccepted", invitationEmailOutcome: null, invitationSettlement: null })).toEqual({
      invitationEmail: "notIssued",
    });
    expect(invitationReportOf({ invitationIssue: "legacyUnresolved", invitationEmailOutcome: null, invitationSettlement: null })).toEqual({
      invitationEmail: "legacyUnresolved",
    });
  });

  it("REQUIRED copy: accepted+settled adds nothing; failed sends point to the withdrawn link; unknown stays neutral; settlement states never guess", () => {
    expect(invitationFeedbackCopy({ invitationEmail: "accepted", invitationSettlement: "settled" })).toEqual({ email: "email.accepted", needsAttention: false });
    for (const email of ["rejected", "not_configured"] as const) {
      expect(invitationFeedbackCopy({ invitationEmail: email, invitationSettlement: "settled" })).toEqual({
        email: `email.${email}`,
        settlement: "settlement.withdrawn",
        needsAttention: true,
      });
    }
    expect(invitationFeedbackCopy({ invitationEmail: "unknown", invitationSettlement: "settled" })).toEqual({
      email: "email.unknown",
      settlement: "settlement.unknownOpen",
      needsAttention: false,
    });
    expect(invitationFeedbackCopy({ invitationEmail: "accepted", invitationSettlement: "acceptedMeanwhile" })).toMatchObject({
      settlement: "settlement.acceptedMeanwhile",
      needsAttention: false,
    });
    expect(invitationFeedbackCopy({ invitationEmail: "accepted", invitationSettlement: "unavailable" })).toMatchObject({
      settlement: "settlement.unavailable",
      needsAttention: true,
    });
    expect(invitationFeedbackCopy({ invitationEmail: "rejected", invitationSettlement: "failed" })).toMatchObject({
      settlement: "settlement.failed",
      needsAttention: true,
    });
    expect(invitationFeedbackCopy({ invitationEmail: "notIssued" })).toEqual({ email: "email.notIssued", needsAttention: false });
    expect(invitationFeedbackCopy({ invitationEmail: "legacyUnresolved" })).toEqual({ email: "email.legacyUnresolved", needsAttention: true });
    // A missing outcome is never reported as accepted.
    expect(invitationFeedbackCopy({})).toMatchObject({ email: "email.unknown", needsAttention: true });
  });

  it("REQUIRED the redirect's query carries fixed values only; anything else read back from the URL is dropped", () => {
    const query = invitationReportQuery("org-1", { invitationEmail: "rejected", invitationSettlement: "settled" });
    expect(query).toBe("created=org-1&invitationEmail=rejected&invitationSettlement=settled");
    expect(parseInvitationReport(Object.fromEntries(new URLSearchParams(query)))).toEqual({ invitationEmail: "rejected", invitationSettlement: "settled" });
    expect(parseInvitationReport({ invitationEmail: "<script>", invitationSettlement: "settled" })).toEqual({
      invitationEmail: undefined,
      invitationSettlement: undefined,
    });
    expect(parseInvitationReport({ invitationEmail: "accepted", invitationSettlement: "delivered" })).toEqual({
      invitationEmail: "accepted",
      invitationSettlement: undefined,
    });
  });

  it("REQUIRED the list page's notice appears only for an organization it lists; an unknown id shows nothing", () => {
    const listed = [{ id: "org-1", name: "Listed" }];
    expect(createdOrganizationNotice({ created: "org-1", invitationEmail: "unknown", invitationSettlement: "settled" }, listed)).toEqual({
      organization: listed[0],
      report: { invitationEmail: "unknown", invitationSettlement: "settled" },
    });
    expect(createdOrganizationNotice({ created: "forged-id", invitationEmail: "accepted", invitationSettlement: "settled" }, listed)).toBeNull();
    expect(createdOrganizationNotice({}, listed)).toBeNull();
  });

  it("every copy key exists in EN and ES", () => {
    for (const messages of [en, es]) {
      for (const key of Object.keys(en.email)) expect(messages.email[key as keyof typeof en.email]).toBeTruthy();
      for (const key of Object.keys(en.settlement)) expect(messages.settlement[key as keyof typeof en.settlement]).toBeTruthy();
    }
  });
});

describe("the notice", () => {
  const cases = [
    { report: { invitationEmail: "accepted", invitationSettlement: "settled" }, email: "accepted", settlement: null, attention: false },
    { report: { invitationEmail: "rejected", invitationSettlement: "settled" }, email: "rejected", settlement: "withdrawn", attention: true },
    { report: { invitationEmail: "not_configured", invitationSettlement: "settled" }, email: "not_configured", settlement: "withdrawn", attention: true },
    { report: { invitationEmail: "unknown", invitationSettlement: "settled" }, email: "unknown", settlement: "unknownOpen", attention: false },
    { report: { invitationEmail: "accepted", invitationSettlement: "acceptedMeanwhile" }, email: "accepted", settlement: "acceptedMeanwhile", attention: false },
    { report: { invitationEmail: "unknown", invitationSettlement: "unavailable" }, email: "unknown", settlement: "unavailable", attention: true },
    { report: { invitationEmail: "rejected", invitationSettlement: "failed" }, email: "rejected", settlement: "failed", attention: true },
    { report: { invitationEmail: "notIssued" }, email: "notIssued", settlement: null, attention: false },
    { report: { invitationEmail: "legacyUnresolved" }, email: "legacyUnresolved", settlement: null, attention: true },
  ] as const;

  for (const [locale, messages] of [["en", en], ["es", es]] as const) {
    for (const c of cases) {
      it(`${locale}: ${c.email}${c.settlement ? ` + ${c.settlement}` : ""} — the operation first, then the email outcome`, () => {
        render(
          withIntl(<InvitationFeedbackNotice operation="approved" organizationId="org-1" organizationName="Gracie Heredia" report={c.report} />, locale),
        );
        expect(screen.getByText(messages.approved.replace("{name}", "Gracie Heredia"))).toBeTruthy();
        const line = screen.getByTestId("invitation-feedback-email");
        expect(line.textContent).toBe(
          messages.email[c.email] + (c.settlement ? ` ${messages.settlement[c.settlement as keyof typeof messages.settlement]}` : ""),
        );
        expect(line.className).toContain(c.attention ? "text-destructive" : "text-muted-foreground");
        expect(screen.getByRole("link", { name: messages.openOrganization }).getAttribute("href")).toBe(`/${locale}/platform/organizations/org-1`);
        // Never shows a link, never claims delivery.
        expect(document.body.textContent).not.toMatch(/accept-invitation|token=/);
        expect(line.textContent).not.toMatch(/\bwas delivered\b|\bse entregó\b/);
      });
    }
  }

  it("REQUIRED failed-send copy says the organization is saved and points to Resend invitation, never to approving again", () => {
    expect(en.settlement.withdrawn).toMatch(/do not approve or create it again/);
    expect(en.settlement.withdrawn).toContain(enMessages.platform.organizations.detail.members.resendInvitation);
    expect(es.settlement.withdrawn).toMatch(/no la apruebes ni la crees de nuevo/);
    expect(es.settlement.withdrawn).toContain(esMessages.platform.organizations.detail.members.resendInvitation);
  });
});

describe("Approve in the pending queue", () => {
  const row = (organizationId: string) => (
    <PendingRowActions key={organizationId} organizationId={organizationId} organizationName={`Name of ${organizationId}`} />
  );
  const page = (rows: React.ReactNode) =>
    withIntl(
      <ApprovalFeedbackProvider>
        <LatestApprovalFeedback />
        {rows}
      </ApprovalFeedbackProvider>,
    );

  it("REQUIRED the outcome survives the refresh that removes the approved row from the queue", async () => {
    approve.mockResolvedValue({ ok: true, invitationEmail: "rejected", invitationSettlement: "settled" });
    const { rerender } = render(page(row("org-1")));

    fireEvent.click(screen.getByRole("button", { name: enMessages.platform.organizations.pending.rowActions.approve }));
    await screen.findByTestId("invitation-feedback");
    rerender(page(null)); // the approved organization is no longer pending

    expect(screen.getByText(en.approved.replace("{name}", "Name of org-1"))).toBeTruthy();
    expect(screen.getByTestId("invitation-feedback-email").textContent).toBe(`${en.email.rejected} ${en.settlement.withdrawn}`);
  });

  it("an action error is shown exactly as before, with no outcome notice", async () => {
    approve.mockResolvedValue({ error: "notApprovable" });
    render(page(row("org-2")));
    fireEvent.click(screen.getByRole("button", { name: enMessages.platform.organizations.pending.rowActions.approve }));
    await screen.findByText("notApprovable");
    expect(screen.queryByTestId("invitation-feedback")).toBeNull();
  });
});

describe("New organization", () => {
  function fill() {
    for (const [name, value] of Object.entries({
      organizationName: "Gracie Heredia",
      desiredSlug: "gracie-heredia",
      country: "Costa Rica",
      city: "Heredia",
      directorEmail: "owner@example.test",
      contactName: "Owner",
      contactPhone: "88880000",
      studentCountBand: "1-25",
    })) {
      fireEvent.change(document.querySelector(`input[name="${name}"]`)!, { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: enMessages.platform.organizations.new.submit }));
  }

  it("REQUIRED success keeps the redirect to the organizations list, carrying the id and the email outcome", async () => {
    createOrganization.mockResolvedValue({ ok: true, organizationId: "org-9", invitationEmail: "not_configured", invitationSettlement: "settled" });
    render(withIntl(<NewOrganizationPage />));
    fill();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/en/platform/organizations?created=org-9&invitationEmail=not_configured&invitationSettlement=settled");
  });

  it("a refused creation stays on the form with its error, exactly as before — no redirect", async () => {
    createOrganization.mockResolvedValue({ error: "slugTaken", slugTaken: true });
    render(withIntl(<NewOrganizationPage />));
    fill();
    await screen.findByText(enMessages.platform.organizations.new.errors.slugTaken);
    expect(push).not.toHaveBeenCalled();
  });
});
