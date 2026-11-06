import "vite-plus/test/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    ...(command === "serve"
      ? { conditions: ["factory-source", "module", "browser", "development"] }
      : {}),
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    // Parallel workspace runners must not clear or write each other's module cache.
    fsModuleCachePath: fileURLToPath(new URL("./node_modules/.vitest-cache", import.meta.url)),
  },
  server: {
    host: process.env.FACTORY_DEV_HOST?.trim() || "127.0.0.1",
    proxy: {
      "/api": {
        target: process.env.FACTORY_DEV_BACKEND_URL ?? "http://127.0.0.1:4310",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            // Translate only the development UI's own Origin. Cross-site
            // origins must still fail the backend mutation guard.
            if (incoming.headers.origin === `http://${incoming.headers.host}`)
              outgoing.setHeader("origin", `http://${String(outgoing.getHeader("host"))}`);
          });
        },
      },
    },
  },
}));
