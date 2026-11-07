import { basename, dirname, join } from "node:path";

/**
 * The Factory Block skill installed beside each harness configuration. It names which tool
 * to use when; protocol rules live in the MCP tool descriptions so an update needs no reinstall.
 */
export const FACTORY_BLOCK_SKILL = `---
name: factory-block
description: Work one Factory Block with the factory-runtime tools. Use when the thread's first message starts with $factory-block.
---

# Factory Block

This thread is one Block in a Factory Run. Factory takes the Block's result only from its tools, never from chat.

1. Call \`factory_get_block\` before any other work. Done when it returns your Block with its inputs and exits.
2. Work from this Agent's prompt and those inputs. Call \`factory_get_run\` when you need the rest of the Run as context.
3. Report with \`factory_update_block\`. Done when it returns an acknowledgement.
   - \`to: "waiting"\` when you need the user's reply, then end the turn.
   - \`to: "finished"\` with one of the Block's exits when the work is done.

When the message gives a Factory tool ref, pass it as \`ref\` on every Factory tool call. Factory tools belong to this thread's own agent; subagents work without them.

Every later turn in this thread, including feedback and user replies, starts again at step 1.
`;

/** Codex keeps the skill next to config.toml. Claude's user config keeps it under `.claude/skills`. */
export function factoryBlockSkillPath(configPath: string) {
  const home = dirname(configPath);
  const nestedClaude = basename(configPath) === ".claude.json" && basename(home) !== ".claude";
  return join(home, ...(nestedClaude ? [".claude"] : []), "skills", "factory-block", "SKILL.md");
}
