import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/analytics/csv";

describe("toCsv", () => {
  it("builds a header row from the first object's keys, plus one row per object", () => {
    const csv = toCsv([
      { name: "Ana", count: 3 },
      { name: "Beto", count: 5 },
    ]);
    expect(csv).toBe("name,count\r\nAna,3\r\nBeto,5");
  });

  it("quotes and escapes a value containing a comma", () => {
    expect(toCsv([{ label: "Escazú, Costa Rica" }])).toBe('label\r\n"Escazú, Costa Rica"');
  });

  it("quotes and escapes a value containing a double quote by doubling it", () => {
    expect(toCsv([{ label: 'She said "hi"' }])).toBe('label\r\n"She said ""hi"""');
  });

  it("quotes and escapes a value containing a newline", () => {
    expect(toCsv([{ label: "line one\nline two" }])).toBe('label\r\n"line one\nline two"');
  });

  it("an empty rows array produces an empty, header-less string", () => {
    expect(toCsv([])).toBe("");
  });

  it("prefixes a value starting with = with a single quote to prevent formula injection", () => {
    expect(toCsv([{ label: "=1+1" }])).toBe("label\r\n'=1+1");
  });

  it("prefixes a value starting with + with a single quote to prevent formula injection", () => {
    expect(toCsv([{ label: "+1+1" }])).toBe("label\r\n'+1+1");
  });

  it("prefixes a value starting with - with a single quote to prevent formula injection", () => {
    expect(toCsv([{ label: "-1+1" }])).toBe("label\r\n'-1+1");
  });

  it("prefixes a value starting with @ with a single quote to prevent formula injection", () => {
    expect(toCsv([{ label: "@example.com" }])).toBe("label\r\n'@example.com");
  });

  it("does not prefix a normal value with no leading special character", () => {
    expect(toCsv([{ label: "Ana Perez" }])).toBe("label\r\nAna Perez");
  });

  it("both prefixes AND quote-wraps a formula-leading value that also contains a comma", () => {
    expect(toCsv([{ label: "=HYPERLINK(\"http://evil\"), Ana" }])).toBe(
      'label\r\n"\'=HYPERLINK(""http://evil""), Ana"',
    );
  });
});
