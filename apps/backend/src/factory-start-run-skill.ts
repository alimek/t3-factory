/**
 * The optional launch skill installed beside the Factory Block skill. The user invokes it by name
 * to start a Run from a conversation; its confirmation gate lives here because
 * `factory_start_run` starts a Run as soon as it is called. Inspection compares installed copies
 * with this exact text, so any edit makes them outdated until Repair or Reinstall.
 */
export const FACTORY_START_RUN_SKILL = `---
name: factory-start-run
description: Start a Factory Run from this conversation after the user reviews and confirms its Project, Flow and prompt. Use only when the user invokes factory-start-run by name.
disable-model-invocation: true
---

# Factory Start Run

\`factory_start_run\` starts a Run the moment it is called: Factory launches workers on the user's computer and spends budget. The user's explicit **confirmation** of the review in step 4 is the only gate, so call it only after that confirmation and only with the reviewed values.

The \`factory_*\` tools come from the \`factory-runtime\` MCP server. When they are missing, tell the user to install or repair Factory's harness setup from Factory and start a fresh session, then stop.

## Asking

Ask with the session's native question tool when one is available, and keep a free-text answer possible. Respect its option limit by narrowing or paging, so every returned Flow and Project stays reachable. Without a native tool, ask in chat with numbered choices and accept a number or free text. Work with the current provider and mode.

## Steps

Skip a collection step only when the user already supplied an unambiguous value for it. Review and confirmation always happen.

1. **Project.** Call T3's \`t3_worktree_status\`. When it reports a \`projectWorkspaceRoot\`, pass it as \`workspaceRoot\` to \`factory_list_projects\`: use the Project when \`match.status\` is \`matched\`, and otherwise relay \`match.explanation\`. Without a root, call \`factory_list_projects\` with no arguments. When the reply has a \`problem\`, relay it. Without a matched Project, ask the user to choose one of the reply's \`projects\` whose \`availability\` is \`available\`; when none is available, explain that and stop. A repository that is not listed must first be added in Factory. Identify a Project by its \`id\` and repository path, never by its name. Done when one available Project id is chosen.
2. **Flow.** Call \`factory_list_flows\`. When it returns no Flows, explain that a Flow must first be created in Factory Studio, then stop. Offer every returned Flow by name; when names repeat, add its workspace setting and id. For a Flow whose \`readiness.ready\` is false, relay its issue messages: Start makes the final check. Done when one Flow id is chosen.
3. **Prompt.** Use the text the user gave for the Run, or ask for it. Keep it verbatim: the user's own words, unedited and without conversation context added. This entry point carries text only; images and files go through Factory's Start form. Done when the exact text is held.
4. **Review.** Show the Project title and repository path, the Flow name and workspace setting (project checkout, or a new worktree and its base), the Run title Factory derives (the prompt's first non-empty line) and the exact prompt in a quoted block. Add one line saying that Factory may replace this title with a generated title shortly after Start, unless the latest \`factory_list_projects\` reply in this conversation has \`generateRunTitles: false\`. Keep the line when that reply has \`true\` or \`null\`, or when step 1 was skipped and there is no reply. Ask the user to confirm, revise or cancel. Done when the user answers:
   - **Cancel**: say that nothing was started, then stop. A later request to start begins again at step 1 and gets its own review.
   - **Revise**: apply the change from its step onward, then review again. A confirmation given before the change no longer counts.
   - **Confirm**: an explicit yes to this review. Complete information in an earlier message is not confirmation.
5. **Start.** Create one new random UUID as \`requestId\` for this confirmed review, for example with \`uuidgen\`. Call \`factory_start_run\` with \`requestId\`, \`projectId\`, \`flowId\` and \`input\` (the exact prompt), and keep those values frozen.
   - No reply, \`RUNTIME_UNAVAILABLE\` or \`internal\`: the outcome is unknown. Call again with the same \`requestId\` and identical arguments; Factory returns the already accepted Run instead of creating another.
   - \`validation\`: Factory created nothing. Relay the issues and the recovery the user can take. Changing Agents, Flows, Projects, the T3 connection or reporting setup is the user's separate decision. When the user changes the Project, Flow or prompt, return to step 4; the next confirmed review gets a new \`requestId\`.
   - \`conflict\` with a \`start_key_conflict\` issue: this \`requestId\` was accepted with other content. Return to step 4.
   - Any other \`conflict\`, such as Factory shutting down or setup changing during the check: nothing new was accepted. Follow the reply's \`next\` and call again with the same \`requestId\` and identical arguments.
   - \`not_found\`: the Flow no longer exists. Return to step 2.
   - Another Run requested later, even with the same prompt, is a new submission: it gets its own review and \`requestId\`.
6. **Receipt.** Report that Factory accepted the Run, with its number, id, title, Project and Flow from the reply. Acceptance is not startup: workers may not have started yet, and Factory shows their progress. Done when the receipt is sent.
`;
