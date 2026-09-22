import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Every `.ts`/`.tsx` file under `dirs` (relative to the repo root), skipping
 * the generated Prisma client. For structural guard tests that scan production
 * code for a pattern that must never appear. */
export function productionSourceFiles(dirs: string[] = ["src", "scripts"]): Array<{ file: string; text: string }> {
  const root = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return entry === "generated" || entry === "node_modules" ? [] : walk(full);
      return /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });

  return dirs
    .filter((dir) => statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory())
    .flatMap((dir) => walk(path.join(root, dir)))
    .map((full) => ({ file: path.relative(root, full), text: readFileSync(full, "utf8") }));
}

/** The text without block or line comments, string contents kept — for scans that need to read a string literal, such as a role name. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** An argument list split at its top-level commas (commas inside `()`, `[]` or `{}` do not split), each part trimmed; a trailing comma leaves no empty part. */
export function splitArguments(argumentText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argumentText.length; i += 1) {
    const char = argumentText[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(argumentText.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = argumentText.slice(start).trim();
  if (last !== "" || parts.length === 0) parts.push(last);
  return parts;
}

/** The argument text of every call to `name(...)` in `text` (balanced parentheses), for text that has already been through `stripComments`. The definition (`function name(`) is not a call. */
export function callArguments(text: string, name: string): string[] {
  const calls: string[] = [];
  const opening = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    if (/\bfunction\s+$/.test(text.slice(0, match.index))) continue;
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")") depth -= 1;
      end += 1;
    }
    calls.push(text.slice(match.index + match[0].length, end - 1).trim());
  }
  return calls;
}
