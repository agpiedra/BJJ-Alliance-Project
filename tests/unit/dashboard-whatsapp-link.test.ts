import { describe, expect, it } from "vitest";
import { buildWhatsAppLink } from "@/app/[locale]/(staff)/dashboard/whatsapp-link";

describe("buildWhatsAppLink", () => {
  it("prefixes 506 for a plain 8-digit local number", () => {
    expect(buildWhatsAppLink("8888-8888", "hola")).toBe("https://wa.me/50688888888?text=hola");
  });

  it("accepts an already-prefixed 11-digit 506 number as-is", () => {
    expect(buildWhatsAppLink("+506 8888 8888", "hola")).toBe("https://wa.me/50688888888?text=hola");
  });

  it("returns null for free text with no plausible phone number", () => {
    expect(buildWhatsAppLink("no tiene", "hola")).toBeNull();
  });

  it("returns null for a digit count that isn't a plausible CR number", () => {
    expect(buildWhatsAppLink("12345", "hola")).toBeNull();
  });
});
