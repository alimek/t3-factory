/** Runs, their prompt images, Tasks, attention and Human occurrences. */
import type { AgentDefinition, AgentExecutionSettings } from "./agent.ts";
import type { FlowDraft } from "./flow.ts";
import type { FactoryProject } from "./project.ts";
import { operation } from "./operation.ts";

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
  /**
   * `stopped`: the Run was archived before this activated Block finished. A Continuation is
   * `sent` while its prompt is in a worker thread and `pass-through` once its response went out.
   * A Human step or a Wait is `waiting` while an occurrence or arrival is pending on it.
   */
  readonly state:
    | "not-started"
    | "working"
    | "waiting"
    | "finished"
    | "error"
    | "stopped"
    | "sent"
    | "pass-through";
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
  readonly continuationVisits: readonly ContinuationVisit[];
  readonly waitArrivals: readonly WaitArrival[];
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

/**
 * One message that reached a Continuation. The first sends the prompt into the message's worker
 * thread (`prompt`); every later one is forwarded unchanged (`pass-through`), keeping its own
 * worker. Messages arriving while the prompt is pending stay `queued` until its response is out.
 */
export interface ContinuationVisit {
  readonly id: string;
  readonly blockId: string;
  /** The delivery that arrived; Continuation timeline events name it as their cause. */
  readonly incomingIntentId: string;
  readonly kind: "prompt" | "pass-through";
  /** The block whose result or answer arrived. */
  readonly sourceBlockId: string | null;
  /** The worker thread binding the message belongs to; see `RunDetail.threadBindings`. */
  readonly bindingId: string | null;
  /** The prompt visit's activation, which the worker reports against. */
  readonly activationId: string | null;
  readonly state: "queued" | "sent" | "forwarded" | "cancelled";
  readonly arrivedAt: string;
  readonly forwardedAt: string | null;
}

/**
 * The worker a delivered message belongs to: the T3 thread of a worker binding of this Run, and the
 * Block activation whose result produced the message when it is known.
 */
export interface MessageOrigin {
  /** See `RunDetail.threadBindings`. */
  readonly bindingId: string;
  readonly threadId: string;
  readonly activationId: string | null;
}

/**
 * One message that reached a Wait. Each arrival waits for the Wait's duration from its own start
 * and is forwarded unchanged on its own; parallel arrivals and later visits never join or reset.
 */
export interface WaitArrival {
  readonly id: string;
  readonly blockId: string;
  /** The delivery that arrived, the arrival's deduplication identity; a retry of it is no new
   * arrival. */
  readonly incomingIntentId: string;
  /** The block whose result or answer arrived. */
  readonly sourceBlockId: string | null;
  /** Null when the message arrived without a worker. */
  readonly origin: MessageOrigin | null;
  /** The Final result version whose message waits; null for a Human step's answer. */
  readonly reportId: string | null;
  /** `cancelled`: Archive cancelled the arrival before its deadline; nothing was forwarded. */
  readonly state: "pending" | "forwarded" | "cancelled";
  /** Why a forwarded arrival left: its deadline elapsed or the user continued it early. */
  readonly forwardReason: "elapsed" | "early" | null;
  /** The waiting message, retained while pending; null once forwarded or cancelled. */
  readonly message: string | null;
  /** When counting started: the incoming handoff's release. */
  readonly startedAt: string;
  readonly deadlineAt: string;
  /** When it was forwarded or cancelled. */
  readonly settledAt: string | null;
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

export const runOperations = {
  listRunNavigation: operation<never, readonly RunNavigationEntry[]>()({
    method: "GET",
    path: "/api/run-navigation",
  }),
  startRun: operation<StartRunInput, RunDetail>()({
    method: "POST",
    path: "/api/runs",
    body: "json",
  }),
  getRun: operation<never, RunDetail>()({ method: "GET", path: "/api/runs/:id" }),
  listRuns: operation<never, readonly RunSummary[]>()({
    method: "GET",
    path: "/api/runs",
    query: ["projectId"],
  }),
  renameRun: operation<{ title: string }, RunDetail>()({
    method: "PATCH",
    path: "/api/runs/:id",
    body: "json",
  }),
  snoozeRun: operation<never, RunPresentation>()({ method: "POST", path: "/api/runs/:id/snooze" }),
  restoreRun: operation<never, RunPresentation>()({
    method: "POST",
    path: "/api/runs/:id/restore",
  }),
  markRunWokeSeen: operation<never, RunPresentation>()({
    method: "POST",
    path: "/api/runs/:id/woke-seen",
  }),
  /** Moves an Active or Snoozed Run to Settled; an accepted Block report returns it to Active. */
  settleRun: operation<never, RunDetail>()({ method: "POST", path: "/api/runs/:id/settle" }),
  /**
   * Archives a Run for good: closes its handoff gate, cancels unsent work and requests
   * interruption of its worker threads without waiting. The Run leaves navigation; its data stays.
   */
  archiveRun: operation<never, RunDetail>()({ method: "POST", path: "/api/runs/:id/archive" }),
  /** Asks an idle Agent Block without a finished result to assess its existing work and report. */
  requestReport: operation<{ blockId: string }, RunDetail>()({
    method: "POST",
    path: "/api/runs/:runId/request-report",
    body: "json",
  }),
  continueWaitArrival: operation<never, RunDetail>()({
    method: "POST",
    path: "/api/wait-arrivals/:id/continue",
  }),
  answerHumanOccurrence: operation<{ exitId?: string; message?: string }, RunDetail>()({
    method: "POST",
    path: "/api/human-occurrences/:id/answer",
    body: "json",
  }),
  listAttention: operation<never, readonly RunAttention[]>()({
    method: "GET",
    path: "/api/attention",
  }),
  getRunCreationPolicy: operation<never, RunCreationPolicy>()({
    method: "GET",
    path: "/api/run-creation-policy",
  }),
  listTasks: operation<never, readonly TaskSummary[]>()({
    method: "GET",
    path: "/api/tasks",
    query: ["projectId"],
  }),
  updateTask: operation<{ title: string }, TaskSummary>()({
    method: "PATCH",
    path: "/api/tasks/:id",
    body: "json",
  }),
  /** Whether Factory holds the bytes of this digest, staged or retained by a Run. */
  getRunImageInfo: operation<never, RunImageInfo>()({
    method: "HEAD",
    path: "/api/run-images/:sha256",
    // A HEAD answer has no body, so clients read only its status; not a JSON `Result` call.
    answer: "bytes",
  }),
  /** Stages raw image bytes under their digest for a later Start; an existing digest succeeds. */
  stageRunImage: operation<StageRunImageInput, RunImageInfo>()({
    method: "PUT",
    path: "/api/run-images/:sha256",
    body: "bytes",
  }),
  getRunImage: operation<never, RunImageContent>()({
    method: "GET",
    path: "/api/run-images/:sha256",
    answer: "bytes",
  }),
};
