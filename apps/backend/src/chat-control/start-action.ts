import type { JSONSchema7, JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type {
  FlowDraft,
  ProjectCatalog,
  Result,
  RunDetail,
  RunTitleSetting,
} from "@t3-factory/contracts";
import { promptTitle } from "@t3-factory/domain-validation";
import {
  REVIEW_CHARACTER_LIMIT,
  type ActionOutcome,
  type ChatOperation,
  type Proposed,
} from "./actions.ts";
import { invalid, type ChatToolOutcome, type MutationTool } from "./chat-tools.ts";
import { messageParts } from "./interpretation.ts";

/** The Factory operations a chat Start uses: the shared text Start and its reads. */
export interface StartOperations {
  readonly listProjects: () => Effect.Effect<Result<ProjectCatalog>, unknown>;
  readonly getFlow: (id: string) => Effect.Effect<Result<FlowDraft>, unknown>;
  readonly getRunTitleSetting: () => Effect.Effect<Result<RunTitleSetting>, unknown>;
  /** Factory MCP's shared text Start; the request ID is the Start's identity. */
  readonly startTextRun: (input: unknown) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The Run a Start request ID was accepted as, if it was; read only. */
  readonly acceptedStart: (
    requestId: string,
  ) => Effect.Effect<Result<RunDetail> | undefined, unknown>;
}

/** Where the exact prompt text came from. */
type PromptSource = "requester-message" | "selected-reply" | "composed";
const PROMPT_SOURCES: readonly PromptSource[] = ["requester-message", "selected-reply", "composed"];

/** A chat Start's exact parameters, immutable once proposed. */
interface StartParameters {
  readonly projectId: string;
  readonly flowId: string;
  readonly prompt: string;
  readonly source: PromptSource;
}

const PROMPT_CHARACTERS = 8000;
const PROMPT_BYTES = 16 * 1024;
const MESSAGE_LENGTH = 2000;
const FENCE = "```";

const characters = (text: string) => [...text].length;

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
      enum: [...PROMPT_SOURCES],
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
  if (!PROMPT_SOURCES.includes(promptSource as PromptSource))
    return "promptSource must be requester-message, selected-reply or composed.";
  if (supersedes !== undefined && typeof supersedes !== "string")
    return "supersedes must be a proposal ID.";
  return {
    parameters: { projectId, flowId, prompt, source: promptSource as PromptSource },
    supersedes: supersedes as string | undefined,
  };
}

const refused = (error: string, message: string): ChatToolOutcome => ({
  output: { error, message },
  fact: { error },
});

/** Displayable text inside a code block; the stored prompt is never changed. */
const fenced = (text: string) => `${FENCE}\n${text.replaceAll(FENCE, "``​`")}\n${FENCE}`;

/** Code blocks carrying all of `prompt` in order, each within one Discord message. */
function promptBlocks(prompt: string) {
  const room = MESSAGE_LENGTH - 2 * (FENCE.length + 1) - 64;
  const blocks: string[] = [];
  let block = "";
  for (const character of prompt) {
    if (block.length + character.length > room) {
      blocks.push(fenced(block));
      block = "";
    }
    block += character;
  }
  return [...blocks, fenced(block)];
}

const workspaceLine = (flow: FlowDraft) =>
  flow.workspace.mode === "checkout"
    ? "the Project's checkout"
    : flow.workspace.base.kind === "default"
      ? "a new worktree from the Project's default branch"
      : `a new worktree from \`${flow.workspace.base.ref}\``;

const titlePolicy = (setting: Result<RunTitleSetting>) =>
  !setting.ok
    ? "Factory could not read the Generate Run titles setting, so a generated title may still replace this one shortly after Start."
    : setting.value.enabled
      ? "Generate Run titles is on: Factory may replace this title with a generated title shortly after Start."
      : "Generate Run titles is off: the Run keeps this title.";

const SOURCE_LINES: Record<PromptSource, string> = {
  "requester-message": "exactly as written in your message",
  "selected-reply": "exactly as written in the message you replied to",
  composed:
    "**composed by Factory's assistant, not written by you**; read all of it before confirming",
};

const DISCLOSURE = [
  "When you confirm, Factory resolves the current saved definitions of this Flow and its Agents, including the workspace setting, at that moment: changes saved before then apply without another review. Factory checks the Project, the Flow and T3 again and may still refuse the Start.",
  "Only the person who asked can confirm, with the button below, within five minutes of it appearing. A reply such as “yes” confirms nothing.",
].join("\n");

const clip = (text: string, limit: number) =>
  characters(text) <= limit ? text : `${[...text].slice(0, limit - 1).join("")}…`;

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
          `**Start accepted.** Factory accepted Run ${facts.runNumber === null ? "" : `#${facts.runNumber} `}“${clip(facts.title, 500)}” in ${clip(facts.projectTitle ?? facts.projectId, 200)} with Flow ${clip(facts.flowName, 200)}. Workers start asynchronously; Factory shows their progress.`,
          `Run ID: \`${facts.runId}\``,
        ].join("\n");
      }
      const facts = outcome.facts as RejectedFacts;
      return [
        `**Start not accepted.** Factory did not start this Run: ${clip(facts.message, 300)}`,
        ...facts.issues.map((issue) => `- ${clip(issue, 200)}`),
        "Nothing was started. Fix the cause, then ask for a new review.",
      ].join("\n");
    },
    summary: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as AcceptedFacts;
        return `Factory accepted Run ${facts.runNumber === null ? "" : `#${facts.runNumber} `}“${clip(facts.title, 200)}”.`;
      }
      return `Factory did not accept it: ${clip((outcome.facts as RejectedFacts).message, 300)}`;
    },
  };

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
        const { prompt, source } = parameters;
        if (characters(prompt) > PROMPT_CHARACTERS || Buffer.byteLength(prompt) > PROMPT_BYTES)
          return refused(
            "prompt_too_long",
            "The task text is longer than Chat control accepts (8,000 characters and 16 KiB). Ask the requester for shorter text or to use Factory; never shorten it yourself.",
          );
        const origin =
          source === "requester-message"
            ? scope.source.message
            : source === "selected-reply"
              ? scope.source.selectedReply
              : undefined;
        if (source !== "composed" && (origin === null || !origin!.includes(prompt)))
          return refused(
            "prompt_not_exact",
            `The prompt is not exact text from the ${source === "selected-reply" ? "selected reply" : "requester's message"}. Copy it character for character, or mark it composed so Factory labels it.`,
          );
        if (!scope.projectIds.includes(parameters.projectId))
          return refused(
            "project_not_permitted",
            "This thread does not permit that Project. Use a Project ID from list_projects.",
          );
        const catalog = yield* operations.listProjects();
        const project = catalog.ok
          ? catalog.value.projects.find((entry) => entry.id === parameters.projectId)
          : undefined;
        if (!project || project.availability !== "available")
          return refused(
            "project_unavailable",
            "Factory cannot start work in that Project now: its repository is unavailable. Say so; do not choose another Project.",
          );
        const flow = yield* operations.getFlow(parameters.flowId);
        if (!flow.ok)
          return refused(
            "flow_not_found",
            "Factory has no saved Flow with that ID. Use list_flows.",
          );
        if (!flow.value.readiness.ready)
          return refused(
            "flow_not_ready",
            `That Flow is not ready to start: ${flow.value.readiness.issues
              .slice(0, MAX_ISSUES)
              .map((issue) => issue.message)
              .join(" ")}`,
          );
        const title = promptTitle(prompt)!;
        const setting = yield* operations.getRunTitleSetting();
        const header = [
          "**Review: start a Run**",
          `**Project:** ${project.title} — \`${project.workspaceRoot}\``,
          `**Flow:** ${flow.value.name} (\`${flow.value.id}\`)`,
          `**Workspace:** ${workspaceLine(flow.value)}`,
          `**Run title:** ${title}`,
          "Factory derives this automatic title from the prompt's first non-empty line.",
          titlePolicy(setting),
          `**Prompt** (${characters(prompt).toLocaleString("en-US")} characters), ${SOURCE_LINES[source]}:`,
        ].join("\n");
        const review = [...messageParts(header), ...promptBlocks(prompt), DISCLOSURE];
        const confirmation = {
          label: "Confirm Start",
          text: clip(
            `Confirm this Start: Run “${title}” in ${project.title} with Flow ${flow.value.name}.`,
            MESSAGE_LENGTH,
          ),
        };
        const length = [...review, confirmation.text].reduce(
          (total, part) => total + characters(part),
          0,
        );
        if (length > REVIEW_CHARACTER_LIMIT)
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
            flowId: flow.value.id,
            flowName: flow.value.name,
            title,
            promptSource: source,
          },
          supersedes,
        } satisfies Proposed;
      }),
  };

  return { operation, tool };
}
