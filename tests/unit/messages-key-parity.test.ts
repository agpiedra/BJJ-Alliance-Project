import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 7: "every new string exists in both
 * messages/es.json and messages/en.json; a test asserts key parity." Walks
 * both trees to their leaves (a translated string, never an object) and
 * diffs the full dotted-path key sets — catches a key added to one locale
 * and forgotten in the other, in either direction, at any nesting depth.
 */
function leafKeyPaths(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) {
    return [prefix];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leafKeyPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("messages/en.json and messages/es.json key parity", () => {
  it("have exactly the same set of leaf keys", () => {
    const enKeys = new Set(leafKeyPaths(en));
    const esKeys = new Set(leafKeyPaths(es));

    const missingFromEs = [...enKeys].filter((key) => !esKeys.has(key)).sort();
    const missingFromEn = [...esKeys].filter((key) => !enKeys.has(key)).sort();

    expect(missingFromEs, "keys present in en.json but missing from es.json").toEqual([]);
    expect(missingFromEn, "keys present in es.json but missing from en.json").toEqual([]);
  });

  it("every leaf value is a non-empty string, in both locales", () => {
    for (const [locale, messages] of [
      ["en", en],
      ["es", es],
    ] as const) {
      for (const path of leafKeyPaths(messages)) {
        const value = path.split(".").reduce<unknown>((node, segment) => (node as Record<string, unknown>)[segment], messages);
        expect(typeof value, `${locale}:${path} should be a string`).toBe("string");
        expect((value as string).length > 0, `${locale}:${path} should not be empty`).toBe(true);
      }
    }
  });
});
