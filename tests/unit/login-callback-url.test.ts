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

  it("rejects a leading-backslash bypass", () => {
    expect(sanitizeCallbackUrl("/\\evil.example")).toBeUndefined();
  });

  it("rejects a backslash bypass with a control character prefix", () => {
    expect(sanitizeCallbackUrl("/\t//evil.example")).toBeUndefined();
  });

  it("still allows a normal relative path with a query string", () => {
    expect(sanitizeCallbackUrl("/es/students?status=PENDING")).toBe("/es/students?status=PENDING");
  });

  // Belt-and-braces around the WHATWG backslash equivalence the string-based
  // predecessor missed — every one of these resolves off-site in a browser.
  it("rejects further backslash / control-character open-redirect payloads", () => {
    expect(sanitizeCallbackUrl("/\\\\evil.example")).toBeUndefined();
    expect(sanitizeCallbackUrl("/\r\n\\evil.example")).toBeUndefined();
    expect(sanitizeCallbackUrl("\\\\evil.example")).toBeUndefined();
    expect(sanitizeCallbackUrl("/\t/\\evil.example")).toBeUndefined();
  });

  it("rejects a non-http scheme", () => {
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBeUndefined();
  });
});
