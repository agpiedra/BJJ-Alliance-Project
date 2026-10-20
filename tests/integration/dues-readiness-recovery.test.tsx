/** @vitest-environment jsdom */
import "dotenv/config";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { ActionState } from "../../src/lib/action-state";
import enMessages from "../../messages/en.json";

/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §7.4): deterministic recovery scenarios R1-R6. The REAL screen view
 * (`Students`, rendered from REAL `getReadinessScreenForOwner` reads on the isolated test database) is driven in jsdom. The action
 * the UI calls is a test wrapper: it loses the response (rejects at once, as a dropped connection does) while the REAL server work
 * runs on its own, either after a test gate (delayed start) or paused inside its transaction by the existing 8c `afterLocks`
 * hook. No production test hook is added. Every step asserts: no success message, no rejection message, the alert still says the
 * outcome is unknown, exactly one call from the UI, and the typed values untouched by refreshed data.
 */
type MockSession = { user: { id: string; role?: string }; activeOrganizationId: string | null; access?: unknown } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn(), unstable_update: vi.fn(async () => null) }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", async () => ({ ...(await vi.importActual<object>("next/navigation")), useRouter: () => router }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("../../messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: en, namespace } as never),
    getLocale: async () => "en",
  };
});
// What the UI calls. Each scenario sets `ui.impl`; `ui.calls` counts calls from the UI only.
const ui = vi.hoisted(() => ({ impl: null as null | ((name: string, args: unknown[]) => Promise<unknown>), calls: [] as string[] }));
vi.mock("@/lib/dues/readiness/opening-actions", () => {
  const wrap = (name: string) => (...args: unknown[]) => {
    ui.calls.push(name);
    return ui.impl!(name, args);
  };
  return {
    createOpeningDraft: wrap("createOpeningDraft"),
    replaceOpeningDraft: wrap("replaceOpeningDraft"),
    withdrawOpeningDraft: wrap("withdrawOpeningDraft"),
    recordOpeningReview: wrap("recordOpeningReview"),
    acknowledgePricing: wrap("acknowledgePricing"),
  };
});

const real = await vi.importActual<typeof import("../../src/lib/dues/readiness/opening-actions")>("../../src/lib/dues/readiness/opening-actions");
const core = await import("../../src/lib/dues/readiness/opening-core");
const { getReadinessScreenForOwner } = await import("../../src/lib/dues/readiness/screen");
const { Students } = await import("../../src/app/[locale]/(staff)/payments/readiness/readiness-view");
const { ReadinessClientRoot } = await import("../../src/app/[locale]/(staff)/payments/readiness/use-readiness-action");

const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2026, month: 12 };
const OUT = enMessages.payments.readiness.forms.outcome;
const LOST = () => Promise.reject(new TypeError("Failed to fetch"));

let a: Fixture;
let secondOwner: { id: string };
let n = 0;

const asOwner = (userId = a.admin.id) => (currentSession = { user: { id: userId, role: "ADMIN" }, activeOrganizationId: a.org.id, access: { staff: true, portal: false } });
const ctx = (): TenantContext => ({
  kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});
const content = (year: number, month: number, amount: string, note: string) => ({ coverageYear: year, coverageMonth: month, amount, currency: "CRC" as const, note, legacyPaymentPeriodId: null });
const fd = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function newStudent(first: string) {
  n++;
  const s = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: first, lastName: `Recovery${n}`, phone: "00000000",
      email: `recovery-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `recovery-${n}-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2024, 0, 1)), sequence: 1, source: "EVENT", actorId: a.admin.id },
  });
  return s.id;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((res) => (open = res));
  return { opened, open };
}

/** A pause inside the server transaction (the existing 8c hook): resolves `held` once the locks are taken, waits for `release`. */
function hold() {
  const release = gate();
  let markHeld!: () => void;
  const held = new Promise<void>((res) => (markHeld = res));
  return { hooks: { afterLocks: async () => { markHeld(); await release.opened; } }, held, release: release.open };
}

/** The real view for the real current data, as the page renders it. */
async function view() {
  asOwner();
  const result = await getReadinessScreenForOwner(a.org.id, S);
  if (!result.ok) throw new Error("expected a screen");
  const screen = result.screen;
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ReadinessClientRoot asOf={screen.asOf.toISOString()}>{await Students({ screen, locale: "en", candidate: S, organizationId: a.org.id })}</ReadinessClientRoot>
    </NextIntlClientProvider>
  );
}

const cardOf = (container: HTMLElement, studentId: string) => container.querySelector(`a[href="/en/students/${studentId}"]`)!.closest("li")! as HTMLElement;
const addForm = (card: HTMLElement) => [...card.querySelectorAll("form")].find((f) => f.querySelector("input[name=studentId]"))!;

function fillAdd(card: HTMLElement, year: number, month: number, amount: string, note: string) {
  const form = addForm(card);
  fireEvent.change(form.querySelector("select[name=coverageMonth]")!, { target: { value: String(month) } });
  fireEvent.change(form.querySelector("input[name=coverageYear]")!, { target: { value: String(year) } });
  fireEvent.change(form.querySelector("input[name=amount]")!, { target: { value: amount } });
  fireEvent.click(form.querySelector("input[name=currency][value=CRC]")!);
  fireEvent.change(form.querySelector("textarea[name=note]")!, { target: { value: note } });
}
const typedAdd = (card: HTMLElement) => {
  const form = addForm(card);
  return {
    month: (form.querySelector("select[name=coverageMonth]") as HTMLSelectElement).value,
    year: (form.querySelector("input[name=coverageYear]") as HTMLInputElement).value,
    amount: (form.querySelector("input[name=amount]") as HTMLInputElement).value,
    note: (form.querySelector("textarea[name=note]") as HTMLTextAreaElement).value,
  };
};

/** The invariants every step of every lost-response scenario must hold. */
function assertUnknown(container: HTMLElement, card: HTMLElement, refreshed: boolean) {
  const text = container.textContent ?? "";
  expect(text).not.toContain(OUT.saved);
  for (const message of Object.values(OUT.rejected)) expect(text).not.toContain(message);
  expect(within(card).getByRole("alert").textContent).toContain(refreshed ? OUT.stillUnknownTitle : OUT.unknownTitle);
  expect(ui.calls).toHaveLength(1);
}

/** "Reload current data" (or "Reload again"), then the refreshed real view arrives. */
async function reloadWith(rerender: (ui: React.ReactElement) => void, card: () => HTMLElement, label: string) {
  fireEvent.click(within(card()).getByRole("button", { name: label }));
  const next = await view();
  await act(async () => rerender(next));
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "recovery");
  secondOwner = await prisma.user.create({ data: { email: `recovery-owner2-${suffix}@example.com`, passwordHash: "x", role: "ADMIN" } });
  await prisma.organizationMembership.create({ data: { userId: secondOwner.id, organizationId: a.org.id, role: "ADMIN" } });
}, 120_000);

afterAll(async () => {
  if (a) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesReadinessConfirmation", "DuesOpeningItem"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    });
    await prisma.organizationMembership.deleteMany({ where: { userId: secondOwner?.id } });
    await a.drop();
  }
  if (secondOwner) await prisma.user.deleteMany({ where: { id: secondOwner.id } });
}, 120_000);

beforeEach(() => {
  ui.calls = [];
  ui.impl = null;
  router.refresh.mockReset();
});

describe("R1-R6: a lost response is never reported as saved or not saved", () => {
  it("R1: the action commits AFTER the first refresh returned unchanged data", async () => {
    const x = await newStudent("Raul");
    const pause = hold();
    let work!: Promise<ActionState>;
    ui.impl = (_name, args) => {
      const data = args[2] as FormData;
      work = core.createOpeningDraftCore(ctx(), x, content(Number(data.get("coverageYear")), Number(data.get("coverageMonth")), String(data.get("amount")), String(data.get("note"))), pause.hooks);
      return LOST();
    };
    const { container, rerender } = render(await view());
    const card = () => cardOf(container, x);
    fillAdd(card(), 2025, 3, "300.00", "R1 March");
    const typed = typedAdd(card());
    await act(async () => fireEvent.submit(addForm(card())));
    await pause.held;
    assertUnknown(container, card(), false);

    await reloadWith(rerender, card, OUT.reload); // refresh 1: the transaction is still open, so the data is unchanged
    assertUnknown(container, card(), true);
    expect(card().textContent).not.toContain("R1 March");
    expect(within(card()).queryByRole("button", { name: OUT.checked })).not.toBeNull(); // inspection offered, no retry decision made

    pause.release();
    expect(await work).toEqual({ ok: true }); // it committed — after a refresh that showed nothing
    await reloadWith(rerender, card, OUT.reloadAgain); // refresh 2: the draft is shown as currently recorded
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain("R1 March");
    expect(typedAdd(card())).toEqual(typed);

    fireEvent.click(within(card()).getByRole("button", { name: OUT.checked }));
    expect(within(card()).queryByRole("alert")).toBeNull();
    expect(typedAdd(card())).toEqual(typed); // still the owner's own input; nothing resubmitted
    expect(ui.calls).toHaveLength(1);
  });

  it("R2: another owner creates a DIFFERENT draft during recovery; nothing is attributed to this request", async () => {
    const x = await newStudent("Rosa");
    const start = gate();
    let work!: Promise<ActionState>;
    ui.impl = (_name, args) => {
      work = start.opened.then(() => real.createOpeningDraft(a.org.id, {}, args[2] as FormData));
      return LOST();
    };
    const { container, rerender } = render(await view());
    const card = () => cardOf(container, x);
    fillAdd(card(), 2025, 1, "100.00", "R2 January");
    const typed = typedAdd(card());
    await act(async () => fireEvent.submit(addForm(card())));
    assertUnknown(container, card(), false);
    await reloadWith(rerender, card, OUT.reload);
    assertUnknown(container, card(), true);

    asOwner(secondOwner.id);
    expect(await real.createOpeningDraft(a.org.id, {}, fd({ studentId: x, coverageYear: "2025", coverageMonth: "2", amount: "200.00", currency: "CRC", note: "R2 February by another owner", legacyPaymentPeriodId: "" }))).toEqual({ ok: true });
    await reloadWith(rerender, card, OUT.reloadAgain); // a NEW draft appeared — not this request's
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain("R2 February by another owner");
    expect(card().textContent).not.toContain("R2 January");

    asOwner();
    start.open();
    expect(await work).toEqual({ ok: true });
    await reloadWith(rerender, card, OUT.reloadAgain);
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain("R2 January");
    expect(typedAdd(card())).toEqual(typed);
  });

  it("R3: another owner records a DIFFERENT review during recovery; this request is stale server-side; neither is claimed", async () => {
    const x = await newStudent("Ruth");
    const start = gate();
    let work!: Promise<ActionState>;
    ui.impl = (_name, args) => {
      work = start.opened.then(() => real.recordOpeningReview(a.org.id, {}, args[2] as FormData));
      return LOST();
    };
    const { container, rerender } = render(await view());
    const card = () => cardOf(container, x);
    fireEvent.click(within(card()).getByRole("button", { name: /no opening debt before December 2026/ }));
    const dialog = document.body.querySelector("[role=alertdialog]") as HTMLElement;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: enMessages.payments.readiness.forms.review.submit })));
    assertUnknown(container, card(), false);

    asOwner(secondOwner.id);
    expect(await real.createOpeningDraft(a.org.id, {}, fd({ studentId: x, coverageYear: "2025", coverageMonth: "4", amount: "40.00", currency: "CRC", note: "R3 April", legacyPaymentPeriodId: "" }))).toEqual({ ok: true });
    const other = await getReadinessScreenForOwner(a.org.id, S);
    if (!other.ok) throw new Error("expected a screen");
    expect(await real.recordOpeningReview(a.org.id, {}, fd({ studentId: x, candidateYear: "2026", candidateMonth: "12", binding: other.screen.students.find((s) => s.id === x)!.openingBinding, declaration: "itemsAsShown" }))).toEqual({ ok: true });
    await reloadWith(rerender, card, OUT.reload);
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain(enMessages.payments.readiness.students.state.valid); // a current review exists — not this one

    asOwner();
    start.open();
    expect(await work).toEqual({ error: "stale" }); // this request wrote nothing — and the UI does not say so either
    await reloadWith(rerender, card, OUT.reloadAgain);
    assertUnknown(container, card(), true);
    expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId: x } })).toBe(1);
  });

  it("R4: the replacement changes the month; the old form closes; no claim either way", async () => {
    const x = await newStudent("Rene");
    asOwner();
    expect(await real.createOpeningDraft(a.org.id, {}, fd({ studentId: x, coverageYear: "2025", coverageMonth: "1", amount: "10.00", currency: "CRC", note: "R4 January", legacyPaymentPeriodId: "" }))).toEqual({ ok: true });
    const pause = hold();
    let work!: Promise<ActionState>;
    ui.impl = (_name, args) => {
      const data = args[2] as FormData;
      const parsed = core.parseDraftContent((k) => (typeof data.get(k) === "string" ? (data.get(k) as string) : null));
      if (!parsed.ok) throw new Error("fixture form should parse");
      work = core.replaceOpeningDraftCore(ctx(), String(data.get("draftId")), parsed.value, pause.hooks);
      return LOST();
    };
    const { container, rerender } = render(await view());
    const card = () => cardOf(container, x);
    const replaceForm = [...card().querySelectorAll("form")].find((f) => f.querySelector("input[name=draftId]"))!;
    fireEvent.change(replaceForm.querySelector("select[name=coverageMonth]")!, { target: { value: "3" } });
    fireEvent.change(replaceForm.querySelector("textarea[name=note]")!, { target: { value: "R4 March" } });
    await act(async () => fireEvent.submit(replaceForm));
    await pause.held;
    assertUnknown(container, card(), false);
    await reloadWith(rerender, card, OUT.reload); // January still active: not "not saved"
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain("R4 January");

    pause.release();
    expect(await work).toEqual({ ok: true });
    await reloadWith(rerender, card, OUT.reloadAgain); // January gone, March active
    assertUnknown(container, card(), true);
    expect(card().textContent).toContain("R4 March");
    expect(card().textContent).not.toContain("R4 January");
    expect(card().querySelectorAll("input[name=draftId]")).toHaveLength(1); // only the successor's form; the January one closed
    expect(within(card()).getByRole("alert").textContent).toContain(OUT.targetClosed);
  });

  for (const first of ["withdraw", "replace"] as const) {
    it(`R5 (${first} holds the lock first): a withdrawal races a replacement; tab A shows only current state`, async () => {
      const x = await newStudent(`Rocio${first}`);
      asOwner();
      expect(await real.createOpeningDraft(a.org.id, {}, fd({ studentId: x, coverageYear: "2025", coverageMonth: "5", amount: "50.00", currency: "CRC", note: "R5 May", legacyPaymentPeriodId: "" }))).toEqual({ ok: true });
      const draftId = (await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: x } })).id;
      const pause = hold();
      let tabA!: Promise<ActionState>;
      ui.impl = (_name, args) => {
        const reason = String((args[2] as FormData).get("reason"));
        tabA = core.withdrawOpeningDraftCore(ctx(), draftId, reason, first === "withdraw" ? pause.hooks : {});
        return LOST();
      };
      const { container, rerender } = render(await view());
      const card = () => cardOf(container, x);
      let tabB!: Promise<ActionState>;
      const replaceB = () => core.replaceOpeningDraftCore(ctx(), draftId, content(2025, 6, "60.00", "R5 June by tab B"), first === "replace" ? pause.hooks : {});
      if (first === "replace") {
        tabB = replaceB();
        await pause.held;
      }
      fireEvent.click(within(card()).getByRole("button", { name: enMessages.payments.readiness.forms.drafts.withdraw }));
      const dialog = document.body.querySelector("[role=alertdialog]") as HTMLElement;
      fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "R5 reason" } });
      await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: enMessages.payments.readiness.forms.drafts.withdrawSubmit })));
      if (first === "withdraw") {
        await pause.held;
        tabB = replaceB();
      }
      await new Promise((res) => setTimeout(res, 150)); // the second one is now waiting on the student lock
      assertUnknown(container, card(), false);
      pause.release();
      const [resultA, resultB] = await Promise.all([tabA, tabB]);
      expect(first === "withdraw" ? [resultA, resultB] : [resultB, resultA]).toEqual([{ ok: true }, { error: "stale" }]);

      await reloadWith(rerender, card, OUT.reload);
      assertUnknown(container, card(), true);
      expect(card().textContent).not.toContain("R5 May");
      if (first === "replace") expect(card().textContent).toContain("R5 June by tab B");
      expect(within(card()).getByRole("alert").textContent).toContain(OUT.targetClosed);
      const rows = await prisma.duesOpeningItem.findMany({ where: { organizationId: a.org.id, studentId: x, id: draftId } });
      expect(rows[0].withdrawalKind).toBe(first === "withdraw" ? "WITHDRAWN" : "EDITED");
    });
  }

  it("R6 (contrast): an explicit response alone decides — ok is 'Saved.', a refusal is its documented message", async () => {
    const x = await newStudent("Ramon");
    ui.impl = (_name, args) => real.createOpeningDraft(a.org.id, {}, args[2] as FormData);
    const { container, rerender } = render(await view());
    const card = () => cardOf(container, x);
    fillAdd(card(), 2025, 8, "80.00", "R6 August");
    asOwner();
    await act(async () => fireEvent.submit(addForm(card())));
    // A real round trip to the database: wait for the response itself.
    await waitFor(() => expect(within(card()).getByRole("status").textContent).toContain(OUT.saved));
    await act(async () => rerender(await view()));
    fillAdd(card(), 2025, 8, "81.00", "R6 August again");
    await act(async () => fireEvent.submit(addForm(card())));
    await waitFor(() => expect(within(card()).getByRole("alert").textContent).toContain(OUT.rejected.monthHasDraft));
    expect(ui.calls).toHaveLength(2);
  });
});
