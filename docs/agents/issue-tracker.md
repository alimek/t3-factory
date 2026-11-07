# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

Write issue titles, bodies, comments, and resolutions in English. Conversations with the user remain in Polish.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Tool discovery and work state

Before concluding that a CLI cannot perform an operation, read the installed
command's `--help`. Use its supported operation before a browser, gist or custom
API workaround. For PR images and videos, check `gh pr edit --help` for `--attach`;
upload ignored local evidence directly when supported. Keep multiline text in a
file and pass `--body-file`.

Before claiming work, read the issue's comments and linked PRs, then use
`t3_thread_search` by issue number and topic and `t3_thread_read` for relevant
active threads. No assignee or PR means ownership is unknown, not that nobody is
working. Search is not exhaustive and skips subagent threads. Use the thread's
current state to detect overlapping work; coordinate only with the relevant
owner. If discovery is inconclusive or T3 tools are unavailable, report that limit
and obtain ownership confirmation from the user or known owner before claiming
an unassigned issue. An explicit task assignment supplies that confirmation for
its scope. Claim an available issue before implementation.

For long work, keep one short checkpoint in ignored
`.e2e/checkpoints/<task-key>.md` in the task's worktree. Use a stable thread
identifier or unique task key and reuse that key on resume, so tasks sharing a
worktree retain separate checkpoints. Update it after a meaningful verification
or change of direction, and before a handoff or context reset. Record:

- acceptance criteria already met, with evidence paths;
- open problems and the relevant documentation or test seam already found;
- last verification command, result and the commit or working-tree state it covered;
- the next concrete action.

On resume, read the checkpoint, then refresh Git status/diff, the issue, PR checks
and relevant T3 thread state from their tools. Without T3 tools, obtain current
thread state from the user or known owner and report that it was not independently
verified. Those tools own current branch, ownership and review status; the
checkpoint stores reasoning and evidence needed to continue, rather than a second
status tracker. Reuse earlier verification only when its inputs still match.

## Pull requests as a triage surface

**PRs as a request surface: no.** (Set to `yes` if external PRs should be triaged like issues; `/triage` reads this flag.) GitHub shares one number space across issues and PRs, so resolve a bare
`#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see **Make an issue a sub-issue of a parent**). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line), an assignee or active work found through **Tool discovery and work state**; first available in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
