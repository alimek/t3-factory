import type { T3Adapter } from "./adapters/t3.ts";

/** Everything a caller may choose when opening a Factory; defaults live where each is consumed. */
export interface FactoryOptions {
  readonly runtimeBackendUrl?: string;
  readonly reportingStateDirectory?: string;
  readonly databasePath: string;
  readonly credentialsDirectory?: string;
  readonly t3?: T3Adapter;
  readonly connectionRetryMs?: number;
  /** Discord's REST API base for Chat control's Gateway connection; tests use a controlled Discord. */
  readonly discordApiUrl?: string;
}
