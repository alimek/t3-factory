import type {
  AgentEnvironment,
  AgentProviderCapability,
  ConnectionState,
  ProjectIcon,
  T3Contract,
} from "@t3-factory/contracts";

/** A provider as T3's catalog publishes it; Factory adds its own reporting support. */
export type T3ProviderCapability = Omit<AgentProviderCapability, "reporting">;

export type T3ConnectionReason =
  | "connected"
  | "approval-required"
  | "approval-pending"
  | "browser-unavailable"
  | "callback-unavailable"
  | "approval-expired"
  | "contract-missing";
export type AuthorizationResumption = "reopened" | "completing" | "none";
export interface T3Inspection {
  readonly state: ConnectionState;
  readonly reason: T3ConnectionReason;
  /** Opaque grant lineage, never an access/refresh token or client secret. */
  readonly authorizationIdentity?: string;
  readonly contract?: T3Contract;
}
/** Extend this capability seam with typed operations as later tickets require them. */
export interface RuntimeActivity {
  readonly thread: {
    readonly threadId?: string;
    readonly projectId: string;
    readonly activeRunId: string | null;
    readonly runtimeMode?: string;
  };
  readonly items: readonly {
    readonly createdBy?: "user" | "agent" | "system" | null;
    readonly creationSource?: "web" | "mobile" | "mcp" | "provider" | "server" | null;
    readonly senderThreadId?: string | null;
    readonly itemId: string;
    readonly type: string;
    readonly status?: string;
    readonly runId: string;
    readonly text: string | null;
    readonly visibility?: string;
    readonly subagentId?: string;
    readonly sourceThreadId?: string;
    readonly textTruncated?: boolean;
    readonly nextTextOffset?: number | null;
  }[];
  readonly hasMore: boolean;
  readonly nextPosition: number | null;
}
/** A bounded, fresh scan. Only complete local assistant items carry verified full text. */
export interface ReportActivityItem {
  readonly position: number;
  readonly itemId: string;
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly subagentId?: string;
  readonly visibility: "local" | "inherited" | "synthetic";
  readonly type: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly text: string | null;
  readonly complete: boolean;
  readonly problem?: string;
}
export interface ReportActivity {
  readonly threadId: string;
  readonly projectId: string;
  readonly items: readonly ReportActivityItem[];
  /** False means coverage is uncertain, never evidence that an execution omitted a report. */
  readonly complete: boolean;
  readonly problem?: string;
}
export interface ReportSupport {
  readonly supported: boolean;
  readonly explanation: string;
}
/** Saved T3 connection and project context Factory passes into adapter operations. */
export interface T3Target {
  readonly endpoint: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
}
export type T3Endpoint = Pick<T3Target, "endpoint"> & { readonly peerEnvironmentId?: string };
export type T3EnvironmentTarget = Pick<T3Target, "endpoint" | "environmentId">;
export type T3ProjectTarget = Pick<T3Target, "endpoint" | "environmentId" | "workspaceRoot">;
export interface T3Adapter {
  readRemoteWork(
    target: T3Endpoint,
    remote: import("./remote-work.ts").RemoteWorkTarget,
  ): Promise<import("./remote-work.ts").RemoteWorkObservation>;
  /** Exact aggregate only; queues, native requests and business completion stay separate. */
  readDelegatedSettlement(
    target: T3Endpoint,
    threadId: string,
    runId: string,
  ): Promise<import("./coordination-evidence.ts").DelegatedSettlement>;
  /** Bounded local lineage candidates; even a complete scan cannot prove absence. */
  readDescendants(
    target: T3Endpoint,
    parentThreadId: string,
  ): Promise<import("./coordination-evidence.ts").DescendantEvidence>;
  /** Independent local child evidence; public reads omit options and task membership. */
  readChildEvidence(
    target: T3Endpoint,
    child: import("./coordination-evidence.ts").ChildEvidenceTarget,
  ): Promise<import("./coordination-evidence.ts").ChildEvidence>;
  /** Full native invocation evidence only; callers still prove lineage, ownership and settlement. */
  readDelegationActivity(
    target: T3Endpoint,
    threadId: string,
  ): Promise<import("./delegation-activity.ts").DelegationActivity>;
  inspectSettleSupport(target: T3Endpoint): Promise<ReportSupport>;
  settleThread(target: T3Endpoint, payload: { threadId: string }): Promise<void>;
  inspectReportSupport(target: T3Endpoint, driverKind?: string): Promise<ReportSupport>;
  readReportActivity(target: T3Endpoint, threadId: string): Promise<ReportActivity>;
  inspectStopSupport(target: T3Endpoint, kind: "cancel" | "tree"): Promise<LaunchSupport>;
  cancelQueued(
    target: T3Endpoint,
    payload: { threadId: string; queuedRunId: string },
  ): Promise<void>;
  /** Thread/tree scope, including idle-parent delegated work; no run fence. */
  stopOwnedTree(
    target: T3Endpoint,
    payload: { threadId: string; clientRequestId: string },
  ): Promise<void>;
  inspectSendSupport(target: T3Endpoint): Promise<LaunchSupport>;
  sendMessage(target: T3Endpoint, payload: SendPayload): Promise<SendReference>;
  inspectLaunchSupport(target: T3Endpoint): Promise<LaunchSupport>;
  launchThread(target: T3Endpoint, payload: LaunchPayload): Promise<LaunchReference>;
  /** Search one project for a launch that may already exist. Incomplete scans withhold candidates. */
  discoverLaunchCandidates(target: T3Target, title: string): Promise<LaunchDiscovery>;
  /** Independent thread identity. Callers still prove it is the saved worker. */
  readThreadIdentity(target: T3Target, threadId: string): Promise<ThreadIdentityRead>;
  readQueue(
    target: T3Endpoint,
    threadId: string,
  ): Promise<{
    readonly threadId: string;
    readonly queuedRunIds: readonly string[];
    /** Non-null means incomplete coverage; never interpreted as empty. */
    readonly nextCursor: number | null;
  }>;
  /** Separate native coverage; pending_request list omits permission approvals. */
  readNativeRequests(
    target: T3Endpoint,
    threadId: string,
  ): Promise<{
    readonly threadId: string;
    readonly projectId: string;
    readonly pendingRequestCount: number;
  }>;
  readExecution(
    target: T3Endpoint,
    threadId: string,
    recorded?: readonly RecordedExecution[],
  ): Promise<ExecutionObservation>;
  readRuntimeActivity(
    target: T3Endpoint,
    threadId: string,
    afterPosition?: number,
    itemId?: string,
  ): Promise<RuntimeActivity>;
  listProjects(target: T3EnvironmentTarget): Promise<readonly T3Project[]>;
  resolveRepository(path: string): Promise<string>;
  createProject(target: T3ProjectTarget): Promise<T3Project>;
  inspect(target: T3Endpoint): Promise<T3Inspection>;
  /** Starts backend-host approval; returns without waiting for the human. */
  authorize(target: T3Endpoint): Promise<void>;
  /**
   * Reopens a live pending approval's own authorization page in the backend-host browser,
   * keeping its state and verifier. `completing`: a callback is being exchanged; `none`:
   * no live attempt exists (never started, expired, denied or completed). Throws when
   * the browser cannot open. The page address never leaves the adapter.
   */
  resumeAuthorization(target: T3Endpoint): Promise<AuthorizationResumption>;
  readEnvironment(target: T3Endpoint): Promise<AgentEnvironment>;
  orchestratorCapabilities(target: T3Endpoint): Promise<readonly T3ProviderCapability[]>;
  close(): Promise<void>;
}

export interface T3Project {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly available: boolean;
  readonly projectIcon?: ProjectIcon | null;
  readonly faviconPath?: string | null;
}

export interface LaunchPayload {
  readonly environmentId: string;
  readonly projectId: string;
  readonly clientRequestId: string;
  readonly title: string;
  readonly message: string;
  readonly workspaceStrategy: { readonly type: "root" };
  readonly interactionMode: "default";
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options: Readonly<Record<string, string | boolean>>;
  };
}
export interface LaunchSupport {
  readonly supported: boolean;
  /** Non-null only when the adapter can establish continuity AND retained replay keys.
   * Matching version/schema alone is insufficient. Changes invalidate uncertain replay. */
  readonly retryScope: string | null;
  readonly explanation: string;
}
export interface LaunchReference {
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly link: string | null;
  readonly status: string;
}
/** T3 refused the launch before accepting it. The outcome is not uncertain. */
export class LaunchRejected extends Error {
  override readonly name = "LaunchRejected";
}
export interface LaunchCandidateExecution {
  readonly runId: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly status: string;
}
export interface LaunchCandidate {
  readonly title: string;
  readonly projectId: string;
  readonly parentThreadId: string | null;
  readonly workspaceRoot: string | null;
  readonly interactionMode: string | null;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>> | null;
  readonly threadId: string;
  readonly executions: readonly LaunchCandidateExecution[];
  readonly link?: string | null;
}
export type LaunchDiscovery =
  | { readonly available: false }
  | { readonly available: true; readonly candidates: readonly LaunchCandidate[] };
export interface ThreadIdentityRead {
  readonly threadId: string;
  readonly projectId: string;
  readonly parentThreadId: string | null;
  readonly workspaceRoot: string | null;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly executions: readonly LaunchCandidateExecution[];
}
export interface ExecutionObservation {
  readonly projectId: string;
  readonly threadId: string;
  readonly activeRunId: string | null;
  readonly link: string | null;
  readonly workspaceRoot: string | null;
  readonly pendingRequestCount: number;
  readonly latestRunId?: string | null;
  readonly recentRuns: readonly {
    readonly runId: string;
    readonly status: string;
    readonly ordinal?: number;
    readonly sourceAt?: string | null;
    readonly startedAt?: string | null;
    readonly completedAt?: string | null;
  }[];
}

/** Queue always means an independent new turn, never steering or batching. */
export interface SendPayload {
  readonly environmentId: string;
  readonly threadId: string;
  readonly mode: "queue";
  readonly clientRequestId: string;
  readonly message: string;
}
export interface SendReference {
  readonly threadId: string;
  readonly messageId: string;
  /** Exact execution reference returned by send, including a queued execution. */
  readonly runId: string;
  readonly status: string;
  readonly delivery: "started" | "queued";
}

export interface RecordedExecution {
  readonly runId: string;
  readonly ordinal?: number;
}
