/**
 * Compares two scripts/alliance-baseline.ts snapshot files for the CI
 * parity check (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 0: "seed ->
 * snapshot -> migrate -> snapshot -> diff. Any unexpected difference fails
 * the build."). Ignores fields that are expected to legitimately differ
 * between two runs (capturedAt is a timestamp) rather than diffing raw JSON
 * text.
 *
 * Usage: tsx scripts/diff-snapshots.ts <before.json> <after.json>
 * Exits 1 and prints the first mismatch path if anything else differs.
 */
import { readFileSync } from "node:fs";

const IGNORED_KEYS = new Set(["capturedAt"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (IGNORED_KEYS.has(k)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

function findFirstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const diff = findFirstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const diff = findFirstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  if (a !== b) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  return null;
}

function main() {
  const [, , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    throw new Error("Usage: tsx scripts/diff-snapshots.ts <before.json> <after.json>");
  }

  const before = normalize(JSON.parse(readFileSync(beforePath, "utf8")));
  const after = normalize(JSON.parse(readFileSync(afterPath, "utf8")));

  const diff = findFirstDiff(before, after);
  if (diff) {
    console.error(`Snapshot mismatch: ${diff}`);
    process.exitCode = 1;
    return;
  }
  console.log("Snapshots match (ignoring capturedAt).");
}

main();
