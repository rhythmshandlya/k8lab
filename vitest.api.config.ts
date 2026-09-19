import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Separate vitest project for DB-backed API/repo tests. These run in the NODE
 * environment against an in-process pglite Postgres (see src/tests/api/pglite.ts),
 * kept apart from the main jsdom suite so the existing tests + the solvability harness
 * stay byte-identical. Run with `pnpm test:api`.
 */
export default defineConfig({
  test: {
    name: "api",
    environment: "node",
    include: ["src/tests/api/**/*.{test,spec}.ts"],
    testTimeout: 60000,
    clearMocks: true,
    restoreMocks: true,
    server: { deps: { inline: [/@ngrok[\\/]webernetes/] } },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
