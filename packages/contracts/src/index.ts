/** Transport-neutral values shared by the backend and its clients. No Node imports. */
import type { agentOperations } from "./agent.ts";
import type { FlowDraft, FlowReadiness } from "./flow.ts";
import type { FactoryProject } from "./project.ts";
import type { runOperations } from "./run.ts";
import type { FacadeOperations } from "./operation.ts";
import type { Result } from "./result.ts";

export * from "./result.ts";
export * from "./flow.ts";
export * from "./agent.ts";
export * from "./operation.ts";
export * from "./project.ts";
export * from "./run.ts";

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
  readonly runtimeEvidence: "UNVERIFIED" | "ACCEPTED_REPORT";
  readonly actions: ReportingInstallationActions;
}
/** The Factory facade: derived from the operation definitions, plus operations HTTP does not reach. */
export interface FactoryOperations extends FacadeOperations<
  typeof agentOperations & typeof runOperations
> {
  getReportingInstallations(): Promise<Result<readonly ReportingInstallation[]>>;
  installReporting(input: unknown): Promise<Result<ReportingInstallation>>;
  reconcileRuns(): Promise<Result<void>>;
  recheckRuntime(input: unknown): Promise<Result<RuntimeReadiness>>;
  listProjects(): Promise<Result<ProjectCatalog>>;
  recheckProjects(): Promise<Result<ProjectCatalog>>;
  addRepository(input: unknown): Promise<Result<FactoryProject>>;
  selectProject(input: unknown): Promise<Result<ProjectCatalog>>;
  getProjectReadiness(id: string): Promise<Result<FlowReadiness>>;
  getProjectFavicon(id: string): Promise<Result<ProjectFavicon>>;
  getConnection(): Promise<Result<T3Connection>>;
  configureConnection(input: unknown): Promise<Result<T3Connection>>;
  recheckConnection(): Promise<Result<T3Connection>>;
  authorizeConnection(): Promise<Result<T3Connection>>;
  /**
   * Opens authorization for the saved endpoint in the host's browser: reopens a live
   * pending approval, or starts one when none exists. Never edits the endpoint and never
   * replaces a grant that is ready or incompatible. Allowed for approved remote clients.
   */
  openConnectionAuthorization(): Promise<Result<T3Connection>>;
  createFlow(input: unknown): Promise<Result<FlowDraft>>;
  updateFlow(id: string, input: unknown): Promise<Result<FlowDraft>>;
  removeFlow(id: string): Promise<Result<void>>;
  validateFlow(input: unknown): Promise<Result<FlowReadiness>>;
  listFlows(): Promise<Result<readonly FlowDraft[]>>;
  getFlow(id: string): Promise<Result<FlowDraft>>;
  requestClientAccess(input: unknown): Promise<Result<ClientAccessGrant>>;
  getClientAccess(credential: string): Promise<Result<ClientAccessState>>;
  authenticateClient(credential: string): Promise<Result<FactoryClient>>;
  listClients(): Promise<Result<readonly FactoryClient[]>>;
  approveClient(id: string): Promise<Result<FactoryClient>>;
  denyClient(id: string): Promise<Result<FactoryClient>>;
  revokeClient(id: string): Promise<Result<FactoryClient>>;
  getHostLifecycle(): Promise<Result<HostLifecycle>>;
}

/** A desktop installation or one browser profile; the label is a display hint, never authority. */
export type ClientKind = "desktop" | "browser";
export type ClientAccessStatus = "pending" | "approved" | "denied" | "revoked";
export interface FactoryClient {
  readonly id: string;
  readonly label: string;
  readonly kind: ClientKind;
  readonly status: ClientAccessStatus;
  /** Shown on the requesting device and the host so the owner approves the right request. */
  readonly verificationCode: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly lastSeenAt: string | null;
}
export interface RequestClientAccessInput {
  readonly label: string;
  readonly kind: ClientKind;
}
/** The secret credential is returned exactly once, to the requesting client. */
export interface ClientAccessGrant {
  readonly client: FactoryClient;
  readonly credential: string;
}
/** `none`: no request is known for this credential (never sent, expired or forgotten). */
export type ClientAccessState =
  | { readonly status: "none" }
  | { readonly status: ClientAccessStatus; readonly client: FactoryClient };
/**
 * `host`: the request reached the host-local loopback surface, which owns the server.
 * `remote`: an approved-client listener; product access follows `access`.
 */
export type ClientScope =
  | { readonly scope: "host" }
  | { readonly scope: "remote"; readonly access: ClientAccessState };

/** Factory client/server wire compatibility, independent of application release numbers. */
export interface ProtocolDescriptor {
  readonly protocol: number;
  /** Oldest peer protocol this side still interoperates with. */
  readonly minimumPeerProtocol: number;
  readonly application: string;
}
export type ProtocolCompatibility =
  | { readonly kind: "compatible" }
  | {
      readonly kind: "update-client" | "update-server";
      readonly message: string;
    };

/** Host lifecycle facts used before Quit, role switch or update installation. */
export interface HostLifecycle {
  /** Active Runs; Quit leaves them to T3 and later reconciliation, it never Stops them. */
  readonly openRunCount: number;
}

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

/** Remote access settings and certificate identity shown only on the host-local panel. */
export interface RemoteAccessStatus {
  readonly enabled: boolean;
  readonly port: number;
  readonly addresses: readonly string[];
  /** SHA-256 fingerprint of the certificate authority clients pin or install. */
  readonly certificateFingerprint: string | null;
  readonly certificateSource: "factory" | "provided" | null;
  readonly problem: string | null;
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

/** Binary project favicon bytes served through Factory, not arbitrary upstream URLs. */
export interface ProjectFavicon {
  readonly contentType: string;
  readonly data: Uint8Array;
}
export interface ProjectCatalog {
  readonly projects: readonly FactoryProject[];
  readonly selectedProjectId: string | null;
  readonly problem: string | null;
}

export * from "./live.ts";
