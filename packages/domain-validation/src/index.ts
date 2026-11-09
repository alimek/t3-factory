import type {
  AgentCapabilities,
  AgentExecutionSettings,
  AgentModelOptionValue,
  CreateAgentInput,
  CreateFlowInput,
  DuplicateAgentInput,
  FlowGraph,
  FlowWorkspace,
  UpdateFlowInput,
  FlowReadiness,
  ProjectIcon,
  ProjectIconColor,
  Result,
  UpdateAgentInput,
  ValidationIssue,
} from "@t3-factory/contracts";

export const TASK_TITLE_LIMIT = 500;

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
export function validateCreateFlow(input: unknown): Result<CreateFlowInput> {
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
  return {
    ok: true,
    value: { name: name.value, prompt: prompt.value, execution: execution.value },
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

type IssueReporter = (code: string, path: string, message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200;
const CANVAS_COORD_MIN = -10000;
const CANVAS_COORD_MAX = 10000;
const CANVAS_COORD_MESSAGE = `Use finite canvas coordinates from ${CANVAS_COORD_MIN} to ${CANVAS_COORD_MAX}.`;

const isCanvasPosition = (v: unknown) =>
  isRecord(v) &&
  [v.x, v.y].every(
    (c) =>
      typeof c === "number" && Number.isFinite(c) && c >= CANVAS_COORD_MIN && c <= CANVAS_COORD_MAX,
  );
const EXIT_OUTCOMES = ["completion", "assessment-ok", "assessment-fail", "custom"];

function checkExit(
  exit: unknown,
  path: string,
  exitIds: Set<string>,
  names: Set<string>,
  issue: IssueReporter,
) {
  if (!isRecord(exit)) {
    issue("invalid_exit", path, "Supply a named exit.");
    return;
  }
  if (!isId(exit.id) || exitIds.has(exit.id))
    issue("invalid_exit_id", `${path}.id`, "Exit IDs must be unique within a block.");
  else exitIds.add(exit.id);
  const name = typeof exit.name === "string" ? exit.name.trim() : undefined;
  if (typeof exit.name !== "string" || exit.name.length > 200 || (name && names.has(name)))
    issue(
      "invalid_exit_name",
      `${path}.name`,
      "Exit names must be distinct within a block and up to 200 characters.",
    );
  if (name) names.add(name);
  if (typeof exit.description !== "string" || exit.description.length > 4000)
    issue(
      "invalid_exit_description",
      `${path}.description`,
      "Use a description up to 4000 characters.",
    );
  if (
    typeof exit.outcome !== "string" ||
    !EXIT_OUTCOMES.includes(exit.outcome) ||
    typeof exit.requiresFeedback !== "boolean"
  )
    issue("invalid_exit_semantics", path, "Choose an outcome and explicit feedback requirement.");
  if (exit.outcome === "assessment-fail" && exit.requiresFeedback !== true)
    issue(
      "correction_feedback_required",
      `${path}.requiresFeedback`,
      "Assessment fail requires correction feedback, regardless of its name.",
    );
}

/** Returns the block's valid exit IDs, empty when its exits are malformed. */
function checkExits(exits: unknown, path: string, issue: IssueReporter): Set<string> {
  const exitIds = new Set<string>();
  const names = new Set<string>();
  if (!Array.isArray(exits) || exits.length > 100)
    issue("invalid_exits", `${path}.exits`, "Supply up to 100 exits.");
  else exits.forEach((exit, j) => checkExit(exit, `${path}.exits.${j}`, exitIds, names, issue));
  return exitIds;
}

function checkBlockFields(
  block: Record<string, unknown>,
  path: string,
  blockIds: Set<string>,
  issue: IssueReporter,
) {
  const allowed = [
    "id",
    "name",
    "kind",
    "position",
    "exits",
    ...(block.kind === "agent" ? ["agentId"] : []),
  ];
  if (Object.keys(block).some((key) => !allowed.includes(key)))
    issue(
      "block_overrides_forbidden",
      path,
      "Blocks reference saved Agents; local settings and extra fields are not allowed.",
    );
  if (!isId(block.id) || blockIds.has(block.id))
    issue("invalid_block_id", `${path}.id`, "Block IDs must be non-empty and unique.");
  else blockIds.add(block.id);
  if (block.kind !== "agent" && block.kind !== "human")
    issue("invalid_block_kind", `${path}.kind`, "Use an Agent or Human block.");
  if (typeof block.name !== "string" || block.name.length > 200)
    issue("invalid_block_name", `${path}.name`, "Use a block name up to 200 characters.");
  if (block.kind === "agent" && block.agentId !== null && !isId(block.agentId))
    issue(
      "invalid_agent_reference",
      `${path}.agentId`,
      "Choose a saved Agent or leave the reference empty.",
    );
  if (!isCanvasPosition(block.position))
    issue("invalid_position", `${path}.position`, CANVAS_COORD_MESSAGE);
}

function checkBlock(
  block: unknown,
  path: string,
  blockIds: Set<string>,
  exits: Map<string, Set<string>>,
  issue: IssueReporter,
) {
  if (!isRecord(block)) {
    issue("invalid_block", path, "Supply an Agent or Human block.");
    return;
  }
  checkBlockFields(block, path, blockIds, issue);
  const exitIds = checkExits(block.exits, path, issue);
  if (typeof block.id === "string") exits.set(block.id, exitIds);
}

const GRAPH_FIELDS = ["blocks", "connections", "flowInput"];
const FLOW_INPUT_FIELDS = ["position", "targetBlockIds"];

/** The Flow input may target only existing Agent blocks, each at most once. */
function checkFlowInput(
  flowInput: unknown,
  agentBlockIds: ReadonlySet<string>,
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
  if (!isCanvasPosition(flowInput.position))
    issue("invalid_position", `${path}.position`, CANVAS_COORD_MESSAGE);
  const targets = new Set<string>();
  flowInput.targetBlockIds.forEach((target, i) => {
    if (!isId(target) || targets.has(target) || !agentBlockIds.has(target))
      issue(
        "invalid_flow_input_target",
        `${path}.targetBlockIds.${i}`,
        "Connect the Flow input only to Agent blocks in this Flow, each once.",
      );
    else targets.add(target);
  });
}

function checkConnections(
  connections: readonly unknown[],
  blockIds: ReadonlySet<string>,
  exits: ReadonlyMap<string, Set<string>>,
  issue: IssueReporter,
) {
  const edges = new Set<string>();
  connections.forEach((edge, i) => {
    const path = `graph.connections.${i}`;
    if (
      !isRecord(edge) ||
      typeof edge.sourceBlockId !== "string" ||
      typeof edge.exitId !== "string" ||
      typeof edge.targetBlockId !== "string" ||
      !exits.get(edge.sourceBlockId)?.has(edge.exitId) ||
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
  const exits = new Map<string, Set<string>>();
  if (graph.blocks.length > 500 || graph.connections.length > 5000)
    issue("graph_too_large", "graph", "Use at most 500 blocks and 5000 connections.");
  graph.blocks.forEach((block, i) =>
    checkBlock(block, `graph.blocks.${i}`, blockIds, exits, issue),
  );
  const agentBlockIds = new Set(
    graph.blocks.flatMap((block) =>
      isRecord(block) && block.kind === "agent" && isId(block.id) ? [block.id] : [],
    ),
  );
  checkFlowInput(graph.flowInput, agentBlockIds, issue);
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

/** Reject malformed/ambiguous graphs, while preserving unfinished authoring. */
export function validateUpdateFlow(input: unknown): Result<UpdateFlowInput> {
  const name = validateCreateFlow(input);
  if (!name.ok) return name;
  const raw = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1)
    issue("invalid_revision", "expectedRevision", "Include the revision you opened.");
  checkGraph(raw.graph, issue);
  const workspace = raw.workspace === undefined ? undefined : checkWorkspace(raw.workspace, issue);
  return issues.length
    ? { ok: false, error: { code: "validation", message: issues[0]!.message, issues } }
    : {
        ok: true,
        value: {
          ...name.value,
          expectedRevision: raw.expectedRevision as number,
          graph: raw.graph as FlowGraph,
          ...(workspace ? { workspace } : {}),
        },
      };
}

/** Whether any Agent block in the graph references the saved Agent definition. */
export function flowGraphReferencesAgent(graph: FlowGraph, agentId: string): boolean {
  return graph.blocks.some((block) => block.kind === "agent" && block.agentId === agentId);
}

/** Graph readiness only; live T3, project and provisioning gates remain separate. */
export function flowReadiness(graph: FlowGraph, agentIds?: ReadonlySet<string>): FlowReadiness {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const roots = graph.flowInput.targetBlockIds;
  if (!roots.length)
    add(
      "flow_input_required",
      "graph.flowInput.targetBlockIds",
      "Connect the Flow input to at least one Agent before running this Flow.",
    );
  graph.blocks.forEach((block, i) => {
    const path = `graph.blocks.${i}`;
    if (!block.name.trim()) add("block_name_required", `${path}.name`, `Name block ${block.id}.`);
    if (block.kind === "agent" && (!block.agentId || (agentIds && !agentIds.has(block.agentId))))
      add(
        "agent_required",
        `${path}.agentId`,
        `Choose a saved Agent for ${block.name || block.id}.`,
      );
    if (!block.exits.length)
      add("exit_required", `${path}.exits`, `Add an exit to ${block.name || block.id}.`);
    block.exits.forEach((exit, j) => {
      if (!exit.name.trim())
        add(
          "exit_name_required",
          `${path}.exits.${j}.name`,
          `Name exit ${exit.id} on ${block.name || block.id}.`,
        );
    });
  });
  if (roots.length) {
    const reached = new Set(roots);
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
          `Connect a path from the Flow input to ${block.name || block.id}.`,
        );
    });
  }
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
  CLIENT_LABEL_LIMIT,
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
  RUN_IMAGE_LIMIT,
  RUN_IMAGE_MAX_BYTES,
  RUN_IMAGE_MIME_TYPES,
  RUN_IMAGE_NAME_LIMIT,
  validateStartPrompt,
  type StartPrompt,
} from "./run-prompt.ts";
