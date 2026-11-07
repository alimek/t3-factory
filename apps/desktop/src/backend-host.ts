/**
 * The desktop server's backend: the same public Factory operations and listeners as
 * `pnpm start`, in an Electron utility process with the bundled runtime.
 */
import type { Result, ServerUpdateAction } from "@t3-factory/contracts";
import { loadConfiguration } from "@t3-factory/backend/config";
import { startServer, type ApplicationUpdates } from "@t3-factory/backend/server";

type Message =
  | { readonly type: "shutdown" }
  | {
      readonly type: "update-status";
      readonly status: ReturnType<ApplicationUpdates["status"]>;
    }
  | { readonly type: "update-result"; readonly id: number; readonly result: Result<null> };
const parent = process.parentPort;

function explain(error: unknown, home: string | undefined): string {
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (message.startsWith("Another Factory backend owns this database"))
    return `Another Factory backend already uses ${home ?? "this data home"} — for example \`pnpm start\` or \`pnpm dev:prod\` from a source checkout, or another Factory app. Close it, then choose Retry. Factory never removes a live lock, stops that backend or starts with an empty data home instead.`;
  if (code === "EADDRINUSE")
    return "The Factory port is already in use. Close the program using it, or change port in config.json, then choose Retry.";
  if (message.includes("FACTORY_HOME") || message.includes("config.json")) return message;
  return "Factory could not open its data home. Check permissions on the data directory and its config.json, then choose Retry.";
}

/** The main process owns the updater; it publishes status here and answers each action. */
function hostUpdates(): ApplicationUpdates {
  let status: ReturnType<ApplicationUpdates["status"]> = {
    channel: null,
    update: {
      state: "checking",
      version: null,
      progress: null,
      downloadedBytes: null,
      totalBytes: null,
      releaseNotes: null,
      checkedAt: null,
      message: null,
    },
  };
  let next = 0;
  const pending = new Map<number, (result: Result<null>) => void>();
  parent.on("message", (event: { data: Message }) => {
    if (event.data.type === "update-status") status = event.data.status;
    if (event.data.type === "update-result") {
      pending.get(event.data.id)?.(event.data.result);
      pending.delete(event.data.id);
    }
  });
  return {
    status: () => status,
    run: (action: ServerUpdateAction) =>
      new Promise((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        parent.postMessage({ type: "update-action", id, action });
      }),
  };
}

let home: string | undefined;
try {
  const config = await loadConfiguration();
  home = config.home;
  const server = await startServer(config, {
    uiDirectory: process.env.FACTORY_UI_DIRECTORY ?? null,
    applicationVersion: process.env.FACTORY_APPLICATION_VERSION ?? "desktop",
    applicationUpdates: hostUpdates(),
  });
  parent.postMessage({ type: "ready", port: server.address.port, home: config.home });
  parent.on("message", (event: { data: Message }) => {
    if (event.data.type !== "shutdown") return;
    // Orderly exit releases the database lock; it is not Stop and leaves T3 work alone.
    void server.close().finally(() => {
      parent.postMessage({ type: "stopped" });
      process.exit(0);
    });
  });
} catch (error) {
  parent.postMessage({ type: "failed", message: explain(error, home) });
  process.exit(1);
}
