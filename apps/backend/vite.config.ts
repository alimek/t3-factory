import "vite-plus/test/config";
import { fileURLToPath } from "node:url";
import { defaultServerConditions, defineConfig } from "vite-plus";

export default defineConfig({
  // Tests run the shared packages from source, so a result reflects the working tree.
  ssr: { resolve: { conditions: ["factory-source", ...defaultServerConditions] } },
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    // Parallel workspace runners must not clear or write each other's module cache.
    fsModuleCachePath: fileURLToPath(new URL("./node_modules/.vitest-cache", import.meta.url)),
    // SQLite, process ownership and frozen upgrade fixtures use real local resources.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
