# Starting and observing a Run

## Starting

Open **New Run (+)** (`/runs/new`; the Flow editor's **Start Run** opens a fresh composition with its saved Flow selected). Choose an
available project, a global ready Flow and a required initial prompt. Factory checks the project and connection, the graph,
every referenced Agent's settings, reporting installation and explicit-call API compatibility before accepting Start.
Failures explain recovery and keep the draft. Start collects setup problems for every referenced Agent,
including later branches, labels each cause with its Agent and offers reporting, Studio or connection
repair actions. Agent checks and launch capability inspection use the same Start preflight; no worker
is launched on rejection. For a Flow whose [workspace setting](studio.md#workspace-setting) is a new worktree, Start
resolves the base in the selected Project's repository on the Factory host: the default branch from `origin/HEAD`, or the
custom ref verified as a commit, read through bounded `git` calls without a shell. A missing ref, an unset default branch or
a T3 endpoint that is not on this computer rejects Start with a `workspace.*` issue and the **Open Studio → Flows** repair
action; no Run, Task or worker is created. Correct configuration, accepted Start and accepted Block result are separate
levels of evidence. A configuration check alone proves neither execution nor report acceptance.

- **Screenshots.** Pasting images (Ctrl+V/Cmd+V) at the prompt caret or dropping image files on the prompt field attaches
  them and inserts a clickable reference to each at the caret (a drop uses the last caret position, or the end of the
  prompt). **Attach images** attaches files without inserting references. Images are PNG, JPEG, GIF or WebP files, up to 8
  images of 1 byte–10 MiB each, sent unchanged (no recompression or resizing). The field shows thumbnails with remove
  controls; a thumbnail or reference opens a full-size preview. A reference shows the image name with its size and points
  to the attached image itself, so references to different images with the same name stay distinct. Each unsupported,
  oversized, excess or unsavable file is rejected with its name and reason; valid files and existing attachments stay.
  Identical bytes attach once: pasting or dropping them again inserts another reference to the attached image without
  using another slot. Different files with the same name stay separate images. Removing a thumbnail removes that image
  and every reference to it; deleting a reference from the text keeps its image attached and delivered. Start still
  requires prompt text: references alone do not count, and a line holding only references does not supply the automatic
  title. At Start the composer uploads every image Factory does not
  hold yet, then sends the request; Factory accepts it only with every image uploaded and attaches them to the Run in
  order. Each Flow-input worker receives the same original images with its first message, named `image-N-<name>`, and
  the Run's input text spells each reference as `[Image N: name]` in place and ends with `Attached images:` listing every
  image, referenced or not. Later Blocks, revisits and Request report turns remain text-only. Every worker, including
  during later user conversations, can discover the initial images and retrieve relevant originals through
  [read-only Factory MCP access](t3-integration.md#run-image-reads). The immutable image labels keep the same meaning
  across visits. An image Start needs a T3 that accepts uploaded
  launch attachments; otherwise it is rejected with "update T3 or remove the images" and nothing is created. Images are
  part of the Run's input and stay with it after Settle and Archive.
- **Task and Run.** Each Start creates a new Task and its Run, both named with the draft's chosen title: a manual title, or
  else its first non-empty line of prompt text limited to 500 characters. Start also carries the draft's creation time, which becomes
  the Run's creation time; the Run's start time is when Factory accepted it. Factory rejects a blank or over-500-character
  title (after trimming) or a creation time not in `Date.toISOString()` form (for example `2026-11-07T08:00:00.000Z`),
  and creates nothing.
- **Idempotency.** A draft's id is its Start request key, so one draft yields at most one Run. A confirmed rejection
  records nothing, so the corrected draft is sent again with the same key. Retrying an accepted request returns the same Run,
  even after a lost response or restart; reusing the key with changed content, including title, creation time or the
  images' bytes, order, names or positions, conflicts. An unknown response keeps the
  submitted fields and images read-only (previews still open) and offers **Check same request**, which uploads missing
  images again and repeats the same request; only confirmed success clears the prompt and opens the Run. If Factory
  reports an image missing at acceptance, the composer uploads it again and retries once automatically; a further
  failure keeps the request locked for another check.
  The submitted request is saved in browser storage before it is sent, so reloading or reopening the client during an
  in-flight or unknown Start offers the same check instead of a fresh request. It is kept with its draft, so each draft has its
  own pending request, and per selected Factory server (a desktop client never checks it against another server); it is
  removed after a confirmed acceptance or rejection. When
  storage is blocked, the unknown-outcome notice says the request survives only while the window stays open.
- **Concurrency.** Every Start creates its own Task, so Start never waits for, reuses or is blocked by another Run. Checkout
  Runs work concurrently in the shared project checkout; each worktree Run works in its own worktree. A Run stays Active, including unresolved work, until it
  [settles](#settled-runs) or is [archived](#archive).
- **Captured definitions.** The Run keeps its immutable input and references the Flow revision it started with, including
  its workspace setting, and the revision of every Agent that Flow references, frozen at Start. Every read and every later activation, also after restart,
  uses those revisions: the full graph and each Agent's prompt, settings and labels. Agent edits need no Flow save: the next
  Start uses the current saved Agents. Later edits and removals affect only future Runs.
- **Launch.** Factory launches one top-level worker per Agent block visit, using that Agent's saved provider, model and
  options. Agents connected to the Flow input start in parallel and independently (no Agent is told about the others). There
  is no Run conversation. A lost launch is searched for by its saved title and verified thread evidence; Factory does not
  launch a second worker for it. A definitive rejection is an error. Other workers keep going.
  Factory works in the Run's workspace: the project root, or for a worktree Flow one worktree that all of the Run's
  workers share ([Run workspace](runner.md#run-workspace)). It omits `runtimeMode` and leaves execution permissions to T3
  and its OAuth grant, so effective autonomy is not guaranteed by Factory. Use a repository you are willing to let agents
  change.
- **Composer.** Project and Flow choices are remembered locally per selected Factory server, like drafts. Each blocking condition is a notice with a recovery action, and
  fields that cause it are marked. The Project picker keeps searchable paths, **Recheck projects** and **Add repository**;
  unavailable references stay visible in history but cannot be selected for a new Run.
- **Drafts.** Typing a prompt with a non-whitespace character or attaching an image creates a Run draft; removing all
  text and images removes it. A draft with images but no text is listed as **Untitled draft** and cannot Start. Image
  bytes are kept in the browser's IndexedDB per selected Factory server and draft, saved before the draft refers to them;
  opening the composer deletes bytes no draft references, and discarding a draft or a confirmed Start deletes its images.
  Drafts save silently while typing, without a T3 connection or ready choices, and the current composition is restored after a
  reload or reopening the client. A draft keeps the exact prompt and Project/Flow references only; Start resolves the current
  saved Flow and Agents. Drafts live in browser storage per client and selected Factory server; tabs sharing a profile share
  them, and the last save wins, except that another tab's unresolved Start is never overwritten or removed: the stale tab
  reopens that draft instead. If storage is blocked the composer says the draft lasts only while the window is open.
  **New Run** (button, shortcut or palette) opens an empty prompt with the remembered choices and keeps earlier drafts; the
  Flow editor's **Start Run** does the same with its Flow. Project and Flow choices update live; while they are
  synchronizing or offline the last choices stay visible, the draft is kept and Start is disabled. A selected Project or Flow
  is cleared only when a current live delivery no longer lists it; a non-current or failed delivery changes nothing, and
  choosing a just-created Project or Flow waits for the delivery that lists it. Confirmed Start removes the draft and opens its Run; a confirmed
  rejection keeps it editable. A draft's title follows its first non-empty prompt line until it is renamed; a manual title
  survives prompt edits, reload and other tabs' saves, and a title or selection alone never creates a draft.

## Live viewing

The Run screen and sidebar update live, including reports, attention, timeline and
navigation membership. Shared T3 connection status and the composer's Project and Flow
choices also update live. The selected Run
and the sidebar share one view subscription; switching Runs refreshes that view with the
new Run and releases the previous one. Live updates preserve the canvas viewport and
selected Block.

Project descriptions and the comparison with the current saved Flow load on screen entry.
Edits in another window need not update those values until the Run is reopened or the page
is reloaded; the Run's Captured definitions stay unchanged.

During reconnect or **Synchronizing**, retained information stays visible and mutations
are disabled until active scopes have fresh snapshots and any catch-up those snapshots
needed, and again while a failed read is retried. The open Run and the sidebar share one
subscription and show one commit's changes together. Browsing and navigation remain
available; no command is queued for later. Hidden browser tabs and minimized or closed
desktop windows detach live delivery; returning obtains current snapshots. A visible
unfocused window keeps updating. These visibility changes never stop the Runner.
The [foundation contract](foundation.md#live-delivery) describes consistency and delivery limits.

## Execution canvas

Opening a Run shows the Flow revision it captured at Start on a read-only canvas (labelled **Flow revision**). Positions, exits,
connections and Agent labels come from the captured revisions, even after the Flow or its Agents are edited or removed or the
project is unavailable; a later edit or removal is labelled (**Flow edited since**, **Flow removed since**), never substituted.
Only a read that finds the Flow gone shows **Flow removed since**; any other failed read shows no comparison label.
A block's exits are its captured Agent revision's exits minus those the Flow hid, plus its Flow-local exits. Reports and handoffs
keep the exit they recorded; Human steps upgraded from earlier releases show their exits as **Approve** and **Request changes**, the
fixed Human exits their old exits were mapped to.

- The **Flow input** block shows the Run's truncated prompt and has no state or details panel. With images it shows up
  to three prompt lines, each image reference as an **Image N: name** chip, the first three thumbnails and a **+N** control
  for the rest. A thumbnail or **+N** opens a gallery of every image in manifest order, titled **Image N of M** with
  its name, with a full-size preview and **Previous image**/**Next image** (also the arrow keys). Ordinals and names match
  the workers' `[Image N: name]` text. The canvas chips are labels, since the truncated prompt can hide them; the context
  rail's initial prompt shows the full prompt with clickable references and every image, opening the same gallery. Settled and Archived Runs keep their images ([persistence](foundation.md#persistence-model)). Images are
  read from the selected Factory server without thumbnails or transformation. Missing or corrupt retained bytes show
  **Image unavailable** with the image's ordinal and name; the rest of the history stays readable, and a failed read is not
  retried and creates no attention or state change.
- Each work block shows its recorded state: not started, working, waiting, finished, error or stopped (the Run was archived
  or manually settled before it finished). A [Continuation](#continuations) shows **sent** or **pass-through** instead of working and finished. Several blocks can be
  active at once; the canvas marks no "current step", percentage or taken path. Repeated visits update the same block; the
  timeline and executions keep the sequence. Connections use one neutral style, including never-run branches.
- A working block whose Agent reported `working` shows that message in place of its visit time; its details show the full
  message and offer **Request report** once the worker is idle.
- A [Wait](#waits) is not started before its first arrival, waiting while any arrival is pending, with **until** and the
  nearest deadline (and the count of waiting arrivals when there are several), and finished once every arrival has
  continued. It has no worker, thread or attention.
- **Needs input** and **Problem** use the same labels as the Run sidebar, are independent of execution state and are not
  cleared by selecting a block. Stale observations say **Not live** and **Last known**; an unknown observation on a started
  block differs from stale; a block that never ran says **Not visited**.
- On entry, the view centers the combined bounds of active Blocks (`working` or `waiting`), with direct predecessors and successors visible where possible. With no active Block, it centers error-state Blocks if execution failed; otherwise it fits the whole graph. Entry zoom never exceeds 100%. Only target bounds determine zoom and center; surrounding Blocks are visible where they fit at that scale and clipped otherwise.
- The view then follows that focus: when the active Blocks change, or execution fails with none active, it glides there in about 400 ms. A successful finish leaves the view where it is. Following is on each time the Run is opened and is never saved. Manual pan or zoom (wheel, pinch, buttons, keys) or **Fit Flow** turns it off and interrupts a glide; automatic moves never do. **Follow active** in the zoom controls, or its shortcut (default **.**) while the execution canvas is focused, turns it back on and moves to the current focus (the button glides; the shortcut jumps); it is disabled when nothing is active or failed. While following is off, a focus change marks the button with a dot instead of moving the view; there are no notifications. A hidden window or a Run covered by Settings or Studio stops any glide: on return, a following view jumps once to the current focus without replaying missed changes. With reduced motion, the view jumps instead of gliding.
- Pan, zoom, fit and **Auto-arrange** are local. Zoom ranges 20%–200% (**+**/**−**, **Fit Flow**, **0**, pinch or **Mod**+wheel
  at the pointer; plain wheel and arrow keys pan; bindings are in [Keyboard shortcuts](keyboard-shortcuts.md)). Auto-arrange
  lays out left to right, changes neither the Flow nor the captured revision and resets on reload. Apart from following, live Run updates and container resize preserve the Run viewport.
- Selecting a block floats its details (visits, exits, T3 references and link, attention actions). There is no editing here.
- Drag the inner edge of the shell sidebar (224–480 px) or of the right panel beside the canvas (280–640 px; the context rail and
  block details share one width) to resize it; with the edge focused, Left/Right step 16 px and Home/End jump to the bounds.
  Double-click restores the responsive default, which a saved width otherwise replaces. Widths are saved per browser profile
  on this device.
- The top bar shows title, project, captured Flow revision, block states, each worker's **Open worker in T3** link (a pending launch says
  recovery is still searching and offers no replacement), **Archive Run** (until archived) and a ··· menu. The timeline starts collapsed; the context rail (attention,
  prompt, Flow revision, workspace, project, work periods) opens from 1280 px wide. Its **Workspace** section reads **Project
  checkout**, **Preparing workspace** with the base ref until T3 reports the worktree, **Worktree · branch · path**, or
  **Workspace failed** with the reason; an unconfirmed creator launch shows its recovery note. Retained Runs that queued a
  first visit on an idle worker prepared under the earlier contract still show **entered · prepared idle T3 thread**.
- Running worker work is ordinary progress; unavailable observations mark the Block **Not live**, preserving prior facts without creating a Problem.

Engine termination alone never settles a Run; automatic settlement needs every condition in [Settled Runs](#settled-runs).

## Run list

The shell sidebar lists Runs globally, newest created first, with equal creation times in ascending creation-key order;
opening, renaming and closing never change either. Run drafts join the main list in the same order with a **Draft** indicator once you leave the New Run view
(Settings and Studio open over it and do not count); a draft row reopens it in the composer, and editing never moves it.
A draft's creation key is its id, and its Start sends that id as the request key, which becomes the Run's creation key. With
the draft's title and creation time, the Run therefore replaces the draft row in place, also among entries created at the same
time. Runs created before drafts carried a creation time use their start time and Run id. Creation times come from the
client's clock. Active rows show the project icon and name, execution indicator and time since the last
Run activity, followed by the title. The [Run number](../GLOSSARY.md) appears as a `#N` pill after the project name in
active rows, before the title in compact rows and palette results, and first in the Run top bar meta line; Runs without a number show none.
A third line appears for known worker branches, linked PRs or attention:
one branch shows its name, several show a count, and a PR icon shows the number of distinct linked PRs.
Branches and PRs are independent; neither requires the other and missing data has no placeholder or Flow fallback.
The age advances from execution changes, accepted reports, Human answers, attention appearing, handoff release
and settling or returning to Active, not unchanged observations, viewing or renaming. It does not change creation-based ordering.
Missing projects keep readable history; an unavailable open Run stays open.

Hovering or focusing a row opens one information card to the right, aligned to the row and constrained to
the viewport. It shows the full title, project, captured Flow, execution/attention, working messages and known
repository metadata, even when the title fits. Opening a row menu dismisses and blocks the card; hovering
menu items never opens a row preview.

- **Needs input**: a pending Human occurrence or native T3 question/permission.
  **Problem**: a pending missing report, execution failure or report problem. Both can show. Stale observations or an unavailable
  project are not Problems and opening a Run clears no chip.
- **Settled** (collapsed, with a count) holds Settled Runs as compact single-line rows with just their project icon and title; details remain in the side preview. **Snoozed** sits above it. Each group appears only after navigation loads and while it contains Runs; hiding it preserves its expanded state. Archived Runs are not listed.
  Case-insensitive title search shows one list of matching Runs and drafts in creation order, with a total match count and no group headers. Snoozed and Settled matches have muted titles and status icons unless selected. Drafts are titled from the first non-empty prompt line, or **Untitled draft**; Escape or × clears search.
- When Runs exist but none are open, the open list shows **Nothing open** / **You're all caught up.**
  Snooze and Settle focus the destination group toggle after it appears. Restore focuses the restored row; during search, all three actions keep focus on that row.
- **Rename** changes that Run's or draft's title only (trimmed, non-empty, ≤500 characters); renaming never moves a row.
  The same shadcn/Radix row menu serves desktop and browser clients. Right click opens it at the pointer;
  Shift+F10 and the context-menu key anchor it below the focused row. Touch devices retain a ⋯ button;
  mouse layouts omit it. Closing the menu or Rename/Archive dialogs returns focus to the row when it remains visible. Rename
  in the menu shows the current binding from the shortcut registry (default F2). With a Run open in detail, the same
  **Rename Run** command runs from that binding; customization is in [Keyboard shortcuts](keyboard-shortcuts.md).
  Keyboard **Snooze or restore**, **Settle** and **Archive…** apply to the open Run under the same availability rules as
  these menu items and show registry hints on tooltips where present. Active and Snoozed rows offer Snooze or Restore and
  **Settle**; every Run row offers **Archive…**. Draft rows offer Rename and
  **Discard**, which removes the draft from this browser at once without confirmation; discarding the open draft leaves an
  empty composition with the same choices. While a draft's Start is in flight or its outcome is unknown, both are
  unavailable: the draft keeps its exact request until **Check same request** settles it.
- An automatically Settled Run returns to Active only when one of its Agents reports; a manually settled or Archived Run is
  never reopened or relaunched. To work on the matter again otherwise, start a **New Run**: it uses the current saved Flow and Agent definitions, not an earlier
  Run's captured revisions.

### Branches and pull requests

Repository information is last known metadata from the Run's bound worker threads in T3. A Run can have
several branches and PRs; the same PR linked to multiple workers counts once. Branch names describe the
workers' T3 workspace metadata, not exclusive ownership of a branch by the Run. Factory does not infer
associations from conversation text or the project's current checkout, and it does not create or switch branches.

The side preview and Run context show the full branch list with the corresponding worker names and the
distinct PR list. The Run context links to those PRs; their states are last known in T3, not live GitHub checks.
Normal worker observations update the metadata; metadata-only changes affect neither the activity age nor list order. If an
observation fails, retained metadata stays visible as Not live. Settled Runs keep their recorded metadata;
expanding their group or hovering a row does not start background work or refresh T3. Older Runs have no
repository metadata until their workers are observed by this version.

### Snooze and Woke

**Snooze** moves an Active Run to **Snoozed** and changes only presentation: Agents, handoffs and attention continue. A newly
recorded Needs input or Problem identity, or a higher native pending-question count while questions are already pending,
wakes it (**Woke**). Ordinary progress, stale observations and re-reads of the same matter do not. Opening a Run clears only Woke;
**Restore** returns it to the main list. Snooze state survives reload and restart. Settling or archiving a Run clears both;
Settled Runs cannot be snoozed. T3 reports only a count, so a replacement question with an unchanged count cannot be detected.

## Reports and attention

For new Runs a worker calls `factory_update_block` with its Block id (stated in every Factory message to that worker):
`to: "working"` with a message and no exit when it starts a visit's work, and `to: "finished"` (one of the Block's exits and a
message, required when that exit requires one) when the task is complete. Questions and replies in between need no report.
A report from any turn of the worker's thread, including a user reply or a notification after delegated work, applies to the
Block's current visit. Factory returns acceptance only after saving it. The model supplies no report key or Run id.

- The newest finished report is the visit's result, so the user can continue the conversation and have the Agent report an
  updated outcome. Before hand-off a newer result replaces the held one and only it is passed on. Afterwards the same exit only
  updates the result and message without relaunching the next Blocks; a different exit also hands off to that exit's Blocks,
  while Blocks started from the earlier exit keep running. Repeating the block's latest report returns the original
  acknowledgement, also after settling; while a missing report or execution failure is pending, the repeat is accepted again
  and settles it. Repeating an earlier result after a working report makes it the result again.
- Acceptance holds every outgoing handoff until the worker thread is finished in T3: no active run, no native request and its
  delegated or background work settled ([rule](runner.md#worker-thread-completion)). The timeline shows **handoff held**, then
  **handoff released** (dispatch reserved); the recipient's launch or send acknowledgement is separate.
- A first visit launches the block's own top-level worker with its task; no T3 thread exists for a block before it is
  reached. In a worktree Run that worker joins the bound worktree ([Run workspace](runner.md#run-workspace)). Later visits
  queue independent turns on that same worker, each as its own activation. Two Reviewers returning corrections create two Worker turns, with no Join or agreement on a revision.
  Partial fan-out survives restart; an unresolved launch holds later arrivals to that block only.
- Block state, report, engine status and freshness are separate: a finished report can appear while T3 still works; a finished
  worker thread without a report is a **missing-report Problem**, also after a notification or reply turn; a worker waiting on
  delegated or background work T3 has not settled stays working. A failed, cancelled or interrupted latest run is a Problem until
  a later run of that thread completes or the Block reports; it does not return for that run, and a later failed run is a new
  Problem. Missing-report Problems persist across restart and renewed work;
  there is no automatic retry or dismiss-as-success.
- **Working**: an Agent on its task reports `to: "working"` with a message when the visit's work starts. The block stays
  working and shows the message on the canvas, in its details and in the Run row; it selects no exit, releases nothing and is
  not attention. It stays the visit's current report across later turns, including questions to you, your replies in T3 and
  waits for CI or review, so a finished worker thread is not a missing-report Problem. A later working or finished report
  replaces it. Reported after a result, when the Agent reopens the task, it shows the block working without withdrawing the
  result, and the Run stays Active until a later report.
- **Conversation**: an Agent that asks questions in chat ends its turn with them; reply in the worker's T3 thread. The block
  stays working and the Run shows no Needs input for it, so the next block cannot start on unanswered questions. Factory never
  parses chat; a model may still omit or misuse a report. Earlier Agent questions recorded before this contract stay in Settled
  attention with their text, and an upgrade turned questions still pending into the visit's working report without resuming the
  worker. See [report acceptance](runner.md#report-acceptance).
- **Request report** on a missing-report Problem, or in the details of a block idle in working, starts one extra turn on the
  same thread asking the Agent to assess existing work and report. Eligibility is rechecked at acceptance (a newer run, an unfinished thread, changed authorization, accepted results
  and Archive make it stale); repeated clicks reuse the request. A successful linked recovery settles the original
  attention with a recovery reason and may let the Run settle; a failed one stays unresolved.
- **Rejected report**: a rejected report for a known Block appears as a separate Problem with the rejection
  code, reason and repair guidance. Missing report means no report was accepted; the worker may have attempted one.
  Correct the reported issue without repeating work. Any accepted report on that Block or confirmed linked recovery settles
  the rejection while preserving its history; progress alone does not. Unknown or missing Block ids stay in MCP/T3.
- **Attention panel** (per Run, optionally per block): Pending by default, Settled keeping times, reasons and selected Human exit.
  Native questions and permissions link to **Open in T3** and are answered there; Factory has no native answer controls. A fresh
  read showing none records `withdrawn`; unavailable reads keep matters pending and mark the observation stale.
- **Timeline** entries are plain sentences derived from recorded facts ("entered · new T3 thread", "handed off to Reviewer via
  Review", "finished · exit Approved", "result version 2 replaces the earlier result", "you answered", "settled by you",
  "reported · the Run is Active again", "archived"). Every
  result version keeps its exit, message and deliveries; an earlier version reads **Replaced by version N** and its cancelled
  handoffs **Cancelled**, and a same-exit update after hand-off says it was not handed off again. Activations show the current
  result, and the latest Agent visit shows the Block's current execution state. **Work periods** list each exact execution with
  its own state, the finished or working report (or a historical waiting report) accepted during it, and its T3 link; elapsed times are approximate observations.

## Human steps

Each arrival creates its own pending occurrence, including parallel arrivals and repeated visits. Answer under **Attention →
Pending** by choosing one of the fixed exits: **Approve** with optional text, or **Request changes** with a non-empty message
describing the changes. Submission settles only that
occurrence and atomically saves all outgoing handoffs: double submission cannot send twice and a competing answer conflicts. Agent
recipients get independent deliveries on the existing thread/queue rules; a Human recipient gets a new occurrence. The block stays
waiting until its last occurrence is answered. Context and delivery text survive restart, are cleared after settlement and
acknowledgement, and Settled keeps only metadata. Human steps have no T3 thread; an answer carries on the originating
worker of the message it answered.

## Waits

Each delivery released to a Wait becomes its own arrival: Factory keeps its message and the
[worker provenance](../GLOSSARY.md#worker-provenance) it carries (the T3 thread and, when known, the Block activation that produced it) and fixes an absolute deadline, counted from the
moment the incoming handoff was released, after the source worker's thread finished, not from the report. Parallel arrivals
and repeated visits keep their own messages and deadlines and never join. At its deadline Factory forwards the arrival on its
own, with no open window and no worker: every recipient of the Wait's output gets the unchanged message, and an unconnected
output ends the branch. Timing is best effort; the [Runner](runner.md#wait-arrivals) defines how deadlines survive restart and
downtime and how repeated deliveries and competing forwards resolve.

**Continue now** forwards one selected pending arrival immediately, without confirmation, exactly as its deadline would, and
disables its timer; other arrivals keep waiting. The Wait's details offer it beside each pending arrival, and the canvas block
offers it only while exactly one arrival is pending; like other Run actions it is unavailable while offline or synchronizing.
An arrival the timer already forwarded, or one cancelled by Archive or manual settlement, cannot be continued, nor can any arrival
while a confirmed **Settle** is stopping the Run's workers; an automatically Settled Run stays Settled.

The Wait's details list each arrival with its start, deadline, retained message and outcome, and say when you forwarded one
early. A forwarded arrival keeps its message only while its recipients still need it
([retention](foundation.md#persistence-model)); once it is cleared, or Archive or a cancellation clears it, the details say why. The timeline records **wait started · until …**, **wait elapsed → forwarded**,
**forwarded early by you** and **wait cancelled** with the Wait icon. A pending Wait is visible work, never
Needs input or a Problem, and does not wake a Snoozed Run. A Continuation after a Wait continues the thread of the worker
whose message waited.

## Continuations

A Continuation continues the conversation of the worker whose message reaches it. The first message in a Run queues its prompt on that
worker's T3 thread, stating the Continuation's own Block id; after a Human step, also one whose answer first waited in a Wait, the
person's reply follows the prompt, labelled, because the worker has not seen it. The Continuation shows **sent**, and the worker's own Agent block shows **working** while the thread works on
it, without a new visit and without changing that block's result or firing its connections again. When the worker reports `finished` for
the Continuation and its thread is finished, the response leaves the single output and the Continuation shows **pass-through**. Messages that
arrive while the prompt is pending wait (**Queued** in its details) and go out after the response, in arrival order. From then on every
message is forwarded unchanged with its own worker, also in loops and after a restart; the prompt is never sent again in that Run.

Its details list the prompt visit (input, prompt sent and response) and each pass-through visit, each with **Open thread in T3** for the
worker its message belongs to; Blocks that share a worker open the same conversation. Timeline rows for it use the Continuation icon. A missing
report after its prompt is a Problem on the Continuation, and **Request report** asks the same thread for it. Archive stops a pending
Continuation and cancels waiting messages; its worker thread is interrupted with the other workers.

## Settled Runs

A Run **settles** automatically when every visited Block's current visit has its worker's accepted final result and no later
working report, every Human step is answered, no Wait arrival is pending, no delivery, launch, handoff or send is outstanding, no attention is pending, and
a fresh read finds every worker thread finished in T3. Never-visited branches need not run. A report or T3 completion alone keeps
the Run Active. T3 reads are not an atomic cutoff, so direct T3 activity can arrive just before the Run settles; settling does not
certify result quality or one reviewed revision.

**Settle** settles an Active or Snoozed Run manually and ends its automatic work; every entry point (row menu, Run detail,
shortcut and desktop menu) uses the same rules. When fresh T3 reads confirm every bound worker thread finished, it settles at
once. Otherwise nothing changes until you confirm stopping every worker and ending the Run; cancelling or dismissing the
confirmation changes nothing and sends no Stop. An ordinary Settle request never interrupts a worker: the server answers that
confirmation is needed.

Confirming holds the Run at once: nothing new is launched, sent, released or delivered, no Wait forwards (at its deadline or
through **Continue now**), and Human answers and **Request report** are refused. Factory then asks T3 to Stop each worker thread that is still unfinished, with its delegated and background work,
and settles only once fresh reads confirm every worker finished; a Stop acknowledgement is not enough. Until then the Run stays
Active and its settlement shows **stopping**, with each worker's progress. A worker becomes **unresolved** when T3 does not
support or accept Stop, cannot show the thread in the Run's project, workspace and authorization, or still shows it unfinished
30 seconds after acknowledging Stop; the settlement then names the affected workers and what blocks them (a run in progress, a
native request, delegated work or a queued run). A worker whose launch T3 may have accepted without Factory receiving the reply
also keeps the settlement unresolved: Factory keeps searching for it and stops the worker it finds before settling. Factory sends
Stop only while the T3 authorization the Run started under is still live. **Settle** again retries with a new Stop request;
repeating it while stopping changes nothing. The hold stays, Factory keeps reading the workers and settles as soon as all read finished. An unresolved
settlement is not a lifecycle state: there is no Resume, and **Archive** remains available. Work T3 holds queued in a worker
thread keeps the settlement unresolved until it is removed in T3 or runs; Factory deletes nothing.

Settling cancels unsent launches, sends and handoffs (held or released), unsent Request report turns, pending Human occurrences
without inventing answers, pending Wait arrivals and messages waiting at a Continuation; a cancelled Wait never forwards, also
after restart. Pending attention settles as `manual-settlement`, activated
Blocks without a Final result show stopped, and uncertain sends keep their recorded state. The Run moves to
**Settled**, Snooze and Woke clear, and Factory best-effort settles the worker threads in T3. The timeline records the
confirmation and each retry, each Stop request, each worker found stopped and the settlement. Stopping raises no
execution-failure Problem. T3 Stop has no exact-run fence: a turn started directly in T3 around the Stop request may be stopped
too, or start after the Run settled; settling does not delete T3 conversations or roll back repository edits.

A manually settled Run's work stays ended: a later report from one of its Blocks, including a delayed one from stopped work, is
acknowledged as a success that changes nothing and tells the Agent to stop, and Factory no longer observes or drives the Run.
An automatically Settled Run differs: any accepted report from one of its Blocks (`working` or `finished`, including a repeat
of the current result) returns it to **Active**, and the timeline names the Block that reported. Chat in a worker thread without
a report leaves it Settled: Factory observes it only while it still owes a launch, handoff, send, Request report or Wait
forwarding, so later turns add no work periods or Problems. Human answers and Request report on it are accepted and dispatched without returning it
to Active. Runs settled before manual settlement stopped workers keep their open gate and behave like automatically Settled
Runs. History, input, captured definitions and events remain; no transcript or response-body archive exists.

## Archive

**Archive…** in the row menu and **Archive Run** in the Run's top bar both ask for confirmation, then end the Run for good.
Archiving closes the handoff gate, cancels unsent launches and handoffs, cancels pending Human steps without inventing answers,
cancels pending Wait arrivals so no deadline forwards afterwards and clears every arrival's message, settles pending attention
as `archived` and shows activated blocks that had not finished, including waiting Waits, as stopped. Factory then asks T3 once to
interrupt every worker thread, which also stops its delegated work, and does not wait for or confirm termination; in-flight or
uncertain deliveries keep their recorded state and are not retried.

An Archived Run leaves navigation and cannot be restored, settled or snoozed. Archiving the open Run returns to the composer. All
its data stays: its link still opens the read-only history with an **Archived** badge. Any later report from one of its Agents is
acknowledged as a success that changes nothing and tells the Agent to stop work on the Block; Human answers and Request report are
refused. Archive does not roll back edits or prevent new direct T3 chats; closing Factory or a browser tab is not Archive. Runs
stopped by an earlier release are Archived after the upgrade, with their recorded Stop history.

## Restart and shutdown

History stays readable when T3 is unavailable. On startup Factory restores bindings and reconciles Active Runs, and automatically
Settled Runs that still owe an operation, before dispatching, then
observes periodically (no Resume button). A confirmed Settle keeps its hold across restart: Factory reads the workers again and
settles once they read finished, but never sends a Stop the earlier process had not, so a worker still unfinished is unresolved
until you retry. Missing or incomplete observations stay stale and keep the last known facts. An uncertain
launch or send replays only with the saved key and body under the same authorization context and a verified replay scope; otherwise it
stays unresolved and keeps the Run open (see [Runner](runner.md#ownership-and-restart)). One backend owns a database; another
fails startup. Shutdown neither archives a Run nor interrupts T3; reopening the same data home observes accepted work.

## Completed stages in T3

When native settle is supported, Factory best-effort marks a worker thread **Settled** in T3
once its Block's current `finished` result is confirmed by worker completion, even while the
Run continues. Run settlement remains the fallback for remaining threads. Factory never
unsettles a thread, and an attempted request is not repeated for the same thread and T3 run.
See [native thread organization](runner.md#native-thread-organization) for guards, failure
handling and the limits of this best-effort organization.
