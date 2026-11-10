import type {
  AgentDefinition,
  BlockExit,
  FlowBlockInput,
  Result,
  ValidationIssue,
} from "@t3-factory/contracts";

export type IssueReporter = (code: string, path: string, message: string) => void;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const isId = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200;

/** Every Human step's exits. They are fixed: no Flow or Agent configures them. */
export const HUMAN_EXITS: readonly BlockExit[] = [
  {
    id: "approve",
    name: "Approve",
    description: "Continue with the work as it is.",
    messageRequired: false,
  },
  {
    id: "request-changes",
    name: "Request changes",
    description: "Send the work back with the changes to make.",
    messageRequired: true,
  },
];

/** The single unnamed output every Wait forwards by; stored connections leave by this ID. */
export const WAIT_OUTPUT: BlockExit = {
  id: "output",
  name: "",
  description: "",
  messageRequired: false,
};

/**
 * A Continuation's single output. It has no name: wires from it carry no label, and a worker may
 * finish the Continuation without naming an exit. Its message is the forwarded response.
 */
export const CONTINUATION_EXIT: BlockExit = {
  id: "output",
  name: "",
  description: "The worker's response to the prompt, then every later message unchanged.",
  messageRequired: true,
};

/** Where a block's exit comes from: its Agent, this Flow only, a Human step, a Wait's output or a
 * Continuation. */
export type ExitSource = "agent" | "local" | "human" | "wait" | "continuation";
export interface EffectiveExit extends BlockExit {
  readonly source: ExitSource;
}

/** The exits of `block`'s Agent among `agents`; none when the reference is unset or unknown. */
export function inheritedExits(
  block: FlowBlockInput,
  agents: readonly Pick<AgentDefinition, "id" | "exits">[],
): readonly BlockExit[] {
  if (block.kind !== "agent") return [];
  return agents.find((agent) => agent.id === block.agentId)?.exits ?? [];
}

/**
 * The exits a block offers: an Agent block's Agent exits minus those hidden in this Flow, then its
 * Flow-local exits; a Human block's fixed exits; a Wait's or a Continuation's single output. Pass the Agents the reader resolves against: the
 * current saved ones for authoring, the captured revisions for a Run.
 */
export function effectiveExits(
  block: FlowBlockInput,
  agents: readonly Pick<AgentDefinition, "id" | "exits">[],
): EffectiveExit[] {
  if (block.kind === "human") return HUMAN_EXITS.map((exit) => ({ ...exit, source: "human" }));
  if (block.kind === "wait") return [{ ...WAIT_OUTPUT, source: "wait" }];
  if (block.kind === "continuation") return [{ ...CONTINUATION_EXIT, source: "continuation" }];
  const hidden = new Set(block.hiddenExitIds);
  return [
    ...inheritedExits(block, agents)
      .filter((exit) => !hidden.has(exit.id))
      .map((exit) => ({ ...exit, source: "agent" as const })),
    ...block.localExits.map((exit) => ({ ...exit, source: "local" as const })),
  ];
}

const EXIT_FIELDS = ["id", "name", "description", "messageRequired"];
const EXIT_LIMIT = 100;

function checkExitName(
  value: unknown,
  path: string,
  names: Set<string>,
  required: boolean,
  issue: IssueReporter,
) {
  const name = typeof value === "string" ? value.trim() : undefined;
  const valid = name !== undefined && name.length <= 200 && (!required || !!name);
  if (!valid || (name && names.has(name)))
    issue("invalid_exit_name", path, "Exit names must be distinct and up to 200 characters.");
  if (name) names.add(name);
}

function checkExit(
  exit: unknown,
  path: string,
  seen: { ids: Set<string>; names: Set<string> },
  requireName: boolean,
  issue: IssueReporter,
) {
  if (!isRecord(exit)) {
    issue("invalid_exit", path, "Supply a named exit.");
    return;
  }
  if (Object.keys(exit).some((key) => !EXIT_FIELDS.includes(key)))
    issue(
      "exit_fields_forbidden",
      path,
      "An exit has only an ID, name, description and message requirement.",
    );
  if (!isId(exit.id) || seen.ids.has(exit.id))
    issue("invalid_exit_id", `${path}.id`, "Exit IDs must be unique within a block.");
  else seen.ids.add(exit.id);
  checkExitName(exit.name, `${path}.name`, seen.names, requireName, issue);
  if (typeof exit.description !== "string" || exit.description.length > 4000)
    issue(
      "invalid_exit_description",
      `${path}.description`,
      "Use a description up to 4000 characters.",
    );
  if (typeof exit.messageRequired !== "boolean")
    issue(
      "invalid_exit_message_required",
      `${path}.messageRequired`,
      "State whether this exit requires a message.",
    );
}

/** Reports malformed exits at `path`. Only Flow-local exits may stay unnamed while authoring. */
export function checkExits(
  exits: unknown,
  path: string,
  requireNames: boolean,
  issue: IssueReporter,
) {
  if (!Array.isArray(exits) || exits.length > EXIT_LIMIT) {
    issue("invalid_exits", path, `Supply up to ${EXIT_LIMIT} exits.`);
    return;
  }
  const seen = { ids: new Set<string>(), names: new Set<string>() };
  exits.forEach((exit, j) => checkExit(exit, `${path}.${j}`, seen, requireNames, issue));
  // Workers finish on an exit's name or ID, so one exit's name must not be another exit's ID.
  exits.forEach((exit, j) => {
    if (!isRecord(exit) || typeof exit.name !== "string") return;
    const name = exit.name.trim();
    if (name && name !== exit.id && seen.ids.has(name))
      issue(
        "invalid_exit_name",
        `${path}.${j}.name`,
        "An exit's name must not be another exit's ID.",
      );
  });
}

/** An Agent's exits: unique IDs and distinct, non-empty names, stored trimmed. */
export function parseAgentExits(exits: unknown): Result<BlockExit[]> {
  const issues: ValidationIssue[] = [];
  checkExits(exits, "exits", true, (code, path, message) => issues.push({ code, path, message }));
  if (issues.length)
    return { ok: false, error: { code: "validation", message: issues[0]!.message, issues } };
  return {
    ok: true,
    value: (exits as BlockExit[]).map((exit) => ({
      id: exit.id,
      name: exit.name.trim(),
      description: exit.description,
      messageRequired: exit.messageRequired,
    })),
  };
}
