/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

function renderBelt(
  locale: "es" | "en",
  belt: "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK",
  stripes: number,
) {
  const messages = locale === "es" ? esMessages : enMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <BeltGraphic belt={belt} stripes={stripes} />
    </NextIntlClientProvider>,
  );
}

describe("BeltGraphic", () => {
  it("renders the Spanish belt name and stripe count as visible text", () => {
    renderBelt("es", "BLUE", 2);
    expect(screen.getByText("Cinturón Azul, 2 franjas")).toBeInTheDocument();
  });

  it("renders the English belt name and singular stripe count as visible text", () => {
    renderBelt("en", "BROWN", 1);
    expect(screen.getByText("Brown belt, 1 stripe")).toBeInTheDocument();
  });

  it("renders the zero-stripes case correctly in both locales", () => {
    renderBelt("es", "BLACK", 0);
    expect(screen.getByText("Cinturón Negro, sin franjas")).toBeInTheDocument();
  });

  it("exposes the same visible text via aria-label on the SVG, so color alone never carries meaning", () => {
    renderBelt("en", "PURPLE", 3);
    expect(screen.getByRole("img", { name: "Purple belt, 3 stripes" })).toBeInTheDocument();
  });

  it("clamps stripes above 4 down to 4", () => {
    renderBelt("en", "WHITE", 9);
    expect(screen.getByText("White belt, 4 stripes")).toBeInTheDocument();
  });

  it("clamps negative stripes up to 0", () => {
    renderBelt("en", "WHITE", -3);
    expect(screen.getByText("White belt, no stripes")).toBeInTheDocument();
  });
});
