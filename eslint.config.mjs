import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/prisma/unscoped",
              message:
                "Importing unscopedPrisma bypasses tenant scoping entirely. If this call site is genuinely platform-level, add it to the allowlist in eslint.config.mjs with a one-line reason — never import it silently.",
            },
          ],
          patterns: [
            {
              group: ["**/prisma/unscoped", "**/lib/prisma/unscoped"],
              message:
                "Importing unscopedPrisma bypasses tenant scoping entirely — relative paths are banned too. Add the file to the allowlist in eslint.config.mjs with a one-line reason.",
            },
          ],
        },
      ],
    },
  },
  {
    // Allowlist: every file below has a one-line reason next to its own
    // unscopedPrisma import explaining why it's a legitimate hatch.
    // Keep this list and those comments in sync — add both together.
    //
    // Deliberately no bracketed Next.js route paths here: every genuinely
    // platform-level operation was extracted into named, single-purpose
    // functions in src/lib/tenant/platform-lookups.ts. Route files import
    // one of those functions now, never unscopedPrisma directly — so the
    // bracket-as-character-class glob bug that hid three entries from this
    // list structurally cannot recur.
    files: [
      "src/lib/prisma.ts",
      "src/lib/tenant/scoped-client.ts",
      "src/lib/tenant/platform-lookups.ts",
      "tests/integration/tenant-guard-transaction.test.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },
];

export default eslintConfig;