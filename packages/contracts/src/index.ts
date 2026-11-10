/** Transport-neutral values shared by the backend and its clients. No Node imports. */
import type { AgentDefinition, AgentExecutionSettings, agentOperations } from "./agent.ts";
import type { ClientAccessState, FactoryClient, clientAccessOperations } from "./client-access.ts";
import type { BlockExit } from "./flow.ts";
import type { FacadeOperations } from "./operation.ts";
import type { Result, ValidationIssue } from "./result.ts";

export * from "./result.ts";
export * from "./flow.ts";
export * from "./agent.ts";
export * from "./operation.ts";
export * from "./client-access.ts";
export * from "./update.ts";

export interface CreateFlowInput {
  readonly name: string;
}

interface BlockBase {
  readonly id: string;
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number };
}
/**
 * An Agent block exposes its Agent's exits, minus those this Flow hides, plus its Flow-local
 * exits. A Human block has the fixed Approve and Request changes exits.
 */
export type FlowBlock = BlockBase &
  (
    | {
        readonly kind: "agent";
        readonly agentId: string | null;
        /** Inherited Agent exit IDs hidden in this Flow; IDs the Agent no longer has are ignored. */
        readonly hiddenExitIds: readonly string[];
        /** Exits only this Flow adds to the block. */
        readonly localExits: readonly BlockExit[];
      }
    | { readonly kind: "human" }
  );
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
/** Where a new worktree starts: the Project repository's default branch or a named Git ref. */
export type FlowWorkspaceBase =
  | { readonly kind: "default" }
  | { readonly kind: "ref"; readonly ref: string };
/** The workspace every worker of a Run shares; saved on the Flow, outside its graph. */
export type FlowWorkspace =
  | { readonly mode: "checkout" }
  | { readonly mode: "worktree"; readonly base: FlowWorkspaceBase };
export interface UpdateFlowInput {
  readonly name: string;
  readonly expectedRevision: number;
  readonly graph: FlowGraph;
  /** Protocol 1–3 clients cannot see it and omit it; such a save keeps the saved setting. */
  readonly workspace?: FlowWorkspace;
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
  readonly workspace: FlowWorkspace;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readiness: FlowReadiness;
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
  /** `unsupported`: the provider has no Factory reporting yet; there is nothing to install. */
  readonly status: "not-installed" | "installed" | "needs-attention" | "unsupported";
  readonly message: string;
  readonly runtimeEvidence: "UNVERIFIED" | "ACCEPTED_REPORT";
  readonly actions: ReportingInstallationActions;
}
/** The Factory facade: derived from the operation definitions, plus operations HTTP does not reach. */
export interface FactoryOperations extends FacadeOperations<
  typeof agentOperations & typeof clientAccessOperations
> {
  getReportingInstallations(): Promise<Result<readonly ReportingInstallation[]>>;
  installReporting(input: unknown): Promise<Result<ReportingInstallation>>;
  answerHumanOccurrence(id: string, input: unknown): Promise<Result<RunDetail>>;
  listAttention(): Promise<Result<readonly RunAttention[]>>;
  /** Asks an idle Agent Block without a finished result to assess its existing work and report. */
  requestReport(runId: string, input: { blockId: string }): Promise<Result<RunDetail>>;
  /**
   * Archives a Run for good: closes its handoff gate, cancels unsent work and requests
   * interruption of its worker threads without waiting. The Run leaves navigation; its data stays.
   */
  archiveRun(id: string): Promise<Result<RunDetail>>;
  /** Moves an Active or Snoozed Run to Settled; an accepted Block report returns it to Active. */
  settleRun(id: string): Promise<Result<RunDetail>>;
  getRunCreationPolicy(): Promise<Result<RunCreationPolicy>>;
  startRun(input: unknown): Promise<Result<RunDetail>>;
  /** Whether Factory holds the bytes of this digest, staged or retained by a Run. */
  getRunImageInfo(sha256: string): Promise<Result<RunImageInfo>>;
  /** Stages raw image bytes under their digest for a later Start; an existing digest succeeds. */
  stageRunImage(sha256: string, input: StageRunImageInput): Promise<Result<RunImageInfo>>;
  getRunImage(sha256: string): Promise<Result<RunImageContent>>;
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
  getClientAccess(credential: string): Promise<Result<ClientAccessState>>;
  authenticateClient(credential: string): Promise<Result<FactoryClient>>;
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
export interface RunImageInfo {
  readonly sha256: string;
  readonly mimeType: RunImageMimeType;
  readonly sizeBytes: number;
}
export interface StageRunImageInput {
  /** The request's declared Content-Type; the bytes' signature must match it. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}
export interface RunImageContent {
  readonly mimeType: RunImageMimeType;
  readonly data: Uint8Array;
}
export interface ProjectCatalog {
  readonly projects: readonly FactoryProject[];
  readonly selectedProjectId: string | null;
  readonly problem: string | null;
}

export type RunImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** One image of a Run's initial prompt. `imageId` is draft-local; `sha256` names the staged bytes. */
export interface RunImage {
  readonly imageId: string;
  readonly sha256: string;
  readonly name: string;
  readonly mimeType: RunImageMimeType;
  readonly sizeBytes: number;
}
/** The initial prompt in order: text, and references to images of the manifest. */
export type PromptSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly imageId: string };
export interface StartRunInput {
  /** Also the Run's navigation `creationKey`. */
  readonly requestId: string;
  readonly projectId: string;
  readonly flowId: string;
  readonly segments: readonly PromptSegment[];
  /** Every image of the prompt in manifest order, including ones no segment references. */
  readonly images: readonly RunImage[];
  /** The draft's chosen title; stored trimmed as the Run title. */
  readonly title: string;
  /** When the draft was created, as `Date.toISOString()` output; it orders Run navigation. */
  readonly createdAt: string;
}
export interface TaskRunEntry {
  readonly id: string;
  readonly lifecycle: RunLifecycle;
  readonly flowId: string;
  readonly flowName: string;
  readonly input: string;
  readonly startedAt: string;
}
export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly activeRunId: string | null;
  readonly latestRun: {
    readonly id: string;
    readonly lifecycle: RunLifecycle;
    readonly flowId: string;
    readonly flowName: string;
    readonly startedAt: string;
  } | null;
  readonly runs: readonly TaskRunEntry[];
}
/** Factory can accept a Start. The server no longer publishes a coordinator contract. */
export interface RunCreationPolicy {
  readonly ready: true;
}
export interface RunActivation {
  readonly id: string;
  readonly blockId: string;
  readonly cause: string;
  readonly phase: "delegating" | "assessing" | "reported" | "finished";
  readonly problem: string | null;
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
/**
 * The Flow revision and the Agent revisions a Run captured at Start, read from stored revisions.
 * Readiness and settings availability are live authoring checks, not part of a revision.
 */
export interface RunDefinitions {
  readonly flow: Omit<FlowDraft, "readiness">;
  readonly agents: readonly Omit<AgentDefinition, "settingsStatus">[];
}
export interface RunBlock {
  readonly blockId: string;
  readonly name: string;
  /** `stopped`: the Run was archived before this activated Block finished. */
  readonly state: "not-started" | "working" | "waiting" | "finished" | "error" | "stopped";
  readonly threadId: string | null;
  readonly executionId: string | null;
  readonly link: string | null;
  readonly engineStatus: string | null;
  readonly reportStatus: "working" | "finished" | null;
  /** The Agent's message while `working` is the current report of the Block's current visit. */
  readonly workingMessage: string | null;
  readonly problem: string | null;
  readonly pendingRequestCount: number | null;
  readonly observedAt: string | null;
  readonly freshness: "unknown" | "fresh" | "stale";
  /** An unresolved Factory launch for this Block. Title search has not bound a worker. */
  readonly recovery: "pending" | null;
}
/** The workspace every worker of a Run shares. */
export type RunWorkspaceDetail =
  | { readonly mode: "checkout" }
  | {
      readonly mode: "worktree";
      readonly baseRef: string;
      readonly state: "preparing" | "bound" | "failed";
      /** The worktree path and branch T3 reported; null until bound. */
      readonly path: string | null;
      readonly branch: string | null;
      readonly problem: string | null;
    };
/**
 * Active Runs are in the main navigation. Settled Runs are done, automatically or because the
 * user settled them; an accepted Block report returns them to Active. Archived Runs are final
 * and hidden from navigation; their data stays.
 */
export type RunLifecycle = "active" | "settled" | "archived";
export interface RunSummary {
  readonly id: string;
  readonly lifecycle: RunLifecycle;
  readonly task: { readonly id: string; readonly title: string; readonly projectId: string };
  readonly flowId: string;
  readonly flowName: string;
  readonly startedAt: string;
}
export interface RunPresentation {
  readonly snoozed: boolean;
  readonly woke: boolean;
}
export interface RunPullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged" | null;
}
/** Last repository metadata T3 reported for a bound worker, independent of its Block result. */
export interface RunWorkerRepository {
  readonly blockId: string;
  readonly blockName: string;
  readonly threadId: string;
  readonly branch: string | null;
  readonly pullRequests: readonly RunPullRequest[];
  readonly updatedAt: string;
  readonly freshness: RunBlock["freshness"];
}
/** Global navigation reads durable Run identity without loading definitions or Task hierarchies. */
export interface RunNavigationEntry {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly flowName: string;
  readonly repositories: readonly RunWorkerRepository[];
  /**
   * Orders entries with equal `createdAt` (ascending): the Start request key, which the
   * composer takes from the draft's id so its Run keeps the draft's place.
   */
  readonly creationKey: string;
  readonly project: Pick<
    FactoryProject,
    "id" | "title" | "workspaceRoot" | "availability" | "projectIcon" | "faviconUrl"
  >;
  readonly lifecycle: Exclude<RunLifecycle, "archived">;
  readonly blocks: readonly Pick<RunBlock, "state" | "freshness" | "workingMessage">[];
  /** Pending attention only. Reading this summary does not settle any matter. */
  readonly attention: RunAttentionSummary;
  readonly presentation: RunPresentation;
}
/** Answers sent from Factory to retired conversation-waiting questions, kept as history. */
export interface RunCoordinationActions {
  readonly questionReplies: readonly {
    readonly attentionId: string;
    readonly requestId: string;
    readonly message: string;
    readonly state: string;
    readonly executionId: string | null;
  }[];
}
export interface RunDetail extends RunSummary {
  readonly repositories: readonly RunWorkerRepository[];
  /** Durable sequence used in worker titles; null when absent from stored history. */
  readonly number: number | null;
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
  /** The worker-readable prompt frozen at Start, with `[Image N: name]` references. */
  readonly input: string;
  /** The prompt as accepted at Start; image segments name entries of `images`. */
  readonly segments: readonly PromptSegment[];
  /** Every image of the initial prompt in manifest order; position + 1 is its `Image N` ordinal. */
  readonly images: readonly RunImage[];
  readonly definitions: RunDefinitions;
  readonly workspace: RunWorkspaceDetail;
  readonly activations: readonly RunActivation[];
  readonly threadBindings: readonly RunThreadBinding[];
  readonly gateOpen: boolean;
  readonly generation: number;
  readonly blocks: readonly RunBlock[];
  readonly reports: readonly {
    readonly id: string;
    readonly blockId: string;
    readonly executionId: string | null;
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
    /** The missing-report Problem this Request report settles; null when none was pending. */
    readonly attentionId: string | null;
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
    readonly reportStatus: "working" | "waiting" | "finished" | null;
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
  /**
   * The Agent's question for `conversation-waiting`, a retired kind kept only as settled history;
   * null for every other kind.
   */
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
  /** `cancelled`: Archive cancelled the occurrence; no answer was invented. */
  readonly state: "pending" | "answered" | "withdrawn" | "cancelled";
  readonly context: string | null;
  readonly appearedAt: string;
  readonly settledAt: string | null;
  readonly exitId: string | null;
}
export * from "./live.ts";
