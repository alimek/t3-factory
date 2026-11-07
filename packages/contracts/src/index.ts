/** Transport-neutral values shared by the backend and its clients. No Node imports. */
export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface OperationError {
  /**
   * `unauthorized`, `host_only` and `incompatible` are client-access transport
   * outcomes: no Factory operation ran.
   */
  readonly code:
    | "validation"
    | "not_found"
    | "conflict"
    | "internal"
    | "unauthorized"
    | "host_only"
    | "incompatible";
  readonly message: string;
  readonly issues: readonly ValidationIssue[];
}

export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: OperationError };

export interface CreateFlowInput {
  readonly name: string;
}

export type ExitOutcome = "completion" | "assessment-ok" | "assessment-fail" | "custom";
export interface BlockExit {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly outcome: ExitOutcome;
  readonly requiresFeedback: boolean;
}
interface BlockBase {
  readonly id: string;
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly exits: readonly BlockExit[];
}
export type FlowBlock = BlockBase &
  ({ readonly kind: "agent"; readonly agentId: string | null } | { readonly kind: "human" });
export interface FlowConnection {
  readonly sourceBlockId: string;
  readonly exitId: string;
  readonly targetBlockId: string;
}
/** The single, always-present source of a Flow; its targets start a Run in parallel. */
export interface FlowInputBlock {
  readonly position: { readonly x: number; readonly y: number };
  /** Agent blocks that each receive the Flow input in their own session at Start. */
  readonly targetBlockIds: readonly string[];
}
export interface FlowGraph {
  readonly blocks: readonly FlowBlock[];
  readonly connections: readonly FlowConnection[];
  readonly flowInput: FlowInputBlock;
}
export interface UpdateFlowInput {
  readonly name: string;
  readonly expectedRevision: number;
  readonly graph: FlowGraph;
}

export interface FlowReadiness {
  readonly ready: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface FlowDraft {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly graph: FlowGraph;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readiness: FlowReadiness;
}

export interface AgentModelOptionValue {
  readonly id: string;
  readonly value: string | boolean;
}

export interface AgentExecutionSettings {
  readonly environmentId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly modelOptions: readonly AgentModelOptionValue[];
}

export type AgentSettingAvailability = "available" | "unavailable" | "unknown";

export interface AgentSettingStatus {
  readonly state: AgentSettingAvailability;
  readonly explanation?: string;
}

export interface AgentExecutionSettingsStatus {
  readonly environment: AgentSettingStatus;
  readonly provider: AgentSettingStatus;
  readonly model: AgentSettingStatus;
  readonly options: readonly { readonly id: string; readonly state: AgentSettingAvailability }[];
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly revision: number;
  readonly execution: AgentExecutionSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settingsStatus: AgentExecutionSettingsStatus;
}

export interface AgentEnvironment {
  readonly environmentId: string;
  readonly label: string;
}

export interface AgentOptionChoice {
  readonly id: string;
  readonly label: string;
}

export interface AgentModelOptionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly type: "select" | "boolean";
  readonly choices?: readonly AgentOptionChoice[];
  /** Exact permitted values when published; absent for unrestricted legacy booleans. */
  readonly values?: readonly (string | boolean)[];
  readonly default?: string | boolean;
}

export interface AgentModelCapability {
  readonly id: string;
  readonly label: string | null;
  readonly options?: readonly AgentModelOptionDescriptor[];
}

export interface AgentProviderCapability {
  readonly providerInstanceId: string;
  readonly displayName: string | null;
  readonly driverKind: string;
  readonly models: readonly AgentModelCapability[];
}

export interface AgentCapabilities {
  readonly state: "ready" | "unavailable";
  readonly explanation: string;
  readonly checkedAt: string | null;
  readonly environments: readonly AgentEnvironment[];
  readonly providers: readonly AgentProviderCapability[];
}

export interface CreateAgentInput {
  readonly name: string;
  readonly prompt: string;
  readonly execution: AgentExecutionSettings;
}

export interface UpdateAgentInput {
  readonly expectedRevision: number;
  readonly name: string;
  readonly prompt: string;
  readonly execution: AgentExecutionSettings;
}

export interface DuplicateAgentInput {
  readonly name?: string;
}

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
  readonly status: "not-installed" | "installed" | "needs-attention";
  readonly message: string;
  readonly runtimeEvidence: "UNVERIFIED" | "ACCEPTED_REPORT";
  readonly actions: ReportingInstallationActions;
}
export interface FactoryOperations {
  getReportingInstallations(): Promise<Result<readonly ReportingInstallation[]>>;
  installReporting(input: unknown): Promise<Result<ReportingInstallation>>;
  answerHumanOccurrence(id: string, input: unknown): Promise<Result<RunDetail>>;
  listAttention(): Promise<Result<readonly RunAttention[]>>;
  replyCoordinatorQuestion(
    runId: string,
    input: { attentionId: string; requestId: string; message: string },
  ): Promise<Result<RunDetail>>;
  recoverRunCoordinator(runId: string, sourceExecutionId: string): Promise<Result<RunDetail>>;
  requestReport(attentionId: string): Promise<Result<RunDetail>>;
  stopRun(id: string): Promise<Result<RunDetail>>;
  getRunCreationPolicy(): Promise<Result<RunCreationPolicy>>;
  startRun(input: unknown): Promise<Result<RunDetail>>;
  listRunNavigation(): Promise<Result<readonly RunNavigationEntry[]>>;
  renameRun(id: string, input: unknown): Promise<Result<RunDetail>>;
  snoozeRun(id: string): Promise<Result<RunPresentation>>;
  restoreRun(id: string): Promise<Result<RunPresentation>>;
  markRunWokeSeen(id: string): Promise<Result<RunPresentation>>;
  getRun(id: string): Promise<Result<RunDetail>>;
  listRuns(projectId: string): Promise<Result<readonly RunSummary[]>>;
  listTasks(projectId: string): Promise<Result<readonly TaskSummary[]>>;
  updateTask(id: string, input: unknown): Promise<Result<TaskSummary>>;
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
  listAgents(): Promise<Result<readonly AgentDefinition[]>>;
  getAgent(id: string): Promise<Result<AgentDefinition>>;
  createAgent(input: unknown): Promise<Result<AgentDefinition>>;
  updateAgent(id: string, input: unknown): Promise<Result<AgentDefinition>>;
  duplicateAgent(id: string, input: unknown): Promise<Result<AgentDefinition>>;
  removeAgent(id: string): Promise<Result<void>>;
  getAgentCapabilities(): Promise<Result<AgentCapabilities>>;
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
  /** Runs that are not closed; Quit leaves them to T3 and later reconciliation, it never Stops them. */
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

/** Known T3 project icon palette; unknown colors are rejected at parse time. */
export type ProjectIconColor =
  | "gray"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "rose";

/** Normalized T3 project icon metadata safe for Factory clients to render. */
export type ProjectIcon =
  | {
      readonly kind: "lucide";
      readonly name: string;
      readonly color: ProjectIconColor;
      readonly monogram?: string | null;
      readonly monogramText?: string | null;
    }
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor };

/** Durable Factory reference; T3 identity is scoped to endpoint and environment. */
export interface FactoryProject {
  readonly id: string;
  readonly endpoint: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly availability:
    | "available"
    | "directory-unavailable"
    | "project-unavailable"
    | "connection-unavailable"
    | "different-environment";
  readonly observedAt: string;
  readonly projectIcon?: ProjectIcon | null;
  /** Same-origin favicon route; explicit projectIcon takes UI priority when both exist. */
  readonly faviconUrl?: string | null;
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

export interface StartRunInput {
  /** Also the Run's navigation `creationKey`. */
  readonly requestId: string;
  readonly projectId: string;
  readonly flowId: string;
  readonly input: string;
  /** The draft's chosen title; stored trimmed as the Run title. */
  readonly title: string;
  /** When the draft was created, as `Date.toISOString()` output; it orders Run navigation. */
  readonly createdAt: string;
}
export interface TaskRunEntry {
  readonly stopRequestedAt: string | null;
  readonly id: string;
  readonly flowId: string;
  readonly flowName: string;
  readonly input: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly outcome: RunClosure["outcome"] | null;
}
export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly activeRunId: string | null;
  readonly latestRun: {
    readonly stopRequestedAt: string | null;
    readonly id: string;
    readonly flowId: string;
    readonly flowName: string;
    readonly startedAt: string;
    readonly closedAt: string | null;
    readonly outcome: RunClosure["outcome"] | null;
  } | null;
  readonly runs: readonly TaskRunEntry[];
}
/** Factory can accept a Start. The server no longer publishes a coordinator contract. */
export interface RunCreationPolicy {
  readonly ready: true;
}
export interface CoordinatorEvidence {
  readonly version: 1;
  readonly observedAt: string;
  readonly designation: boolean;
  readonly lineageCoverage: "incomplete" | "unknown";
  readonly lineageScanComplete: boolean;
  readonly aggregateState: "settled" | "pending" | "unknown";
  readonly holdReason: string | null;
  readonly release: boolean;
  readonly limitations: readonly string[];
  readonly members: readonly {
    threadId: string;
    role: "coordinator" | "worker" | "descendant";
    executionIds: readonly string[];
  }[];
}
/** Safety evidence only; remote work never becomes a local reporting binding. */
export interface RemoteWork {
  readonly activationId: string;
  readonly sourceItemId: string;
  readonly sourceExecutionId: string;
  readonly parentThreadId: string;
  readonly sourceEnvironmentId: string;
  readonly taskId: string | null;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly label: string;
  readonly status: string;
  readonly available: boolean;
  readonly pendingRequestCount: number | null;
}
export interface RunActivation {
  readonly id: string;
  readonly blockId: string;
  readonly cause: string;
  readonly phase: "delegating" | "waiting-worker" | "assessing" | "reported" | "finished";
  readonly coverage: "unverified" | "local-bounded";
  readonly problem: string | null;
  readonly evidence: CoordinatorEvidence | null;
  readonly createdAt: string;
  readonly delegation: {
    readonly requestKey: string;
    readonly inputFingerprint: string;
    readonly state: "planned" | "accepted";
    readonly accepted?: {
      readonly taskId: string;
      readonly childThreadId: string;
      readonly childExecutionId: string | null;
      readonly sourceExecutionId: string;
      readonly itemId: string;
    };
  };
}
export interface RunThreadBinding {
  readonly link: string | null;
  readonly id: string;
  readonly blockId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly role: "worker" | "descendant";
  readonly parentBindingId: string | null;
}
export interface RunSnapshot {
  readonly flow: FlowDraft;
  readonly agents: readonly AgentDefinition[];
}
export interface RunBlock {
  readonly blockId: string;
  readonly name: string;
  readonly state: "not-started" | "working" | "waiting" | "finished" | "error" | "stopped";
  readonly threadId: string | null;
  readonly executionId: string | null;
  readonly link: string | null;
  readonly engineStatus: string | null;
  readonly reportStatus: "waiting" | "finished" | null;
  readonly problem: string | null;
  readonly pendingRequestCount: number | null;
  readonly observedAt: string | null;
  readonly freshness: "unknown" | "fresh" | "stale";
  /** An unresolved Factory launch for this Block. Title search has not bound a worker. */
  readonly recovery: "pending" | null;
}
/** The bounded observed frontier that justified permanent local closure. */
export interface RunClosure {
  readonly rootFrontier?: readonly Omit<RunClosure["frontier"][number], "blockId">[];
  readonly coordination?: readonly CoordinatorEvidence[];
  readonly outcome: "finished" | "stopped";
  readonly generation: number;
  readonly confirmedAt: string;
  readonly frontier: readonly {
    readonly environmentId: string;
    readonly blockId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly projectObservedAt: string;
    readonly executionObservedAt: string;
    readonly queueObservedAt: string;
    readonly nativeObservedAt: string;
    readonly activeRunId: string | null;
    readonly latestRunId: string | null;
    readonly executions: readonly {
      readonly executionId: string;
      readonly status: string;
      readonly ordinal: number | null;
      readonly sourceAt: string | null;
    }[];
    readonly queuedRunIds: readonly string[];
    readonly queueNextCursor: number | null;
    readonly pendingRequestCount: number;
  }[];
}
export interface RunSummary {
  readonly stopRequestedAt: string | null;
  readonly id: string;
  readonly task: { readonly id: string; readonly title: string; readonly projectId: string };
  readonly flowId: string;
  readonly flowName: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  readonly outcome: RunClosure["outcome"] | null;
}
export interface RunPresentation {
  readonly snoozed: boolean;
  readonly woke: boolean;
}
/** Global navigation reads durable Run identity without loading snapshots or Task hierarchies. */
export interface RunNavigationEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  /**
   * Orders entries with equal `createdAt` (ascending): the Start request key, which the
   * composer takes from the draft's id so its Run keeps the draft's place.
   */
  readonly creationKey: string;
  readonly project: Pick<FactoryProject, "id" | "title" | "workspaceRoot" | "availability">;
  readonly closedAt: string | null;
  readonly outcome: RunClosure["outcome"] | null;
  readonly stopRequestedAt: string | null;
  readonly blocks: readonly Pick<RunBlock, "state" | "freshness">[];
  /** Pending attention only. Reading this summary does not settle any matter. */
  readonly attention: RunAttentionSummary;
  readonly presentation: RunPresentation;
}
/** Read-only action candidates from durable ledgers. A click still requires fresh backend proof. */
export interface CoordinationAction {
  readonly sourceExecutionId: string;
  readonly threadId: string;
  readonly state: string;
  readonly executionId: string | null;
  readonly canRequest: boolean;
  readonly reason: string;
}
export interface RunCoordinationActions {
  readonly questionReplies: readonly {
    readonly attentionId: string;
    readonly requestId: string;
    readonly message: string;
    readonly state: string;
    readonly executionId: string | null;
  }[];
  readonly controlRecoveries: readonly (CoordinationAction & {
    readonly sourceStatus: string | null;
  })[];
}
export interface RunDetail extends RunSummary {
  /** Durable sequence used in worker titles. Assigned when the Run is accepted. */
  readonly number: number;
  readonly coordinationActions: RunCoordinationActions;
  /** Root work is Run-owned, never a Block execution or reporting binding. */
  readonly rootWork: readonly {
    readonly executionId: string;
    readonly engineStatus: string | null;
    readonly control: boolean;
    readonly observedStartedAt: string | null;
    readonly observedEndedAt: string | null;
  }[];
  readonly runCoordinator: {
    readonly freshness: "unknown" | "fresh" | "stale";
    readonly observedAt: string | null;
    readonly pendingRequestCount: number | null;
    readonly queuedCount: number | null;
    readonly pendingOperationCount: number;
    readonly pendingStopCount: number;
    readonly selection: AgentExecutionSettings;
    readonly state: "pending" | "reserved" | "uncertain" | "acknowledged" | "cancelled";
    readonly threadId: string | null;
    readonly executionId: string | null;
    readonly link: string | null;
    readonly engineStatus: string | null;
    readonly problem: string | null;
  } | null;
  readonly title: string;
  readonly closure: RunClosure | null;
  readonly input: string;
  readonly snapshot: RunSnapshot;
  readonly activations: readonly RunActivation[];
  readonly remoteWork: readonly RemoteWork[];
  readonly threadBindings: readonly RunThreadBinding[];
  readonly gateOpen: boolean;
  readonly generation: number;
  readonly blocks: readonly RunBlock[];
  readonly reports: readonly {
    readonly id: string;
    readonly blockId: string;
    readonly executionId: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly status: "waiting" | "finished";
    readonly exitId: string | null;
    readonly recipients: readonly string[];
    readonly acceptedAt: string;
    readonly completionEligibleAt?: string | null;
    readonly activationId?: string | null;
    readonly resultMessage?: string | null;
  }[];
  readonly recoveries: readonly {
    readonly attentionId: string;
    readonly blockId: string;
    readonly sourceExecutionId: string;
    readonly intentId: string;
    readonly executionId: string | null;
    readonly requestedAt: string;
    readonly settledAt: string | null;
  }[];
  readonly humanOccurrences: readonly HumanOccurrence[];
  readonly attention: readonly RunAttention[];
  readonly executions: readonly {
    readonly bindingId: string;
    readonly activationId: string | null;
    readonly blockId: string;
    readonly executionId: string;
    readonly engineStatus: string | null;
    readonly reportStatus: "waiting" | "finished" | null;
    readonly problem: string | null;
    readonly observedAt: string | null;
    readonly observedStartedAt: string | null;
    readonly observedEndedAt: string | null;
  }[];
  readonly intents: readonly {
    readonly id: string;
    readonly blockId: string;
    readonly reportId: string | null;
    readonly occurrenceId: string | null;
    readonly sourceBlockId: string | null;
    readonly exitId: string | null;
    readonly payloadRetained: boolean;
    readonly reference: {
      readonly threadId: string;
      readonly runId: string;
      readonly messageId?: string;
      readonly status: string;
    } | null;
    readonly kind: string;
    readonly state: string;
    readonly requestKey: string | null;
    readonly fingerprint: string;
    readonly contextId: string;
    readonly reservedAt: string | null;
    readonly problem: string | null;
  }[];
  readonly events: readonly {
    readonly sequence: number;
    readonly kind: string;
    readonly observedAt: string;
    readonly sourceAt: string | null;
    readonly engineStatus: string | null;
    readonly executionId: string | null;
    readonly causeId: string | null;
    readonly blockId: string | null;
  }[];
}

/** Native questions AND approvals are addressed in T3. No native response body is retained. */
export interface RunAttention {
  readonly bindingId?: string;
  readonly id: string;
  readonly runId: string;
  readonly taskTitle: string;
  readonly blockId: string;
  readonly blockName: string;
  readonly executionId: string;
  readonly kind:
    | "human"
    | "native-request"
    | "conversation-waiting"
    | "missing-report"
    | "execution-failed"
    | "report-problem";
  readonly nativeRequestId: string | null;
  readonly occurrenceId: string | null;
  readonly link: string | null;
  readonly freshness: "unknown" | "fresh" | "stale";
  readonly appearedAt: string;
  readonly settledAt: string | null;
  readonly settlementReason: string | null;
  /** The Agent's explanation for `conversation-waiting`; null for every other kind. */
  readonly message: string | null;
}

/** Needs input is a pending question or decision. Problem is an execution or report issue. */
export type RunAttentionPresentation = "needs-input" | "problem";

/**
 * One unsettled attention record. `id` is that record and the attention-appeared
 * event cause. A Human step also sets `occurrenceId` to the same occurrence.
 * Later wake detection treats an id that was not already recorded as new attention.
 */
export interface RunAttentionMatter {
  readonly id: string;
  readonly kind: RunAttention["kind"];
  readonly presentation: RunAttentionPresentation;
  readonly blockId: string;
  readonly occurrenceId: string | null;
  readonly nativeRequestId: string | null;
}

export interface RunAttentionSummary {
  readonly needsInput: boolean;
  readonly problem: boolean;
  readonly matters: readonly RunAttentionMatter[];
}

export function attentionPresentation(kind: RunAttention["kind"]): RunAttentionPresentation {
  switch (kind) {
    case "human":
    case "native-request":
    case "conversation-waiting":
      return "needs-input";
    case "missing-report":
    case "execution-failed":
    case "report-problem":
      return "problem";
  }
}

/** Each incoming activation is independent, including repeated visits to the same block. */
export interface HumanOccurrence {
  readonly id: string;
  readonly blockId: string;
  readonly incomingIntentId: string;
  readonly state: "pending" | "answered" | "withdrawn" | "cancelled-on-Stop";
  readonly context: string | null;
  readonly appearedAt: string;
  readonly settledAt: string | null;
  readonly exitId: string | null;
}
