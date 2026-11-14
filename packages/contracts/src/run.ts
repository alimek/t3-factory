/** Runs, their prompt images, Tasks, attention and Human occurrences. */
import type { AgentDefinition, AgentExecutionSettings, AgentModelOptionValue } from "./agent.ts";
import type { FlowDraft } from "./flow.ts";
import type { FactoryProject } from "./project.ts";
import { operation, operationPath } from "./operation.ts";

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
/** A Settled or Archived Run that attached a stored image, at the image's 1-based `ordinal`. */
export interface RunImageReference {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  readonly lifecycle: Exclude<RunLifecycle, "active">;
  readonly project: { readonly id: string; readonly title: string };
  readonly ordinal: number;
}
/**
 * Stored image bytes whose every referencing Run is Settled or Archived. `name` is the name the
 * newest referencing Run gave it; `runs` lists every referencing Run, newest first.
 */
export interface EligibleRunImage extends RunImageInfo {
  readonly name: string;
  readonly runs: readonly RunImageReference[];
}
/** Stored images to delete, by their lowercase hex SHA-256 digests. */
export interface DeleteRunImagesInput {
  readonly sha256: readonly string[];
}
/** Digests whose bytes were removed, and those kept because they were unknown or no longer eligible. */
export interface RunImageDeletion {
  readonly deleted: readonly string[];
  readonly skipped: readonly string[];
}
/** The initial prompt in order: text, and references to images of the manifest. */
export type PromptSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly imageId: string };
/**
 * How a Run's title was chosen: the prompt's first line (`automatic`), the owner's own title
 * (`manual`), a title model's (`generated`), or unknown because the Run or its request predates
 * provenance (`legacy`). It is recorded explicitly, never inferred from the title text.
 */
export type RunTitleProvenance = "automatic" | "manual" | "generated" | "legacy";
/** A Start never claims a generated title: generation only replaces an accepted automatic one. */
export type StartTitleProvenance = Exclude<RunTitleProvenance, "generated">;
/**
 * Run title generation for one Run, decided once at Start: pending until a terminal outcome.
 * `skipped` means an eligibility check failed or the prompt had no meaningful text.
 */
export type RunTitleGenerationState =
  | "pending"
  | "applied"
  | "dropped"
  | "timed-out"
  | "cancelled"
  | "skipped"
  | "failed";
/** What a Run captured for title generation at Start, and how it ended. */
export interface RunTitleGeneration {
  readonly state: RunTitleGenerationState;
  /** A short reason for the state; null while pending. */
  readonly reason: string | null;
  /** The provider and model captured at Start, as T3's catalog labelled them. */
  readonly modelLabel: string;
  /** Acceptance time plus 30 seconds. */
  readonly deadlineAt: string;
  /** The Run's title at Start: its prompt's first non-empty line. */
  readonly automaticTitle: string;
  readonly generatedTitle: string | null;
  /** The title thread in T3, once known. */
  readonly threadLink: string | null;
}
/** The T3 provider instance, model and options the title model runs with. */
export interface RunTitleModel {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly modelOptions: readonly AgentModelOptionValue[];
}
/** The latest eligibility failure recorded at Start, kept until a later one replaces it. */
export interface RunTitleDiagnostic {
  readonly runId: string;
  readonly runNumber: number | null;
  readonly message: string;
  readonly recordedAt: string;
}
/** The installation-wide Generate Run titles setting; only the Factory host changes it. */
export interface RunTitleSetting {
  readonly enabled: boolean;
  readonly model: RunTitleModel | null;
  readonly diagnostic: RunTitleDiagnostic | null;
}
/** Enabling needs a model the live T3 catalog offers; a disabled setting may keep its model. */
export interface UpdateRunTitleSettingInput {
  readonly enabled: boolean;
  readonly model: RunTitleModel | null;
}
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
  /** How the draft's title was chosen; part of the request identity. */
  readonly titleProvenance: StartTitleProvenance;
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
   * `stopped`: the user archived or manually settled the Run before this activated Block
   * finished. A Continuation is `sent` while its prompt is in a worker thread and `pass-through`
   * once its response went out.
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
 * user settled them; an accepted Block report returns an automatically settled Run to Active,
 * while a manually settled Run's work stays stopped. Archived Runs are final and hidden from
 * navigation; their data stays.
 */
export type RunLifecycle = "active" | "settled" | "archived";

/** What the user sends to settle a Run manually. */
export interface SettleRunInput {
  /**
   * Explicit authorization to stop the Run's executing workers. Without it, Settle on a Run whose
   * workers T3 does not confirm finished answers `confirmation-required` and changes nothing.
   */
  readonly stopWorkers?: boolean;
}

/** One bound worker thread as manual settlement sees it. */
export interface RunSettlementWorker {
  /** The worker's Flow block. */
  readonly blockId: string;
  readonly blockName: string;
  /** Null for a launch Factory has no acknowledgement for: it searches T3 for its worker. */
  readonly threadId: string | null;
  readonly link: string | null;
  /**
   * `executing` (only in a `confirmation-required` answer): a fresh read in the Run's scope showed
   * the worker unfinished, so confirming stops it. `stopping`: Factory requested T3 Stop in this attempt, or is about to, and
   * waits for a fresh read to confirm the thread finished. `finished`: the latest fresh read
   * confirmed it. `unresolved`: Stop is unsupported, failed or not confirmed, T3 could not
   * show the thread, or the launch is still searched for; Settle with `stopWorkers` again to retry.
   */
  readonly state: "executing" | "stopping" | "finished" | "unresolved";
  /** When Factory requested T3 Stop for this worker in the current attempt. */
  readonly stopRequestedAt: string | null;
  /** What keeps the worker from counting as finished, or why it could not be stopped. */
  readonly problem: string | null;
}

/**
 * A manual settlement the user confirmed, while it has not settled the Run yet. Its handoff gate
 * is closed: nothing new is launched, sent, released or answered. It is not a lifecycle state;
 * the Run stays Active until every worker is confirmed finished.
 */
export interface RunSettlement {
  /** `unresolved` while any worker of the current attempt is unresolved; otherwise `stopping`. */
  readonly state: "stopping" | "unresolved";
  /** When the user first confirmed Settle. */
  readonly requestedAt: string;
  /** 1 for the confirmation, increased by every retry. */
  readonly attempt: number;
  readonly attemptedAt: string;
  readonly workers: readonly RunSettlementWorker[];
}

/** The answer to manual Settle. */
export type RunSettlementOutcome =
  /** The Run is Settled: now, or it already was. */
  | { readonly outcome: "settled"; readonly run: RunDetail }
  /** The confirmed settlement is in progress; `run.settlement` shows it. */
  | { readonly outcome: "stopping" | "unresolved"; readonly run: RunDetail }
  /**
   * T3 did not confirm every bound worker finished. Nothing changed and no Stop was sent; Settle
   * again with `stopWorkers: true` to stop them and settle the Run.
   */
  | {
      readonly outcome: "confirmation-required";
      readonly run: RunDetail;
      readonly workers: readonly RunSettlementWorker[];
    };
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
  readonly titleProvenance: RunTitleProvenance;
  /** Null when the Run records no title generation. */
  readonly titleGeneration: RunTitleGeneration | null;
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
  /** A confirmed manual settlement in progress; see `RunDetail.settlement`. */
  readonly settlement: RunSettlement["state"] | null;
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
  readonly titleProvenance: RunTitleProvenance;
  /** Null when the Run records no title generation: manual, legacy or started with the setting off. */
  readonly titleGeneration: RunTitleGeneration | null;
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
  /** Closed by Archive and by accepting a manual settlement. */
  readonly gateOpen: boolean;
  /** The confirmed manual settlement in progress; null once Settled, when Archived or never. */
  readonly settlement: RunSettlement | null;
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
  readonly waitArrivals: readonly WaitArrival[];
  readonly continuationVisits: readonly ContinuationVisit[];
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
    /** The Wait arrival whose forwarding created this Handoff. */
    readonly waitArrivalId: string | null;
    readonly origin: WorkerProvenance | null;
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

/** Each incoming activation is independent, including repeated visits to the same block. */
export interface HumanOccurrence {
  readonly id: string;
  readonly blockId: string;
  readonly incomingIntentId: string;
  /** `cancelled`: Archive or manual settlement cancelled the occurrence; no answer was invented. */
  readonly state: "pending" | "answered" | "withdrawn" | "cancelled";
  readonly context: string | null;
  readonly appearedAt: string;
  readonly settledAt: string | null;
  readonly exitId: string | null;
}

/**
 * A delivery's worker provenance as Run detail shows it: the Run, the Block activation whose
 * result the message is and that worker's T3 thread. An Agent result establishes it; a Wait
 * forwards it unchanged. Absent unless both thread and activation are known.
 */
export interface WorkerProvenance {
  readonly runId: string;
  readonly activationId: string;
  readonly threadId: string;
}

/**
 * One accepted delivery to a Wait, held until its own deadline and then forwarded unchanged to
 * every recipient of the Wait's output. Parallel and repeated arrivals stay independent.
 */
export interface WaitArrival {
  readonly id: string;
  readonly blockId: string;
  readonly incomingIntentId: string;
  /** `cancelled`: Archive cancelled the arrival before it forwarded. */
  readonly state: "pending" | "forwarded" | "cancelled";
  /** `timer`: the deadline elapsed; `user`: Continue now forwarded it early. Null unless forwarded. */
  readonly forwardedBy: "timer" | "user" | null;
  /** The retained incoming message; null once no recipient needs it or Archive cleared it. */
  readonly message: string | null;
  readonly origin: WorkerProvenance | null;
  /** When the incoming handoff was released and counting started. */
  readonly startedAt: string;
  /** The absolute deadline, fixed when the arrival was recorded. */
  readonly deadlineAt: string;
  readonly settledAt: string | null;
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
  /**
   * Settles an Active or Snoozed Run and cancels its remaining automatic work. Executing workers
   * are stopped only with `stopWorkers: true`; Factory then settles the Run in the background
   * once fresh T3 reads confirm every worker finished. Repeating it while stopping changes
   * nothing; with `stopWorkers: true` on an unresolved settlement it retries.
   */
  settleRun: operation<SettleRunInput, RunSettlementOutcome>()({
    method: "POST",
    path: "/api/runs/:id/settle",
    body: "json",
  }),
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
  answerHumanOccurrence: operation<{ exitId?: string; message?: string }, RunDetail>()({
    method: "POST",
    path: "/api/human-occurrences/:id/answer",
    body: "json",
  }),
  /**
   * Continue now: forwards one pending Wait arrival immediately, as its deadline would, and
   * disables its timer. An arrival already forwarded or cancelled is a conflict without change.
   */
  continueWaitArrival: operation<never, RunDetail>()({
    method: "POST",
    path: "/api/wait-arrivals/:id/continue",
  }),
  listAttention: operation<never, readonly RunAttention[]>()({
    method: "GET",
    path: "/api/attention",
  }),
  getRunTitleSetting: operation<never, RunTitleSetting>()({
    method: "GET",
    path: "/api/settings/run-titles",
  }),
  /** Host only: approved clients read the setting but cannot change it. */
  updateRunTitleSetting: operation<UpdateRunTitleSettingInput, RunTitleSetting>()({
    method: "PUT",
    path: "/api/settings/run-titles",
    body: "json",
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
  /** A stored image's bytes, revalidated by the digest's ETag on every load; see `runImageUrl`. */
  getRunImage: operation<never, RunImageContent>()({
    method: "GET",
    path: "/api/run-images/:sha256",
    answer: "bytes",
  }),
  /** Stored images no Active Run uses; a `projectId` keeps those a Run of that project uses. */
  listEligibleRunImages: operation<never, readonly EligibleRunImage[]>()({
    method: "GET",
    path: "/api/run-images",
    query: ["projectId"],
  }),
  /**
   * Deletes the bytes of eligible stored images, rechecking eligibility for each; Run manifests
   * and history stay unchanged, and a digest that is unknown or no longer eligible is skipped.
   */
  deleteRunImages: operation<DeleteRunImagesInput, RunImageDeletion>()({
    method: "POST",
    path: "/api/run-images/delete",
    body: "json",
  }),
};

/**
 * The URL clients load a stored image's bytes from. `key` is the client's revalidation key,
 * ignored by the server: a client changes it to ask again for bytes it may have loaded before.
 * Every client URL carries it, so none matches a copy cached under the year-long immutable
 * policy the bare path was served with before.
 */
export const runImageUrl = (sha256: string, key: string) =>
  `${operationPath(runOperations.getRunImage, sha256)}?v=${key}`;
