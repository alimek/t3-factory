import { basename, dirname, join } from "node:path";

/**
 * The Factory Block skill installed beside each harness configuration. It carries the worker's
 * reporting obligations; argument rules and Factory's next step live in the MCP tool descriptions
 * and replies, which change without a reinstall. Readiness compares installed copies with this
 * exact text, so any edit makes every installed copy outdated until Repair.
 */
export const FACTORY_BLOCK_SKILL = `---
name: factory-block
description: Work one Factory Block and report it through the factory-runtime tools. Use in any thread whose first message starts with $factory-block.
---

# Factory Block

This thread is the worker for a Block of a Factory Run. Factory knows the Block's state only from your \`factory_update_block\` reports, never from chat, and Factory alone routes the result to the next Blocks.

Factory's messages in this thread give your **Block id** on a \`Factory Block id:\` line. Pass it as \`blockId\` on every Factory tool call. It stays the same on every visit and is not the T3 thread id. A later Factory message may start a task for a different Block in this same thread, a Continuation, with its own Block id: report each task with the Block id from the Factory message that started it, never an earlier one; the \`blockId\` fields inside tool replies name Flow blocks, not your Block id. Only this thread's own agent calls Factory tools: subagents return their work to you and never receive the Block id.

## Every turn

Follow these steps on every turn of this thread: the first visit, a later visit, a user reply (also after a result), a notification after CI, review, delegated or background work, and a Request report.

1. Read the Block with \`factory_get_block\`. Done when it returns the current visit with its state, reason, inputs, exits and allowed reports.
2. Except on a Request report, which reports its assessment instead: if this visit has no \`working\` report yet, or you are reopening the task after a \`finished\` result, report \`working\` before you start. Each visit needs its own report, even when an earlier visit finished. Done when the call succeeds.
3. Work from this Agent's prompt, or for a Continuation (reason \`continuation\`) from its prompt, and the current visit's inputs: the Run input, the result that caused this visit and any feedback. Call \`factory_get_run\` only for wider Run context; other Blocks' latest results do not replace this visit's inputs. The Run input may reference images as \`[Image N: name]\`; \`inputs.images\` lists them in order with their \`imageId\`, so fetch one with \`factory_get_run_image\` when relevant to your task, not every image automatically. A failed image read changes nothing in Factory, so continue or explain the blocker in your report. Done when the task is complete, you need the user, or what remains runs outside this turn (CI, review, delegated or background work).
4. When the task is complete, report \`finished\`. Otherwise end the turn without another report: your \`working\` report stays current. When you need the user, your questions are the final message of the turn; do not follow them with a Factory call or another prompt to reply. Done when the call succeeds and you followed the reply's \`next\` guidance, or when the turn ends with the questions or the open work.

## Reports

Your latest report is the Block's **current report**.

- \`to: "working"\` with a \`message\` and no exit: you are on the task. Say what you are doing or waiting on. It stays current across every later turn of this visit, including questions to the user, their replies and waits for CI, review, delegated or background work, so do not report it again for those. Report it again only to replace the message or when you reopen the task. Something must resume this thread when outside work changes, such as a watch or delegated work notifying it.
- \`to: "finished"\` with one \`exit\` from the Block's exits and a result message: the task is complete. A Continuation has no exits: finish it without an exit, with your response as the message. While questions are unanswered or CI, review, delegated or background work is still pending, the task is not complete; leave \`working\` current. Unanswered questions and your recommendations are not the user's decisions.

There is no \`waiting\` report: a question in chat needs no report.

The newest \`finished\` is this visit's result. To correct it, report \`finished\` again from a later turn. Before Factory hands it off, only the newest result goes on. After hand-off, the same exit only updates the result; a different exit also starts that exit's next Blocks while Blocks started from the earlier result keep running, so change the exit only when the outcome changed.

### Result message

The next Block receives your \`finished\` message and a link to this thread; Factory fetches nothing else. Write the message so that Block can continue without asking:

- the outcome, and why it fits the chosen exit;
- evidence: the checks, tests and reviews you ran and their results;
- artifact references: repository paths, branch names, commit SHAs and PR URLs.

When the exit requires feedback, the message is that feedback.

## Request report

A Factory message saying \`Factory Request report\` asks you to assess the work already done in this thread. Read the Block, check the current state of that work (for example its CI or PR status) and report what you find: \`working\` with what remains open while questions or outside work are unfinished, \`finished\` only when the task is complete. Assessing is the whole turn; leave the task as it stands.

## Settled and Archived Runs

A Run Factory settled automatically accepts reports as usual, and an accepted report returns it to Active. When the user settles a Run, or archives it, Factory answers every report with a success that records nothing: \`RUN_SETTLING\` while the user is settling it and Factory is stopping its workers, \`RUN_SETTLED\` once the user settled it, and \`RUN_ARCHIVED\` for an Archived Run. After any of these replies, stop work on this Block and end the turn.

## Tool errors

A rejected report carries a \`reason\` and a \`next\` step; follow \`next\`. A rejection leaves your work intact: correct the call, not the work.

- A validation code such as \`MESSAGE_REQUIRED\`, \`EXIT_NOT_ALLOWED\`, \`INVALID_EXIT\` or \`FEEDBACK_REQUIRED\`: fix the arguments and call again.
- \`WAITING_RETIRED\`: you followed an outdated instruction. Do not report the question; end the turn with it as your final message.
- \`UNKNOWN_BLOCK\` or \`BLOCK_ID_REQUIRED\`: copy the Block id exactly from the latest \`Factory Block id:\` line and call again.
- \`RUNTIME_UNAVAILABLE\` or no reply at all: Factory may not have recorded the report. Repeat the same call; an identical report returns the same acknowledgement.

If reporting still fails, say in chat which report you could not make and the error, then end the turn.
`;

/** Codex keeps the skill next to config.toml. Claude's user config keeps it under `.claude/skills`. */
export function factorySkillPath(configPath: string, skill: string) {
  const home = dirname(configPath);
  const nestedClaude = basename(configPath) === ".claude.json" && basename(home) !== ".claude";
  return join(home, ...(nestedClaude ? [".claude"] : []), "skills", skill, "SKILL.md");
}
