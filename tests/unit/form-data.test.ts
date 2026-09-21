import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formDataToObject } from "../../src/lib/form-data";

describe("formDataToObject", () => {
  it("drops the framework's hidden $ACTION_* fields and keeps everything the visitor submitted", () => {
    const fd = new FormData();
    fd.set("$ACTION_REF_1", "");
    fd.set("$ACTION_1:0", '{"id":"abc","bound":"$@1"}');
    fd.set("$ACTION_1:1", "[{}]");
    fd.set("$ACTION_KEY", "k123");
    fd.set("organizationName", "Dojo");
    fd.set("termsAccepted", "on");

    expect(formDataToObject(fd)).toEqual({ organizationName: "Dojo", termsAccepted: "on" });
  });

  it("keeps a genuinely unknown field — it is the schema's job to reject it, not this function's to hide it", () => {
    const fd = new FormData();
    fd.set("$ACTION_KEY", "k123");
    fd.set("primaryColor", "#FF0000");

    expect(formDataToObject(fd)).toEqual({ primaryColor: "#FF0000" });
  });

  it("keeps file values as files", () => {
    const fd = new FormData();
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    fd.set("logo", file);

    expect(formDataToObject(fd).logo).toBeInstanceOf(File);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "generated" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe("structural guard: strict form schemas never parse raw form data", () => {
  it("REQUIRED: no file using z.strictObject reads FormData through Object.fromEntries — it must use formDataToObject", () => {
    // `useActionState` forms carry the framework's hidden `$ACTION_*` fields.
    // A strictObject fed the raw entries rejects EVERY genuine browser
    // submission with no field errors — this shipped once on the public
    // registration form (revision 33) and was invisible to every test, because
    // tests build their FormData by hand. Found twice now (billing, then
    // registration); this makes a third impossible to add quietly.
    const offenders = sourceFiles(path.join(process.cwd(), "src"))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        // The CALL, not the word: billing-actions.ts deliberately uses plain
        // z.object and merely mentions strictObject in a comment.
        return /z\.strictObject\(/.test(text) && /Object\.fromEntries\(\s*formData/.test(text);
      })
      .map((file) => path.relative(process.cwd(), file));

    expect(offenders, "parse FormData with formDataToObject(formData) from @/lib/form-data").toEqual([]);
  });
});
