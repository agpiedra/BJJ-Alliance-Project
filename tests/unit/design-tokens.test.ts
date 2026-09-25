import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/theme";

/**
 * design/matroom/tokens.css is the design authority for colour. This test reads THAT file (not a copy) and measures every
 * pair against the surface it actually sits on, so the authority and the rendered app cannot drift: a token edit that
 * breaks a threshold fails here, and globals.css is checked to import the file rather than redefine the values.
 */
const ROOT = join(__dirname, "..", "..");
const TOKENS = readFileSync(join(ROOT, "design", "matroom", "tokens.css"), "utf8");
const GLOBALS = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");

function block(css: string, selector: ":root" | ".dark"): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const end = css.indexOf("\n}", start);
  const vars: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const light = block(TOKENS, ":root");
const darkOnly = block(TOKENS, ".dark");
const dark = { ...light, ...darkOnly }; // .dark inherits :root for anything it does not override, exactly as the browser does
const THEMES = { light, dark } as const;
const hex = (theme: Record<string, string>, name: string) => {
  const v = theme[name];
  if (!/^#[0-9a-f]{6}$/i.test(v ?? "")) throw new Error(`--${name} is not a plain hex colour: ${v}`);
  return v;
};

type Pair = [fg: string, bg: string, min: number, why: string];
const SURFACES = ["background", "card", "muted"];
const PAIRS: Pair[] = [
  ...SURFACES.flatMap((s): Pair[] => [
    ["foreground", s, 4.5, "text"],
    ["muted-foreground", s, 4.5, "secondary text"],
    ["destructive", s, 4.5, "error text"],
    ["input", s, 3, "control boundary (WCAG 1.4.11)"],
    ["ring", s, 3, "focus ring"],
    ["primary", s, 4.5, "brand as text or link"],
    ["data", s, 3, "chart mark"],
    ["data-muted", s, 3, "secondary chart mark"],
  ]),
  ["brand-gold-foreground", "brand-gold", 4.5, "label on the action colour"],
  ["primary-foreground", "primary", 4.5, "label on primary"],
  ["secondary-foreground", "secondary", 4.5, "label on secondary"],
  ["accent-foreground", "accent", 4.5, "label on accent"],
  ["card-foreground", "card", 4.5, "card text"],
  ["popover-foreground", "popover", 4.5, "popover text"],
  ["data", "data-track", 3, "progress fill against its track"],
  ["input", "data-track", 3, "track edge"],
  ["sidebar-foreground", "sidebar", 4.5, "sidebar text"],
  ["sidebar-primary-foreground", "sidebar-primary", 4.5, "active nav label"],
  ["sidebar-accent-foreground", "sidebar-accent", 4.5, "hovered nav label"],
  ["sidebar-ring", "sidebar", 3, "focus ring on the sidebar"],
  ...(["ok", "warn", "bad"] as const).flatMap((k): Pair[] => [
    [k, "background", 4.5, `${k} text on ground`],
    [k, "card", 4.5, `${k} text on card`],
    [k, `${k}-soft`, 4.5, `${k} text on its own fill`],
    [`${k}-line`, "card", 3, `${k} border`],
  ]),
];

/** sRGB channel mix: what `color-mix(in srgb, a p%, b)` computes. */
function mixHex(a: string, b: string, p: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)).toString(16).padStart(2, "0")).join("");
}

describe("design/matroom/tokens.css", () => {
  for (const [themeName, theme] of Object.entries(THEMES)) {
    describe(themeName, () => {
      for (const [fg, bg, min, why] of PAIRS) {
        it(`--${fg} on --${bg} >= ${min}:1 (${why})`, () => {
          expect(contrastRatio(hex(theme, fg), hex(theme, bg))).toBeGreaterThanOrEqual(min);
        });
      }

      it("--sidebar-muted (74% sidebar-foreground over sidebar) >= 4.5:1 on the sidebar", () => {
        const mix = mixHex(hex(theme, "sidebar-foreground"), hex(theme, "sidebar"), 0.74);
        expect(contrastRatio(mix, hex(theme, "sidebar"))).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("declares --sidebar-muted as exactly that 74% mix, so the test above measures the real token", () => {
    expect(light["sidebar-muted"]).toBe("color-mix(in srgb, var(--sidebar-foreground) 74%, var(--sidebar))");
    expect(darkOnly["sidebar-muted"]).toBe(light["sidebar-muted"]);
  });

  it("the dark block overrides every colour token of :root except the theme-invariant families", () => {
    const invariant = /^(radius|chart-\d|belt-(blue|purple|brown|black)|class-.+|action-edge|brand-data)$/;
    const missing = Object.keys(light).filter((k) => !invariant.test(k) && !(k in darkOnly));
    // action-edge / brand-data are redeclared in .dark (they are var()-based and resolve per element), listed above only to stay out of this check
    expect(missing).toEqual([]);
  });

  it("the sidebar-foreground focus ring is scoped to the sidebar and banner SURFACES, not to every element carrying data-sidebar", () => {
    // A bare `[data-sidebar]:focus-visible` also matched the sidebar trigger in the page header, where a tenant's near-white
    // sidebar foreground is invisible on the ivory header (found by the real-app audit: 1.06:1).
    expect(GLOBALS).toContain('[data-sidebar="sidebar"] :focus-visible');
    expect(GLOBALS).toContain('[data-sidebar="banner"] :focus-visible');
    expect(GLOBALS).not.toMatch(/\[data-sidebar\]:focus-visible/);
    expect(GLOBALS).not.toMatch(/(^|[\s,])\[data-sidebar\]\s+:focus-visible/m);
  });

  it("touch targets: a coarse-pointer base rule sizes every plain form control, checkbox and disclosure, whatever class a page gives it", () => {
    // Found by the coarse-pointer emulation (390px, pointer: coarse): page-local field classes rendered 36-42px, native checkboxes
    // 13px and <summary> rows 20px. Emulation, not a real device; the rule is what makes the numbers hold.
    const block = GLOBALS.slice(GLOBALS.indexOf("@media (pointer: coarse)"));
    expect(GLOBALS).toContain("@media (pointer: coarse)");
    expect(block).toMatch(/select,\s*textarea\s*\{\s*min-height: 2\.75rem;/);
    expect(block).toMatch(/input\[type="checkbox"\], input\[type="radio"\]\s*\{\s*width: 1\.5rem;\s*height: 1\.5rem;/);
    expect(block).toMatch(/label:has\(> input\[type="checkbox"\], > input\[type="radio"\]\)\s*\{\s*min-height: 2\.75rem;/);
    expect(block).toMatch(/summary\s*\{\s*min-height: 2\.75rem;/);
  });

  it("standalone links and the portal avatar grow on coarse pointers (they measured 20px and 32px)", () => {
    const read = (rel: string) => readFileSync(join(ROOT, ...rel.split("/")), "utf8");
    for (const [file, needle] of [
      ["src/app/[locale]/login/login-form.tsx", "forgot-password`} className=\"text-sm underline pointer-coarse:py-3\""],
      ["src/app/[locale]/login/login-form.tsx", "register-academy`} className=\"mt-4 text-sm underline pointer-coarse:py-3\""],
      ["src/app/[locale]/page.tsx", "login`} className=\"text-sm underline pointer-coarse:py-3\""],
      ["src/app/[locale]/(staff)/payments/page.tsx", "payments/plans`} className=\"text-sm underline pointer-coarse:py-3\""],
      ["src/app/[locale]/portal/portal-top-bar.tsx", "size-8 pointer-coarse:size-11"],
    ] as const) {
      expect(read(file), `${file}: ${needle}`).toContain(needle);
    }
  });

  it("globals.css imports the authority file and does not redefine its colours", () => {
    expect(GLOBALS).toContain('@import "../../design/matroom/tokens.css";');
    for (const name of ["background", "foreground", "card", "brand-gold", "input", "ok", "data"]) {
      expect(GLOBALS, `--${name} must live in design/matroom/tokens.css only`).not.toMatch(new RegExp(`^\\s*--${name}:`, "m"));
    }
  });
});
