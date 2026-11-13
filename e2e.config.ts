import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
export default {
  tests: "tests/*.e2e.ts",
  workers: 1,
  targets: [
    {
      name: "web",
      engine: web(),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: "node",
          args: ["--conditions=factory-source", "tests/support/server.ts"],
          env: { PORT: "{port}" },
          log: ".e2e/logs/fixture.log",
        },
        // The result reader's Copy Markdown is read back from the clipboard.
        permissions: { "clipboard-read": "grant", "clipboard-write": "grant" },
      },
    },
  ],
} satisfies E2EConfig;
