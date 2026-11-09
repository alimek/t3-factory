# Studio

Studio is the modal authoring surface for global Flows and reusable Agent definitions. It opens over the current Run or the Run composer and leaves that screen mounted, so closing it returns
there with its draft intact. Settings holds connection, Agent reporting and keyboard preferences and does not list Agents.

## Shell

Studio is an almost full-window dialog with a Settings-style header (**Studio / Flows** or **Studio / Agents**, an Escape hint and **Back to Runs**) and no logo. The desktop dialog leaves 48 px above
it for native window controls and 16 px elsewhere; browsers use 16 px margins (8 px when narrow). The 192 px sidebar (144 px narrow) has an **AUTHOR** group with **Flows** and **Agents**, each with its
definition count. Studio and Settings share a short opacity-only transition that reduced motion disables; the underlying sidebar title area stays mounted.

The current Flow draft survives navigation to the lists and Agents; closing Studio or opening another Flow with unsaved changes asks to **Keep editing** or **Discard changes** (browser Back follows the same
rule; reload uses the browser's leave warning). Agent edits are guarded independently of a retained Flow draft.

| Destination | Browser URL |
| --- | --- |
| Flow list | `/studio/flows` (`/studio` and `/flows` also open it) |
| Opened Flow | `/studio/flows/:flowId` (`/flows/:flowId`) |
| Agent list | `/studio/agents` (`/settings/agents`) |
| Opened or new Agent | `/studio/agents/:agentId` (`new` creates; `/settings/agents/:agentId`) |

The Flow editor's **Start Run** leaves Studio and opens a fresh composition with that Flow selected; unfinished Run drafts stay saved. Direct Studio links remember the last Run or composer and restore it on close, also when browser storage is
unavailable; a fresh session opens `/runs/new`. `/settings` and `/settings/connection` open the connection dialog and `/settings/skills` redirects to `/studio/flows`. Routing is described in
[Application foundation](foundation.md#ui-routes).

## Keyboard shortcuts

The [keyboard shortcuts](keyboard-shortcuts.md) topic is the authoritative reference for
platform defaults, customization, migration and every registry command. Canvas zoom keys
are listed there under **Canvas**; defaults can be changed in **Settings → Keyboard
shortcuts**.

While Studio or Settings is open, the Run composer and detail underneath are **inert**.
Run actions, sidebar navigation and the cheat sheet are blocked. Settings, New Run and
Studio shortcuts remain available through the existing unsaved-change guards; nested
dialogs and menus block them. **Mod+/** opens the read-only shortcuts cheat
sheet from the same registry grouping as Settings. Escape closes only the topmost layer
(palette, nested dialogs, block configuration, then Studio). Switching from a dirty Flow
by shortcut or palette uses the same Keep editing / Discard changes guard; opening
Settings from a clean Studio closes Studio. Palette navigation stays available while
catalogs load or fail (errors name the section and offer Retry).

## Agent definitions

Open **Studio → Agents** (`/studio/agents`) to create, edit or duplicate reusable definitions; an existing one opens at `/studio/agents/:agentId` and a new one at `/studio/agents/new`. A
definition stores a name, plain-text prompt, T3 environment, provider, model, thinking options and its exits. There is no runtime-mode, permission or tools field: T3 chooses launch
defaults. Definitions are global and Runs supply project context.

**Exits.** An Agent declares the exits its worker can finish with, listed under the Prompt. Each exit has a stable ID, a name, an optional description and **Message required**; names
are distinct and non-empty. A new Agent starts with one exit, `done`, which needs no message. Every Flow block of the Agent offers its current exits, so an exit edit reaches every Flow on
its next Run, while a Run keeps the exits of the Agent revision it captured. Renaming an exit keeps its ID and therefore every wire; removing a wired exit makes those Flows not ready (see
[Saving and readiness](#saving-and-readiness)). Agents saved before Agent exits existed have none: their blocks kept their former exits as Flow-local exits.

A persistent 300 px list sits beside the editor with **Search Agents**, **+ Add agent**, runtime summaries and counts of distinct saved Flows using each Agent (excluding Runs and unsaved
drafts); narrow screens stack list and editor. The header shows name, revision, **Duplicate…**, **Delete** and **Save** (**Create Agent** for a new one). Leaving an edited Agent asks to **Keep
editing** or **Discard changes**; a retained Flow draft keeps its own guard.

**Worker settings.** Studio exposes one **Worker** execution selection: choose the environment first, then provider, model and thinking options from live T3 capabilities
(`orchestrator_capabilities`) for that environment, never a Factory allowlist. When T3 is unavailable saved settings stay visible as unknown or unavailable and nothing is substituted.
Availability is separate from verified execution support. A provider without Factory reporting support (Codex, Claude, Cursor and Grok have it) stays in the provider menu
as a disabled choice marked **No Factory reporting yet**, with the reason under it, so it cannot be chosen; a saved Agent that already uses one keeps it visible with that mark. New Agents default to the first provider with reporting support; when T3 offers none, no provider is preselected and the Agent needs a supported provider before it can run. Omitted thinking-option lists use defaults; malformed lists are rejected. Factory launches each Block worker with these saved settings
([Run execution](runner.md#current-execution-contract)); the API's `execution` field holds the worker settings and `settingsStatus` their availability.

The list and editor also show the provider's [reporting installation status](t3-integration.md#agent-reporting).
The editor follows the current provider choice, explains installation problems and links to **Settings → Agent reporting**.
Installed configuration does not establish full execution readiness or live report visibility; Start still checks those gates.

**Saving.** Each accepted create or save appends one immutable Agent revision holding the name, prompt, settings and exits, and Studio shows the latest; a stale or invalid save returns an error,
appends nothing and keeps local edits. Duplicate creates a variant with a new identity from the saved revision, so save edits first.
A save response arriving after leaving refreshes the list without reopening the editor. Mention skills directly in the prompt (for example `$review-code`); there is no skill field or interpolation.

**Removing.** **Delete** confirms by name and removes the Agent from Studio, Flow references and Start selection with no restore; its saved revisions are kept and later saves to it are rejected. It
rejects Agents placed in the latest revision of any current Flow; the backend checks those blocks at removal time even if the usage count is stale, while removed Flows and Runs never block
removal. An unsaved Flow draft may still reference a removed Agent and needs repair before running. Runs keep the Agent revision they started with, and removing an absent or removed Agent succeeds.

See [T3 integration](t3-integration.md) for authorization and capability reads.

## Flow authoring

Open **Studio → Flows** (`/studio/flows`), choose **New Flow** and save a name; the editor opens at `/studio/flows/:flowId`. All Flows are global: project selection never
filters or assigns them, and no connection or project is needed to author. Block and exit IDs, positions, graph, name and revision persist across restarts.

### Canvas and block configuration

The editor has a block library on the left (**Human step** and saved Agent definitions; **Search Agents**, **Collapse**/**Expand library**) and the canvas. Add a block with the row's
**Add** action or drag the row onto the canvas (a ghost shows the drop position; dropping elsewhere adds nothing); undropped additions fill a three-column grid right of the Flow
input and are selected. Drag a block's header or edit its X/Y fields; wires follow live and the draft changes once, on drop. Escape cancels any drag.

Selecting a block (click, or focus + Enter) opens **Block configuration**, a panel floating over the canvas's right edge. It renames the block, chooses its saved Agent, lists its exits
read-only and links to the Agent definition. Prompts, execution settings and exits belong to the Agent; blocks have no overrides (create or duplicate an Agent for a variant), and two blocks
may share a definition. Clicking empty canvas, **Close block configuration** or Escape closes the panel. Blocks show kind, Agent, an input port and one port per exit, each marked **Agent**,
**local** or **fixed** and with **message** when it requires one; wires carry `exit → recipient` labels in one neutral style, and multiple incoming connections each anchor to their own
input port (Flow input first, at least 18 px apart).

Every Flow has one **Flow input block** (**FLOW INPUT** / **Flow input** / **Run prompt**) at the top left: one output port, no input, exits or configuration, and it cannot be removed. The
Agent blocks it connects to start a Run, each with the same prompt in its own session; no block is marked "entry".

**Connections.** Drag from an exit's output port (right edge dot) onto any block, including earlier blocks and the source itself; an exit may connect to many recipients (independent
fan-out; there are no Join or End blocks). A dashed preview snaps to the highlighted target's input port and the draft changes once on a valid drop; dropping on empty canvas, the port
itself, an already connected block or pressing Escape changes nothing. Drag from the Flow input port (**Connect Flow input**) the same way; only Agent blocks are valid targets. Ports
take no keyboard focus. Click a wire or its label to select it (the block panel closes); each wire is also a keyboard button (**Connection *exit* from *source* to *target***). With a
connection selected, Delete/Backspace (outside form controls) or the **Delete connection** button removes it. Removing a block or exit removes its connections.

**Exits.** An Agent block offers its Agent's exits, minus those hidden in this Flow, followed by its Flow-local exits; inherited exits cannot be edited in a Flow. Hiding exits and adding
Flow-local exits are stored with the Flow revision. **Exits from Agent** shows read-only names, descriptions and message requirements, with **Hide in this Flow** / **Show in this Flow**.
Hidden rows remain visible in the panel but are absent from worker choices and cannot start new connections. Hiding a wired exit preserves its connection and reports a readiness issue until the exit is shown or the wire removed.
Wired hidden or removed exits keep a separate, unavailable canvas endpoint marked **Agent · hidden** or **Agent · removed**, so their wires never appear to leave a usable exit.
**Local exits · only in this Flow** offers editable name, description and message-required cards and **Add local exit**. Removing a local exit removes its connections.
Changes to the saved Agent appear on the next Flow read; Flows upgraded from per-block exits show those exits as local. A Human step has the fixed, locked
exits **Approve** (message optional) and **Request changes** (message required). An unconnected exit ends that branch.

### Automatic layout and canvas view

**Auto-arrange** lays out the draft left to right (Flow input leftmost, correction edges returning left, including disconnected blocks and loops, with orthogonal routes) and fits the
result. Progress is shown; an error, the 15-second limit, an edit or a drag leaves the draft intact. Positions are draft changes persisted by **Save Flow**; routed wires are transient and recomputed
on load only when the saved positions can be preserved, so blocks never move on reload. Manual edits return to normal wire paths.

The canvas shares its view controls with the Run canvas: scale 20%–200%; **+**/**−** zoom around the viewport center and **0** fits (bare keys leave browser zoom alone; bindings in
[Keyboard shortcuts](keyboard-shortcuts.md)); pinch or **Mod**+wheel (Command on macOS, Control elsewhere) zooms at the pointer, including Safari pinch; plain scroll, arrow keys and dragging
empty canvas pan. Drag, drop and wire gestures follow the zoom level. The view fits on load and container resize but is preserved across edits and selection; explicit Fit reserves space for an open
inspector. Zoom and pan never change saved positions.

### Workspace setting

The toolbar's **Workspace** control holds the Flow's [workspace setting](../GLOSSARY.md): **Project checkout** or **New worktree**, and for a
worktree its **Base**, either **Default branch** (the Project repository's `origin/HEAD`, such as `origin/main`; no branch name is assumed across projects) or **Custom ref** (a
branch, tag or commit such as `develop`). New Flows use a new worktree from the default branch; Flows saved before the setting existed keep the project checkout. A changed
setting is part of the unsaved draft: it clears readiness and is saved, compared on conflict and retained like the graph. Studio does not check the ref, because Flows
are global; Start resolves it against the selected Project ([Runs](runs.md#starting)).

### Saving and readiness

**Save Flow** accepts structurally valid incomplete graphs, increments the revision and shows **Saved** separately from readiness. There is no autosave or undo/redo. **Check readiness**
validates the draft through the backend without saving and is cleared by any change. The summary sits at the canvas's top-left and its issue list can cover the Flow input until collapsed. Actionable
issues: a Flow input connected to no Agent, a missing Agent reference, block and local exit names, a block without exits, a local exit named like one of its Agent's visible exits (also when
the Agent adds that name later), a wire from an exit hidden in this Flow or no longer on the Agent, and unreachable blocks. Each names the block, the exit and the problem, and selecting one
inspects its block. These issues disable **Start Run**, never a save. **Graph ready** covers graph requirements only; live connection, Agent settings availability, project and reporting installation
are separate Start gates ([Runs](runs.md)).

A stale save returns a conflict and keeps local work. **Compare latest revision** shows both drafts: choose the latest saved Flow to discard local changes, or reconcile and **Keep local draft against
revision N** (another explicit save, which can conflict again). There is no automatic merge or silent overwrite.

### Removing a Flow

**Remove** in Flow details removes the editable definition from Studio and the Run composer after a confirmation that names the Flow, says existing Runs remain and warns about unsaved changes. Success returns to
the Flow list, also when another view already removed it: removing an absent or removed Flow succeeds. Runs, their captured revisions, shared Agents and T3 threads are unaffected: active Runs continue, Run canvases show the revision each Run started with, and
removal is not Archive. Its saved revisions are kept, but there is no restore. Removal needs no revision match; a save that reaches a removed Flow errors, keeps the local draft visible for copying and never recreates it. New Runs cannot select a removed
Flow.

## Validation contract

`PUT /api/flows/:id` and `POST /api/flows/validate` take
`{name, expectedRevision, graph, workspace}`. `workspace` is `{mode: "checkout"}` or
`{mode: "worktree", base: {kind: "default"} | {kind: "ref", ref}}`; a custom ref is trimmed and
must be 1–255 characters without whitespace, control characters or a leading `-`, and its
issues use `workspace.*` paths. A save that omits `workspace` keeps the saved setting. Factory does not save a Run coordinator on the Flow.

### Graph shape

Blocks have stable IDs, position and name. An Agent block adds `agentId`, `hiddenExitIds` (inherited exit IDs it hides) and `localExits`; a Human block has
no exit fields. An exit is `{id, name, description, messageRequired}`, with IDs scoped to their block; runtime consumers enforce a non-empty message when
`messageRequired` is true. Connections identify source block, exit ID and target block: a Human block's exit is `approve` or `request-changes`, and an Agent block's
exit is resolved against its Agent by readiness, not by the save. No block execution settings or prompt overrides are accepted.

#### Flow input block

Every graph carries exactly one `flowInput`: a canvas `position` and the `targetBlockIds` of the Agent blocks it feeds (each at most once). It has no work execution state. Targets are distinct Agent blocks; Human targets are rejected. A new Flow has no Flow input targets; removing a block also removes its target reference. Reachability starts at every Flow input target. Initial activations are independent, are not Handoffs and receive the same prompt; a failed or uncertain activation creates its own Problem while other branches can continue.

### Validation

Structural failures return `Result` errors with `code`, `path` and `message`: invalid or duplicate IDs and names,
positions, Flow input targets, dangling or duplicate edges, a Human connection from another exit, malformed exits or hide entries and unknown block, exit, graph or Flow input
fields. Limits: 500 blocks, 100 local exits and 100 hide entries per block, 100 exits per Agent, 5000 connections, coordinates −10000 to 10000, bodies up to 2 MB.

Unfinished names, unset Agents, an unconnected Flow input, blocks without exits, local exit name collisions and wires from hidden or removed exits can be saved.
Readiness reports these gaps (`flow_input_required`: connect the Flow input to at least one Agent; `exit_name_conflict`, `exit_hidden`, `exit_missing`), missing saved
Agents and blocks unreachable from the Flow input, resolving each block against the current saved Agents. Hide entries for exits the Agent no longer has are ignored. A
terminal exit needs no edge; cycles, self-loops and independent fan-out are allowed. Graph readiness does not claim T3 capability or live execution readiness.

### Revisions

Each successful create or save appends one immutable Flow revision whose name, graph and
workspace setting are stored as rows owned by that revision; Studio reads the latest revision of each Flow that is
not removed, and `revision` is that revision's number. An update compares the expected revision
atomically: a stale or invalid request returns an error and appends nothing, and an accepted save
advances the revision exactly once. Within a revision, connections reference blocks of the same
revision, and the Flow input targets blocks of that revision.
Agent references are resolved against saved definitions at read time, so a draft may still name a
missing Agent. Stored shapes follow the
[stored-data migration rules](foundation.md#sql-migrations). Start references the current
revision and freezes the referenced Agents' revisions; Auto-arrange and input-port presentation do not change
validation semantics. [Removing a Flow](#removing-a-flow) keeps the revisions Runs reference.
