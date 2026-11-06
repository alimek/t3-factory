import type { T3Adapter } from "./adapters/t3.ts";
import type { BridgeRuntime } from "./reporting-installation.ts";

/** Everything a caller may choose when opening a Factory; defaults live where each is consumed. */
export interface FactoryOptions {
  readonly runtimeBackendUrl?: string;
  readonly reportingStateDirectory?: string;
  readonly databasePath: string;
  readonly credentialsDirectory?: string;
  readonly t3?: T3Adapter;
  readonly connectionRetryMs?: number;
  /** Runtime harnesses use to launch the reporting bridge; source installs use PATH `node`. */
  readonly bridgeRuntime?: BridgeRuntime;
}
