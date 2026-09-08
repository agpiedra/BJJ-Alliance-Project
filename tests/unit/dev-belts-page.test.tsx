/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import DevBeltsPage from "@/app/[locale]/dev/belts/page";
import esMessages from "../../messages/es.json";

describe("DevBeltsPage", () => {
  it("renders all 5 belts across all 5 stripe counts (25 total)", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <DevBeltsPage />
      </NextIntlClientProvider>,
    );
    const belts = screen.getAllByRole("img");
    expect(belts).toHaveLength(25);
  });

  it("includes the white belt with 0 stripes and the black belt with 4 stripes among them", () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <DevBeltsPage />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Cinturón Blanco, sin franjas")).toBeInTheDocument();
    expect(screen.getByText("Cinturón Negro, 4 franjas")).toBeInTheDocument();
  });
});
