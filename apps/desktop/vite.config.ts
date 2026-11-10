import "vite-plus/test/config";
import { fileURLToPath } from "node:url";
import { defaultServerConditions, defineConfig } from "vite-plus";

export default defineConfig({
  // This config serves only the rule tests; the shipped bundle comes from
  // scripts/bundle.mjs, which resolves compiled workspace output.
  ssr: { resolve: { conditions: ["factory-source", ...defaultServerConditions] } },
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    // Parallel workspace runners must not clear or write each other's module cache.
    fsModuleCachePath: fileURLToPath(new URL("./node_modules/.vitest-cache", import.meta.url)),
  },
});
