import type { FlowReadiness } from "./flow.ts";
import { operation } from "./operation.ts";

export interface RuntimeSelection {
  readonly projectId: string;
  readonly agentId: string;
}
export interface RuntimeReadiness extends FlowReadiness {
  readonly checkedAt: string;
  readonly instructions: string;
}
export interface ReportingInstallationActions {
  readonly install: boolean;
  readonly repair: boolean;
  readonly reinstall: boolean;
}
export interface ReportingInstallation {
  readonly id: string;
  readonly provider: string;
  readonly instances: readonly string[];
  readonly path: string | null;
  /** `unsupported`: the provider has no Factory reporting yet; there is nothing to install. */
  readonly status: "not-installed" | "installed" | "needs-attention" | "unsupported";
  readonly message: string;
  /** Optional user-invoked launch skill; independent of reporting readiness. */
  readonly launchSkill: "current" | "missing" | "outdated" | null;
  readonly runtimeEvidence: "UNVERIFIED" | "ACCEPTED_REPORT";
  readonly actions: ReportingInstallationActions;
}
export type ConnectionState = "unavailable" | "authorization-required" | "incompatible" | "ready";
export interface T3Contract {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly environmentId: string | null;
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly problems: readonly string[];
  /** Contract inspection never proves project, harness or runtime execution readiness. */
  readonly executionVerified: false;
}
export interface AuthorizationContext {
  readonly id: string;
  readonly endpoint: string;
  readonly environmentId: string;
  readonly createdAt: string;
}
export interface T3Connection {
  readonly endpoint: string | null;
  readonly state: ConnectionState;
  readonly explanation: string;
  readonly checkedAt: string | null;
  readonly authorizationContext: AuthorizationContext | null;
  /** An approval started on the host is waiting for consent in the host's browser. */
  readonly authorizationPending: boolean;
  readonly contract: T3Contract | null;
}

export interface ConfigureConnectionInput {
  readonly endpoint: string;
}
export interface InstallReportingInput {
  readonly targetId: string;
}

/** T3 connection, reporting installation and runtime readiness operations. */
export const connectionOperations = {
  getReportingInstallations: operation<never, readonly ReportingInstallation[]>()({
    method: "GET",
    path: "/api/reporting",
  }),
  installReporting: operation<InstallReportingInput, ReportingInstallation>()({
    method: "POST",
    path: "/api/reporting/install",
    body: "json",
  }),
  recheckRuntime: operation<RuntimeSelection, RuntimeReadiness>()({
    method: "POST",
    path: "/api/runtime/recheck",
    body: "json",
  }),
  getConnection: operation<never, T3Connection>()({ method: "GET", path: "/api/connection" }),
  configureConnection: operation<ConfigureConnectionInput, T3Connection>()({
    method: "PUT",
    path: "/api/connection",
    body: "json",
  }),
  recheckConnection: operation<never, T3Connection>()({
    method: "POST",
    path: "/api/connection/recheck",
  }),
  authorizeConnection: operation<never, T3Connection>()({
    method: "POST",
    path: "/api/connection/authorize",
  }),
  /**
   * Opens authorization for the saved endpoint in the host's browser: reopens a live
   * pending approval, or starts one when none exists. Never edits the endpoint and never
   * replaces a grant that is ready or incompatible. Allowed for approved remote clients.
   */
  openConnectionAuthorization: operation<never, T3Connection>()({
    method: "POST",
    path: "/api/connection/authorization/open",
  }),
};
