import { basename, dirname, join } from "node:path";

/** The one Factory Block skill installed for Codex and Claude. Harness copies must match this text. */
export const FACTORY_BLOCK_SKILL = `---
name: factory-block
description: Work one Factory Block from factory_get_block and report only through factory_update_block.
---

# Factory Block

You are one Block in a Factory Run. Factory owns routing, Stop, and closure.

1. Call \`factory_get_block\` before other work. If the reply is \`BINDING_PENDING\`, wait \`retryAfterMs\` and call it again. That reply grants no authority. When the message gives a Factory tool ref, pass that exact string as \`ref\` on every Factory tool call. \`ref\` only tells Factory which in-flight call is yours. It is not a Run or Block id.
2. Work from this Agent's prompt and the returned inputs: the original Run input, incoming results, and feedback.
3. Call \`factory_update_block\` with \`to: "waiting"\` and a nonempty \`message\` when you need a user reply. Do not send an exit.
4. Call \`factory_update_block\` exactly once with \`to: "finished"\`, one configured exit, and a message when that exit requires feedback.
5. On a conflict, use \`allowedTransitions\` and \`allowedExits\` from the reply. Do not invent a transition or an exit.
6. An identical retry of an accepted update returns the original acknowledgement. Do not send a different update for the same state.
7. Subagents never call Factory tools.
8. \`factory_get_run\` is read-only. It grants no routing authority.

The first message in this thread starts with \`$factory-block\`. Follow this skill on every visit, including feedback.
`;

/** Codex keeps the skill next to config.toml. Claude's user config keeps it under `.claude/skills`. */
export function factoryBlockSkillPath(configPath: string) {
  const home = dirname(configPath);
  const nestedClaude = basename(configPath) === ".claude.json" && basename(home) !== ".claude";
  return join(home, ...(nestedClaude ? [".claude"] : []), "skills", "factory-block", "SKILL.md");
}
