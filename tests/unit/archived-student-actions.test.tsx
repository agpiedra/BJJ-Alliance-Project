/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * Genuine-return-to-training brief, corrected: the ARCHIVED-student markup must not change for the always-inactive-
 * today case. A narrow, scoped assertion — this proves the markup around `RestoreStudentButton` specifically, not
 * whole-page render equivalence (the same discipline `create-student-form.test.tsx`'s hidden-field regression uses).
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/actions", () => ({ restoreStudent: vi.fn(), returnToTraining: vi.fn() }));

const { ArchivedStudentActions } = await import("../../src/app/[locale]/(staff)/students/[id]/archived-student-actions");

function renderActions(trustworthyArchiveEvent: Parameters<typeof ArchivedStudentActions>[0]["trustworthyArchiveEvent"]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ArchivedStudentActions organizationId="org-1" studentId="student-1" trustworthyArchiveEvent={trustworthyArchiveEvent} />
    </NextIntlClientProvider>,
  );
}

describe("ArchivedStudentActions — billing inactive / no trustworthy event: markup around Restore is unchanged", () => {
  it("trustworthyArchiveEvent null (billing inactive): renders exactly ONE top-level element (RestoreStudentButton's own <form>), no wrapping <div>", () => {
    const { container } = renderActions(null);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild!.tagName).toBe("FORM"); // RestoreStudentButton's own root element, not a wrapper
    expect(container.querySelector('input[name="archiveEventId"]')).toBeNull(); // no trace of the return action
  });

  it("trustworthyArchiveEvent not ok (noTrustworthyArchiveEvent/notEligible): identical markup to the null case", () => {
    const { container } = renderActions({ ok: false, reason: "noTrustworthyArchiveEvent" });
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild!.tagName).toBe("FORM");
  });
});

describe("ArchivedStudentActions — a trustworthy archive event: both actions render, explicitly distinguished", () => {
  it("renders a wrapping <div> with BOTH Restore and Return-to-training, the return action never presented as a variant of Restore", () => {
    const { container, getByRole } = renderActions({ ok: true, archiveEventId: "event-123" });
    expect(container.firstElementChild!.tagName).toBe("DIV"); // the wrapper now legitimately exists
    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(container.querySelector('input[name="archiveEventId"]')).toHaveValue("event-123");
    expect(getByRole("button", { name: "Restore student" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Return to training" })).toBeInTheDocument();
  });
});
