import { operation } from "./operation.ts";

/** Desktop release track: stable Releases from tags, or nightly/manual beta builds from main. */
export type UpdateChannel = "stable" | "beta";

/** A desktop installation's updater, as its own window or an approved client sees it. */
export interface ApplicationUpdate {
  readonly state:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "error"
    | "unsupported";
  readonly version: string | null;
  /** Download percentage and byte counts while downloading. */
  readonly progress: number | null;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly releaseNotes: string | null;
  readonly message: string | null;
  /** ISO time the feed was last read successfully. */
  readonly checkedAt: string | null;
}

/** The server installation's updater, operated by approved clients through `/api/server-update`. */
export interface ServerUpdate {
  /** Running release, or `source` for a source checkout. */
  readonly application: string;
  /** Null when the server is not a desktop installation with a release feed. */
  readonly channel: UpdateChannel | null;
  readonly update: ApplicationUpdate;
  /** Installing restarts the server; Runs stay open and reconcile afterwards. */
  readonly openRunCount: number;
}
export type ServerUpdateAction = "check" | "download" | "install";

/** Server update operations are answered by the server, not the Factory facade. */
export const serverUpdateOperations = {
  getServerUpdate: operation<never, ServerUpdate>()({ method: "GET", path: "/api/server-update" }),
  checkServerUpdate: operation<never, ServerUpdate>()({
    method: "POST",
    path: "/api/server-update/check",
  }),
  downloadServerUpdate: operation<never, ServerUpdate>()({
    method: "POST",
    path: "/api/server-update/download",
  }),
  installServerUpdate: operation<never, ServerUpdate>()({
    method: "POST",
    path: "/api/server-update/install",
  }),
};
