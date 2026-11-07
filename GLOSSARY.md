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

**Flow block**:
A constituent element of a flow: the Flow input block, an agent block or a human step.
_Avoid_: Puzzle as the canonical name; agent when referring to all block types.

**Agent**:
A reusable worker definition consisting of a prompt and execution settings, independent of a particular project. An agent block uses this definition within a Flow; its execution belongs to a Run.

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
The first accepted `finished` report for one Block activation under the explicit
MCP contract, attributed to its exact worker execution. It is immutable; acceptance and source execution completion are
separate facts.

**Run coordinator**:
Retired. Factory no longer saves a model selection for a primary Run conversation. A closed Run may still display one when it was stored before this contract.

**Run conversation**:
Retired as the way a Run starts. Factory launches each Agent Block as its own top-level worker. A closed Run may still show a historical primary conversation.

**Worker**:
The top-level T3 thread Factory launches for one Agent Block. It performs that Block's task, receives the user's replies in the same thread, and reports through `factory_update_block`. Two Blocks that share an Agent have separate workers. Its completed turn alone does not establish a completed Block.

**Block activation**:
One accepted task at a Flow block, spanning its exact worker Work periods until its result is completed.

**Needs input**:
Pending questions or decisions on a Run. This covers Human occurrences answered in Factory, native T3 questions or permissions, and conversation waiting reports; the last two stay Open in T3. It is not an execution state.

**Conversation waiting**:
An explicit, non-final `waiting` report from an Agent that asked the user in chat and needs the reply. It carries a message for the user, selects no exit and releases no handoff. The user replies in the same T3 thread; that reply turn takes over and reports for itself. It is neither a Final result nor a Human step.

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

**Run timeline**:
The chronological record of a Run's execution events, including block activity, handoffs, human-attention events, and closure. Each Run has its own timeline, distinct from conversations in its T3 threads.

**Execution canvas**:
The read-only view of the Flow snapshot saved with a Run. Each block shows its recorded execution state, and the same block is updated when work visits it again. Needs input and Problem are separate indicators. Pan, zoom and fit do not edit the Flow, and configured connections stay visible without implying they were traversed.

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

**Stop**:
The user's request to close a Run's handoff gate and reconcile cancellation of queued work and interruption of active executions. The Run closes as stopped only after fresh observations confirm termination; Stop does not undo repository changes.

**Handoff**:
An accepted delivery from a block's selected exit to one connected recipient.
Under the explicit contract it is held until fresh source completion and clear
queue/native evidence permit reservation; acceptance alone does not start work. Each recipient and repeated arrival proceeds independently, using the Run snapshot's routing rules.

**Human occurrence**:
One arrival at a Human step within a Run, with its own pending context and settlement. Under the explicit reporting contract, the occurrence activates only after the source completion gate permits release; it has no T3 session. Answering or cancelling one occurrence does not settle another arrival.

**Work period**:
One exact T3 execution in a Run or Block conversation, including repeated visits and queued turns. The Run conversation and worker conversations retain separate ownership scopes.

**Settled**:
In Run navigation, the group of executions with confirmed whole-Run Finished or
Stopped closure. On a Run, matters that no longer await attention retain
their appearance and settlement times and reasons; attention settlement does not
by itself establish Run closure.

**T3 thread settlement**:
T3's presentation state for a conversation whose current work is complete; the
same conversation can return to the active list when it receives new work.
It is independent of Factory Run closure and attention settlement.

**Snoozed**:
Durable presentation for an open Run set aside from the main navigation list.
Execution continues. New actionable attention can wake it; manual Restore returns
it without Woke. Confirmed closure always moves it to Settled.

**Woke**:
An unseen presentation marker showing that new attention returned a snoozed Run
to the main list. Opening clears only this marker, leaving Needs input and Problem
pending. Resnoozing accounts for existing attention identities so they cannot
repeatedly wake the same Run.

**Run closure**:
The permanent local confirmation of a Run's finished or stopped outcome, backed by a recorded observed frontier and an unchanged local generation. It is not an atomic cutoff of later T3 activity or a quality guarantee.

**Run composer**:
The full-page launch surface for choosing a Project, global Flow and required
initial prompt. It edits one Run draft at a time and opens a fresh composition from
New Run or a Flow's Start Run; opening it does not start execution. Start always uses
the current saved Flow and Agent definitions.

**Run draft**:
A client-local composition saved in browser storage while its prompt has a
non-whitespace character: the exact prompt, Project/Flow references, title and
creation time. It has no Task, Run or snapshot until Start is accepted, which removes
it; the Run keeps its title and creation time. Not to be confused with an unsaved Flow draft in Studio.

**Request report**:
An explicit user operation starting one additional Agent turn on the same thread
to assess existing work and submit its report. A durable recovery link connects
that new execution to an earlier missing-report obligation. Successful recovery
settles the obligation without fabricating an earlier report or erasing an engine
failure.
