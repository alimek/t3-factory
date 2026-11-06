import "vite-plus/test/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
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
