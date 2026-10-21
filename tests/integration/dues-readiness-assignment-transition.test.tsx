/** @vitest-environment jsdom */
import "dotenv/config";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * Stage 8d-2 correction: an assignment that clears check 4 moves its student from the default assignment list to "the other
 * active students". The REAL `BeforeStart` layout (rendered from REAL `getReadinessScreenForOwner` reads on the isolated test
 * database) is driven in jsdom, and the row must keep one mounted identity across that transition: typed values, the open
 * form, and the outcome region (with its recovery controls) survive the refresh and stay reachable. The action the UI calls
 * is a test wrapper around the REAL `assignPlan` (no production test hook); it can lose the response after the real work.
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
// What the UI calls. Each test sets `ui.impl`; `ui.calls` counts calls from the UI only.
const ui = vi.hoisted(() => ({ impl: null as null | ((name: string, args: unknown[]) => Promise<unknown>), calls: [] as string[] }));
vi.mock("@/lib/dues/assignment-actions", () => {
  const wrap = (name: string) => (...args: unknown[]) => {
    ui.calls.push(name);
    return ui.impl!(name, args);
  };
  return { assignPlan: wrap("assignPlan"), correctAssignment: wrap("correctAssignment") };
});

const real = await vi.importActual<typeof import("../../src/lib/dues/assignment-actions")>("../../src/lib/dues/assignment-actions");
const { getReadinessScreenForOwner } = await import("../../src/lib/dues/readiness/screen");
const { BeforeStart } = await import("../../src/app/[locale]/(staff)/payments/readiness/readiness-view");
const { ReadinessClientRoot } = await import("../../src/app/[locale]/(staff)/payments/readiness/use-readiness-action");

const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2026, month: 12 };
const OUT = enMessages.payments.readiness.forms.outcome;
const AS = enMessages.payments.readiness.forms.assignment;
const LOST = () => Promise.reject(new TypeError("Failed to fetch"));
const realAssign = real.assignPlan as (...args: unknown[]) => Promise<unknown>;

let a: Fixture;
let plan: { id: string };
let secondOwner: { id: string };
let n = 0;

const asOwner = (userId = a.admin.id) => (currentSession = { user: { id: userId, role: "ADMIN" }, activeOrganizationId: a.org.id, access: { staff: true, portal: false } });

async function newStudent(first: string) {
  n++;
  const s = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: first, lastName: `Transition${n}`, phone: "00000000",
      email: `transition-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `transition-${n}-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2024, 0, 1)), sequence: 1, source: "EVENT", actorId: a.admin.id },
  });
  return s.id;
}

async function screenNow() {
  asOwner();
  const result = await getReadinessScreenForOwner(a.org.id, S);
  if (!result.ok) throw new Error("expected a screen");
  return result.screen;
}

const failsCheck4 = async (studentId: string) => (await screenNow()).report.checks.find((c) => c.id === 4)!.items.includes(`student:${studentId}`);

/** The real BeforeStart section for the real current data, as the page renders it. */
async function view() {
  const screen = await screenNow();
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ReadinessClientRoot asOf={screen.asOf.toISOString()}>{await BeforeStart({ screen, candidate: S, locale: "en", organizationId: a.org.id })}</ReadinessClientRoot>
    </NextIntlClientProvider>
  );
}

const rowOf = (container: HTMLElement, studentId: string) => container.querySelector(`a[href="/en/students/${studentId}"]`)!.closest("li")! as HTMLElement;

/** Rendered and not behind a collapsed disclosure or `hidden`: what a keyboard user can reach. */
function reachable(el: HTMLElement) {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden) return false;
    if (node.tagName === "DETAILS" && node !== el && !(node as HTMLDetailsElement).open) return false;
  }
  return true;
}

/** Opens the row's "Assign a plan" form and types: effective November (not the default December) and the plan. */
function typeAssignment(row: HTMLElement) {
  const form = [...row.querySelectorAll("form")].find((f) => f.querySelector("select[name=effectiveMonth]"))!;
  (form.closest("details") as HTMLDetailsElement).open = true;
  fireEvent.change(form.querySelector("select[name=effectiveMonth]")!, { target: { value: "11" } });
  fireEvent.click(form.querySelector(`input[name=planId][value="${plan.id}"]`)!);
  return form;
}

function assertTyped(form: HTMLFormElement) {
  expect((form.closest("details") as HTMLDetailsElement).open).toBe(true);
  expect((form.querySelector("select[name=effectiveMonth]") as HTMLSelectElement).value).toBe("11");
  expect((form.querySelector(`input[name=planId][value="${plan.id}"]`) as HTMLInputElement).checked).toBe(true);
}

function assertUnknown(container: HTMLElement, row: HTMLElement, refreshed: boolean) {
  const text = container.textContent ?? "";
  expect(text).not.toContain(OUT.saved);
  for (const message of Object.values(OUT.rejected)) expect(text).not.toContain(message);
  const alert = within(row).getByRole("alert");
  expect(alert.textContent).toContain(refreshed ? OUT.stillUnknownTitle : OUT.unknownTitle);
  expect(reachable(alert)).toBe(true);
  expect(ui.calls).toHaveLength(1);
}

/** "Reload current data" (or "Reload again"), then the refreshed real view arrives. */
async function reloadWith(rerender: (ui: React.ReactElement) => void, row: HTMLElement, label: string) {
  const button = within(row).getByRole("button", { name: label });
  expect(reachable(button)).toBe(true);
  fireEvent.click(button);
  const next = await view();
  await act(async () => rerender(next));
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "transition");
  plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Monthly ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2024, effectiveMonth: 1, priceAmount: "100.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
  });
  secondOwner = await prisma.user.create({ data: { email: `transition-owner2-${suffix}@example.com`, passwordHash: "x", role: "ADMIN" } });
  await prisma.organizationMembership.create({ data: { userId: secondOwner.id, organizationId: a.org.id, role: "ADMIN" } });
}, 120_000);

afterAll(async () => {
  if (a) {
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
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

describe("BeforeStart: an assignment that clears check 4 keeps its row mounted and its recovery reachable", () => {
  it("a committed assignment whose response is lost: still unknown, typed values kept, acknowledgement reachable", async () => {
    const x = await newStudent("Lia");
    expect(await failsCheck4(x)).toBe(true);
    let work!: Promise<unknown>;
    ui.impl = (_name, args) => {
      work = realAssign(...args);
      return work.then(LOST); // the write commits; its response never arrives
    };
    const { container, rerender } = render(await view());
    const row = rowOf(container, x);
    expect(reachable(row)).toBe(true);
    const form = typeAssignment(row);
    await act(async () => fireEvent.submit(form));
    expect(await work).toEqual({ ok: true });
    await waitFor(() => within(row).getByRole("alert"));
    assertUnknown(container, row, false);

    await reloadWith(rerender, row, OUT.reload);
    expect(await failsCheck4(x)).toBe(false); // the student now passes check 4…
    expect(rowOf(container, x)).toBe(row); // …and the row is the same mounted element
    assertUnknown(container, row, true);
    assertTyped(form);
    const checked = within(row).getByRole("button", { name: OUT.checked });
    expect(reachable(checked)).toBe(true);
    checked.focus();
    expect(document.activeElement).toBe(checked);
    expect(ui.calls).toEqual(["assignPlan"]);
    expect(router.refresh).toHaveBeenCalledTimes(1); // the owner's reload only
    expect(await prisma.studentPlanAssignment.count({ where: { studentId: x } })).toBe(1);

    // Acknowledged: the approved default filtering applies again; the row is behind the disclosure, still the same element.
    await act(async () => fireEvent.click(checked));
    expect(reachable(row)).toBe(false);
    const toggle = within(container).getByRole("button", { name: new RegExp(AS.showAll.replace(" ({count})", "")) });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowOf(container, x)).toBe(row);
    expect(reachable(row)).toBe(true);
    expect(ui.calls).toEqual(["assignPlan"]);
  });

  it("another owner's assignment clears check 4 during recovery: still unknown, nothing resubmitted", async () => {
    const x = await newStudent("Mia");
    ui.impl = () => LOST(); // this request never reaches the server
    const { container, rerender } = render(await view());
    const row = rowOf(container, x);
    const form = typeAssignment(row);
    await act(async () => fireEvent.submit(form));
    assertUnknown(container, row, false);

    asOwner(secondOwner.id);
    const other = new FormData();
    for (const [k, v] of Object.entries({ studentId: x, effectiveYear: "2026", effectiveMonth: "12", planId: plan.id })) other.set(k, v);
    expect(await real.assignPlan(a.org.id, {}, other)).toEqual({ ok: true });

    await reloadWith(rerender, row, OUT.reload);
    expect(await failsCheck4(x)).toBe(false);
    expect(rowOf(container, x)).toBe(row);
    assertUnknown(container, row, true);
    assertTyped(form);
    expect(reachable(within(row).getByRole("button", { name: OUT.checked }))).toBe(true);
    expect(ui.calls).toEqual(["assignPlan"]);
    expect(await prisma.studentPlanAssignment.findMany({ where: { studentId: x }, select: { effectiveMonth: true } })).toEqual([{ effectiveMonth: 12 }]);
  });

  it("a normal successful assignment: the row stays mounted and its saved message visible; a fresh load filters it", async () => {
    const x = await newStudent("Noa");
    ui.impl = (_name, args) => realAssign(...args);
    const { container, rerender, unmount } = render(await view());
    const row = rowOf(container, x);
    const form = typeAssignment(row);
    await act(async () => fireEvent.submit(form));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect((form.querySelector("select[name=effectiveMonth]") as HTMLSelectElement).value).toBe("12"); // reset only on explicit success

    const next = await view(); // the refresh arrives
    await act(async () => rerender(next));
    expect(await failsCheck4(x)).toBe(false);
    expect(rowOf(container, x)).toBe(row);
    const status = within(row).getByRole("status");
    expect(status.textContent).toContain(OUT.saved);
    expect(reachable(status)).toBe(true);
    expect(ui.calls).toEqual(["assignPlan"]);
    unmount();

    const fresh = render(await view());
    expect(reachable(rowOf(fresh.container, x))).toBe(false); // default filtering on a new load
  });
});
