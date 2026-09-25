/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { ProgressToNextGrade } from "@/components/belt-graphic/progress-to-next-grade";

const classes = (el: Element) => el.getAttribute("class") ?? "";

describe("Button (MATROOM Phase 1)", () => {
  it("loading disables the button, marks it busy, keeps its label and adds a decorative spinner", () => {
    render(<Button loading>Guardar</Button>);
    const b = screen.getByRole("button", { name: "Guardar" });
    expect(b).toBeDisabled();
    expect(b.getAttribute("aria-busy")).toBe("true");
    const spinner = b.querySelector("svg");
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute("aria-hidden")).toBe("true");
  });

  it("is not busy and has no spinner by default, and stays enabled", () => {
    render(<Button>Guardar</Button>);
    const b = screen.getByRole("button", { name: "Guardar" });
    expect(b).toBeEnabled();
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.querySelector("svg")).toBeNull();
  });

  it("an explicitly disabled button is not busy", () => {
    render(<Button disabled>Guardar</Button>);
    expect(screen.getByRole("button", { name: "Guardar" }).getAttribute("aria-busy")).toBeNull();
  });

  it("the primary variant draws the tenant's action colour with the presentation edge token", () => {
    render(<Button variant="primary">Inscribir</Button>);
    const c = classes(screen.getByRole("button", { name: "Inscribir" }));
    expect(c).toContain("bg-brand-gold");
    expect(c).toContain("border-action-edge");
  });

  it("is disabled by fill and text, not by fading the tenant colour", () => {
    render(<Button variant="primary" disabled>Inscribir</Button>);
    const c = classes(screen.getByRole("button", { name: "Inscribir" }));
    expect(c).toContain("disabled:bg-muted");
    expect(c).toContain("disabled:text-muted-foreground");
    expect(c).not.toContain("disabled:opacity-50");
  });

  it("every size grows to a 44px touch target on coarse pointers", () => {
    for (const size of ["default", "sm", "lg", "icon", "icon-sm", "icon-lg"] as const) {
      const { unmount } = render(<Button size={size}>x</Button>);
      expect(classes(screen.getByRole("button")), size).toMatch(/pointer-coarse:(h|size)-11/);
      unmount();
    }
  });

  it("keeps its label when it is the render target of a Base UI trigger (the schedule page's Sheet trigger)", () => {
    // Regression: re-passing `children` as JSX children rendered this trigger EMPTY in the real app (found in the browser,
    // not by any contrast measurement). jsdom cannot reproduce the RSC path, so this pins the contract; the browser check
    // is recorded in the PR.
    render(
      <Sheet>
        <SheetTrigger render={<Button type="button" variant="primary" size="sm" />}>Nueva clase</SheetTrigger>
      </Sheet>,
    );
    expect(screen.getByRole("button", { name: "Nueva clase" })).toBeInTheDocument();
  });

  it("loading keeps the label of a render-target button too, with the spinner in front", () => {
    render(<Button loading render={<span role="button" />}>Guardar</Button>);
    expect(screen.getByText("Guardar")).toBeInTheDocument();
  });

  it("does not switch the browser focus outline off (the global 2px ring must show)", () => {
    render(<Button>x</Button>);
    expect(classes(screen.getByRole("button"))).not.toMatch(/(^|\s)outline-none(\s|$)/);
  });
});

describe("Input (MATROOM Phase 1)", () => {
  it("uses the control-boundary token on a card-coloured fill, at 44px on coarse pointers", () => {
    render(<Input aria-label="Correo" />);
    const c = classes(screen.getByRole("textbox", { name: "Correo" }));
    expect(c).toContain("border-input");
    expect(c).toContain("bg-card");
    expect(c).toContain("pointer-coarse:h-11");
    expect(c).not.toMatch(/(^|\s)bg-transparent(\s|$)/); // the bare utility; `file:bg-transparent` on the file-picker button is fine
  });

  it("an invalid input gets a thicker destructive border, not only a colour change", () => {
    render(<Input aria-label="Correo" aria-invalid="true" />);
    const c = classes(screen.getByRole("textbox", { name: "Correo" }));
    expect(c).toContain("aria-invalid:border-destructive");
    expect(c).toContain("aria-invalid:border-2");
  });

  it("disabled reads as disabled by fill and text", () => {
    render(<Input aria-label="Correo" disabled />);
    const c = classes(screen.getByRole("textbox", { name: "Correo" }));
    expect(c).toContain("disabled:bg-muted");
    expect(c).toContain("disabled:text-muted-foreground");
  });
});

describe("Card (MATROOM Phase 1)", () => {
  it("has a hairline border on the card surface, not a translucent foreground ring", () => {
    render(<Card data-testid="c">x</Card>);
    const c = classes(screen.getByTestId("c"));
    expect(c).toContain("border");
    expect(c).toContain("border-border");
    expect(c).not.toContain("ring-foreground/10");
  });
});

describe("ProgressToNextGrade (MATROOM Phase 1)", () => {
  it("is a real progressbar with its value and range, so the bar is not colour-only", () => {
    render(<ProgressToNextGrade current={20} target={60} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("60");
    expect(screen.getByText("20 / 60")).toBeInTheDocument();
  });

  it("draws the track with the control-boundary edge and the fill with the data colours (never foreground/40)", () => {
    const { container, rerender } = render(<ProgressToNextGrade current={20} target={60} />);
    const track = screen.getByRole("progressbar");
    expect(classes(track)).toContain("border-input");
    expect(classes(track)).toContain("bg-data-track");
    const fill = () => container.querySelector("[data-fill]")!;
    expect(classes(fill())).toContain("bg-data");
    expect(classes(fill())).not.toContain("foreground/40");
    rerender(<ProgressToNextGrade current={58} target={60} />);
    expect(classes(fill())).toContain("bg-brand-data"); // near completion: the tenant colour, lightness-adjusted to 3:1 by BrandingScope
  });

  it("clamps the fill at 100% and handles a zero target", () => {
    const { container, rerender } = render(<ProgressToNextGrade current={99} target={30} />);
    expect((container.querySelector("[data-fill]") as HTMLElement).style.width).toBe("100%");
    rerender(<ProgressToNextGrade current={5} target={0} />);
    expect((container.querySelector("[data-fill]") as HTMLElement).style.width).toBe("0%");
  });
});
