/** @vitest-environment jsdom */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The archive dialog used to promise "This can be reversed by editing status
 * later" while nothing could reverse it — status is deliberately not editable.
 * There is now a Restore, so the promise is true, and it says how. These pin the
 * button's behaviour and that neither locale still claims the old, false thing.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/actions", () => ({
  archiveStudent: vi.fn(),
  restoreStudent: vi.fn(),
}));

const actions = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { RestoreStudentButton } = await import("../../src/app/[locale]/(staff)/students/[id]/restore-student-button");
const { ArchiveStudentButton } = await import("../../src/app/[locale]/(staff)/students/[id]/archive-student-button");

const restoreStudent = vi.mocked(actions.restoreStudent);

function inEnglish(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe("the Restore button", () => {
  afterEach(() => {
    cleanup();
    restoreStudent.mockReset();
    vi.restoreAllMocks();
  });

  it("REQUIRED: asks first, and restores nothing if the confirmation is declined", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(inEnglish(<RestoreStudentButton organizationId="org-1" studentId="student-1" />));

    fireEvent.click(screen.getByRole("button", { name: "Restore student" }));

    expect(confirm).toHaveBeenCalledWith(enMessages.students.detail.restore.confirm);
    expect(restoreStudent).not.toHaveBeenCalled();
  });

  it("REQUIRED: on confirmation it restores exactly that student, in that organization, and says so", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restoreStudent.mockResolvedValue({ ok: true });
    render(inEnglish(<RestoreStudentButton organizationId="org-1" studentId="student-1" />));

    fireEvent.click(screen.getByRole("button", { name: "Restore student" }));

    await screen.findByText("Student restored.");
    expect(restoreStudent).toHaveBeenCalledTimes(1);
    const [organizationId, , formData] = restoreStudent.mock.calls[0] as [string, unknown, FormData];
    expect(organizationId).toBe("org-1");
    expect(formData.get("studentId")).toBe("student-1");
  });

  it("a refusal is shown in words, not swallowed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restoreStudent.mockResolvedValue({ error: "notArchived" });
    render(inEnglish(<RestoreStudentButton organizationId="org-1" studentId="student-1" />));

    fireEvent.click(screen.getByRole("button", { name: "Restore student" }));

    await waitFor(() => expect(screen.getByText("This student is not archived.")).toBeTruthy());
  });
});

describe("the archive dialog no longer promises something that does not exist", () => {
  afterEach(cleanup);

  it("REQUIRED: says the student can be restored, in both locales — and never that status can be edited", () => {
    const en = enMessages.students.detail.archive.confirm;
    const es = esMessages.students.detail.archive.confirm;

    expect(en).toBe("Archive this student? You can restore them later.");
    expect(es).toBe("¿Archivar este estudiante? Podés restaurarlo más adelante.");
    for (const text of [en, es]) {
      expect(text).not.toMatch(/editing status|editando el estado/i);
    }
  });

  it("the promise is real: an archived student's page offers Restore (its confirmation says what comes back)", () => {
    expect(enMessages.students.detail.restore.button).toBe("Restore student");
    expect(enMessages.students.detail.restore.confirm).toMatch(/status they had before/);
    expect(esMessages.students.detail.restore.button).toBe("Restaurar estudiante");
    expect(esMessages.students.detail.restore.confirm).toMatch(/estado que tenía/);
  });

  it("the archive button still archives (control): its own confirmation is the new copy", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(inEnglish(<ArchiveStudentButton organizationId="org-1" studentId="student-1" />));

    fireEvent.click(screen.getByRole("button", { name: "Archive student" }));

    expect(confirm).toHaveBeenCalledWith("Archive this student? You can restore them later.");
    vi.restoreAllMocks();
  });
});

describe("the awaiting-approval notice copy", () => {
  it("REQUIRED: exists in both locales, names the academy, and says it is awaiting approval — not 'no organization'", () => {
    const en = enMessages.auth.noOrganizationAccess;
    const es = esMessages.auth.noOrganizationAccess;

    expect(en.pendingHeading).toBe("Awaiting approval");
    expect(en.pendingBody).toContain("{organization}");
    expect(en.pendingBody).toMatch(/awaiting approval|approve/i);
    expect(es.pendingHeading).toBe("Pendiente de aprobación");
    expect(es.pendingBody).toContain("{organization}");
    expect(es.pendingBody).toMatch(/aprob/i);
    // The generic copy is untouched for everyone else.
    expect(en.heading).toBe("No organization access");
  });
});
