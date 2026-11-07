# Starting and observing a Run

## Starting

Open **New Run (+)** (`/runs/new`; the Flow editor's **Start Run** opens it with its saved Flow selected). Choose an
available project, a global ready Flow and a required initial prompt. Factory checks the project and connection, the graph,
every referenced Agent's settings, reporting installation and explicit-call API compatibility before accepting Start.
Failures explain recovery and keep the draft.

- **Task and Run.** Each Start creates a new Task (named from the first non-empty input line) and its Run. Each Run has its own
  title, from its first non-empty prompt line, limited to 500 characters.
- **Idempotency.** A stable request key belongs to one composer submission. Retrying an accepted request returns the same Run,
  even after a lost response or restart; reusing the key with changed content conflicts. An unknown response keeps the
  submitted fields read-only and offers **Check same request**; only confirmed success clears the prompt and opens the Run.
- **Active slot.** One non-closed Run (including unresolved work or an in-progress Stop) occupies its Task's slot. Different
  Tasks run concurrently in the shared project checkout.
- **Snapshot.** The Run keeps immutable input, the full Flow graph and each referenced Agent's prompt, settings, revision and
  labels. Later edits affect only future Runs.
- **Launch.** Factory launches one top-level worker per Agent block visit, using that Agent's saved provider, model and
  options. Agents connected to the Flow input start in parallel and independently (no Agent is told about the others). There
  is no Run conversation. A lost launch is searched for by its saved title and verified thread evidence; Factory does not
  launch a second worker for it. A definitive rejection is an error. Other workers keep going.
  Factory works in the project root with no isolated worktrees, omits `runtimeMode` and leaves execution permissions to T3
  and its OAuth grant, so effective autonomy is not guaranteed by Factory. Use a repository you are willing to let agents
  change.
- **Composer.** Project and Flow choices are remembered locally; the prompt stays in memory across in-app navigation. Each
  blocking condition is a notice with a recovery action, and fields that cause it are marked. The Project picker keeps
  searchable paths, **Recheck projects** and **Add repository**; unavailable references stay visible in history but cannot be
  selected for a new Run.

## Execution canvas

Opening a Run shows its saved Flow snapshot on a read-only canvas. Positions, exits, connections and Agent labels come from the
snapshot, even after the Flow is edited or removed or the project is unavailable; a changed later definition is labelled, never
substituted.

- The **Flow input** block shows the Run's truncated prompt and has no state or details panel.
- Each work block shows its recorded state: not started, working, waiting, finished, error or stopped. Several blocks can be
  active at once; the canvas marks no "current step", percentage or taken path. Repeated visits update the same block; the
  timeline and executions keep the sequence. Connections use one neutral style, including never-run branches.
- **Needs input** and **Problem** use the same labels as the Run sidebar, are independent of execution state and are not
  cleared by selecting a block. Stale observations say **Not live** and **Last known**; an unknown observation on a started
  block differs from stale; a block that never ran says **Not visited**.
- Pan, zoom, fit and **Auto-arrange** are local. Zoom ranges 20%–200% (**+**/**−**, **Fit Flow**, **0**, pinch or **Mod**+wheel
  at the pointer; plain wheel and arrow keys pan; bindings are in [Keyboard shortcuts](keyboard-shortcuts.md)). Auto-arrange
  lays out left to right, changes neither the Flow nor the snapshot and resets on reload. After the initial fit, status polling and container resize preserve the Run viewport.
- Selecting a block floats its details (visits, exits, T3 references and link, attention actions). There is no editing here.
- The top bar shows title, project, snapshot, block states, each worker's **Open worker in T3** link (a pending launch says
  recovery is still searching and offers no replacement), **Stop Run** (open) and a ··· menu. The timeline starts collapsed; the context rail (attention, Stop/closure
  evidence, prompt, snapshot, project, work periods) opens from 1280 px wide.
- Verified running worker work is ordinary progress; unavailable native evidence is a coordination Problem.

Engine termination alone never completes a Run: whole-Run completion is only a recorded Finished or Stopped outcome.

## Run list

The shell sidebar lists Runs globally, newest created first (id ascending breaks ties); opening, renaming and closing never
change that key. Rows show project, execution indicator (Working, Waiting, Finished, Stopped, Stopping, Observation unknown or
stale) and chips. Missing projects keep readable history; an unavailable open Run stays open.

- **Needs input**: a pending Human occurrence, native T3 question/permission or an Agent's conversation-waiting report.
  **Problem**: a pending missing report, execution failure or report problem. Both can show. Stale observations or an unavailable
  project are not Problems and opening a Run clears no chip.
- **Settled** (collapsed, with a count) holds only Runs with recorded Finished or Stopped closure. **Snoozed** sits above it.
  Case-insensitive title search reveals matching entries in every group; Escape or × clears it.
- **Rename** changes that Run's title only (trimmed, non-empty, ≤500 characters). Row menu: hover/focus/select, Shift+F10,
  F2 renames; closed rows offer Rename only.
- A closed Run is read-only history and is never reopened or relaunched. To work on the matter again, start a **New Run**: it
  uses the current saved Flow and Agent definitions, not an earlier Run's snapshot.

### Snooze and Woke

**Snooze** moves an open Run to **Snoozed** and changes only presentation: Agents, handoffs, Stop and attention continue. A newly
recorded Needs input or Problem identity, or a higher native pending-question count while questions are already pending,
wakes it (**Woke**). Ordinary progress, stale observations and re-reads of the same matter do not. Opening a Run clears only Woke;
**Restore** returns it to the main list. Snooze state survives reload and restart. Closure always moves a Run to Settled and clears
both. T3 reports only a count, so a replacement question with an unchanged count cannot be detected.

## Reports and attention

For new Runs a worker calls `factory_update_block` with `to: "finished"` (a configured exit and a message when feedback is
required) or `to: "waiting"` with a message and no exit. Factory verifies the call against the exact saved execution and returns
acceptance only after saving it. The model does not supply a report key or a Run id.

- An identical retry returns the original acknowledgement, also after renewed work, Stop or closure; changed content conflicts,
  even under a new key. A previous execution's report cannot finish renewed work.
- Acceptance holds every outgoing handoff until fresh evidence shows source completion, empty queues and no native request. The
  timeline shows **handoff held**, then **handoff released** (dispatch reserved); the recipient's launch or send acknowledgement is
  separate.
- A first visit launches the block's own top-level worker. Later visits queue independent turns on that same worker, each as
  its own activation. Two Reviewers returning corrections create two Worker turns, with no Join or agreement on a revision.
  Partial fan-out survives restart; an unresolved launch holds later arrivals to that block only.
- Block state, report, engine status and freshness are separate: a finished report can appear while T3 still works; completion
  without a report is a **missing-report Problem**; failure is a Problem. Problems persist across restart and renewed work; there
  is no automatic retry or dismiss-as-success.
- **Request report** on a missing-report Problem starts one extra turn on the same thread asking the Agent to assess existing work
  and report. Eligibility is rechecked at acceptance (newer or queued work, native attention, changed authorization, accepted
  results, Stop and closure make it stale); repeated clicks reuse the request. A successful linked recovery settles the original
  attention with a recovery reason and may allow closure; a failed one stays unresolved.
- **Conversation waiting**: an Agent that asked questions in chat reports `to: "waiting"` with a message. The block
  shows waiting, the Run shows **Needs input** with that message and **Open in T3**; reply in the worker's T3 thread. When Factory
  observes the reply turn the attention settles (`resumed-by`), the waiting report stays in history and the reply turn reports
  again. Factory never parses chat; a model may still omit or misuse the report. See
  [waiting reports](runner.md#report-acceptance).
- **Attention panel** (per Run, optionally per block): Pending by default, Settled keeping times, reasons and selected Human exit.
  Native questions and permissions link to **Open in T3** and are answered there; Factory has no native answer controls. A fresh
  read showing none records `withdrawn`; unavailable reads keep matters pending and mark the observation stale.
- **Timeline** entries are plain sentences derived from recorded facts ("entered · new T3 thread", "handed off to Reviewer via
  Review", "finished · exit Approved", "you answered", Stop and closure). **Work periods** list each exact execution with its own
  state and T3 link; elapsed times are approximate observations.

## Human steps

Each arrival creates its own pending occurrence, including parallel arrivals and repeated visits. Answer under **Attention →
Pending**. A single exit offers **Continue** with optional text; multiple exits require a selection; an exit requiring correction
feedback needs non-empty text. Validation comes from the saved exit rules, never the exit name. Submission settles only that
occurrence and atomically saves all outgoing handoffs: double submission cannot send twice and a competing answer conflicts. Agent
recipients get independent deliveries on the existing thread/queue rules; a Human recipient gets a new occurrence. The block stays
waiting until its last occurrence is answered. Context and delivery text survive restart, are cleared after settlement and
acknowledgement, and Settled keeps only metadata. Human steps have no T3 thread.

## Completion and permanent history

A Run closes **Finished** only when every Block visit has its worker's accepted final result, every Human step is answered, no
delivery, launch, handoff or send is outstanding, and fresh observations of every worker and
their descendants show completed work, no queued work, no native attention and no Problem. Never-visited branches need not run.
A report or T3 completion alone, or incomplete coverage, keeps the Run open and its Task slot occupied.

Run detail shows the **recorded observed frontier**: exact executions, statuses, queue and native counts with their separate read
times. T3 reads are not an atomic cutoff, so direct T3 activity can arrive before local closure; completion does not certify result
quality or one reviewed revision. Confirmed Stop keeps finished blocks, leaves unvisited blocks not started and marks other activated
blocks stopped.

Finished and Stopped Runs stay closed: later T3 conversations neither reopen them nor extend their timeline, and new reports and
Human answers are rejected (identical accepted report retries still return the saved acknowledgement). History, input, snapshots,
events and closure evidence remain; no transcript or response-body archive exists.

## Stop

**Stop Run** first blocks new handoffs, cancels unsent launches and handoffs and settles pending Human steps as
**cancelled-on-Stop** without inventing answers. Nothing is dispatched after Stop; a delivery whose outcome is unknown stays
unresolved and keeps Stop uncertain. Factory cancels queued turns and requests thread/tree Stop across the owned
workers and their descendants; the recorded execution reference is not a T3 fence.

**Stop requested / Uncertain Stop** means terminal state and empty queue and native coverage are not yet confirmed, or a pre-Stop
operation is unresolved. An acknowledgement is insufficient; the Run keeps its slot through restart and reconciles automatically.
Confirmed **Stopped** shows the frontier and settles remaining Problems and native matters as cancelled-on-Stop. Stop does not roll back
edits or prevent new direct T3 chats; closing Factory or a browser tab is not Stop.

## Restart and shutdown

History stays readable when T3 is unavailable. On startup Factory restores bindings and reconciles open Runs before dispatching, then
observes periodically (no Resume button). Missing or incomplete observations stay stale and keep the last known facts. An uncertain
launch or send replays only with the saved key and body under the same authorization context and a verified replay scope; otherwise it
stays unresolved and keeps the slot (see [Runner](runner.md#ownership-and-restart)). One backend owns a database; another
fails startup. Shutdown does not Stop the Run or interrupt T3; reopening the same data home observes accepted work.

## Completed stages in T3

When native settle is supported, Factory best-effort marks each worker in the closure frontier **Settled** in T3 before recording
Finished. New Runs have no Run conversation to settle. A historical closed Run that still has a coordinator row can settle that
thread after closure. Factory never unsettles. This is best-effort organization: failure never changes results or closure, and an
attempted request is never replayed.
