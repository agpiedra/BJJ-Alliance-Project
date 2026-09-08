import { describe, expect, it } from "vitest";
import { sanitizeCallbackUrl } from "@/lib/callback-url";

describe("sanitizeCallbackUrl", () => {
  it("passes through a normal same-origin relative path unchanged", () => {
    expect(sanitizeCallbackUrl("/en/dashboard")).toBe("/en/dashboard");
  });

  it("passes through a relative path with a query string unchanged", () => {
    expect(sanitizeCallbackUrl("/es/students?tab=active")).toBe("/es/students?tab=active");
  });

  it("returns undefined for undefined input", () => {
    expect(sanitizeCallbackUrl(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(sanitizeCallbackUrl("")).toBeUndefined();
  });

  it("rejects an absolute off-site URL", () => {
    expect(sanitizeCallbackUrl("https://evil.example")).toBeUndefined();
  });

  it("rejects an absolute off-site URL with a path", () => {
    expect(sanitizeCallbackUrl("https://evil.example/phish")).toBeUndefined();
  });

  it("rejects a protocol-relative URL (parsed by browsers as scheme-relative)", () => {
    expect(sanitizeCallbackUrl("//evil.example")).toBeUndefined();
  });

  it("rejects a bare host with no leading slash", () => {
    expect(sanitizeCallbackUrl("evil.example")).toBeUndefined();
  });
});
