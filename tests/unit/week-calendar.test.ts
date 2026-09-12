import { describe, expect, it } from "vitest";
import { rowFor, layoutOverlappingBlocks } from "@/components/ui/week-calendar";

describe("rowFor", () => {
  it("places 06:00 at row 2 (the first half-hour track)", () => {
    expect(rowFor(6, 0)).toBe(2);
  });

  it("advances one row per half hour", () => {
    expect(rowFor(6, 30)).toBe(3);
    expect(rowFor(7, 0)).toBe(4);
  });

  it("matches the brief's own worked example: 18:30 -> 19:30", () => {
    // 2 + (18-6)*2 + 1 = 27
    expect(rowFor(18, 30)).toBe(27);
    // 2 + (19-6)*2 + 1 = 29
    expect(rowFor(19, 30)).toBe(29);
  });
});

describe("layoutOverlappingBlocks", () => {
  it("gives a lone block the full column", () => {
    const result = layoutOverlappingBlocks([{ id: "a", startRow: 2, endRow: 4 }]);
    expect(result).toEqual([{ id: "a", columnIndex: 0, columnCount: 1 }]);
  });

  it("does NOT treat back-to-back blocks (one ends where the other starts) as overlapping", () => {
    const blocks = [
      { id: "a", startRow: 26, endRow: 28 }, // 18:00-19:00
      { id: "b", startRow: 28, endRow: 30 }, // 19:00-20:00
    ];
    const result = layoutOverlappingBlocks(blocks);
    for (const layout of result) {
      expect(layout.columnCount).toBe(1);
      expect(layout.columnIndex).toBe(0);
    }
  });

  it("splits two genuinely overlapping blocks 50/50 (the brief's 18:30/19:00 example)", () => {
    const blocks = [
      { id: "comp", startRow: rowFor(18, 30), endRow: rowFor(19, 30) }, // 18:30-19:30
      { id: "nineoclock", startRow: rowFor(19, 0), endRow: rowFor(20, 0) }, // 19:00-20:00
    ];
    const result = layoutOverlappingBlocks(blocks);
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get("comp")!.columnCount).toBe(2);
    expect(byId.get("nineoclock")!.columnCount).toBe(2);
    expect(byId.get("comp")!.columnIndex).not.toBe(byId.get("nineoclock")!.columnIndex);
  });

  it("gives three mutually overlapping blocks three lanes, not a hardcoded two", () => {
    const blocks = [
      { id: "a", startRow: 10, endRow: 20 },
      { id: "b", startRow: 12, endRow: 22 },
      { id: "c", startRow: 14, endRow: 24 },
    ];
    const result = layoutOverlappingBlocks(blocks);
    const columns = new Set(result.map((r) => r.columnIndex));
    expect(columns.size).toBe(3);
    for (const layout of result) {
      expect(layout.columnCount).toBe(3);
    }
  });

  it("keeps two independent (non-overlapping) pairs in separate groups with their own lane counts", () => {
    const blocks = [
      { id: "a1", startRow: 2, endRow: 4 },
      { id: "a2", startRow: 3, endRow: 5 }, // overlaps a1 -> group of 2
      { id: "b1", startRow: 20, endRow: 22 }, // isolated -> group of 1
    ];
    const result = layoutOverlappingBlocks(blocks);
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get("a1")!.columnCount).toBe(2);
    expect(byId.get("a2")!.columnCount).toBe(2);
    expect(byId.get("b1")!.columnCount).toBe(1);
  });

  it("reuses a freed lane instead of growing beyond the true concurrent max (a chain, not a clique)", () => {
    // a: 0-10, b: 5-15 (overlaps a), c: 12-20 (overlaps b, not a).
    // Never more than 2 concurrent -> should never need 3 lanes.
    const blocks = [
      { id: "a", startRow: 0, endRow: 10 },
      { id: "b", startRow: 5, endRow: 15 },
      { id: "c", startRow: 12, endRow: 20 },
    ];
    const result = layoutOverlappingBlocks(blocks);
    for (const layout of result) {
      expect(layout.columnCount).toBe(2);
    }
  });
});
