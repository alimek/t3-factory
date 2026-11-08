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
export type T3Endpoint = Pick<T3Target, "endpoint">;
export type T3EnvironmentTarget = Pick<T3Target, "endpoint" | "environmentId">;
export type T3ProjectTarget = Pick<T3Target, "endpoint" | "environmentId" | "workspaceRoot">;
export interface T3Adapter {
  /** `t3_thread_wait` for one run with its delegated and background work. Queues, native
   * requests and business completion stay separate. */
  readDelegatedSettlement(
    target: T3Endpoint,
    threadId: string,
    runId: string,
  ): Promise<import("./delegated-settlement.ts").DelegatedSettlement>;
  inspectSettleSupport(target: T3Endpoint): Promise<ReportSupport>;
  settleThread(target: T3Endpoint, payload: { threadId: string }): Promise<void>;
  inspectReportSupport(target: T3Endpoint, driverKind?: string): Promise<ReportSupport>;
  inspectStopSupport(target: T3Endpoint): Promise<LaunchSupport>;
  /** Thread scope, including delegated work; no run fence. */
  stopThread(
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
  /** One thread read: active/latest run, recent runs and the pending native request count. */
  readExecution(target: T3Endpoint, threadId: string): Promise<ExecutionObservation>;
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
