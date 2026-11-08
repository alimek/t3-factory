# T3 Factory

T3 Factory lets users compose and run their own software development workflows.

## Language

**Release**:
One T3 Factory product version, identified by a `vX.Y.Z` tag on a fixed commit and published only by the controlled `publish` job. macOS packaging is part of the Release; see [Release](docs/release.md).

**Beta build**:
A signed prerelease of `main`, tagged `vX.Y.(Z+1)-beta.N`, built nightly when `main` changed or on demand. It is not a Release: it skips the release PR and maintainer qualification. Installations on the **beta update channel** receive beta builds and newer Releases; the **stable channel** receives Releases only. See [Release](docs/release.md#beta-builds).

**Project**:
A local repository represented by a T3 project, providing the context for Tasks and Runs. Independent local clones are distinct projects even when they share a remote repository.

**Flow**:
A user-defined graph of work steps and control rules. Its design determines which parts run autonomously and which require human participation.

**Flow revision**:
One immutable saved version of a Flow's name, graph and workspace setting. Every successful create or save appends the next revision; Studio shows the latest, and removing a Flow keeps its revisions.

**Workspace setting**:
The Flow's choice of where its Runs work: the selected Project's checkout or a new worktree, with the worktree's base (the Project repository's default branch or a custom Git ref). It belongs to the Flow revision, not the Run draft; Start resolves a worktree base against the selected Project and rejects a missing one.
_Avoid_: Copying workspace choices into a Run draft.

**Run workspace**:
Where all workers of one Run work, fixed at Start: the project checkout, or for a worktree Flow one worktree that the Run's creator worker creates on a Factory-named branch and every other worker joins once Factory has bound its path and branch. The Run's project root stays its project identity.
_Avoid_: A worktree per worker.

**Flow block**:
A constituent element of a flow: the Flow input block, an agent block or a human step.
_Avoid_: Puzzle as the canonical name; agent when referring to all block types.

**Agent**:
A reusable worker definition consisting of a prompt and execution settings, independent of a particular project. An agent block uses this definition within a Flow; its execution belongs to a Run.

**Agent revision**:
One immutable saved version of an Agent's name, prompt and execution settings. Every successful create or save appends the next revision; Studio shows the latest, and removing an Agent keeps its revisions.

**Studio**:
The modal authoring surface for global Flows and reusable Agent definitions. It opens over the current Run or composer from the sidebar icon beside Settings, and closing it returns to that underlying screen. Settings holds the T3 connection and does not edit Agents or Flows.
_Avoid_: Settings as the Agent editor; a Flows destination in the Run sidebar.

**Factory server**:
The installation that owns one Factory data home, Runner and T3 connection. Exactly one backend may own a home; other devices operate it as approved clients.

**Approved client**:
A desktop installation or browser profile the server owner approved on the host panel. It has full normal Factory access until revoked; it never owns data, T3 credentials or host lifecycle.
_Avoid_: user or account (there are no team accounts); session (approval outlives connections).

**Human step**:
A flow block awaiting a person's confirmation or decision in Factory before the flow continues. Returning work for corrections requires a prompt describing the requested changes.

**Block exit**:
A named outcome of a flow block whose connections determine which blocks run next.

**Block result**:
An agent's explicit report of its block's state and, where applicable, a selected exit and a message for subsequent blocks. A request for corrections is distinct from an inability to perform the work.

**Final result**:
The newest accepted `finished` report for one Block activation, sent from any turn of
the Block's worker thread with its Block id. A later `finished` report for the same activation replaces it as a new
version; earlier versions stay in the Run's history unchanged. Acceptance and the worker thread being finished are
separate facts.

**Run coordinator**:
Retired. Factory no longer saves a model selection for a primary Run conversation. A closed Run may still display one when it was stored before this contract.

**Run conversation**:
Retired as the way a Run starts. Factory launches each Agent Block as its own top-level worker. A closed Run may still show a historical primary conversation.

**Worker**:
The top-level T3 thread Factory launches for one Agent Block. In a worktree Run, Factory may create it idle, with no turn, before the Block is reached; such a prepared worker is not a visit, and the visit starts with the first task sent to it. It performs that Block's task, receives the user's replies in the same thread, and reports through `factory_update_block` with its Block id from any turn. Two Blocks that share an Agent have separate workers. Its completed turn alone does not establish a completed Block; see Worker thread finished.

**Worker thread finished**:
Factory's single completion rule for a worker, decided by T3 alone: the thread read shows no active run and no pending native request, and `t3_thread_wait` for its latest run with its delegated work answers a terminal status without timing out. T3's `resultRun` is not consulted. Handoff release, missing report, automatic settlement and Request report use it.
_Avoid_: quiet frontier, owned tree, descendant coverage.

**Active block**:
A Run Block in `working` or `waiting` state. Several Blocks can be active at once; the execution canvas centers their combined bounds on entry and while following them. When none is active, entry shows error-state Blocks for failed execution, or the whole graph.
_Avoid_: current step.

**Follow active**:
The execution canvas keeping its view on the active Blocks (or the error-state Blocks of failed execution) as they change. It is on whenever a Run is opened, turns off on manual pan or zoom, and is turned back on by the zoom-control button of the same name or its shortcut (default **.**) on the focused execution canvas. Not saved.
_Avoid_: auto-scroll, tracking mode.

**Block id**:
The identifier Factory mints for an Agent Block when a Run starts and states in every launch, visit and Request report message to that Block's worker. Factory MCP tools take it to read the Block and its Run and to update the Block; a report naming it applies to the Block's current activation. It is stable across visits and is not the Flow block's id.
_Avoid_: tool ref, caller correlation.

**Factory MCP**:
The MCP server a Factory server serves at `/mcp` on its host-local listener. Harnesses register it once by URL and call `factory_get_block`, `factory_get_run` and `factory_update_block` on it; an application update changes its tools without changing harness configuration.
_Avoid_: bridge (the retired stdio copy installed per harness).

**Block activation**:
One accepted task at a Flow block, from its launch or visit message until its result is completed. Reports naming the Block id apply to the Block's current activation, whichever turn of the worker thread sends them.

**Needs input**:
Pending questions or decisions on a Run. This covers Human occurrences answered in Factory and native T3 questions or permissions, which stay Open in T3. An Agent's question in chat is ordinary conversation, not Needs input. It is not an execution state.

**Conversation waiting**:
A retired, non-final `waiting` report with which an Agent once asked the user in chat. Factory now refuses it; recorded ones stay readable as history, and an upgrade turned pending ones into Working reports.

**Working report**:
An explicit, non-final `working` report an Agent sends when it starts its Block activation's task, or reopens it. It carries a message shown on the Block and in its Run row, selects no exit, releases no handoff and is not attention. It stays current across later turns of the activation, including questions to the user, their replies and waits for CI or review, so a finished worker thread raises no missing report. A later working or finished report replaces it.
_Avoid_: progress report, heartbeat.

**Problem**:
A pending execution or report issue already recorded as attention: a missing report, an execution failure, or a report problem. It is distinct from block execution state and from stale or unavailable observations.

**Inbox**:
The set of Run attention matters awaiting a response or action. Factory presents pending and settled matters on the Run they belong to. There is no separate global Inbox.

**Runner**:
The executor of a flow's declared transitions and conditions. Agent results determine which permitted path it follows.

**Skill**:
A packaged workflow or set of instructions guiding an agent's work.

**Task**:
A concrete matter to work on within a project, such as a coding change, an idea to discuss, or a specification to investigate. Each Start creates a new Task for its Run; Tasks recorded by earlier releases can still hold several Runs.

**Run**:
One execution of a selected flow for a task in a project, with its own editable title
and global navigation entry.

**Captured definitions**:
The Flow revision a Run started with and the Agent revision of every Agent that Flow references, frozen at Start. Every read and later activation of the Run uses them; later saves and removals affect only future Runs.
_Avoid_: Run snapshot.

**Run timeline**:
The chronological record of a Run's execution events, including block activity, handoffs, human-attention events, settling, returning to Active, and archiving. Each Run has its own timeline, distinct from conversations in its T3 threads.

**Run activity**:
A meaningful change in a Run's work, such as an accepted Agent report, an execution change, a new Needs input matter or an answer to a Human step. Viewing or renaming a Run and observing an unchanged state are not Run activity.

**Execution canvas**:
The read-only view of the Flow revision a Run captured at Start. Each block shows its recorded execution state, and the same block is updated when work visits it again. Needs input and Problem are separate indicators. Pan, zoom and fit do not edit the Flow, and configured connections stay visible without implying they were traversed.

**Flow input**:
The data supplied to a particular flow execution: the plain text entered when starting a Run. Every Agent block connected to the Flow input block receives it, each in its own independent session.
_Avoid_: Initial input, initial prompt as a separate concept

**Flow input block**:
The single, always-present Flow block representing the Flow input. It has one unnamed output and no input; the Agent blocks it connects to are the ones that start a Run, independently and in parallel.
_Avoid_: Start block, entry, entry Agent

**Authorization context**:
A durable Factory reference binding accepted work to one T3 endpoint, OAuth grant
lineage and environment. Reconnection and refresh preserve it; changed grants,
endpoints or environments create another context. A matching reference is a
necessary recovery check, not proof of execution readiness or retry retention.

**Archived**:
The final Run lifecycle state, set when the user archives a Run after confirming. Archiving closes the handoff gate, cancels unsent launches, handoffs and Human occurrences and asks T3 once to interrupt each worker thread, without waiting for confirmation. An Archived Run leaves navigation for good and keeps all its data; reports for it are acknowledged as a success that changes nothing. Archive does not undo repository changes.
_Avoid_: Stop and Stopped (the retired confirmed-termination outcome).

**Handoff**:
An accepted delivery from a block's selected exit to one connected recipient.
It is held until the source worker thread is finished and no execution failure is
pending on that Block; acceptance alone does not start work. A held handoff is cancelled when its Final result is
replaced before release. Each recipient and repeated arrival proceeds independently, using the routing rules of the Run's captured Flow revision.

**Human occurrence**:
One arrival at a Human step within a Run, with its own pending context and settlement. An occurrence from an Agent result activates only after that result is released; it has no T3 session. Answering or cancelling one occurrence does not settle another arrival.

**Work period**:
One T3 run of a Block's worker thread, including repeated visits, queued turns, user replies and automatic continuations after delegated or background work. Closed Runs may also show work periods of a historical Run conversation.

**Settled**:
A Run lifecycle state for work that is done. A Run settles automatically when every
visited Block has its Final result with no later working report, every Human
occurrence is answered, nothing is owed or pending and every worker thread is
finished; the user can also settle an Active or Snoozed Run at any time. Settling
changes no execution. Any accepted report from one of its Blocks returns it to
Active; chat without a report does not. Navigation groups Settled Runs together.
On a Run, settled attention matters no longer await attention and keep their
appearance and settlement times and reasons; settling attention does not settle the Run.
_Avoid_: Finished (the retired permanent outcome).

**T3 thread settlement**:
T3's presentation state for a conversation whose current work is complete; the
same conversation can return to the active list when it receives new work.
Factory best-effort settles worker threads when their Run settles and never unsettles them; it is independent of attention settlement.

**Snoozed**:
Durable presentation for an Active Run set aside from the main navigation list.
Execution continues. New actionable attention can wake it; manual Restore returns
it without Woke. Settling or archiving it clears it.

**Woke**:
An unseen presentation marker showing that new attention returned a snoozed Run
to the main list. Opening clears only this marker, leaving Needs input and Problem
pending. Resnoozing accounts for existing attention identities so they cannot
repeatedly wake the same Run.

**Run closure**:
Retired. Earlier releases recorded a permanent Finished or Stopped outcome with each worker thread as observed; such Runs are now Settled or Archived and keep that evidence as history. See Settled and Archived.

**Run composer**:
The full-page launch surface for choosing a Project, global Flow and required
initial prompt. It edits one Run draft at a time and opens a fresh composition from
New Run or a Flow's Start Run; opening it does not start execution. Start always uses
the current saved Flow and Agent definitions.

**Run draft**:
A client-local composition saved in browser storage while its prompt has a
non-whitespace character: the exact prompt, Project/Flow references, title and
creation time. It has no Task, Run or captured revisions until Start is accepted, which removes
it; the Run keeps its title and creation time. Not to be confused with an unsaved Flow draft in Studio.

**Request report**:
An explicit user operation starting one additional Agent turn on the same thread
to assess existing work and submit its report. It applies to an idle Agent Block
without a Final result for its current activation, such as one with a missing
report or one whose latest report is a Working report. A durable recovery link
connects that new execution to the idle run it assesses and to the missing-report
obligation pending for that run, if any. Successful recovery settles the obligation
without fabricating an earlier report or erasing an engine failure.
