# T3 Factory

T3 Factory lets users compose and run their own software development workflows.

## Language

**Release**:
One T3 Factory product version, identified by a `vX.Y.Z` tag on a fixed commit and published only by the controlled `publish` job. macOS packaging is part of the Release; see [Release](docs/release.md).

**First-run setup**:
The host's one-time checklist (connect to T3, install in agents) that must be completed before the application opens; once completed it is never shown again. See [First-run setup](docs/t3-integration.md#first-run-setup).

**Beta build**:
A signed prerelease of `main`, tagged `vX.Y.(Z+1)-beta.N`, built nightly when `main` changed or on demand. It is not a Release: it skips the release PR and maintainer qualification. Installations on the **beta update channel** receive beta builds and newer Releases; the **stable channel** receives Releases only. See [Release](docs/release.md#beta-builds).

**Project**:
A local repository represented by a T3 project, providing the context for Tasks and Runs. Independent local clones are distinct projects even when they share a remote repository.

**Flow**:
A user-defined graph of work steps and control rules. Its design determines which parts run autonomously and which require human participation. Every Flow is either a global Flow or a Project Flow.

**Owning Project**:
The one Project a Project Flow or Project Agent belongs to, identified by Factory's Project identity rather than a path, name or remote. It belongs to the definition, not to its revisions, and is kept when the Project becomes unavailable. A definition is "owned by" its Project.
_Avoid_: owner as the property's name, scope, assignment, local, availability (which says whether a Project can take new Runs).

**Global Flow** / **global Agent**:
A Flow or Agent with no owning Project. A global Flow starts in any available Project and places only global Agents.
_Avoid_: shared (one definition in several Projects is not a supported concept).

**Project Flow** / **Project Agent**:
A Flow or Agent owned by one Project. A Project Flow starts only in its owning Project and places global Agents and its own Project's Agents, never another Project's. A different configuration for another Project is an independent copy owned by that Project, never an override of a shared Flow; only a global Agent's execution settings may differ per Project, through a Project override.
_Avoid_: override (except Project override), overlay, per-project configuration of a shared Flow.

**Project override**:
A global Agent's execution settings for Runs in one Project, replacing its own settings there. It belongs to the Agent revision, so a Run's captured revision and its Project decide the settings it uses. Name, prompt and exits stay shared; only a global Agent with its own execution settings has overrides, at most one per Project.
_Avoid_: per-project Agent, Agent overlay.

**Change owner**:
The action that moves a Flow or Agent to another owning Project or to global without a new revision, only from the owning Project the client last saw and only while the placement rule still holds for every current Flow afterwards. A refusal names the blocking definitions; nothing else is edited or copied.
_Avoid_: reassign, transfer, move as the action's name.

**Placement rule**:
Which Agents a Flow may place: any Flow may place a global Agent, and a Project Flow may also place Agents of its own owning Project. Saving refuses a placement outside the rule, readiness reports one and Start rejects one.

**Flow Duplicate**:
A new, independent Flow copied from another Flow's latest saved revision into a target (Global or one available Project). Its plan lists each Agent the source places as kept (the copy places the same Agent) or copied (a new Agent in the target); an Agent the target may not place is always copied. The source Flow and its Agents never change, and a Flow Duplicate is never synchronized with its source.
_Avoid_: clone, fork, move (Change owner keeps the identity; Duplicate creates a new one).

**Flow revision**:
One immutable saved version of a Flow's name, graph and workspace setting. Every successful create or save appends the next revision; Studio shows the latest, and removing a Flow keeps its revisions.

**Workspace setting**:
The Flow's choice of where its Runs work: the selected Project's checkout or a new worktree, with the worktree's base (the Project repository's default branch or a custom Git ref). It belongs to the Flow revision, not the Run draft; Start resolves a worktree base against the selected Project and rejects a missing one.
_Avoid_: Copying workspace choices into a Run draft.

**Run workspace**:
Where all workers of one Run work, fixed at Start: the project checkout, or for a worktree Flow one worktree that the Run's creator worker creates on a Factory-named branch and every other worker joins once Factory has bound its path and branch. The Run's project root stays its project identity.
_Avoid_: A worktree per worker.

**Flow block**:
A constituent element of a flow: the Flow input block, the Finish block, an agent block, a human step, a Wait, a Continuation or a Condition. An agent block may carry a Revisit instruction.
_Avoid_: Puzzle as the canonical name; agent when referring to all block types.

**Agent**:
A reusable worker definition consisting of a prompt, optional execution settings, its exits and, for a global Agent, its Project overrides; it is a global Agent or a Project Agent, and ownership adds no execution restriction. Execution settings are complete or absent; an Agent without them Needs a model and cannot run. An agent block uses this definition within a Flow, adding only Flow-local exits, hidden exits and a Revisit instruction; its execution belongs to a Run.

**Agent revision**:
One immutable saved version of an Agent's name, prompt, execution settings (complete or none), Project overrides and exits. Every successful create or save appends the next revision; Studio shows the latest, and removing an Agent keeps its revisions. A Run captures only revisions with execution settings.

**Needs a model**:
The state of an Agent saved without execution settings (`execution: null`). It can be edited, placed and duplicated, but it cannot run until a save chooses an environment, provider and model. Studio also shows it for a saved selection T3 no longer offers, which the Agent editor clears from its draft; the stored Agent changes only on Save.
_Avoid_: unavailable, unknown.

**Definition export**:
A JSON file holding the latest saved revision of an Agent, or of a Flow with each Agent it uses bundled once, in the portable document format, with its model as an optional hint and without environment, server ids, revisions, timestamps or Runs. Exporting never changes the definition or its editor.
_Avoid_: backup, sync.

**Import receipt**:
The durable record of one committed import: the client's request id, a versioned fingerprint of the document, reviewed model choices and import target, and the definitions it created. A retry with the same content and target returns the original result instead of a copy; a receipt from before imports took a target replays only as a global import.
_Avoid_: import history, provenance.

**Studio**:
The modal authoring surface for Flows and reusable Agent definitions, global and Project-owned alike (its **Author** group), and Triggers (its **Automate** group). It opens over the current Run or composer from the sidebar icon beside Settings, and closing it returns to that underlying screen. Settings holds the T3 connection and does not edit Agents, Flows or Triggers.
_Avoid_: Settings as the Agent editor or Trigger location; a Flows destination in the Run sidebar.

**Factory server**:
The installation that owns one Factory data home, Runner and T3 connection. Exactly one backend may own a home; other devices operate it as approved clients.

**Approved client**:
A desktop installation or browser profile the server owner approved on the host panel. It has full normal Factory access until revoked; it never owns data, T3 credentials or host lifecycle.
_Avoid_: user or account (there are no team accounts); session (approval outlives connections).

**Human step**:
A flow block awaiting a person's decision in Factory before the flow continues. Its exits are fixed: **Approve** (message optional) and **Request changes** (a message describing the changes is required). No Flow or Agent configures them.

**Wait**:
A flow block that holds each arrival for a fixed duration from 1 minute to 7 days, then forwards its message unchanged through its one unnamed output. It has no Agent, worker, reports or exits to choose from, raises no attention, and cannot be a Flow input target.
_Avoid_: Timer or delay as the block name; manual resume (not a Wait mode).

**Wait arrival**:
One accepted delivery to a Wait within a Run, with its retained message, worker provenance, absolute deadline counted from the delivery's release, and outcome: pending, forwarded (at its deadline, or early by the user with **Continue now**) or cancelled by Archive or manual settlement. Arrivals never join or reset one another.

**Continuation**:
A flow block with a name, a prompt and one unnamed output, and no Agent or exits of its own. The first message that reaches it in a Run sends its prompt into the worker thread that message belongs to; the work shows on that worker's Agent block while the Continuation is **sent**. Its response leaves the single output, and from then on, for the rest of the Run, every message **passes through** unchanged with its own worker. It needs an Agent before it; human steps, Waits, Conditions and other Continuations pass the worker on.
_Avoid_: continuity, follow-up block, reusing a worker by copying its conversation.

**Condition**:
A Flow-local flow block that routes by arrival number: an ordered list of **From arrival N onward** rules, each with its own named output, followed by the fixed, mandatory **Otherwise** output. The first rule whose number the arrival reaches selects its output; Otherwise is selected when none does and is not an error route. It has no Agent, worker, prompt or reports, cannot be a Flow input target, and does not interpret message text. Written with a capital C it always means this block kind; a lowercase condition is any ordinary requirement or circumstance, such as a readiness or Start condition.
_Avoid_: Branch, router, switch or decision as the block name; condition for a generic requirement where the block could be meant.

**Condition arrival**:
One distinct delivery a Condition accepts within a Run, numbered from 1 per Run and Condition and shared by all its incoming wires and workers. A redelivery of the same delivery keeps its number; another delivery with identical text is the next arrival. It records its number, the selected output (the matched rule or Otherwise) and the delivery's worker provenance; the number never resets, and once recorded neither number nor selection changes. An arrival number is not a review or attempt count.
_Avoid_: Attempt, iteration or review number.

**Worker provenance**:
The worker thread a delivered message belongs to, recorded by its durable T3 thread id, and, when known, the Block activation whose result the message is: an Agent's result carries its worker and activation, a human step's answer the worker and activation of the message it answered, a Continuation's response the thread its prompt ran on, and a Wait, Condition or pass-through forwards what it received unchanged. A Continuation reads the thread from the message it receives; titles never select a thread. Run detail shows a delivery's provenance as its `origin` when both thread and activation are known.
_Avoid_: delivery origin as a separate term.

**Block exit**:
A named result a block finishes with, whose connections determine which blocks run next. An exit has a stable ID, a name, an optional description and a "message required" flag; there is no other classification. An agent block's exits are its Agent's current exits minus those hidden in this Flow, plus its Flow-local exits; a Run uses the Agent revisions it captured. Wires leave by exit ID, so renaming an exit keeps them.
_Avoid_: Exit outcome, completion or assessment exits (retired classifications); editing an inherited exit in a Flow.

**Flow-local exit**:
An exit a Flow adds to one agent block without changing its Agent. Its name and ID must differ from all current Agent exits, including hidden exits; a collision is a readiness issue.

**Hidden exit**:
An inherited Agent exit that one Flow hides on an agent block. Hiding an exit the Agent later removes has no effect.

**Revisit instruction**:
Optional plain text, up to 120,000 characters, on one agent block of a Flow, sent on every visit to that block after the first alongside the incoming message. It decides that visit's scope; the Agent's prompt, role, criteria, exits and reporting rules still apply. It is captured with the Flow revision at Start, and an empty one adds nothing. It is the one narrow exception to blocks having no overrides: there is no first-visit block prompt and no execution override.
_Avoid_: Later-visit instruction; block prompt override.

**Block result**:
An agent's explicit report of its block's state and, where applicable, a selected exit and a message for subsequent blocks. A request for corrections is distinct from an inability to perform the work.

**Final result**:
The newest accepted `finished` report for one Block activation, sent from any turn of
the Block's worker thread with its Block id. A later `finished` report for the same activation replaces it as a new
version; earlier versions stay in the Run's history unchanged. Acceptance and the worker thread being finished are
separate facts. It is a Block's result, never the Run's outcome; see Run result.

**Run coordinator**:
Retired. Factory no longer saves a model selection for a primary Run conversation. A closed Run may still display one when it was stored before this contract.

**Run conversation**:
Retired as the way a Run starts. Factory launches each Agent Block as its own top-level worker. A closed Run may still show a historical primary conversation.

**Worker**:
The top-level T3 thread Factory launches for one Agent Block, with the Block's task, when the Block is first reached; no thread exists for a Block before then. It performs that Block's task, receives the user's replies in the same thread, and reports through `factory_update_block` with its Block id from any turn. Its T3 thread title reflects the Run title and the Agent Block that launched it. Two Blocks that share an Agent have separate workers. A Continuation's prompt is a later task in the same thread, reported with the Continuation's own Block id. Its completed turn alone does not establish a completed Block; see Worker thread finished.

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
The identifier Factory mints for an Agent Block or Continuation when a Run starts and states in every launch, visit, Continuation prompt and Request report message to the worker that works the task. Factory MCP tools take it to read the Block and its Run and to update the Block; a report naming it applies to the Block's current activation. It is stable across visits and is not the Flow block's id.
_Avoid_: tool ref, caller correlation.

**Factory MCP**:
The MCP server a Factory server serves at `/mcp` on its host-local listener. Harnesses register it once by URL. Its Block runtime tools are `factory_get_block`, `factory_get_run`, `factory_get_run_image`, `factory_get_condition_arrivals` and `factory_update_block`; its [authoring tools](docs/t3-integration.md#authoring-tools) list, read, create, save and remove Agents and Flows, check Flow readiness and read Agent capabilities without a Block id, and its [Run Start tools](docs/t3-integration.md#run-start-tools) find a conversation's Project and start a text-only Run, and its [Trigger tools](docs/t3-integration.md#trigger-tools) list, read, preview, create, save, enable, disable, check and remove Triggers. An application update changes its tools without changing harness configuration.
_Avoid_: bridge (the retired stdio copy installed per harness).

**Block activation**:
One accepted task at a Flow block, from its launch or visit message until its result is completed. Reports naming the Block id apply to the Block's current activation, whichever turn of the worker thread sends them.

**Needs input**:
Pending questions or decisions on a Run. This covers Human occurrences answered in Factory and native T3 questions or permissions, which stay Open in T3, and an Agent idle with its visit's report still `working`, which the owner reviews in T3 without an attention matter (Factory never parses chat). On a block it replaces Working or Waiting in the status badge.

**Conversation waiting**:
A retired, non-final `waiting` report with which an Agent once asked the user in chat. Factory now refuses it; recorded ones stay readable as history, and an upgrade turned pending ones into Working reports.

**Working report**:
An explicit, non-final `working` report an Agent sends when it starts its Block activation's task, or reopens it. It carries a message shown on the Block and in its Run row, selects no exit, releases no handoff and is not attention. It stays current across later turns of the activation, including questions to the user, their replies and waits for CI or review, so a finished worker thread raises no missing report. A later working or finished report replaces it.
_Avoid_: progress report, heartbeat.

**Problem**:
A pending execution, report, integrity or settlement issue already recorded as attention: a missing report, an execution failure, a report problem, a Condition integrity Problem, which only manual settlement or Archive settles, or **Settle could not stop workers** when a confirmed manual Settle is unresolved. The settlement Problem is about the Run rather than one Block, and is distinct from the execution failure that stopping never raises. A Problem is distinct from block execution state and from stale or unavailable observations.

**Inbox**:
The set of Run attention matters awaiting a response or action. Factory presents pending and settled matters on the Run they belong to. There is no separate global Inbox. The desktop Dock badge and the Run list's **Needs you** filter count and list Runs, not matters, and are not an Inbox.

**Runner**:
The executor of a flow's declared transitions and conditions. Agent results determine which permitted path it follows.

**Skill**:
A packaged workflow or set of instructions guiding an agent's work.

**Task**:
A concrete matter to work on within a project, such as a coding change, an idea to discuss, or a specification to investigate. Each Start creates a new Task for its Run; Tasks recorded by earlier releases can still hold several Runs.

**Run**:
One execution of a selected flow for a task in a project, with its own editable title
and global navigation entry. Its **Run number** is a global sequence assigned at Start,
shared with worker thread titles and worktree branches; stored history may have no number.
Its **title provenance** records how the title was chosen: **automatic** (the prompt's first
non-empty line), **manual** (chosen by the owner; Rename sets it), **generated** (a
**generated title** was applied) or **legacy** (the Run or its Start
request predates provenance). Start records the provenance it is given; it is never inferred
by comparing title text.

**Run title generation**:
An installation-level step outside any Flow that may give a new Run a short title written by a
T3 model; it is not a Block, worker or Flow step. The host-only setting **Generate Run titles**,
off by default, names a T3 provider instance, model and options. Start decides once, at
acceptance: a Run with automatic title provenance accepted while the setting is on captures the
model, options, built-in prompt version and a deadline 30 seconds after acceptance, and its
generation is **pending**, or **skipped** when an eligibility check fails (recorded as the setting's
latest **diagnostic**) or the prompt has no meaningful text. Manual and legacy Runs record none.
Later setting changes affect only future Runs, and there is no regenerate. A pending generation
launches one top-level **title thread** in the Project checkout beside the Flow, never gating it,
after rechecking eligibility. It ends in exactly one outcome: **applied**, **dropped** by a
Rename, **timed out** at the deadline, **cancelled** by Archive or manual settlement, or
**failed** when the launch is rejected or the thread finishes without a title; a timeout or
failure also becomes the setting's latest **diagnostic**. Factory then stops and settles the
title thread best effort. A restart never launches it twice. The Run shows
the generation on its Flow input card and timeline, with the Run, not a Block, as the actor.

**Generated title**:
The Run title a title thread submits through `factory_set_run_title` with its generation's opaque
capability: one trimmed line of at most 120 code points without control characters, never
shortened. The first valid one while the Run's title provenance is still automatic is applied,
makes the provenance generated and is final; it is not Run activity.

**Captured definitions**:
The Flow revision a Run started with and the Agent revision of every Agent that Flow references, frozen at Start. Every read and later activation of the Run uses them; later saves and removals affect only future Runs.
_Avoid_: Run snapshot.

**Run timeline**:
The chronological record of a Run's execution events, including block activity, handoffs, human-attention events, stopping workers for a manual settlement, settling, returning to Active, and archiving. Each Run has its own timeline, distinct from conversations in its T3 threads. Its default **Key events** view collapses repeated T3 status observations of a Block into one row; **All events** shows every entry.

**Run activity**:
A meaningful change in a Run's work, such as an accepted Agent report, an execution change, a new Needs input matter or an answer to a Human step. Viewing or renaming a Run and observing an unchanged state are not Run activity.

**Execution canvas**:
The read-only view of the Flow revision a Run captured at Start. Each block shows its recorded execution state, and the same block is updated when work visits it again. Needs input and Problem are separate indicators. Pan, zoom and fit do not edit the Flow, and configured connections stay visible without implying they were traversed.

**Run inspector**:
The one panel docked beside the Execution canvas. It shows the **Run overview** (Run-level facts such as attention, progress, the Flow input and work periods) until a block is selected or the Run title is inspected; it then shows that block, or the Run title's generation, which is not a block selection. Esc or **Overview** returns it to the Run overview. Whether it is shown is a per-viewer preference, independent of what is inspected.
_Avoid_: Run context, block details card

**Run status**:
A Run's work state as its sidebar row and blocks show it: Needs input and Problem on the row, Working, Waiting, Needs input, Problem, Finished or Stopped on each block. The Run detail header carries no work state; it names only a Settled or Archived lifecycle, or Idle.
_Avoid_: header pills, Run state badges.

**Not live**:
An Active Run whose observations are stale or whose live delivery is unavailable, so the screen may be out of date. It is shown with Factory's last observation time and only while it applies; it is not a Problem.
_Avoid_: Last known as a separate marker.

**Flow input**:
The data supplied to a particular flow execution: the required prompt text entered when starting a Run, with any attached images. Every Agent block connected to the Flow input block receives the text and the same original images with its first message, each in its own independent session; image references in the text read `[Image N: name]`.
_Avoid_: Initial input, initial prompt as a separate concept

**Flow input block**:
The single, always-present Flow block representing the Flow input. It has one unnamed output and no input; the Agent blocks it connects to are the ones that start a Run, independently and in parallel.
_Avoid_: Start block, entry, entry Agent

**Finish block**:
The single, always-present Flow block on which the author declares the Flow's endings, placed right of the other blocks by default. It cannot be removed, has the fixed label Finish, has no worker and no exits, and the Flow input never connects to it. A Flow with no endings keeps its unconnected exits as its only branch ends.
_Avoid_: End block, Join block, terminal block

**Ending**:
One declared way a Flow can end, in the Finish block's ordered list: a stable id, a name, an optional description and an output setting (None, Optional or Required) with a description of the expected output. Wires from any exit or output, Condition Otherwise included, enter a specific ending by its id, so renaming keeps them; several wires may enter one ending. A blank, duplicate or unwired ending is a readiness gap. An ending is not a Block exit, and an unconnected exit is not an ending.
_Avoid_: outcome, result type, terminal exit, End

**Run result**:
A Run's one accepted outcome: the first released delivery into an ending that the Run accepts. It records the ending with its captured name, the delivered text exactly (none for an ending whose output is None), whether a Required ending got blank text (Output missing), the source block and exit or output, the block that wrote the text (a Human step for its answer, also after forwarding), worker provenance, the delivery and the acceptance time. It is never changed by a later report and is kept through Archive. A Run with no endings, or one that ended without reaching one, has no Run result.
_Avoid_: Final result (a Block activation's result), Run output, Finished

**Authorization context**:
A durable Factory reference binding accepted work to one T3 endpoint, OAuth grant
lineage and environment. Reconnection and refresh preserve it; changed grants,
endpoints or environments create another context. A matching reference is a
necessary recovery check, not proof of execution readiness or retry retention.

**Archived**:
The final Run lifecycle state, set when the user archives a Run after confirming. Archiving closes the handoff gate, cancels unsent launches, handoffs, Human occurrences and Wait arrivals and asks T3 once to interrupt each worker thread, without waiting for confirmation. An Archived Run leaves navigation for good and keeps all its data; reports for it are acknowledged as a success that changes nothing. Archive does not undo repository changes.
_Avoid_: Stop and Stopped (the retired confirmed-termination outcome).

**Handoff**:
An accepted delivery from a block's selected exit to one connected recipient.
It is held until the source worker thread is finished and no execution failure is
pending on that Block; acceptance alone does not start work. A held handoff is cancelled when its Final result is
replaced before release. Each recipient and repeated arrival proceeds independently, using the routing rules of the Run's captured Flow revision.

**Handoff gate**:
A Run's switch that permits releasing Handoffs, forwarding Wait arrivals and dispatching new work. It is open from Start; a confirmed manual settlement, Archive and accepting the Run result close it for good, and automatic settlement leaves it open so owed Handoffs are still delivered.
_Avoid_: Treating Settled as a closed gate.

**Run generation**:
A counter on each Run that its state transitions advance. An operation that read the Run and then called T3 commits a dependent change, such as releasing a Handoff, only while the generation it read is unchanged, so a concurrent report or lifecycle change is never overwritten.
_Avoid_: Confusing it with Run title generation or a Chat control conversation's generation.

**Lane**:
A per-Run queue in the backend that runs one operation at a time. The Run store's **mutation lane** serializes a Run's state transitions; the Runner's **drive lane** serializes its observe and dispatch passes across T3 calls. Lanes order work within one backend process and are not persistence guarantees.

**Human occurrence**:
One arrival at a Human step within a Run, with its own pending context and settlement. An occurrence from an Agent result activates only after that result is released; it has no T3 session. Answering or cancelling one occurrence does not settle another arrival.

**Work period**:
One T3 run of a Block's worker thread, including repeated visits, queued turns, user replies and automatic continuations after delegated or background work. Closed Runs may also show work periods of a historical Run conversation.

**Settled**:
A Run lifecycle state for work that is done. A Run settles automatically when every
visited Block has its Final result with no later working report, every Human
occurrence is answered, no Wait arrival is pending, nothing is owed or pending and every
worker thread is finished; any accepted report from one of its Blocks then returns it to
Active, while chat without a report does not. The user can also settle an Active or Snoozed
Run by manual settlement, which ends its automatic work for good. A Run that reaches an ending
stops and settles the same way with reason `finish`, without a dialog, and never returns to Active. Navigation groups Settled
Runs together. On a Run, settled attention matters no longer await attention and keep
their appearance and settlement times and reasons; settling attention does not settle the Run.
_Avoid_: Finished (the retired permanent outcome).

**Manual settlement**:
The user's Settle of an Active or Snoozed Run. It settles at once when fresh T3 reads
confirm every bound worker thread finished; otherwise the user confirms stopping every
worker. A confirmed settlement closes the handoff gate, so no Wait arrival is forwarded,
asks T3 to Stop each unfinished worker thread and settles only once fresh reads confirm
every worker finished. Until then the Run stays Active and its settlement is **stopping**,
or **unresolved** with the affected workers and a retry. Settling cancels owed automatic
work, pending Human occurrences and pending Wait arrivals without inventing answers,
settles pending attention as `manual-settlement` and shows unfinished Blocks as stopped. Later reports change nothing and never return the
Run to Active. Reaching an ending runs the same confirmed path, authorized by the Flow, and records
`finish` instead of `manual`, also on pending attention.
_Avoid_: Stop Run, Stopped, pause, Resume (none exist; an unresolved settlement is not a lifecycle state).

**T3 thread settlement**:
T3's presentation state for a conversation whose current work is complete; the
same conversation can return to the active list when it receives new work.
Factory best-effort settles a worker thread once its Block's `finished` result is
current and the worker thread is finished, while the Run may still be Active, and
at Run settlement for any thread not settled earlier. At most one request per
thread and T3 run; Factory never unsettles. Independent of attention settlement.

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
The full-page launch surface for choosing a Project, a Flow that may start there (a
global Flow or a Flow owned by that Project) and the required initial prompt, with optional attached images. Its Flow
picker offers no Flow until a Project is chosen, and a Flow that no longer fits the Project is cleared silently, keeping
the prompt and images. It edits one Run draft at a time and opens a fresh composition from
New Run only; opening it does not start execution. Start always uses
the current saved Flow and Agent definitions.

**Run draft**:
A client-local composition saved in browser storage while its prompt has a
non-whitespace character or it has an image: the exact prompt text and images, Project/Flow
references, title, title provenance and creation time. Its provenance is automatic until it is renamed, then manual;
a draft or pending Start saved before provenance existed submits legacy. A draft with images but no text cannot Start. It has no Task, Run or captured revisions until Start is accepted, which removes
it; the Run keeps its title, title provenance and creation time. Not to be confused with an unsaved Flow draft in Studio.

**Request report**:
An explicit user operation starting one additional Agent turn on the same thread
to assess existing work and submit its report. It applies to an idle Agent Block
without a Final result for its current activation, such as one with a missing
report or one whose latest report is a Working report. A durable recovery link
connects that new execution to the idle run it assesses and to the missing-report
obligation pending for that run, if any. Successful recovery settles the obligation
without fabricating an earlier report or erasing an engine failure.

**Trigger**:
A saved rule that starts Runs without someone composing them. A **GitHub Issues** Trigger, the only kind, belongs to one host-local Project and that Project's confirmed GitHub repository, and starts its Flow once for each open issue matching its GitHub issue query, oldest first, up to its **Max active Runs**, on a schedule or when **Run** is chosen. Each check reads GitHub with the host's `gh` login, involves no model and never writes to GitHub; each Run starts through the same Start as New Run with a fixed initial prompt Factory builds. Its kind is fixed at creation. A Trigger keeps only its latest check and current problem, never an issue list or check history; a problem puts it in **Error** without disabling it. See [Starting from a Trigger](docs/runs.md#starting-from-a-trigger).
_Avoid_: automation, webhook, schedule as the entity's name; treating a Trigger as a tracker claim or as Factory writing to GitHub.

**Ready label**:
The single positive `label:` qualifier of a GitHub Issues Trigger's query (by default `factory:ready`), which marks an issue as ready to start. The Trigger starts an issue once per labelling: while the issue keeps the label it does not start again, and adding the label again starts it again. The worker's claim removes it, as the Run's start data names it; Factory itself never removes it.
_Avoid_: trigger label, start label; treating other query labels as the ready label.

**Run origin**:
The immutable record of what started a Trigger-started Run, written when Start accepts the Run: the Trigger's name and id, the repository, the issue's number, id and URL, and its title as captured at Start. The Run shows it as **Started from**. It survives renaming and removing the Trigger, is not a claim and never reflects live issue state. Runs started any other way have none.
_Avoid_: Run–issue link or issue association in general; originating thread, which is Chat control's Discord thread.

**Chat control**:
The host-administered capability that lets explicitly allowed Discord users control Factory by
mentioning or replying to Factory's bot in allowed channels and their threads. Factory, not the
language model, decides who may act and which Projects are in scope; the model only interprets
requests through Factory's own tools. Each thread has one shared, bounded and disposable
conversation. It is Off by default, works only while the Factory backend runs, and connects to
Discord and the model provider outbound only. See [Chat control](docs/chat-control.md).
_Avoid_: Chat bot as a separate service; treating chat messages or model output as authorization.

**Originating thread**:
The Discord thread a Run was requested in through a confirmed Chat control Start, recorded when Factory
accepts the Run. It is where Factory reports on that Run, not ownership: any allowed participant may act
on any Run in a permitted Project, and an action's receipt goes to the thread it was requested in. Runs
started any other way have none, and reading or acting on a Run never adds one. See
[Chat control](docs/chat-control.md#originating-thread).
_Avoid_: Run owner; assigning an originating thread to a Run read or acted on from chat; Run origin, which records a Trigger Start.

**Status card**:
The one maintained Discord message Factory posts in a chat-started Run's originating thread.
It shows the Run's identity, lifecycle and Flow, then the captured Flow's Blocks in graph order
with their current or final state on each row. Large Flows summarize not-started Blocks first
and then finished Blocks to fit one message. Factory edits the card as Blocks and the Run change.
The card mentions nobody and omits results, report bodies and prompts. See
[Chat control](docs/chat-control.md#status-cards).
_Avoid_: Progress feed or per-event notification; treating the card's text as conversation input.

**Run notice**:
A new Discord message in a chat-started Run's originating thread. An attention notice reports new
Needs input or Problem matters. A catch-up reports such matters that accrued while Factory could
not post. A completion notice says a Run became Settled and invites a reply, once per Settled cycle.
On create, a Run notice pings the Run's requester while saved Access allows that user. Resolving
a matter edits its attention notice or catch-up in place and removes the mention. A reply to a
notice from the operating application identifies the Run for a fresh scoped read. See
[Chat control](docs/chat-control.md#attention-notices).
_Avoid_: Notices for ordinary Block transitions or Archive, replaying matters that opened and resolved
while Factory could not post, answer buttons on a notice.
