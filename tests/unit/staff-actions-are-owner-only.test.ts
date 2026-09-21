import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Staff management is OWNER ONLY. An action that quietly loses its gate is
 * exactly the kind of regression nothing else notices: a location director
 * could invite an Owner, or deactivate the person above them. Every exported
 * action in `staff-actions.ts` must resolve its context with exactly
 * `["ADMIN"]` — not `["ADMIN", "DIRECTOR"]`, not no role list at all.
 *
 * A text scan like the project's other structural guards: it cannot prove the
 * gate is reached, only that no exported action stops naming it. The
 * behaviour is proved by tests/integration/staff-management.test.ts, which
 * calls every action as a director and an instructor and expects FORBIDDEN.
 */
const OWNER_GATE = /resolveActionContext\(\s*organizationId\s*,\s*\[\s*"ADMIN"\s*\]\s*\)/;

/** Names of exported async functions whose body does not demand the Owner. */
export function actionsWithoutOwnerGate(text: string): string[] {
  const parts = text.split(/^export async function /m).slice(1);
  return parts
    .map((part) => ({ name: part.slice(0, part.indexOf("(")), body: part }))
    .filter(({ body }) => !OWNER_GATE.test(body))
    .map(({ name }) => name);
}

// Adding a location is Owner-only too: it mints a device credential and a new
// tenant-scoped place, so it is held to the same scan.
const OWNER_ONLY_FILES = [
  { file: "src/lib/staff/staff-actions.ts", minActions: 6 },
  { file: "src/lib/locations/location-actions.ts", minActions: 1 },
];

describe.each(OWNER_ONLY_FILES)("every action in $file demands the Owner", ({ file, minActions }) => {
  const source = readFileSync(path.join(process.cwd(), file), "utf8");

  it("REQUIRED: no exported action lacks the ADMIN-only gate", () => {
    expect(actionsWithoutOwnerGate(source)).toEqual([]);
  });

  it("the file actually exports actions (so the scan cannot pass by finding none)", () => {
    expect(source.match(/^export async function /gm)?.length ?? 0).toBeGreaterThanOrEqual(minActions);
  });
});

describe("the Owner-only scanner", () => {

  describe("the scanner can actually flag a missing or widened gate (positive controls)", () => {
    it("flags an action that never resolves a context", () => {
      expect(actionsWithoutOwnerGate("export async function sneaky(organizationId: string) {\n  return { ok: true };\n}\n")).toEqual(["sneaky"]);
    });

    it("flags a gate widened to directors", () => {
      const widened = 'export async function wide(organizationId: string) {\n  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);\n}\n';
      expect(actionsWithoutOwnerGate(widened)).toEqual(["wide"]);
    });

    it("flags a gate with no role list at all", () => {
      expect(actionsWithoutOwnerGate("export async function open(organizationId: string) {\n  await resolveActionContext(organizationId);\n}\n")).toEqual(["open"]);
    });

    it("passes an action that demands exactly the Owner", () => {
      expect(actionsWithoutOwnerGate('export async function ok(organizationId: string) {\n  await resolveActionContext(organizationId, ["ADMIN"]);\n}\n')).toEqual([]);
    });
  });
});
