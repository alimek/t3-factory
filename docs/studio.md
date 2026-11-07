# Studio

Studio is the modal authoring surface for global Flows and reusable Agent definitions. It opens over the current Run or the Run composer and leaves that screen mounted, so closing it returns
there with its draft intact. The Studio icon sits just before Settings in the Run sidebar footer; Settings holds connection, Agent reporting and keyboard preferences and does not list Agents.

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

The Flow editor's **Start Run** leaves Studio and opens the composer with that Flow selected. Direct Studio links remember the last Run or composer and restore it on close, also when browser storage is
unavailable; a fresh session opens `/runs/new`. `/settings` and `/settings/connection` open the connection dialog and `/settings/skills` redirects to `/studio/flows`. Routing is described in
[Application foundation](foundation.md#ui-routes).

## Keyboard shortcuts

The [keyboard shortcut reference](keyboard-shortcuts.md) describes the command palette, Settings, New Run and canvas bindings. Defaults can be changed in **Settings → Keyboard shortcuts**.

While Studio or Settings is open, the Run composer and detail underneath are **inert** so hidden forms get no shortcuts. Escape closes only the topmost layer (palette, nested dialogs, block
configuration, then Studio). Switching from a dirty Flow by shortcut or palette uses the same Keep editing / Discard changes guard; opening Settings from a clean Studio closes Studio. Palette
navigation stays available while catalogs load or fail (errors name the section and offer Retry). Shortcuts match exact platform modifiers, ignore repeats, consumed events and IME composition,
and follow the printed key on Latin layouts (Dvorak, AZERTY), falling back to the physical key only for dead keys or non-Latin characters.

## Agent definitions

Open **Studio → Agents** (`/studio/agents`) to create, edit or duplicate reusable definitions; an existing one opens at `/studio/agents/:agentId` and a new one at `/studio/agents/new`. A
definition stores a name, plain-text prompt, T3 environment, provider, model and thinking options. There is no runtime-mode, permission, tools or exit field: exits belong to Flow blocks and T3
chooses launch defaults. Definitions are global and Runs supply project context.

A persistent 300 px list sits beside the editor with **Search Agents**, **+ Add agent**, runtime summaries and counts of distinct saved Flows using each Agent (excluding Run snapshots and unsaved
drafts); narrow screens stack list and editor. The header shows name, revision, **Duplicate…**, **Delete** and **Save** (**Create Agent** for a new one). Leaving an edited Agent asks to **Keep
editing** or **Discard changes**; a retained Flow draft keeps its own guard.

**Worker settings.** Studio exposes one **Worker** execution selection: choose the environment first, then provider, model and thinking options from live T3 capabilities
(`orchestrator_capabilities`) for that environment, never a Factory allowlist. When T3 is unavailable saved settings stay visible as unknown or unavailable and nothing is substituted.
Availability is separate from verified execution support. Omitted thinking-option lists use defaults; malformed lists are rejected. Factory launches each Block worker with these saved settings
([Run execution](runner.md#current-execution-contract)); the API's `execution` field holds the worker settings and `settingsStatus` their availability.

**Saving.** Accepted saves increment the revision; a stale save returns a conflict and keeps local edits. Duplicate creates a variant with a new identity from the saved revision, so save edits first.
A save response arriving after leaving refreshes the list without reopening the editor. Mention skills directly in the prompt (for example `$review-code`); there is no skill field or interpolation.

**Deleting.** **Delete** confirms by name, is permanent and rejects Agents referenced by any saved Flow; the backend checks saved graphs at deletion time even if the usage count is stale. An unsaved Flow draft
may still reference a removed Agent and needs repair before running. Run snapshots and history are intact, and deleting an absent definition succeeds.

See [T3 integration](t3-integration.md) for authorization and capability reads.

## Flow authoring

Open **Studio → Flows** (`/studio/flows`), choose **New Flow** and save a name; the editor opens at `/studio/flows/:flowId`. All Flows are global: project selection never
filters or assigns them, and no connection or project is needed to author. Block and exit IDs, positions, graph, name and revision persist across restarts.

### Canvas and block configuration

The editor has a block library on the left (**Human step** and saved Agent definitions; **Search Agents**, **Collapse**/**Expand library**) and the canvas. Add a block with the row's
**Add** action or drag the row onto the canvas (a ghost shows the drop position; dropping elsewhere adds nothing); undropped additions fill a three-column grid right of the Flow
input and are selected. Drag a block's header or edit its X/Y fields; wires follow live and the draft changes once, on drop. Escape cancels any drag.

Selecting a block (click, or focus + Enter) opens **Block configuration**, a panel floating over the canvas's right edge. It renames the block, chooses its saved Agent, edits exits
and links to the Agent definition. Prompts and execution settings belong to the Agent; blocks have no overrides (create or duplicate an Agent for a variant), and two blocks may share a
definition. Clicking empty canvas, **Close block configuration** or Escape closes the panel. Blocks show kind, Agent, an input port and one port per exit; wires carry `exit → recipient`
labels, and multiple incoming connections each anchor to their own input port (Flow input first, at least 18 px apart).

Every Flow has one **Flow input block** (**FLOW INPUT** / **Flow input** / **Run prompt**) at the top left: one output port, no input, exits or configuration, and it cannot be removed. The
Agent blocks it connects to start a Run, each with the same prompt in its own session; no block is marked "entry".

**Connections.** Drag from an exit's output port (right edge dot) onto any block, including earlier blocks and the source itself; an exit may connect to many recipients (independent
fan-out; there are no Join or End blocks). A dashed preview snaps to the highlighted target's input port and the draft changes once on a valid drop; dropping on empty canvas, the port
itself, an already connected block or pressing Escape changes nothing. Drag from the Flow input port (**Connect Flow input**) the same way; only Agent blocks are valid targets. Ports
take no keyboard focus. Click a wire or its label to select it (the block panel closes); each wire is also a keyboard button (**Connection *exit* from *source* to *target***). With a
connection selected, Delete/Backspace (outside form controls) or the **Delete connection** button removes it. Removing a block or exit removes its connections.

**Add exit** offers completion, assessment ok/fail and custom presets with editable names and descriptions. **Outcome** and **Require correction feedback** carry the semantics, never the
name; assessment fail always requires non-empty feedback. A single-exit Human step can Continue without text, multiple exits need an exit choice, and an unconnected exit ends that branch.

### Automatic layout and canvas view

**Auto-arrange** lays out the draft left to right (Flow input leftmost, correction edges returning left, including disconnected blocks and loops, with orthogonal routes) and fits the
result. Progress is shown; an error, the 15-second limit, an edit or a drag leaves the draft intact. Positions are draft changes persisted by **Save Flow**; routed wires are transient and recomputed
on load only when the saved positions can be preserved, so blocks never move on reload. Manual edits return to normal wire paths.

The canvas shares its view controls with the Run canvas: scale 20%–200%; **+**/**−** zoom around the viewport center and **0** fits (bare keys leave browser zoom alone; bindings in
[Keyboard shortcuts](keyboard-shortcuts.md)); pinch or **Mod**+wheel (Command on macOS, Control elsewhere) zooms at the pointer, including Safari pinch; plain scroll, arrow keys and dragging
empty canvas pan. Drag, drop and wire gestures follow the zoom level. The view fits on load and container resize but is preserved across edits and selection; explicit Fit reserves space for an open
inspector. Zoom and pan never change saved positions.

### Saving and readiness

**Save Flow** accepts structurally valid incomplete graphs, increments the revision and shows **Saved** separately from readiness. There is no autosave or undo/redo. **Check readiness**
validates the draft through the backend without saving and is cleared by any change. The summary sits at the canvas's top-left and its issue list can cover the Flow input until collapsed. Actionable
issues: a Flow input connected to no Agent, a missing Agent reference, block/exit names, exits and unreachable blocks (selecting one inspects its block). **Graph ready** covers graph requirements only; live
connection, Agent settings availability, project and reporting installation are separate Start gates ([Runs](runs.md)).

A stale save returns a conflict and keeps local work. **Compare latest revision** shows both drafts: choose the latest saved Flow to discard local changes, or reconcile and **Keep local draft against
revision N** (another explicit save, which can conflict again). There is no automatic merge or silent overwrite.

### Removing a Flow

**Remove** in Flow details permanently deletes the editable definition (no archive) after a confirmation that names the Flow, says existing Runs remain and warns about unsaved changes. Success returns to
the Flow list, also when another view already removed it. Runs, their snapshots, shared Agents and T3 threads are unaffected: active Runs continue, settled Run canvases use their snapshots, and
removal is not Stop. Deletion needs no revision match; a save that reaches a deleted Flow errors, keeps the local draft visible for copying and never recreates it. New Runs cannot select a removed
Flow.

## Validation contract

`PUT /api/flows/:id` and `POST /api/flows/validate` take
`{name, expectedRevision, graph}`. Factory does not save a Run coordinator on the Flow.

### Graph shape

Blocks have stable IDs, position, name, exits and an Agent reference or Human kind; exit IDs are scoped to their block.
Connections identify source block, exit and target block. Outcome and explicit `requiresFeedback` are independent of the display name; assessment-fail requires that
flag, and runtime consumers enforce non-empty feedback when it is true. No block execution settings or prompt overrides are accepted.

#### Flow input block

Every graph carries exactly one `flowInput`: a canvas `position` and the `targetBlockIds` of the Agent blocks it feeds (each at most once). It has no work execution state. Targets are distinct Agent blocks; Human targets are rejected. A new Flow has no Flow input targets; removing a block also removes its target reference. Reachability starts at every Flow input target. Initial activations are independent, are not Handoffs and receive the same prompt; a failed or uncertain activation creates its own Problem while other branches can continue.

### Validation

Structural failures return `Result` errors with `code`, `path` and `message`: invalid or duplicate IDs and names,
positions, Flow input targets, dangling or duplicate edges, malformed exits, weakened assessment-fail semantics and unknown block, graph or Flow input fields. Limits: 500 blocks, 100
exits per block, 5000 connections, coordinates −10000 to 10000, bodies up to 2 MB.

Unfinished names, unset Agents, an unconnected Flow input and empty exits can be saved. Readiness reports these gaps (`flow_input_required`: connect the Flow input to at least one Agent),
missing saved Agents and blocks unreachable from the Flow input. A terminal exit needs no edge; cycles, self-loops and independent fan-out are allowed. Graph readiness does not claim T3
capability or live execution readiness.

### Revisions and snapshots

An update compares the expected revision atomically: a stale request returns `conflict`
without mutation, and an accepted save advances the revision exactly once. Agent references
are resolved against saved definitions. Graph and coordinator shapes follow the
[stored-data migration rules](foundation.md#sql-migrations). Start captures the selected
graph and referenced Agents; Auto-arrange and input-port presentation do not change
validation semantics. [Removing a Flow](#removing-a-flow) leaves Run snapshots intact.
