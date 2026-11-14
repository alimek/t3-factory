import type {
  AgentCapabilities,
  AgentDefinition,
  AgentExecutionSettings,
  AgentModelOptionValue,
  CreateAgentInput,
  CreateFlowInput,
  DuplicateAgentInput,
  FlowBlockInput,
  FlowGraphInput,
  FlowWorkspace,
  UpdateFlowInput,
  FlowReadiness,
  ProjectIcon,
  ProjectIconColor,
  Result,
  UpdateAgentInput,
  ValidationIssue,
  WaitDuration,
  WaitUnit,
} from "@t3-factory/contracts";
import {
  CONTINUATION_EXIT,
  checkExits,
  effectiveExits,
  HUMAN_EXITS,
  WAIT_OUTPUT,
  inheritedExits,
  isId,
  isRecord,
  parseAgentExits,
  type IssueReporter,
} from "./block-exits.ts";

export const TASK_TITLE_LIMIT = 500;

/** The automatic Run title: the prompt text's first non-empty line, trimmed and bounded. */
export function promptTitle(text: string): string | undefined {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, TASK_TITLE_LIMIT);
}

/** Run navigation compares creation times as text, so only `Date.toISOString()` output is valid. */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

const PROJECT_ICON_COLORS = new Set<ProjectIconColor>([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

const projectIconColor = (value: unknown): ProjectIconColor | undefined =>
  typeof value === "string" && PROJECT_ICON_COLORS.has(value as ProjectIconColor)
    ? (value as ProjectIconColor)
    : undefined;

const boundedText = (value: unknown, min: number, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return undefined;
  return trimmed;
};

const unsafeRenderableText = (value: string): boolean =>
  value.includes("<") || /^https?:\/\//i.test(value);

const optionalMonogram = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const text = boundedText(value, 1, 4);
  if (!text || unsafeRenderableText(text)) return undefined;
  return text;
};

function lucideProjectIcon(
  record: Record<string, unknown>,
  color: ProjectIconColor | undefined,
): ProjectIcon | null {
  const name = boundedText(record.name, 1, 128);
  if (!name || unsafeRenderableText(name) || !color) return null;
  const monogram = optionalMonogram(record.monogram);
  const monogramText = optionalMonogram(record.monogramText);
  return {
    kind: "lucide",
    name,
    color,
    ...(monogram !== undefined ? { monogram } : {}),
    ...(monogramText !== undefined ? { monogramText } : {}),
  };
}

const FAVICON_PATH_LIMIT = 512;

/** Bounds untrusted T3 faviconPath metadata; unknown or unsafe values become null. */
export function parseProjectFaviconPath(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") return null;
  if (input.includes("\0")) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > FAVICON_PATH_LIMIT) return null;
  if (trimmed.startsWith("/") || trimmed.includes("\\") || /^[a-z]:/i.test(trimmed)) return null;
  if (trimmed.split("/").includes("..")) return null;
  return trimmed;
}

/** Bounds untrusted T3 projectIcon metadata; unknown or malformed values become null. */
export function parseProjectIcon(input: unknown): ProjectIcon | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const color = projectIconColor(record.color);
  if (record.kind === "emoji") {
    const emoji = boundedText(record.emoji, 1, 32);
    if (!emoji || unsafeRenderableText(emoji)) return null;
    return { kind: "emoji", emoji };
  }
  if (record.kind === "monogram") {
    const text = boundedText(record.text, 1, 4);
    if (!text || unsafeRenderableText(text) || !color) return null;
    return { kind: "monogram", text, color };
  }
  if (record.kind === "lucide") {
    return lucideProjectIcon(record, color);
  }
  return null;
}

/** Structural save validation is deliberately separate from execution readiness. */
function validateFlowName(input: unknown): Result<Pick<CreateFlowInput, "name">> {
  const name =
    typeof input === "object" && input !== null && "name" in input ? input.name : undefined;
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 200) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Enter a Flow name between 1 and 200 characters.",
        issues: [
          {
            code: "invalid_name",
            path: "name",
            message: "Enter a Flow name between 1 and 200 characters.",
          },
        ],
      },
    };
  }
  return { ok: true, value: { name: name.trim() } };
}

function agentNameIssue(): ValidationIssue {
  return {
    code: "invalid_name",
    path: "name",
    message: "Enter an Agent name between 1 and 200 characters.",
  };
}

function parseTrimmedString(
  value: unknown,
  path: string,
  max: number,
  code: string,
  message: string,
): Result<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    return {
      ok: false,
      error: { code: "validation", message, issues: [{ code, path, message }] },
    };
  }
  return { ok: true, value: value.trim() };
}

function invalid(code: string, path: string, message: string): Result<never> {
  return { ok: false, error: { code: "validation", message, issues: [{ code, path, message }] } };
}

const EXECUTION_REQUIRED = "Choose an environment, provider, model and thinking options.";
const INVALID_OPTION = "Thinking options must use supported id and value pairs.";

function parseModelOption(option: unknown, index: number): Result<AgentModelOptionValue> {
  const path = `execution.modelOptions.${index}`;
  if (typeof option !== "object" || option === null || !("id" in option) || !("value" in option))
    return invalid("invalid_option", path, INVALID_OPTION);
  const id = parseTrimmedString(
    option.id,
    `${path}.id`,
    256,
    "invalid_option",
    "Each thinking option needs an id.",
  );
  if (!id.ok) return id;
  const value = option.value;
  if (typeof value === "boolean") return { ok: true, value: { id: id.value, value } };
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return invalid("invalid_option", `${path}.value`, INVALID_OPTION);
  return { ok: true, value: { id: id.value, value } };
}

function parseModelOptions(execution: object): Result<AgentModelOptionValue[]> {
  if (
    "modelOptions" in execution &&
    execution.modelOptions !== undefined &&
    !Array.isArray(execution.modelOptions)
  )
    return invalid("invalid_option", "execution.modelOptions", INVALID_OPTION);
  const rawOptions =
    "modelOptions" in execution && Array.isArray(execution.modelOptions)
      ? execution.modelOptions
      : [];
  const modelOptions: AgentModelOptionValue[] = [];
  for (const [index, raw] of rawOptions.entries()) {
    const option = parseModelOption(raw, index);
    if (!option.ok) return option;
    modelOptions.push(option.value);
  }
  return { ok: true, value: modelOptions };
}

function parseExecutionReference(
  execution: object,
  field: "environmentId" | "providerInstanceId" | "modelId",
  code: string,
  message: string,
): Result<string> {
  return parseTrimmedString(
    field in execution ? (execution as Record<string, unknown>)[field] : undefined,
    `execution.${field}`,
    512,
    code,
    message,
  );
}

function parseExecution(input: unknown): Result<AgentExecutionSettings> {
  const execution =
    typeof input === "object" && input !== null && "execution" in input
      ? input.execution
      : undefined;
  return validateExecutionSettings(execution);
}

export function validateExecutionSettings(execution: unknown): Result<AgentExecutionSettings> {
  if (typeof execution !== "object" || execution === null)
    return invalid("execution_required", "execution", EXECUTION_REQUIRED);
  const environmentId = parseExecutionReference(
    execution,
    "environmentId",
    "invalid_environment",
    "Choose a T3 environment.",
  );
  if (!environmentId.ok) return environmentId;
  const providerInstanceId = parseExecutionReference(
    execution,
    "providerInstanceId",
    "invalid_provider",
    "Choose a provider or harness.",
  );
  if (!providerInstanceId.ok) return providerInstanceId;
  const modelId = parseExecutionReference(execution, "modelId", "invalid_model", "Choose a model.");
  if (!modelId.ok) return modelId;
  const modelOptions = parseModelOptions(execution);
  if (!modelOptions.ok) return modelOptions;
  return {
    ok: true,
    value: {
      environmentId: environmentId.value,
      providerInstanceId: providerInstanceId.value,
      modelId: modelId.value,
      modelOptions: modelOptions.value,
    },
  };
}

/** Structural save validation is deliberately separate from T3 capability availability. */
export function validateCreateAgent(input: unknown): Result<CreateAgentInput> {
  const name = parseTrimmedString(
    typeof input === "object" && input !== null && "name" in input ? input.name : undefined,
    "name",
    200,
    "invalid_name",
    "Enter an Agent name between 1 and 200 characters.",
  );
  if (!name.ok) return name;
  const prompt = parseTrimmedString(
    typeof input === "object" && input !== null && "prompt" in input ? input.prompt : undefined,
    "prompt",
    120_000,
    "invalid_prompt",
    "Enter a prompt up to 120,000 characters.",
  );
  if (!prompt.ok) return prompt;
  const execution = parseExecution(input);
  if (!execution.ok) return execution;
  const exits = parseAgentExits(
    typeof input === "object" && input !== null && "exits" in input ? input.exits : undefined,
  );
  if (!exits.ok) return exits;
  return {
    ok: true,
    value: {
      name: name.value,
      prompt: prompt.value,
      execution: execution.value,
      exits: exits.value,
    },
  };
}

export function validateUpdateAgent(input: unknown): Result<UpdateAgentInput> {
  const revision =
    typeof input === "object" && input !== null && "expectedRevision" in input
      ? input.expectedRevision
      : undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Include the revision you opened before saving.",
        issues: [
          {
            code: "invalid_revision",
            path: "expectedRevision",
            message: "Include the revision you opened before saving.",
          },
        ],
      },
    };
  }
  const base = validateCreateAgent(input);
  if (!base.ok) return base;
  return { ok: true, value: { expectedRevision: revision, ...base.value } };
}

export function validateDuplicateAgent(input: unknown): Result<DuplicateAgentInput> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Send a name or an empty object to duplicate.",
        issues: [
          {
            code: "invalid_body",
            path: "",
            message: "Send a name or an empty object to duplicate.",
          },
        ],
      },
    };
  }
  if (!("name" in input) || input.name === undefined) return { ok: true, value: {} };
  const name = parseTrimmedString(
    input.name,
    "name",
    200,
    "invalid_name",
    agentNameIssue().message,
  );
  if (!name.ok) return name;
  return { ok: true, value: { name: name.value } };
}

export const CANVAS_COORD_MIN = -10000;
export const CANVAS_COORD_MAX = 10000;
export const CANVAS_COORD_MESSAGE = `Use finite canvas coordinates from ${CANVAS_COORD_MIN} to ${CANVAS_COORD_MAX}.`;

export const isCanvasPosition = (v: unknown): v is { x: number; y: number } =>
  isRecord(v) &&
  [v.x, v.y].every(
    (c) =>
      typeof c === "number" && Number.isFinite(c) && c >= CANVAS_COORD_MIN && c <= CANVAS_COORD_MAX,
  );
/** Hide entries name inherited exit IDs; whether the Agent still has them is not a save rule. */
function checkHiddenExits(hidden: unknown, path: string, issue: IssueReporter) {
  if (
    !Array.isArray(hidden) ||
    hidden.length > 100 ||
    !hidden.every(isId) ||
    new Set(hidden).size !== hidden.length
  )
    issue("invalid_hidden_exits", path, "Hide up to 100 distinct inherited exit IDs.");
}

/** The fields each block kind may carry beside its id, name, kind and position. A Map, so an
 * untrusted kind such as "toString" never resolves to an Object.prototype member. */
const KIND_FIELDS: ReadonlyMap<unknown, readonly string[]> = new Map([
  ["agent", ["agentId", "hiddenExitIds", "localExits"]],
  ["human", []],
  ["wait", ["duration"]],
  ["continuation", ["prompt"]],
]);

/** An Agent reference, a Wait duration or a Continuation prompt, the fields only one kind has. */
function checkKindFields(block: Record<string, unknown>, path: string, issue: IssueReporter) {
  if (block.kind === "agent" && block.agentId !== null && !isId(block.agentId))
    issue(
      "invalid_agent_reference",
      `${path}.agentId`,
      "Choose a saved Agent or leave the reference empty.",
    );
  if (
    block.kind === "continuation" &&
    (typeof block.prompt !== "string" || block.prompt.trim().length > CONTINUATION_PROMPT_LIMIT)
  )
    issue(
      "invalid_prompt",
      `${path}.prompt`,
      "Enter a Continuation prompt up to 120,000 characters.",
    );
  if (block.kind === "wait") checkWaitDuration(block.duration, `${path}.duration`, issue);
}

function checkBlockFields(
  block: Record<string, unknown>,
  path: string,
  blockIds: Set<string>,
  issue: IssueReporter,
) {
  const kindFields = KIND_FIELDS.get(block.kind);
  const allowed = ["id", "name", "kind", "position", ...(kindFields ?? [])];
  if (Object.keys(block).some((key) => !allowed.includes(key)))
    issue(
      "block_overrides_forbidden",
      path,
      "Blocks reference saved Agents; local settings and extra fields are not allowed.",
    );
  if (!isId(block.id) || blockIds.has(block.id))
    issue("invalid_block_id", `${path}.id`, "Block IDs must be non-empty and unique.");
  else blockIds.add(block.id);
  if (!kindFields)
    issue("invalid_block_kind", `${path}.kind`, "Use an Agent, Human, Wait or Continuation block.");
  if (typeof block.name !== "string" || block.name.length > 200)
    issue("invalid_block_name", `${path}.name`, "Use a block name up to 200 characters.");
  checkKindFields(block, path, issue);
  if (block.position !== undefined && !isCanvasPosition(block.position))
    issue("invalid_position", `${path}.position`, CANVAS_COORD_MESSAGE);
}

const WAIT_UNITS: readonly string[] = ["minutes", "hours", "days"] satisfies WaitUnit[];

/** A Wait's duration is null or a finite amount in a known unit; its range is a readiness rule
 * on the normalized duration, so a zero, negative or out-of-range draft still saves. */
function checkWaitDuration(duration: unknown, path: string, issue: IssueReporter) {
  if (duration === null) return;
  if (
    !isRecord(duration) ||
    Object.keys(duration).some((key) => key !== "amount" && key !== "unit") ||
    typeof duration.amount !== "number" ||
    !Number.isFinite(duration.amount) ||
    typeof duration.unit !== "string" ||
    !WAIT_UNITS.includes(duration.unit)
  )
    issue(
      "invalid_wait_duration",
      path,
      "Enter a number of minutes, hours or days, or leave the duration empty.",
    );
}

/**
 * The exit IDs a connection may leave each block by: a Human block's, Wait's or Continuation's fixed exits,
 * or `inherited` for an Agent block, whose wires may also name Agent exits that readiness resolves.
 */
type ConnectableExits = Map<string, ReadonlySet<string> | "inherited">;
const HUMAN_EXIT_IDS: ReadonlySet<string> = new Set(HUMAN_EXITS.map((exit) => exit.id));
const WAIT_EXIT_IDS: ReadonlySet<string> = new Set([WAIT_OUTPUT.id]);
const CONTINUATION_EXIT_IDS: ReadonlySet<string> = new Set([CONTINUATION_EXIT.id]);
const CONTINUATION_PROMPT_LIMIT = 120_000;

function checkBlock(
  block: unknown,
  path: string,
  blockIds: Set<string>,
  exits: ConnectableExits,
  issue: IssueReporter,
) {
  if (!isRecord(block)) {
    issue("invalid_block", path, "Supply an Agent, Human, Wait or Continuation block.");
    return;
  }
  checkBlockFields(block, path, blockIds, issue);
  if (block.kind === "agent") {
    checkHiddenExits(block.hiddenExitIds, `${path}.hiddenExitIds`, issue);
    checkExits(block.localExits, `${path}.localExits`, false, issue);
  }
  if (typeof block.id === "string")
    exits.set(
      block.id,
      block.kind === "human"
        ? HUMAN_EXIT_IDS
        : block.kind === "wait"
          ? WAIT_EXIT_IDS
          : block.kind === "continuation"
            ? CONTINUATION_EXIT_IDS
            : "inherited",
    );
}

const GRAPH_FIELDS = ["blocks", "connections", "flowInput"];
const FLOW_INPUT_FIELDS = ["position", "targetBlockIds"];

/** The Flow input may target only existing Agent or Wait blocks, each at most once; a Wait target
 * is a readiness gap, not a save error. */
function checkFlowInput(
  flowInput: unknown,
  targetableBlockIds: ReadonlySet<string>,
  issue: IssueReporter,
) {
  const path = "graph.flowInput";
  if (!isRecord(flowInput) || !Array.isArray(flowInput.targetBlockIds)) {
    issue("invalid_flow_input", path, "Supply the Flow input block with its connected Agents.");
    return;
  }
  if (Object.keys(flowInput).some((key) => !FLOW_INPUT_FIELDS.includes(key)))
    issue(
      "flow_input_fields_forbidden",
      path,
      "The Flow input block has only a position and targets.",
    );
  if (flowInput.position !== undefined && !isCanvasPosition(flowInput.position))
    issue("invalid_position", `${path}.position`, CANVAS_COORD_MESSAGE);
  const targets = new Set<string>();
  flowInput.targetBlockIds.forEach((target, i) => {
    if (!isId(target) || targets.has(target) || !targetableBlockIds.has(target))
      issue(
        "invalid_flow_input_target",
        `${path}.targetBlockIds.${i}`,
        "Connect the Flow input only to Agent blocks in this Flow, each once.",
      );
    else targets.add(target);
  });
}

const connectable = (exits: ConnectableExits, source: unknown, exitId: unknown) => {
  const allowed = typeof source === "string" ? exits.get(source) : undefined;
  if (allowed === undefined) return false;
  return allowed === "inherited" ? isId(exitId) : typeof exitId === "string" && allowed.has(exitId);
};

function checkConnections(
  connections: readonly unknown[],
  blockIds: ReadonlySet<string>,
  exits: ConnectableExits,
  issue: IssueReporter,
) {
  const edges = new Set<string>();
  connections.forEach((edge, i) => {
    const path = `graph.connections.${i}`;
    if (
      !isRecord(edge) ||
      !connectable(exits, edge.sourceBlockId, edge.exitId) ||
      typeof edge.targetBlockId !== "string" ||
      !blockIds.has(edge.targetBlockId)
    ) {
      issue("invalid_connection", path, "Connect an existing source exit to an existing block.");
      return;
    }
    const key = JSON.stringify([edge.sourceBlockId, edge.exitId, edge.targetBlockId]);
    if (edges.has(key))
      issue("duplicate_connection", path, "This exit is already connected to that block.");
    edges.add(key);
  });
}

function checkGraph(graph: unknown, issue: IssueReporter) {
  if (!isRecord(graph) || !Array.isArray(graph.blocks) || !Array.isArray(graph.connections)) {
    issue("invalid_graph", "graph", "Supply blocks, connections and the Flow input block.");
    return;
  }
  if (Object.keys(graph).some((key) => !GRAPH_FIELDS.includes(key)))
    issue(
      "graph_fields_forbidden",
      "graph",
      "A Flow graph has only blocks, connections and the Flow input block.",
    );
  const blockIds = new Set<string>();
  const exits: ConnectableExits = new Map();
  if (graph.blocks.length > 500 || graph.connections.length > 5000)
    issue("graph_too_large", "graph", "Use at most 500 blocks and 5000 connections.");
  graph.blocks.forEach((block, i) =>
    checkBlock(block, `graph.blocks.${i}`, blockIds, exits, issue),
  );
  const targetableBlockIds = new Set(
    graph.blocks.flatMap((block) =>
      isRecord(block) && (block.kind === "agent" || block.kind === "wait") && isId(block.id)
        ? [block.id]
        : [],
    ),
  );
  checkFlowInput(graph.flowInput, targetableBlockIds, issue);
  checkConnections(graph.connections, blockIds, exits, issue);
}

const WORKSPACE_REF_LIMIT = 255;

/** A Git ref Factory passes as one argument: never an option, whitespace or control text. */
function workspaceRef(value: unknown): string | undefined {
  const ref = boundedText(value, 1, WORKSPACE_REF_LIMIT);
  if (!ref || ref.startsWith("-") || /[\s\p{Cc}]/u.test(ref)) return undefined;
  return ref;
}

function checkWorkspace(raw: unknown, issue: IssueReporter): FlowWorkspace | undefined {
  if (!isRecord(raw) || (raw.mode !== "checkout" && raw.mode !== "worktree")) {
    issue("invalid_workspace", "workspace.mode", "Choose the project checkout or a new worktree.");
    return undefined;
  }
  if (raw.mode === "checkout") return { mode: "checkout" };
  const base = raw.base;
  if (isRecord(base) && base.kind === "default")
    return { mode: "worktree", base: { kind: "default" } };
  if (!isRecord(base) || base.kind !== "ref") {
    issue("invalid_workspace_base", "workspace.base", "Choose the default branch or a custom ref.");
    return undefined;
  }
  const ref = workspaceRef(base.ref);
  if (ref) return { mode: "worktree", base: { kind: "ref", ref } };
  issue(
    "invalid_workspace_ref",
    "workspace.base.ref",
    `Enter a Git ref up to ${WORKSPACE_REF_LIMIT} characters without spaces or a leading "-".`,
  );
  return undefined;
}

/** A graph supplied at creation is validated exactly as a saved graph. */
/** Checks a create or save body in one pass, so a reply lists every defect at once. */
function checkFlowBody(input: unknown, required: boolean) {
  const name = validateFlowName(input);
  if (!name.ok) return name;
  const raw = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const issue: IssueReporter = (code, path, message) => issues.push({ code, path, message });
  if (
    required &&
    (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1)
  )
    issue("invalid_revision", "expectedRevision", "Include the revision you opened.");
  if (raw.graph !== undefined) checkGraph(raw.graph, issue);
  else if (required)
    issue("invalid_graph", "graph", "Supply blocks, connections and the Flow input block.");
  const workspace = raw.workspace === undefined ? undefined : checkWorkspace(raw.workspace, issue);
  if (issues.length)
    return {
      ok: false as const,
      error: { code: "validation" as const, message: issues[0]!.message, issues },
    };
  return {
    ok: true as const,
    value: {
      ...name.value,
      ...(raw.graph !== undefined ? { graph: trimGraphText(raw.graph as FlowGraphInput) } : {}),
      ...(workspace ? { workspace } : {}),
    },
    expectedRevision: raw.expectedRevision as number,
  };
}
export function validateCreateFlow(input: unknown): Result<CreateFlowInput> {
  const checked = checkFlowBody(input, false);
  return checked.ok ? { ok: true, value: checked.value } : checked;
}
export function validateUpdateFlow(input: unknown): Result<UpdateFlowInput> {
  const checked = checkFlowBody(input, true);
  if (!checked.ok) return checked;
  const { graph, ...rest } = checked.value;
  return {
    ok: true,
    value: { ...rest, expectedRevision: checked.expectedRevision, graph: graph! },
  };
}

/**
 * Local exit names are stored trimmed, as Agent exit names are, so reports match them exactly;
 * Continuation prompts are stored trimmed, as Agent prompts are.
 */
function trimGraphText(graph: FlowGraphInput): FlowGraphInput {
  return {
    ...graph,
    blocks: graph.blocks.map((block) => {
      if (block.kind === "agent")
        return {
          ...block,
          localExits: block.localExits.map((exit) => ({ ...exit, name: exit.name.trim() })),
        };
      if (block.kind === "continuation") return { ...block, prompt: block.prompt.trim() };
      return block;
    }),
  };
}

/** Whether any Agent block in the graph references the saved Agent definition. */
export function flowGraphReferencesAgent(graph: FlowGraphInput, agentId: string): boolean {
  return graph.blocks.some((block) => block.kind === "agent" && block.agentId === agentId);
}

/**
 * A saved Agent as Flow readiness sees it: its current exits and, for naming a wire whose exit
 * the Agent has since removed, the last name of each exit its earlier revisions had.
 */
export interface ReadinessAgent extends Pick<AgentDefinition, "id" | "exits"> {
  readonly formerExitNames: ReadonlyMap<string, string>;
}

const blockLabel = (block: FlowBlockInput) => block.name || block.id;

const MINUTE_MS = 60_000;
const WAIT_UNIT_MS: Record<WaitUnit, number> = {
  minutes: MINUTE_MS,
  hours: 60 * MINUTE_MS,
  days: 24 * 60 * MINUTE_MS,
};
/** The supported Wait range, inclusive: 1 minute through 7 days. */
export const WAIT_MIN_MS = MINUTE_MS;
export const WAIT_MAX_MS = 7 * WAIT_UNIT_MS.days;

/** A Wait duration as elapsed milliseconds; readiness compares this normalized value. */
export function waitDurationMs(duration: WaitDuration): number {
  return duration.amount * WAIT_UNIT_MS[duration.unit];
}

function waitReadiness(
  block: Extract<FlowBlockInput, { kind: "wait" }>,
  path: string,
  add: IssueReporter,
) {
  const label = blockLabel(block);
  if (!block.duration)
    add("wait_duration_required", `${path}.duration`, `Enter how long ${label} waits.`);
  else if (
    waitDurationMs(block.duration) < WAIT_MIN_MS ||
    waitDurationMs(block.duration) > WAIT_MAX_MS
  )
    add("wait_duration_range", `${path}.duration`, `${label} must wait from 1 minute to 7 days.`);
}

/** Names, Agent references and exits of one block. */
function blockReadiness(
  block: FlowBlockInput,
  path: string,
  agents: readonly ReadinessAgent[],
  add: IssueReporter,
) {
  const label = blockLabel(block);
  if (!block.name.trim()) add("block_name_required", `${path}.name`, `Name block ${block.id}.`);
  if (block.kind === "wait") waitReadiness(block, path, add);
  if (block.kind === "continuation" && !block.prompt.trim())
    add(
      "continuation_prompt_required",
      `${path}.prompt`,
      `Write the prompt ${label} sends to the conversation it continues.`,
    );
  if (block.kind !== "agent") return;
  if (!agents.some((agent) => agent.id === block.agentId))
    add("agent_required", `${path}.agentId`, `Choose a saved Agent for ${label}.`);
  if (!effectiveExits(block, agents).length)
    add("exit_required", path, `Add an exit to ${label} or its Agent.`);
  const inherited = inheritedExits(block, agents);
  const agentNames = new Set(inherited.map((exit) => exit.name.trim()));
  const agentIds = new Set(inherited.map((exit) => exit.id));
  block.localExits.forEach((exit, j) => {
    const name = exit.name.trim();
    if (agentIds.has(exit.id))
      add(
        "exit_id_conflict",
        `${path}.localExits.${j}.id`,
        `${label}: local exit "${name || exit.id}" has the same ID as an exit from its Agent. Remove and recreate the local exit.`,
      );
    if (!name)
      add(
        "exit_name_required",
        `${path}.localExits.${j}.name`,
        `Name local exit ${exit.id} on ${label}.`,
      );
    else if (agentNames.has(name))
      add(
        "exit_name_conflict",
        `${path}.localExits.${j}.name`,
        `${label}: local exit "${name}" has the same name as an exit from its Agent. Rename or remove the local exit.`,
      );
    // Workers may finish on an exit's name or ID, so one exit's name must not be another's ID.
    else if (agentIds.has(name) || agentNames.has(exit.id))
      add(
        "exit_name_conflict",
        `${path}.localExits.${j}.name`,
        `${label}: local exit "${name}" is ambiguous: its name or ID matches the ID or name of an exit from its Agent. Rename or remove the local exit.`,
      );
  });
}

/** Wires from an Agent block must leave one of its effective exits. */
function connectionReadiness(
  graph: FlowGraphInput,
  agents: readonly ReadinessAgent[],
  add: IssueReporter,
) {
  const blocks = new Map(graph.blocks.map((block) => [block.id, block]));
  graph.connections.forEach((edge, i) => {
    const source = blocks.get(edge.sourceBlockId);
    if (source?.kind !== "agent") return;
    const agent = agents.find((candidate) => candidate.id === source.agentId);
    if (!agent || effectiveExits(source, agents).some((exit) => exit.id === edge.exitId)) return;
    const target = blocks.get(edge.targetBlockId);
    const toTarget = `its connection to ${target ? blockLabel(target) : edge.targetBlockId}`;
    const inherited = agent.exits.find((exit) => exit.id === edge.exitId);
    if (inherited)
      add(
        "exit_hidden",
        `graph.connections.${i}`,
        `${blockLabel(source)}: exit "${inherited.name}" is hidden in this Flow. Show the exit or remove ${toTarget}.`,
      );
    else
      add(
        "exit_missing",
        `graph.connections.${i}`,
        `${blockLabel(source)}: its Agent no longer has exit "${agent.formerExitNames.get(edge.exitId) ?? edge.exitId}". Remove ${toTarget}.`,
      );
  });
}

/** Every block must be reachable from a Flow input target. */
function reachabilityReadiness(graph: FlowGraphInput, add: IssueReporter) {
  const reached = new Set(graph.flowInput.targetBlockIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.connections)
      if (reached.has(edge.sourceBlockId) && !reached.has(edge.targetBlockId)) {
        reached.add(edge.targetBlockId);
        changed = true;
      }
  }
  graph.blocks.forEach((block, i) => {
    if (!reached.has(block.id))
      add(
        "unreachable_block",
        `graph.blocks.${i}`,
        `Connect a path from the Flow input to ${blockLabel(block)}.`,
      );
  });
}

/**
 * The Agent blocks whose worker threads a Continuation can continue: the nearest Agent on each
 * incoming path, walking back through Human steps, Waits and Continuations, which have no thread of their
 * own. A Flow input targets only Agents, so every path a Run can take into a Continuation passes
 * one; at run time the arriving message's own worker decides.
 */
export function continuationSources(graph: FlowGraphInput, blockId: string): string[] {
  const blocks = new Map(graph.blocks.map((block) => [block.id, block]));
  const sources = new Set<string>();
  const visited = new Set<string>([blockId]);
  const pending = [blockId];
  while (pending.length) {
    const target = pending.pop()!;
    for (const edge of graph.connections) {
      if (edge.targetBlockId !== target) continue;
      const source = blocks.get(edge.sourceBlockId);
      if (source?.kind === "agent") sources.add(source.id);
      else if (source && !visited.has(source.id)) {
        visited.add(source.id);
        pending.push(source.id);
      }
    }
  }
  return graph.blocks.flatMap((block) => (sources.has(block.id) ? [block.id] : []));
}

/**
 * Graph readiness against the given saved Agents; live T3, project and provisioning gates remain
 * separate. Issues block Start, never a save.
 */
export function flowReadiness(
  graph: FlowGraphInput,
  agents: readonly ReadinessAgent[],
): FlowReadiness {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!graph.flowInput.targetBlockIds.length)
    add(
      "flow_input_required",
      "graph.flowInput.targetBlockIds",
      "Connect the Flow input to at least one Agent before running this Flow.",
    );
  const waits = new Set(graph.blocks.flatMap((block) => (block.kind === "wait" ? [block.id] : [])));
  graph.flowInput.targetBlockIds.forEach((target, i) => {
    if (waits.has(target))
      add(
        "flow_input_wait",
        `graph.flowInput.targetBlockIds.${i}`,
        "Connect the Flow input to Agents only; a Wait cannot start a Run.",
      );
  });
  graph.blocks.forEach((block, i) => blockReadiness(block, `graph.blocks.${i}`, agents, add));
  connectionReadiness(graph, agents, add);
  if (graph.flowInput.targetBlockIds.length) reachabilityReadiness(graph, add);
  return { ready: issues.length === 0, issues };
}

/** Resolve saved execution identifiers against a capability catalog without substituting defaults. */
export function resolveAgentModel(
  execution: AgentExecutionSettings,
  capabilities: AgentCapabilities | null,
) {
  const provider = capabilities?.providers.find(
    (entry) => entry.providerInstanceId === execution.providerInstanceId,
  );
  const model = provider?.models.find((entry) => entry.id === execution.modelId);
  return { provider, model };
}

export {
  CONTINUATION_EXIT,
  effectiveExits,
  inheritedExits,
  HUMAN_EXITS,
  WAIT_OUTPUT,
  type EffectiveExit,
  type ExitSource,
} from "./block-exits.ts";
export {
  CLIENT_LABEL_LIMIT,
  FACTORY_APPEARANCE_PROTOCOL,
  FACTORY_FLOW_REVISION_PROTOCOL,
  FACTORY_MINIMUM_PEER_PROTOCOL,
  FACTORY_MINIMUM_SERVER_PROTOCOL,
  FACTORY_PROTOCOL,
  protocolCompatibility,
  validateClientAccessRequest,
} from "./client-access.ts";
export {
  imageSignatureMime,
  isSha256Hex,
  promptText,
  RUN_IMAGE_DELETION_LIMIT,
  RUN_IMAGE_LIMIT,
  RUN_IMAGE_MAX_BYTES,
  RUN_IMAGE_MIME_TYPES,
  RUN_IMAGE_NAME_LIMIT,
  validateStartPrompt,
  type StartPrompt,
} from "./run-prompt.ts";
export { parseAppearancePresentation } from "./appearance.ts";
