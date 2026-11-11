/**
 * The optional setup skill installed beside the Factory Block skill. The user invokes it by name
 * once per repository to record the "in progress" label in that repository's tracker claim
 * operation, which workers then perform; the backend itself never writes to a tracker. Its
 * confirmation gate lives here because the skill edits the repository and the tracker's labels.
 * Inspection compares installed copies with this exact text, so any edit makes them outdated until
 * Repair or Reinstall.
 */
export const SETUP_FACTORY_SKILL = `---
name: setup-factory
description: Configure this repository so Factory workers mark the tracker issues they take with an "in progress" label. Use only when the user invokes setup-factory by name.
disable-model-invocation: true
---

# Setup Factory

A Factory worker that starts work on an issue from the repository's tracker claims it the way the repository's **tracker document** describes. This skill adds an "in progress" label to that claim operation and creates the label in the tracker, so the issue list shows which issues Factory has taken.

Tell the user these facts when you present the proposal in step 3:

- Factory itself never writes to the tracker. Workers perform the claim in their own turn with their own tracker access.
- The label is information, not a lock. Existing ownership checks still decide who may take an issue.
- Nobody removes the label. Closing the issue is the completion signal.
- The label name can be changed later by editing the tracker document; rerunning this skill is not needed.

## Rules

- Run only when the user invokes this skill by name, once per repository.
- Write nothing before the user's explicit confirmation in step 4: no file edit and no tracker write. Exploration is read-only.
- Change only the claim operation and what step 5 lists. Preserve all other content of every file you edit. Create no agent instructions file, no triage document and no domain document.
- Write nothing local to the tracker: no file paths, thread ids or prompt text.

## Asking

Ask with the session's native question tool when one is available, and keep a free-text answer possible. Without one, ask in chat with numbered choices and accept a number or free text.

## Steps

1. **Explore.** Read, without writing:
   - the remote (\`git remote -v\`), to identify the tracker host and repository;
   - the agent instructions file: \`AGENTS.md\`, otherwise \`CLAUDE.md\`, at the repository root;
   - the tracker document: the file the agent instructions point to for the issue tracker, otherwise \`docs/agents/issue-tracker.md\`; when it exists, find its claim operation and whether that already adds a label;
   - the tracker's existing labels (GitHub: \`gh label list --limit 200 --json name,description\`).

   Done when each of the four is known or known to be absent.
2. **Present.** Tell the user what you found: the remote, the agent instructions file, the tracker document and its current claim operation, and any existing label that already means "in progress" (for example \`in progress\`, \`in-progress\`, \`status: in progress\`, \`wip\`). Name what is absent or could not be read. Done when the findings are shown.
3. **Propose.** Propose the tracker and the label string, and state the four facts above.
   - Tracker: the one the tracker document names, otherwise the one the remote implies. For any tracker other than GitHub Issues, ask the user to describe in their own words how an issue is claimed and labelled there, and how a label is created; record that description instead of inventing commands.
   - Label: default \`factory:in-progress\`. When the tracker already has an equivalent label, offer it as the alternative so the user does not get a duplicate. Accept any other name the user gives.

   Done when the user has chosen one tracker and one label string.
4. **Draft and confirm.** Show every change before making it:
   - the tracker document change as a diff, or the full text of a new document;
   - the line to be added to the agent instructions file, when step 5 adds one;
   - the tracker command that creates the label, when the label is missing.

   Ask the user to confirm, revise or cancel. Done when the user answers:
   - **Cancel**: say that nothing was written, then stop.
   - **Revise**: apply the change, then show the full draft again. A confirmation given before the change no longer counts.
   - **Confirm**: an explicit yes to this draft. Agreement in an earlier message is not confirmation.
5. **Write the tracker document.** Write exactly the confirmed draft.
   - **Tracker document exists.** Add the label to its existing claim operation, next to the assignee step, so one claim does both (GitHub: \`gh issue edit <number> --add-assignee @me --add-label "<label>"\`). When the claim already adds this label, change nothing. When the document has no claim operation, add one to its conventions. Leave every other line as it is.
   - **No tracker document.** Create only \`docs/agents/issue-tracker.md\`, from the template below for GitHub Issues, or in the same shape from the user's description for another tracker. Then add one line referencing it to the agent instructions file that already exists, for example \`Issues are in <tracker>; read [the tracker conventions](docs/agents/issue-tracker.md) before claiming an issue.\` When no agent instructions file exists, create none and tell the user the document is not referenced yet.

   Done when the files match the confirmed draft and nothing else changed (\`git status\`, \`git diff\`).
6. **Create the label.** Check whether the label exists, and create it only when it is missing.
   - GitHub: \`gh label list --search "<label>" --json name --jq '.[].name'\` lists candidates; the label exists only on an exact name match. When missing: \`gh label create "<label>" --description "Taken by a Factory worker"\`.
   - Another tracker: use the creation step the user described. When you cannot perform it, tell the user to create the label themselves.

   Done when the label exists in the tracker, or the user knows it does not and why.
7. **Report.** List the files changed and whether the label was created or already existed. Leave committing to the user. Say that workers claim issues with the label from their next Run, and that the tracker document is where to rename it. Done when the report is sent.

## Template: GitHub Issues

Replace \`<label>\` with the chosen label string.

\`\`\`markdown
# Issue tracker: GitHub

Issues for this repo live as GitHub issues. Use the \`gh\` CLI for all operations.

## Conventions

- **Create an issue**: \`gh issue create --title "..." --body "..."\`. Use a heredoc for multi-line bodies.
- **Read an issue**: \`gh issue view <number> --json number,title,body,labels,comments\`.
- **List issues**: \`gh issue list --state open --json number,title,labels\` with appropriate \`--label\` and \`--state\` filters.
- **Comment on an issue**: \`gh issue comment <number> --body "..."\`
- **Apply / remove labels**: \`gh issue edit <number> --add-label "..."\` / \`--remove-label "..."\`
- **Claim**: \`gh issue edit <number> --add-assignee @me --add-label "<label>"\` before starting work on the issue. The label marks the issue as in progress; it is not a lock and is never removed. Closing the issue ends the work.
- **Close**: \`gh issue close <number> --comment "..."\`

Infer the repo from \`git remote -v\`; \`gh\` does this automatically when run inside a clone.
\`\`\`
`;
