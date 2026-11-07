import { utilityProcess, type UtilityProcess } from "electron";
import type { ServerUpdateAction } from "@t3-factory/contracts";
import type { ApplicationUpdates } from "@t3-factory/backend/server";

export type BackendState = {
  readonly state: "stopped" | "starting" | "running" | "failed";
  readonly message: string | null;
};

type HostMessage =
  | { readonly type: "ready"; readonly port: number; readonly home: string }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "stopped" }
  | { readonly type: "update-action"; readonly id: number; readonly action: ServerUpdateAction };

const shutdownTimeoutMs = 30_000;

/** Supervises the one local backend a server installation owns; never restarts it silently. */
export class BackendSupervisor {
  private child: UtilityProcess | null = null;
  private current: BackendState = { state: "stopped", message: null };
  port: number | null = null;
  home: string | null = null;

  constructor(
    private readonly entry: string,
    private readonly env: Record<string, string>,
    private readonly changed: (state: BackendState) => void,
    private readonly updates: ApplicationUpdates,
  ) {}

  get state(): BackendState {
    return this.current;
  }

  private set(state: BackendState) {
    this.current = state;
    this.changed(state);
  }

  start() {
    if (this.child) return;
    this.set({ state: "starting", message: null });
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: "T3 Factory backend",
      env: { ...process.env, ...this.env },
      stdio: "inherit",
    });
    this.child = child;
    child.on("message", (message: HostMessage) => {
      if (message.type === "ready") {
        this.port = message.port;
        this.home = message.home;
        this.publishUpdate();
        this.set({ state: "running", message: null });
      }
      if (message.type === "failed") this.set({ state: "failed", message: message.message });
      if (message.type === "update-action")
        void this.updates
          .run(message.action)
          .then((result) => child.postMessage({ type: "update-result", id: message.id, result }));
    });
    child.on("exit", () => {
      const expected = this.current.state === "stopped";
      this.child = null;
      this.port = null;
      if (!expected && this.current.state !== "failed")
        this.set({
          state: "failed",
          message:
            "The Factory server stopped unexpectedly. Runs were not stopped; choose Retry to reopen and reconcile them.",
        });
    });
  }

  /** The backend answers `/api/server-update` reads from the last published status. */
  publishUpdate() {
    this.child?.postMessage({ type: "update-status", status: this.updates.status() });
  }

  /** Orderly shutdown releases ownership; a hung backend is killed only after the timeout. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.set({ state: "stopped", message: null });
      return;
    }
    this.set({ state: "stopped", message: null });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
      }, shutdownTimeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "shutdown" });
    });
  }
}
