import type { T3Adapter } from "./adapters/t3.ts";

/** Everything a caller may choose when opening a Factory; defaults live where each is consumed. */
export interface FactoryOptions {
  readonly runtimeBackendUrl?: string;
  readonly reportingStateDirectory?: string;
  readonly databasePath: string;
  readonly credentialsDirectory?: string;
  readonly t3?: T3Adapter;
  readonly connectionRetryMs?: number;
  /**
   * Temporary: lets pending Run title generations launch their title threads. Off by default, so
   * the product launches none until the deadline, cancellation, cleanup and restart safeguards
   * ship (#307, which removes this option); tests turn it on.
   */
  readonly launchTitleThreads?: boolean;
}
