/** @vitest-environment jsdom */
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * At exactly ONE location there is nothing to choose between, so nothing should
 * offer a choice: no location switcher, no "all locations" option, and — the part
 * that was silently wrong — no label claiming "Both locations" for a scope that
 * is one. Every surface that offers "all" consults the same rule, so the next
 * one added cannot forget it (structural scan below).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/staff-shell/academy-switcher-actions", () => ({ setSelectedAcademy: vi.fn() }));
vi.mock("@/lib/payments/payment-actions", () => ({ recordPayment: vi.fn(), markPaymentPaid: vi.fn() }));

const { hasAcademyChoice, academyScopeLabel } = await import("../../src/lib/staff-shell/academy-choice");
const { AcademySwitcher } = await import("../../src/components/staff-sidebar/academy-switcher");
const { PaymentsTable } = await import("../../src/app/[locale]/(staff)/payments/payments-table");

const ONE = [{ id: "a1", name: "Heredia" }];
const TWO = [...ONE, { id: "a2", name: "Alajuela" }];

function inEnglish(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe("hasAcademyChoice", () => {
  it("is true only when there is more than one location to choose between", () => {
    expect(hasAcademyChoice([])).toBe(false);
    expect(hasAcademyChoice(ONE)).toBe(false);
    expect(hasAcademyChoice(TWO)).toBe(true);
  });
});

describe("academyScopeLabel", () => {
  const label = (isOwner: boolean, academies: typeof TWO, selectedAcademyId: string | null) =>
    academyScopeLabel({ isOwner, academies, selectedAcademyId, allLabel: "All locations" });

  it("REQUIRED: an Owner with ONE location is told that location's name — never 'All locations'", () => {
    expect(label(true, ONE, null)).toBe("Heredia");
  });

  it("an Owner with several locations sees 'All locations' until one is selected, then its name", () => {
    expect(label(true, TWO, null)).toBe("All locations");
    expect(label(true, TWO, "a2")).toBe("Alajuela");
  });

  it("a director or instructor is always told their own locations by name", () => {
    expect(label(false, ONE, null)).toBe("Heredia");
    expect(label(false, TWO, null)).toBe("Heredia, Alajuela");
  });
});

describe("the location switcher", () => {
  afterEach(cleanup);

  it("REQUIRED: at exactly one location an Owner gets no switcher and no 'all locations' — just the location's name", () => {
    render(inEnglish(<AcademySwitcher academies={ONE} selectedAcademyId={null} readOnly={false} />));

    expect(screen.getByText("Heredia")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/all locations/i)).toBeNull();
    expect(screen.queryByText(/both/i)).toBeNull();
  });

  it("with two or more locations an Owner gets the switcher, and its 'all' option says 'All locations'", () => {
    render(inEnglish(<AcademySwitcher academies={TWO} selectedAcademyId={null} readOnly={false} />));

    expect(screen.getByRole("button")).toBeTruthy();
    expect(screen.getByText("All locations")).toBeTruthy();
    expect(screen.getByText("View all locations")).toBeTruthy();
  });
});

describe("the Payments location filter", () => {
  afterEach(cleanup);

  const renderTable = (academies: typeof TWO) =>
    render(
      inEnglish(
        <PaymentsTable organizationId="org-1" rows={[]} plans={[]} academies={academies} currentYear={2026} currentMonth={9} canRecordPayments locale="en" />,
      ),
    );

  it("REQUIRED: is hidden at one location", () => {
    renderTable(ONE);
    expect(screen.queryByLabelText("Filter by academy")).toBeNull();
  });

  it("is shown with two or more, and its 'all' option says 'All locations'", () => {
    renderTable(TWO);
    const select = screen.getByLabelText("Filter by academy") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["All locations", "Heredia", "Alajuela"]);
  });
});

describe("the copy", () => {
  const BOTH_KEYS: Array<[string, string[]]> = [
    ["staffShell.academySwitcher.bothLabel", ["View all locations", "Ver todas las sedes"]],
    ["staffShell.academySwitcher.bothSelected", ["All locations", "Todas las sedes"]],
  ];
  const at = (messages: unknown, path: string) => path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], messages);

  it("REQUIRED: no message still says 'both' / 'ambas' for what is now 'all locations'", () => {
    for (const [path, [en, es]] of BOTH_KEYS) {
      expect(at(enMessages, path)).toBe(en);
      expect(at(esMessages, path)).toBe(es);
    }
    // Every "bothAcademies" filter option, wherever it lives.
    const collect = (node: unknown, found: unknown[] = []): unknown[] => {
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "bothAcademies") found.push(value);
          else collect(value, found);
        }
      }
      return found;
    };
    const enValues = collect(enMessages);
    const esValues = collect(esMessages);
    expect(enValues.length).toBe(3);
    expect(new Set(enValues)).toEqual(new Set(["All locations"]));
    expect(new Set(esValues)).toEqual(new Set(["Todas las sedes"]));
  });
});

describe("every surface that offers 'all locations' consults the same rule", () => {
  const OFFERS_ALL = /bothAcademies|academySwitcher\.both|["'`]both(Label|Selected)["'`]/;
  // A CALL, not a mention — an import left behind after the condition is deleted must not satisfy the scan.
  const CONSULTS_RULE = /\b(hasAcademyChoice|academyScopeLabel)\s*\(/;
  const offenders = (files: Array<{ file: string; text: string }>) =>
    files.filter(({ text }) => OFFERS_ALL.test(text) && !CONSULTS_RULE.test(text)).map(({ file }) => file);

  it("REQUIRED: no production file offers 'all locations' without hasAcademyChoice / academyScopeLabel", () => {
    expect(offenders(productionSourceFiles(["src"]))).toEqual([]);
  });

  it("the scan actually finds the surfaces it guards (so it cannot pass by matching nothing)", () => {
    const surfaces = productionSourceFiles(["src"]).filter(({ text }) => OFFERS_ALL.test(text));
    expect(surfaces.length).toBeGreaterThanOrEqual(5); // switcher, layout, students, analytics, payments
  });

  it("flags a file that offers 'all' without the rule (positive control)", () => {
    const planted = [
      { file: "bad.tsx", text: `<option value="">{t("filters.bothAcademies")}</option>` },
      { file: "good.tsx", text: `{hasAcademyChoice(academies) && <option>{t("filters.bothAcademies")}</option>}` },
      // The rule imported but never called (the condition was deleted) is still a violation.
      { file: "import-only.tsx", text: `import { hasAcademyChoice } from "x";\n<option>{t("filters.bothAcademies")}</option>` },
    ];
    expect(offenders(planted)).toEqual(["bad.tsx", "import-only.tsx"]);
  });
});
