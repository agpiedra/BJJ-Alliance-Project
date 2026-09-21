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
