import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { FactoryOperations, OperationError, Result } from "@t3-factory/contracts";
import { CANVAS_COORD_MAX, CANVAS_COORD_MIN } from "@t3-factory/domain-validation";

/** The definition operations Studio's API uses; authoring tools call nothing else. */
export type AuthoringOperations = Pick<
  FactoryOperations,
  | "getAgentCapabilities"
  | "listAgents"
  | "getAgent"
  | "createAgent"
  | "updateAgent"
  | "removeAgent"
  | "listFlows"
  | "getFlow"
  | "createFlow"
  | "updateFlow"
  | "removeFlow"
>;

const noArguments: Tool["inputSchema"] = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const agentId = { type: "string", description: "An Agent id from factory_list_agents." };
const flowId = { type: "string", description: "A Flow id from factory_list_flows." };
const expectedRevision = {
  type: "integer",
  minimum: 1,
  description:
    "The revision you last read. A save on an older revision is refused with a conflict.",
};
const exit = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    messageRequired: { type: "boolean" },
  },
  required: ["id", "name", "description", "messageRequired"],
};
const agentFields = {
  name: { type: "string" },
  prompt: { type: "string" },
  execution: {
    type: "object",
    description:
      "Ids from factory_get_agent_capabilities: environment, provider instance (one with reporting.supported), model and model option values.",
    properties: {
      environmentId: { type: "string" },
      providerInstanceId: { type: "string" },
      modelId: { type: "string" },
      modelOptions: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, value: { type: ["string", "boolean"] } },
          required: ["id", "value"],
        },
      },
    },
    required: ["environmentId", "providerInstanceId", "modelId"],
  },
  exits: { type: "array", items: exit, description: "The Agent's exits; at least one." },
};
const position = {
  type: "object",
  properties: {
    x: { type: "number", minimum: CANVAS_COORD_MIN, maximum: CANVAS_COORD_MAX },
    y: { type: "number", minimum: CANVAS_COORD_MIN, maximum: CANVAS_COORD_MAX },
  },
  required: ["x", "y"],
};
const flowFields = {
  name: { type: "string" },
  graph: {
    type: "object",
    description:
      'The whole Flow graph; a save replaces the saved one. Positions are optional: if any Block or Flow input position is omitted, the server auto-arranges the whole graph; fully positioned graphs are kept as given. Agent blocks {id, kind: agent, name, agentId, position, hiddenExitIds, localExits, revisitInstruction} (revisitInstruction is optional plain text up to 120,000 characters, stored trimmed and empty when omitted, that Factory sends on every visit to the block after the first; only Agent blocks have it), Human blocks {id, kind: human, name, position}, Wait blocks {id, kind: wait, name, position, duration: {amount: number, unit: minutes | hours | days} or null} (they hold each arrival for 1 minute to 7 days, judged after converting the unit, and leave by exitId "output"), Continuation blocks {id, kind: continuation, name, prompt, position} (they send their prompt once per Run into the worker thread of the message that reaches them; their single output has exitId "output"), connections {sourceBlockId, exitId, targetBlockId}, and flowInput {position, targetBlockIds} (Agent blocks only).',
    properties: {
      blocks: { type: "array", items: { type: "object" } },
      connections: { type: "array", items: { type: "object" } },
      flowInput: {
        type: "object",
        properties: { position, targetBlockIds: { type: "array", items: { type: "string" } } },
        required: ["targetBlockIds"],
      },
    },
    required: ["blocks", "connections", "flowInput"],
  },
  workspace: {
    type: "object",
    description:
      'Optional: {mode: "checkout"} or {mode: "worktree", base: {kind: "default"} | {kind: "ref", ref}}. Omitted keeps the saved workspace, or defaults to a new worktree from the default branch on create.',
    oneOf: [
      {
        type: "object",
        properties: { mode: { const: "checkout" } },
        required: ["mode"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          mode: { const: "worktree" },
          base: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "default" } },
                required: ["kind"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "ref" }, ref: { type: "string", minLength: 1 } },
                required: ["kind", "ref"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["mode", "base"],
        additionalProperties: false,
      },
    ],
  },
};

/** Confirmation and disambiguation guidance for a removal tool; the server checks none of it. */
const removalGuidance = (kind: "Agent" | "Flow", details: string) =>
  `First get the user's explicit confirmation naming the ${kind}, unless the request gives its id or a name that matches exactly one current ${kind} in a fresh factory_list_${kind.toLowerCase()}s. If several match or the target is inferred, ask with each name, id and ${details}; never pick among duplicates. If none matches, say so and do not call this tool. This is guidance, not a server check: success, also for an absent or already removed id, does not prove the id existed.`;

/** Definition authoring for any session with the Factory MCP; no Block id. */
export const authoringTools: Tool[] = [
  {
    name: "factory_get_agent_capabilities",
    description:
      "Read the live T3 catalog of environments, providers and models with their options, and whether Factory can accept reports from each provider (reporting.supported). Choose Agent model settings from it.",
    inputSchema: noArguments,
  },
  {
    name: "factory_list_agents",
    description: "List the current Agents with their revision and settings status.",
    inputSchema: noArguments,
  },
  {
    name: "factory_get_agent",
    description: "Read one Agent's current revision, model settings, exits and settings status.",
    inputSchema: {
      type: "object",
      properties: { agentId },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_create_agent",
    description:
      "Create an Agent as revision 1. Model settings are checked for shape and reporting support; availability is reported in settingsStatus.",
    inputSchema: {
      type: "object",
      properties: agentFields,
      required: ["name", "prompt", "execution", "exits"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_save_agent",
    description:
      "Save an Agent's name, prompt, model settings and exits as its next immutable revision, exactly as a Studio save.",
    inputSchema: {
      type: "object",
      properties: { agentId, expectedRevision, ...agentFields },
      required: ["agentId", "expectedRevision", "name", "prompt", "execution", "exits"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_remove_agent",
    description: `Delete (remove) an Agent exactly as Studio's Delete: it leaves Studio, Flow references and Start selection with no restore, its saved revisions are kept and Runs keep the revisions they started with. Refused while the latest revision of a current Flow places it. ${removalGuidance("Agent", "its revision, last update and the Flows that place it")}`,
    inputSchema: {
      type: "object",
      properties: { agentId },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_list_flows",
    description: "List the current Flows with their revision, graph, workspace and readiness.",
    inputSchema: noArguments,
  },
  {
    name: "factory_get_flow",
    description: "Read one Flow's current revision, graph, workspace and readiness.",
    inputSchema: {
      type: "object",
      properties: { flowId },
      required: ["flowId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_create_flow",
    description:
      "Create a Flow as revision 1 atomically, optionally with its whole graph and workspace. Omit positions to auto-arrange the whole graph. A name alone creates an empty Flow.",
    inputSchema: {
      type: "object",
      properties: flowFields,
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_save_flow",
    description:
      "Save a Flow's name, whole graph and workspace as its next immutable revision, exactly as a Studio save. If any position is omitted the server auto-arranges the whole graph; otherwise positions are kept. The reply includes readiness.",
    inputSchema: {
      type: "object",
      properties: { flowId, expectedRevision, ...flowFields },
      required: ["flowId", "expectedRevision", "name", "graph"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_check_flow",
    description:
      "Check readiness of a Flow's latest saved revision, as Studio's Check readiness does. Fix the listed issue paths before a Run is started.",
    inputSchema: {
      type: "object",
      properties: { flowId },
      required: ["flowId"],
      additionalProperties: false,
    },
  },
  {
    name: "factory_remove_flow",
    description: `Delete (remove) a Flow exactly as Studio's Remove: it leaves Studio and the Run composer with no restore, its saved revisions are kept and Runs, including active ones, are unaffected. ${removalGuidance("Flow", "its revision and last update")}`,
    inputSchema: {
      type: "object",
      properties: { flowId },
      required: ["flowId"],
      additionalProperties: false,
    },
  },
];

type Subject = "agent" | "flow" | "agentRemoval" | "flowRemoval";

const fixIssuesNext = "Fix the listed issue paths and call the tool again.";

/** Static recovery steps; replies never echo the call's arguments. */
const nextSteps: Record<Subject, Partial<Record<OperationError["code"], string>>> = {
  agent: {
    validation: fixIssuesNext,
    conflict:
      "Read the Agent with factory_get_agent, reapply your change and save with its revision.",
    not_found: "Find a current Agent id with factory_list_agents.",
  },
  flow: {
    validation: fixIssuesNext,
    conflict:
      "Read the Flow with factory_get_flow, reapply your change and save with its revision.",
    not_found: "Find a current Flow id with factory_list_flows.",
  },
  agentRemoval: {
    validation: fixIssuesNext,
    conflict:
      "Nothing was removed. Ask the user before editing or removing the Flows that place this Agent, unless they already authorized those exact changes; never rewrite Flows on your own.",
  },
  flowRemoval: { validation: fixIssuesNext },
};
const unavailableNext = "Recheck the Factory backend, then call the tool again.";

type Call = (args: Record<string, unknown>) => Promise<Result<unknown>>;

/** Splits a required id argument from the operation's input; a missing id is a validation issue. */
const withId =
  (
    key: "agentId" | "flowId",
    operation: (id: string, input: unknown) => Promise<Result<unknown>>,
  ) =>
  ({ [key]: id, ...input }: Record<string, unknown>): Promise<Result<unknown>> =>
    typeof id === "string" && id.length > 0
      ? operation(id, input)
      : Promise.resolve({
          ok: false,
          error: {
            code: "validation",
            message: `Include ${key}.`,
            issues: [{ code: "invalid_id", path: key, message: `Include ${key}.` }],
          },
        });

/** A removal reply names only the removed id; removing an absent or removed id succeeds too. */
const removal = (key: "agentId" | "flowId", remove: (id: string) => Promise<Result<void>>) =>
  withId(key, async (id) => {
    const removed = await remove(id);
    return removed.ok ? { ok: true, value: { [key]: id, removed: true } } : removed;
  });

const authoringCalls = (factory: AuthoringOperations): Record<string, [Subject, Call]> => ({
  factory_get_agent_capabilities: ["agent", () => factory.getAgentCapabilities()],
  factory_list_agents: ["agent", () => factory.listAgents()],
  factory_get_agent: ["agent", withId("agentId", (id) => factory.getAgent(id))],
  factory_create_agent: ["agent", (input) => factory.createAgent(input)],
  factory_save_agent: ["agent", withId("agentId", (id, input) => factory.updateAgent(id, input))],
  factory_remove_agent: ["agentRemoval", removal("agentId", (id) => factory.removeAgent(id))],
  factory_list_flows: ["flow", () => factory.listFlows()],
  factory_get_flow: ["flow", withId("flowId", (id) => factory.getFlow(id))],
  factory_create_flow: ["flow", (input) => factory.createFlow(input)],
  factory_save_flow: ["flow", withId("flowId", (id, input) => factory.updateFlow(id, input))],
  factory_check_flow: [
    "flow",
    withId("flowId", async (id) => {
      const flow = await factory.getFlow(id);
      return flow.ok ? { ok: true, value: flow.value.readiness } : flow;
    }),
  ],
  factory_remove_flow: ["flowRemoval", removal("flowId", (id) => factory.removeFlow(id))],
});

/** A Factory tool result: one JSON text item, flagged as an error when the call failed. */
export const textResult = (isError: boolean, reply: unknown): CallToolResult => ({
  isError,
  content: [{ type: "text", text: JSON.stringify(reply) }],
});

/** Answers an authoring tool call, or `undefined` when `name` is not an authoring tool. */
export async function callAuthoringTool(
  factory: AuthoringOperations,
  name: string,
  args: unknown,
): Promise<CallToolResult | undefined> {
  const calls = authoringCalls(factory);
  if (!Object.hasOwn(calls, name)) return undefined;
  const [subject, call] = calls[name]!;
  const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  try {
    const result = await call(input);
    if (result.ok) return textResult(false, result.value);
    const { code, message, issues } = result.error;
    return textResult(true, {
      code,
      message,
      issues,
      next: nextSteps[subject][code] ?? unavailableNext,
    });
  } catch {
    return textResult(true, {
      code: "internal",
      message: "Factory could not complete this call.",
      issues: [],
      next: unavailableNext,
    });
  }
}
