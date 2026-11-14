import type { JSONSchema7, JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type {
  FactoryProject,
  FlowDraft,
  ProjectCatalog,
  Result,
  RunDetail,
  RunTitleSetting,
} from "@t3-factory/contracts";
import { promptTitle } from "@t3-factory/domain-validation";
import {
  exceedsReviewLimit,
  type ActionOutcome,
  type ChatOperation,
  type Proposed,
} from "./actions.ts";
import {
  invalid,
  type ChatToolOutcome,
  type ChatToolScope,
  type MutationTool,
} from "./chat-tools.ts";
import {
  exactTextProblem,
  refused,
  reviewMessages,
  sourceLine,
  TEXT_SOURCES,
  textBlocks,
  type TextSource,
} from "./review-text.ts";
import { clip, inert } from "./status-cards.ts";

/** The Factory operations a chat Start uses: the shared text Start and its reads. */
export interface StartOperations {
  readonly listProjects: () => Effect.Effect<Result<ProjectCatalog>, unknown>;
  readonly getFlow: (id: string) => Effect.Effect<Result<FlowDraft>, unknown>;
  readonly listFlows: () => Effect.Effect<Result<readonly FlowDraft[]>, unknown>;
  readonly getRunTitleSetting: () => Effect.Effect<Result<RunTitleSetting>, unknown>;
  /** Factory MCP's shared text Start; the request ID is the Start's identity. */
  readonly startTextRun: (input: unknown) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The Run a Start request ID was accepted as, if it was; read only. */
  readonly acceptedStart: (
    requestId: string,
  ) => Effect.Effect<Result<RunDetail> | undefined, unknown>;
}

/** A chat Start's exact parameters, immutable once proposed. */
interface StartParameters {
  readonly projectId: string;
  readonly flowId: string;
  readonly prompt: string;
  readonly source: TextSource;
}

const inputSchema: JSONSchema7 = {
  type: "object",
  properties: {
    projectId: { type: "string", description: "The permitted Project's ID from list_projects." },
    flowId: { type: "string", description: "The saved Flow's ID from list_flows." },
    prompt: {
      type: "string",
      description:
        "The Run's complete exact task text. Copy it character for character from the requester's message or selected reply; never shorten, complete or paraphrase it.",
    },
    promptSource: {
      type: "string",
      enum: [...TEXT_SOURCES],
      description:
        "requester-message or selected-reply when prompt is copied exactly from that text; composed when you wrote it, which Factory labels in the review.",
    },
    supersedes: {
      type: "string",
      description:
        "The proposal ID of this requester's pending Start review in this thread that this one corrects, if any.",
    },
  },
  required: ["projectId", "flowId", "prompt", "promptSource"],
  additionalProperties: false,
};

/** Untrusted call arguments as parameters, or what is wrong with them. */
function startArguments(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return "Arguments must be an object.";
  const { projectId, flowId, prompt, promptSource, supersedes, ...rest } = input as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) return `Unknown arguments: ${Object.keys(rest).join(", ")}.`;
  if (typeof projectId !== "string" || typeof flowId !== "string")
    return "projectId and flowId must be IDs from list_projects and list_flows.";
  if (typeof prompt !== "string" || prompt.trim() === "")
    return "The task text is missing. Ask the requester for the exact text; never invent it.";
  if (!TEXT_SOURCES.includes(promptSource as TextSource))
    return "promptSource must be requester-message, selected-reply or composed.";
  if (supersedes !== undefined && typeof supersedes !== "string")
    return "supersedes must be a proposal ID.";
  return {
    parameters: { projectId, flowId, prompt, source: promptSource as TextSource },
    supersedes,
  };
}

const workspaceLine = (flow: FlowDraft) =>
  flow.workspace.mode === "checkout"
    ? "in the Project's checkout"
    : flow.workspace.base.kind === "default"
      ? "new worktree from the default branch"
      : `new worktree from \`${flow.workspace.base.ref}\``;

/** Shown unless Generate Run titles is known to be off: an unread setting is not "off". */
const TITLE_REPLACEABLE = " _(may be replaced by a generated title)_";

const DISCLOSURE =
  "ℹ️ The current saved Flow and Agent definitions, workspace included, apply when you confirm; Factory checks again and may still refuse.";

type AcceptedFacts = {
  runId: string;
  runNumber: number | null;
  title: string;
  projectId: string;
  projectTitle: string | null;
  flowId: string;
  flowName: string;
};
type RejectedFacts = { message: string; issues: string[] };

const MAX_ISSUES = 5;

/** The complete review of a Start, as ordered Discord messages. */
function startReview(
  { prompt, source }: StartParameters,
  { project, flow }: { readonly project: FactoryProject; readonly flow: FlowDraft },
  title: string,
  setting: Result<RunTitleSetting>,
  sameNamedFlow: boolean,
) {
  const titled = setting.ok && !setting.value.enabled ? "" : TITLE_REPLACEABLE;
  return reviewMessages([
    "📝 **Start a Run?**",
    `📁 ${inert(project.title)} · \`${project.workspaceRoot}\``,
    `🔀 ${inert(flow.name)} · ${workspaceLine(flow)}${sameNamedFlow ? ` · \`${flow.id}\`` : ""}`,
    `🏷️ ${inert(title)}${titled}`,
    ...[sourceLine(source, "Prompt")].filter((line) => line !== undefined),
    ...textBlocks(prompt),
    DISCLOSURE,
  ]);
}

/** The chat Start: proposal validation and review, and its binding to the shared text Start. */
export function startAction(operations: StartOperations) {
  const projectTitle = (projectId: string) =>
    Effect.map(operations.listProjects(), (catalog) =>
      catalog.ok
        ? (catalog.value.projects.find((project) => project.id === projectId)?.title ?? null)
        : null,
    );

  const accepted = (run: RunDetail) =>
    Effect.map(projectTitle(run.task.projectId), (title): ActionOutcome => ({
      kind: "accepted",
      facts: {
        runId: run.id,
        runNumber: run.number,
        title: run.title,
        projectId: run.task.projectId,
        projectTitle: title,
        flowId: run.flowId,
        flowName: run.flowName,
      } satisfies AcceptedFacts,
      originRunId: run.id,
    }));

  const reconcile = (actionId: string) =>
    Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
      const run = yield* operations.acceptedStart(actionId);
      if (run === undefined) return { kind: "unavailable" };
      return run.ok ? yield* accepted(run.value) : { kind: "unknown" };
    });

  const operation: ChatOperation = {
    name: "start",
    execute: (actionId, parameters) =>
      Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
        const { projectId, flowId, prompt } = parameters as unknown as StartParameters;
        const result = yield* operations.startTextRun({
          requestId: actionId,
          projectId,
          flowId,
          input: prompt,
        });
        if (result.ok) return yield* accepted(result.value);
        const { code, message, issues } = result.error;
        // Start refuses these before accepting anything: a definitive rejection with no effect.
        if (code === "validation" || code === "not_found")
          return {
            kind: "rejected",
            facts: {
              message,
              issues: issues.slice(0, MAX_ISSUES).map((issue) => issue.message),
            } satisfies RejectedFacts,
          };
        // Factory is shutting down: Start decided nothing.
        if (code === "conflict" && issues.length === 0) return { kind: "unavailable" };
        return yield* reconcile(actionId);
      }),
    reconcile,
    receipt: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as AcceptedFacts;
        return [
          `✅ **Run ${facts.runNumber === null ? "" : `#${facts.runNumber} `}started** — ${inert(clip(facts.title, 500))}`,
          `📁 ${inert(clip(facts.projectTitle ?? facts.projectId, 200))} · 🔀 ${inert(clip(facts.flowName, 200))}`,
        ].join("\n");
      }
      const facts = outcome.facts as RejectedFacts;
      return [
        `❌ **Start not accepted** — ${clip(facts.message, 300)}`,
        ...facts.issues.map((issue) => `• ${clip(issue, 200)}`),
      ].join("\n");
    },
    summary: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as AcceptedFacts;
        return `Factory accepted Run ${facts.runNumber === null ? "" : `#${facts.runNumber} `}“${clip(facts.title, 200)}”.`;
      }
      return `Factory did not accept it: ${clip((outcome.facts as RejectedFacts).message, 300)}`;
    },
    target: (parameters) => (parameters as unknown as StartParameters).projectId,
  };

  /** The permitted, available Project and the ready saved Flow, or why they cannot be used. */
  const startTargets = (parameters: StartParameters, scope: ChatToolScope) =>
    Effect.gen(function* (): Effect.fn.Return<
      { readonly project: FactoryProject; readonly flow: FlowDraft } | ChatToolOutcome,
      unknown
    > {
      if (!scope.projectIds.includes(parameters.projectId))
        return refused(
          "project_not_permitted",
          "This thread does not permit that Project. Use a Project ID from list_projects.",
        );
      const catalog = yield* operations.listProjects();
      const project = catalog.ok
        ? catalog.value.projects.find((entry) => entry.id === parameters.projectId)
        : undefined;
      if (project?.availability !== "available")
        return refused(
          "project_unavailable",
          "Factory cannot start work in that Project now: its repository is unavailable. Say so; do not choose another Project.",
        );
      const flow = yield* operations.getFlow(parameters.flowId);
      if (!flow.ok)
        return refused("flow_not_found", "Factory has no saved Flow with that ID. Use list_flows.");
      if (!flow.value.readiness.ready)
        return refused(
          "flow_not_ready",
          `That Flow is not ready to start: ${flow.value.readiness.issues
            .slice(0, MAX_ISSUES)
            .map((issue) => issue.message)
            .join(" ")}`,
        );
      return { project, flow: flow.value };
    });

  const tool: MutationTool = {
    name: "start_run",
    description:
      "Propose starting a Factory Run of a saved Flow in a permitted Project with the requester's exact task text. Nothing starts now: Factory posts a complete review with a confirmation button only the requester can use, and ends this reply. Resolve the Project and Flow first; ask when text is missing or a target is ambiguous.",
    inputSchema,
    approval: "requester-confirmation",
    propose: (input, scope) =>
      Effect.gen(function* (): Effect.fn.Return<Proposed | ChatToolOutcome, unknown> {
        const parsed = startArguments(input);
        if (typeof parsed === "string") return invalid(parsed);
        const { parameters, supersedes } = parsed;
        const inexact = exactTextProblem("prompt", parameters.prompt, parameters.source, scope);
        if (inexact) return inexact;
        const targets = yield* startTargets(parameters, scope);
        if ("output" in targets) return targets;
        const { project, flow } = targets;
        const title = promptTitle(parameters.prompt)!;
        const flows = yield* operations.listFlows();
        const review = startReview(
          parameters,
          targets,
          title,
          yield* operations.getRunTitleSetting(),
          // A Flow is named by its ID only when the name alone cannot tell it apart.
          !flows.ok ||
            flows.value.some((other) => other.id !== flow.id && other.name === flow.name),
        );
        const confirmation = { label: "Confirm Start" };
        if (exceedsReviewLimit(review))
          return refused(
            "review_too_long",
            "Factory's complete review of this Start would exceed 32,000 characters, so it cannot be confirmed in chat. Suggest using Factory.",
          );
        return {
          operation: "start",
          parameters: parameters as unknown as JSONValue,
          projectIds: [project.id],
          review,
          confirmation,
          targets: {
            projectId: project.id,
            projectName: project.title,
            flowId: flow.id,
            flowName: flow.name,
            title,
            promptSource: parameters.source,
          },
          supersedes,
        } satisfies Proposed;
      }),
  };

  return { operation, tool };
}
