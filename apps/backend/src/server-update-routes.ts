import * as Effect from "effect/Effect";
import {
  serverUpdateOperations,
  type Result,
  type ServerUpdate,
  type ServerUpdateAction,
} from "@t3-factory/contracts";
import { resultResponse } from "./http-support.ts";
import { operationRoutes } from "./route-table.ts";
import type { Factory } from "./open-factory.ts";
import { failure } from "./result.ts";

/** The desktop installation's updater; source runs have none and report updates as unsupported. */
export interface ApplicationUpdates {
  status(): Omit<ServerUpdate, "application" | "openRunCount">;
  run(action: ServerUpdateAction): Promise<Result<null>>;
}

const actionTimeoutMs = 30_000;

const sourceUpdates: ApplicationUpdates = {
  status: () => ({
    channel: null,
    update: {
      state: "unsupported",
      version: null,
      progress: null,
      downloadedBytes: null,
      totalBytes: null,
      releaseNotes: null,
      checkedAt: null,
      message: "This server runs from a source checkout. Update it on its host.",
    },
  }),
  run: () => Promise.resolve(failure("conflict", "This server cannot be updated remotely.")),
};

/**
 * Approved clients and the host panel read and operate the server's updater. Installing
 * restarts the server without Stopping Runs; the requesting client confirms first.
 */
export function serverUpdateRoutes(
  factory: Factory,
  application: string,
  updates: ApplicationUpdates = sourceUpdates,
): ReturnType<typeof operationRoutes> {
  const read = async (): Promise<Result<ServerUpdate>> => {
    const lifecycle = await factory.getHostLifecycle();
    if (!lifecycle.ok) return lifecycle;
    return {
      ok: true,
      value: { application, ...updates.status(), openRunCount: lifecycle.value.openRunCount },
    };
  };
  // A feed check waits on the network; the request returns and the check continues there.
  const bounded = (name: ServerUpdateAction) =>
    Promise.race([
      updates.run(name),
      new Promise<Result<null>>((resolve) =>
        setTimeout(
          () => resolve(failure("internal", "The server is still working on the update request.")),
          actionTimeoutMs,
        ).unref(),
      ),
    ]);
  const action = (name: ServerUpdateAction) => ({
    handle: () =>
      Effect.map(
        Effect.promise(async () => {
          const result = await bounded(name);
          return result.ok ? read() : result;
        }),
        (result) => resultResponse(result),
      ),
  });
  return operationRoutes(serverUpdateOperations, {
    getServerUpdate: {
      handle: () => Effect.map(Effect.promise(read), (result) => resultResponse(result)),
    },
    checkServerUpdate: action("check"),
    downloadServerUpdate: action("download"),
    installServerUpdate: action("install"),
  });
}
