import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Opt-in live tests. Not used by `pnpm test` or by CI. */
export default defineConfig({
  resolve: {
    alias: {
      "@jevyjs/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.live.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
