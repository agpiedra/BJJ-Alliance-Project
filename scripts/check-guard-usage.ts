/**
 * Mechanizes MULTI_ACADEMY_AND_KIDS_BELTS.md's global rule (revision 16):
 * "CI must fail on an exported guard with zero production call sites; a
 * security helper that only its own test imports is dead code wearing a
 * safety label."
 *
 * Scope: every exported function/const from the enforcement-primitive
 * modules — src/lib/tenant/** and src/lib/auth/**. For each, this searches
 * every .ts/.tsx file under src/** (excluding the generated Prisma client)
 * for a real reference to its name — not just src/app and src/lib: a real
 * caller can live directly under src/ (auth.ts, middleware.ts) or under
 * src/components, src/hooks, src/i18n, src/types. tests/ is never part of
 * the search corpus — a test calling
 * the helper directly does not count as a production call site, which is
 * exactly the gap this check exists to catch (the Prisma tenant extension
 * lived inside getScopedDb() with zero callers while its own test suite
 * passed; requireOrganizationAccess() had the same shape).
 *
 * Deliberately excludes `export class` and `export type`/`interface` — this
 * rule is about callable guards, not error types or type-only exports.
 *
 * A guard's OWN defining file is not excluded outright (a file that exports
 * several guards calling each other, like context.ts's requireTenantContext
 * calling getTenantContext, is a real production call site) — instead, an
 * occurrence count of exactly 1 in the guard's own file (nothing beyond its
 * own declaration) combined with zero occurrences anywhere else is what
 * counts as "zero production call sites."
 *
 * This is a name-based text search, not full symbol resolution: cheap, and
 * accurate enough for two narrow, well-known directories — a real cross-file
 * import-graph tool (ts-morph, knip) is a bigger dependency than this
 * narrowly-scoped security check needs.
 *
 * Usage: tsx scripts/check-guard-usage.ts
 * Exits 1 and lists every offending export if any guard has zero real
 * production call sites.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "..");
const GUARD_DIRS = ["src/lib/tenant", "src/lib/auth"];
const SEARCH_DIRS = ["src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
// The generated Prisma client — huge, irrelevant, and never calls app-level guards.
const EXCLUDED_DIR_NAMES = new Set(["generated"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...listSourceFiles(join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

interface GuardExport {
  name: string;
  file: string; // absolute path
}

/** Exported function declarations and exported const bindings only — see the module doc comment for why classes/types are out of scope. */
function collectGuardExports(file: string): GuardExport[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: GuardExport[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name) {
      found.push({ name: node.name.text, file });
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          found.push({ name: declaration.name.text, file });
        }
      }
    }
  });

  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(pattern: RegExp, content: string): number {
  return content.match(pattern)?.length ?? 0;
}

function main() {
  const guardFiles = GUARD_DIRS.flatMap((dir) => listSourceFiles(join(ROOT, dir)));
  const guards = guardFiles.flatMap(collectGuardExports);

  const searchFiles = SEARCH_DIRS.flatMap((dir) => listSourceFiles(join(ROOT, dir)));
  const fileContents = new Map<string, string>();
  for (const file of searchFiles) {
    fileContents.set(file, readFileSync(file, "utf8"));
  }

  const offenders: GuardExport[] = [];
  for (const guard of guards) {
    const pattern = new RegExp(`\\b${escapeRegExp(guard.name)}\\b`, "g");
    const ownFileContent = fileContents.get(guard.file) ?? "";
    const ownFileOccurrences = countOccurrences(pattern, ownFileContent);

    const usedElsewhere = searchFiles.some((file) => {
      if (file === guard.file) return false;
      return pattern.test(fileContents.get(file)!);
    });

    // Exactly 1 in its own file means nothing beyond the declaration itself
    // referenced it there either.
    if (!usedElsewhere && ownFileOccurrences <= 1) {
      offenders.push(guard);
    }
  }

  if (offenders.length > 0) {
    console.error("check:guard-usage — exported guard(s) with ZERO production call sites:\n");
    for (const offender of offenders) {
      console.error(`  ${offender.name}  (${relative(ROOT, offender.file)})`);
    }
    console.error(
      "\nA security helper that only its own test imports is dead code wearing a safety label\n" +
        "(MULTI_ACADEMY_AND_KIDS_BELTS.md, Global rules). Wire it into a real caller under\n" +
        "src/app or src/lib, or remove the export.",
    );
    process.exit(1);
  }

  console.log(`check:guard-usage — all ${guards.length} exported guard(s) have a real production call site.`);
}

main();
