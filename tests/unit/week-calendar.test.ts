import { describe, expect, it } from "vitest";
import { layoutOverlappingBlocks, clampBlockRows, CALENDAR_START_HOUR, CALENDAR_END_HOUR } from "@/components/ui/week-calendar";
import { rowFor } from "@/components/ui/week-calendar-grid";

const MIN_ROW = 2; // rowFor(CALENDAR_START_HOUR, 0)
const MAX_ROW = 2 + (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * 2; // rowFor(CALENDAR_END_HOUR, 0)

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

describe("clampBlockRows", () => {
  it("leaves a block fully inside the visible window untouched", () => {
    // 18:00-19:00
    expect(clampBlockRows(rowFor(18, 0), rowFor(19, 0), MIN_ROW, MAX_ROW)).toEqual({
      startRow: rowFor(18, 0),
      endRow: rowFor(19, 0),
    });
  });

  it("rejects a block entirely before the grid's start hour (e.g. a 05:00 class)", () => {
    // 05:00-05:30 -> rowFor(5,0) = 0, rowFor(5,30) = 1, both before MIN_ROW (2).
    expect(clampBlockRows(rowFor(5, 0), rowFor(5, 30), MIN_ROW, MAX_ROW)).toBeNull();
  });

  it("rejects a block entirely after the grid's end hour", () => {
    // 21:00-22:00, both rows past MAX_ROW.
    expect(clampBlockRows(rowFor(21, 0), rowFor(22, 0), MIN_ROW, MAX_ROW)).toBeNull();
  });

  it("clamps the start of a class that begins before the grid's start hour but runs into it", () => {
    // 05:30-06:30 -> starts one half-hour before the grid, ends inside it.
    const result = clampBlockRows(rowFor(5, 30), rowFor(6, 30), MIN_ROW, MAX_ROW);
    expect(result).toEqual({ startRow: MIN_ROW, endRow: rowFor(6, 30) });
  });

  it("clamps the end of a class that starts inside the grid but runs past its end hour", () => {
    // 19:30-20:30 -> ends one half-hour past the grid's last track (20:00).
    const result = clampBlockRows(rowFor(19, 30), rowFor(20, 30), MIN_ROW, MAX_ROW);
    expect(result).toEqual({ startRow: rowFor(19, 30), endRow: MAX_ROW });
  });

  it("does not reject a class that ends exactly at the grid's end hour", () => {
    // 19:00-20:00 -> endRow === MAX_ROW exactly, which is a valid (not "past the end") block.
    expect(clampBlockRows(rowFor(19, 0), rowFor(20, 0), MIN_ROW, MAX_ROW)).toEqual({
      startRow: rowFor(19, 0),
      endRow: MAX_ROW,
    });
  });
});
