import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
    server: {
      // Force next-auth through Vite's own resolver (which honors the
      // "next/server" alias below) instead of Node's native ESM loader —
      // see the alias comment for why the bare import otherwise fails.
      deps: { inline: ["next-auth"] },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // next-auth's compiled ESM does `import ... from "next/server"` with no
      // extension. Next's package.json has no "exports" map, so strict Node/Vite
      // ESM resolution can't find it (works fine inside Next's own bundler,
      // which is more permissive). Point it straight at the real file.
      "next/server": path.resolve(__dirname, "./node_modules/next/server.js"),
    },
  },
});
