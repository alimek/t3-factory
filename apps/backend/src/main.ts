import { loadConfiguration } from "./config.ts";
import { startServer } from "./server.ts";

const apiOnly = process.argv.includes("--api-only");

try {
  const config = await loadConfiguration();
  const server = await startServer(config, apiOnly ? { uiDirectory: null } : {});
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`T3 Factory listening on http://${host}:${server.address.port}`);
  console.log("Factory runs in the foreground. Press Ctrl+C to exit. T3 runs independently.");
  const shutdown = () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Another Factory backend owns"))
    console.error(
      "Another Factory backend already owns this data home — for example the T3 Factory desktop app running as a server, or another pnpm start. Quit it, then start again. Factory never removes a live lock or opens a fresh data home instead.",
    );
  else if (apiOnly) console.error("Factory dev backend could not start:", error);
  else
    console.error(
      "Factory could not start. Check the build, data-directory permissions, configuration and bind address/port.",
    );
  process.exitCode = 1;
}
