# Durable Runner

The Runner turns accepted Starts, reports, Human answers, Wait deadlines and Archive requests into
durable operations against T3, and decides when a Run settles. Inside it, the Run
store owns Run state and its SQL transactions; orchestration owns T3 calls and
scheduling. Persistence principles are in [Application foundation](foundation.md#persistence-model); user
behavior is in [Runs](runs.md); live-support limits are in
[Compatibility](installation.md).

## Run state and orchestration

The Run store owns the Run's execution state and reads, including history kept from
the retired Run coordinator. Its transitions own the mutation lane, the owner,
authorization, gate and generation guards, generation advances, timeline events and
publication of committed changes. Each transition keeps the guard facts and
publication conditions its operation requires. Start, startup ownership and renames
keep their existing exceptions to the per-Run mutation lane. Reads participate in
the caller's read transaction, so a live view reads navigation and its open Runs
from one consistent snapshot. The store exposes transitions and reads, without a
SQL handle, mutation lane or shared write steps.

Orchestration calls T3, verifies payloads, searches uncertain launches and schedules
observations, dispatch and retries. Its separate reconciliation lane serializes
observe and dispatch passes for a Run across T3 calls. That scheduling lane is not
a persistence guarantee: a report can enter the store's mutation lane while a T3
read is pending. No Run store transaction spans a T3 call.

The store also owns the local part of the [handoff release rule](#routing-and-independent-queues):
the Final result must still be its activation's newest version, no execution
failure may be pending, and the required guards and generation must hold.
Orchestration reads whether the source worker thread is finished and passes the
observed generation to the release transition. It asks the same rule before a held
Handoff becomes a delivery, so a held arrival cannot create an activation, and
again at reservation. T3 calls or a restart can intervene, and a delivery prepared
before restart reaches reservation without repeating preparation. A revisit also
checks that the recipient worker thread is finished at send time.

## Current execution contract

Each Agent Block gets its own top-level T3 worker. Factory launches it with the Block's first
visit, never before ([Run workspace](#run-workspace)). There is
no Run conversation and no native-delegation turn that copies the Agent. Migrations `050`
and `058` delete open Runs captured under replaced contracts. Runs closed under earlier contracts
stay readable history: `062` made Finished Runs Settled and `063` Stopped Runs Archived.
Captured definitions carry no execution contract, coordination instruction version or
reporting protocol.

- Each Flow-input Agent starts independently. The worker uses that Agent's captured
  provider, model and options, the [Run workspace](#run-workspace), and the runtime mode from T3
  and project defaults. Nothing is inherited from another thread. Two Blocks that share
  one Agent still get separate workers.
- The saved launch title is `Factory #<number> · <block position> <Block name>`, sliced to
  200 characters. The number is a durable Run sequence. The position is the 1-based index
  in the captured block list. Later renames do not change the title recovery searches for.
- Start mints a **Block id** for each Agent Block and Continuation. The first message starts with
  `$factory-block`, then a `Factory Block id: <id>.` line; every later visit and Request
  report message repeats the same id. The worker passes it to `factory_get_block`, then
  `factory_update_block`. `factory_get_run` is read-only and grants no routing authority.
  Subagents do not call Factory tools.
- Factory alone owns routing, handoff release, Human occurrences, settling and Archive. A
  completed model turn is not a business result. A definitive launch rejection is an
  error. An uncertain launch is recovered by search, never by another launch.
- A later handoff or Human correction creates a new activation on the same bound worker.
  Conversation with the user stays in that worker thread; Factory does not track it.
- A [Continuation](#continuations) has no worker of its own: its prompt is a later task in the worker
  thread its first message belongs to, with the Continuation's own Block id.
- A [Wait](#waits) has no worker, Block id or reports: Factory itself holds each message that reaches it
  until its deadline.

### Run workspace

The captured Flow revision's [workspace setting](studio.md#workspace-setting) decides where
every worker of a Run works. A checkout Run works in the project root. A worktree Run's
workers share one worktree; its project root stays the Run's project identity.

- **Creator and branch.** Start of a worktree Flow also requires T3's worktree launch
  support (`launch_unsupported` otherwise) and records the Run workspace: the resolved base
  ref, the planned branch, the creator Block (the first Flow-input target) and its state,
  `preparing`, `bound` or `failed`. The creator launches with its first message on
  `{type: "worktree", baseRef, branch}`. Factory names the branch
  `factory/run-<Run number>-<first 8 characters of the Run id>`, so T3 does not rename it
  after the first turn and Runs of different Factory homes on one repository do not share
  it; T3 rejects the launch if that branch already exists.
- **Binding.** Factory binds the path and branch once the creator's thread shows both. The
  path is not readiness: T3 queues each worker's turn behind that worker's own workspace
  preparation. Before binding only the creator has a thread, and T3 may show its path before
  its branch, so a thread with no branch or the planned branch is accepted; after binding a
  thread must show the bound path. Any other workspace is a scope change. Checkout Runs keep
  the project-root rule.
- **Joining workers.** After binding, every other Flow-input target launches once with its
  first message on `{type: "existing_worktree", worktreePath, branch}`. Every other Agent
  Block launches its worker the same way on its first arrival, so a Block that is never
  reached never gets a thread. Each launch with a message keeps T3's preparation fence for that
  worker's own setup, including blocking worktree setup scripts.
- **Recovery.** An uncertain launch is recovered by search and never repeated. For the
  creator this means no second worktree, and the other workers keep waiting. A definitive creator rejection fails
  the workspace and errors every Flow-input Block; none launches into the project root.
  Automatic settlement waits while the worktree is unbound.
- **Later activations.** After a Human step or a return to an earlier Block, the activation
  is a queued send to an existing thread on the bound path and branch, so T3's recreation of
  a missing managed worktree at turn start applies. Factory adds no restoration step; a
  failed send stays unresolved under the usual delivery rules.
- Factory never removes the worktree; T3's cleanup rules apply to it.
- **Earlier prepared workers.** Runs started before this contract prepared idle threads for
  later Agent Blocks. Migration `070` cancels unresolved preparations; their acknowledged idle
  threads stay in T3, and migration `073` discards Factory's record of them. A first visit already queued as a send to a
  prepared thread keeps its target and request key, and that thread becomes the Block's worker;
  the send is released without waiting, since the thread has never run, and is delivered or
  recovered like any other send. A Block of such a Run that has not been reached
  launches a new worker on its first arrival, and an idle thread with the same title can make
  that launch's recovery search ambiguous if its acknowledgement is lost.

## Start and delivery guarantees

Start checks the connection, project, graph, saved Agent settings, the `$factory-block`
skill, reporting installation and launch support. It does not require a Run coordinator.
Accepted Start atomically creates the Run's Task, assigns the Run number, references the
Flow revision and freezes the current revision of each referenced Agent, and records each
launch intent before contacting T3. An accepted request key is
unique across the database: the same content returns the same Run; changed content
conflicts. Content is the project, Flow, prompt text, title and creation time, plus for an image Start the ordered
prompt segments and every manifest field (image id, digest, name, type and size). A text-only request keeps the
earlier content form, so a request accepted before images recovers its Run, also when it is resent as prompt segments.
Rejected requests record nothing, and the accepted key is also the Run's navigation creation key. A replay of an
accepted key is recognized before image staging and capability checks.

An image Start also requires T3's attachment support (`attachments_unsupported` otherwise), at most 8 images with unique
ids and digests, every image reference in the manifest, names of 1–255 characters, and type and size matching the
staged image. Inside the acceptance transaction every digest must be staged; otherwise Start fails with
`missing_images` (HTTP 409, listing the digests), which is not a confirmed rejection, and creates no Run or Task. The
transaction attaches the ordered manifest to the Run and stores the prompt segments; both are immutable. The Run's
input holds the worker-readable text frozen at Start. Flow input targets start independently and are not handoffs.

A worker is bound from the launch acknowledgement, or from exactly one search candidate
whose title matches and whose thread, workspace, provider, model, options and execution
match the saved launch. Title alone is not ownership. An empty, delayed or ambiguous
search never causes another launch or a guessed binding. An unresolved launch stays
visible, blocks automatic settlement and release, and resumes after restart.

Delivery can be pending, reserved, acknowledged or uncertain. A crash or lost response
after reservation leaves uncertainty, not a fresh attempt. An acknowledgement proves
acceptance only, not execution or completion. Later arrivals to the same Block wait for
its unresolved launch; unrelated branches may continue.

Start always resolves the current saved Flow and Agents on the backend; it never trusts a
client-supplied graph or launches from an earlier Run's captured revisions. The composer requires the
server's creation policy before Start.

### Run images

Image bytes are content-addressed files in `FACTORY_HOME/images`, written to a temporary file, synced and renamed; a
staging row in SQLite exists only while its file is complete. Uploads and the staging sweep share one permit. The sweep
runs at startup and before each upload and deletes staged images no Run references once they are 24 hours old, counted
from the first upload; uploading again or checking an image does not extend that. A Run's reference keeps shared bytes
for good, including after Settle and Archive. A failed write is an explicit storage error; there is no quota or eviction.

Every Flow-input launch intent saves the ordered image list (ordinal, digest, name, type, size), covered by its payload
fingerprint, also for workers that join a bound worktree later. T3 attachment ids are never saved. Each dispatch of a
pending launch checks attachment support, reads and verifies each image, uploads it to T3 and only then reserves and
launches with the attachments. An upload failure leaves the launch pending with "Image upload to T3 failed: …" and
retries after a delay of 1 second doubling to 60; it is neither a Block error nor a Problem. Lost attachment support uses
the pending launch-unsupported path. Bytes missing from Factory storage or failing their digest cancel the launch and
mark the Block error "Run image missing from Factory storage" (for a worktree creator, every other Flow-input Block too).
A rejected launch is an error; an uncertain one is searched for and never uploaded or launched again. Downstream
launches, including a worktree Block's launch on its first arrival, revisits and Request report remain text-only.
Factory does not use `t3_thread_send_attachments`: it has no retry key, and launch attachments cannot reach a worker
that is already running.

Every worker can instead discover and retrieve relevant original images through
[read-only Factory MCP access](t3-integration.md#run-image-reads), including during later user conversations.
A read creates no intent, turn, activation, handoff, attention or execution/lifecycle change. It can be repeated after a
lost response without changing launch recovery or send uncertainty rules or authorizing a resend. Unlike missing bytes
at Flow-input launch, an image-read failure does not fail the Block or raise attention; the worker handles any blocker
through normal reporting.

## Ownership and restart

Only one backend may own a database. It holds an exclusive OS lock for its lifetime;
a second owner fails startup. Never delete a live lock file. Process exit releases
ownership without a takeover timer. Storage requires local-filesystem locking on macOS
or Linux; network filesystems and remote backend ownership are unsupported.

Startup reconciles every Run it [drives](#settled-runs) before dispatching. Local changes serialize per Run,
and no SQL transaction spans T3 I/O. Shutdown releases ownership without archiving or
interrupting anything.

An uncertain worker launch is never replayed, including with the same key. While Factory
is running, recovery searches the same T3 environment and project for the saved title,
then binds only a uniquely verified thread and its exact execution. A missing parent, a
non-string parent, or a missing workspace withholds the search. T3 reports a project-checkout
thread with a null workspace, and that null matches a root-strategy launch. Any other
workspace must equal the Run's project root. A worktree-creating launch matches a thread
with a worktree path on its planned branch; a launch joining a bound worktree matches its
exact path and branch. A null branch never matches a worktree launch. The first search is
immediate; each completed search that does not bind waits longer, from 1 second doubling
up to 60 seconds. Empty, delayed, ambiguous or incomplete evidence stays unresolved.
Model options must be readable; otherwise live recovery can remain pending. A matching
version or OAuth grant is not ownership. A definitive T3 rejection is an error and is
not searched back into service. A thread T3 created before that rejection is an accepted
limit. Uncertain queue sends still need the identical saved body, key, target and
authorization context plus independent retention proof. The live adapter supplies no such
proof by default. Acknowledged threads are observed, never relaunched. There is no Resume
or fresh-attempt escape hatch.

## Report acceptance

A Block's worker reports by naming its Block id. Factory resolves the id to its Run and
Block and applies the report to the Block's current activation, whichever turn of the
worker thread sent it: the launch turn, a user reply, a notification after delegated or
background work, a delegated completion or a Request report turn. Factory does not
correlate native tool calls, search in-flight calls or bind authority to an exact
execution. Before acceptance it observes the Run so the report belongs to the thread's
current turn. Identity and recipients come from the Block id and the Run's captured Flow
revision. Acceptance and creation of outgoing handoffs are durable before the
acknowledgement is returned.

Anything that knows a Block id can report for that Block, including a subagent the worker
passes it to. Factory MCP is host-local for one user, so the realistic failure is Agent
confusion rather than attack; the skill and tool descriptions say only the Block's own
worker reports.

- An unknown id is `UNKNOWN_BLOCK` and a missing one is `BLOCK_ID_REQUIRED`, both with
  repair guidance. Neither attaches attention to any Run.
- The newest `finished` report of an activation is its result. Every version stays in the
  Run's reports and timeline as an immutable record. A later `finished` from any turn of the
  worker thread:
  - before release, replaces the held result: the earlier version's handoffs are cancelled
    and only the newest version is handed off;
  - after release with the same exit, updates the recorded result and message; it creates no
    handoff and relaunches no recipient;
  - after release with a different exit, creates handoffs to that exit's recipients, held under
    the same release rule, while Blocks started from the earlier exit keep running.
- The Block's current report is its current `working` report, else the activation's newest
  result; acceptance, observation and automatic settlement all read it
  the same way. Repeating the current report returns its acknowledgement, also after settling,
  unless an execution failure or missing report is pending on the Block; then the repeat is a
  new report that settles it. Repeating an earlier result after a later `working` makes it a new
  result version. Reports cannot erase engine failure, prove semantic correctness
  or settle a Run.
- Every report for an [Archived](#archive) Run, `working` or `finished`, is
  answered with `RUN_ARCHIVED` before any validation. Factory MCP returns it as a successful
  tool result whose text says the Run is archived and the worker should stop work on the
  Block; nothing is recorded and no diagnostic attention is created.
- Any accepted report on a [Settled](#settled-runs) Run, including a repeat of the current
  result, returns the Run to Active in the same transaction and records `run-activated`
  naming the Block.
- Exits must match the ID or unambiguous exact name of one of the Block's exits in the Run's
  captured definitions (its captured Agent revision's exits minus those the Flow hid, plus its
  Flow-local exits), with a non-empty message when that exit requires one (`FEEDBACK_REQUIRED`
  otherwise). Accepted results remain held until the
  [handoff release](#routing-and-independent-queues) rule passes.
- Workers report only `working` and `finished`. The worker reports `working` when it starts a
  visit's work and `finished` when the task is complete. Each activation needs its own report;
  Factory never reports for the worker and never infers state by parsing chat.
- `working` requires a non-empty message and no exit. It is non-final: it selects no exit,
  releases nothing and creates no attention. It is scoped to the activation, not to one T3
  turn: it stays the current report across later turns of the worker thread, including
  questions to the user, their replies, idle periods and waits for CI or review, so a finished
  worker thread raises no missing report. A newer `working` replaces the message, an identical
  one is a repeat, and a later `finished` replaces it. Every working report is kept as history.
  A `working` after a result, when the worker reopens the task, is the Block's current state
  until its next report; it withdraws neither the result nor its handoffs, but it keeps the Run
  from settling automatically. A later accepted report settles earlier missing-report and
  execution-failed attention on the Block.
- A question in chat is ordinary conversation: it creates no Needs input and wakes no Snoozed
  Run. Unfinished discussion keeps the Block on `working`, so the next Block cannot start on
  unanswered questions. Native T3 questions and permissions and Human steps keep their own
  attention.
- `waiting` is retired: `factory_update_block` answers it with `WAITING_RETIRED` and guidance to
  keep the question as the turn's final message, and records nothing. A `working` report with an
  exit is `EXIT_NOT_ALLOWED`, and one without a message is `MESSAGE_REQUIRED`, all with repair
  guidance.
- Waiting reports accepted before retirement keep their questions, settled attention and
  work-period report status. Upgrading settles each pending question as `upgraded-to-working`
  and makes the latest one of a Block's latest activation that activation's current `working`
  report, with the question as its message, even after an earlier result. That report's
  `retired-wait:` id marks it as derived by the upgrade, not reported by the Agent; the upgrade
  sends nothing and resumes no worker. Request report treats the upgraded work period like one
  idle in `working`, although it keeps its historical waiting status. Migration `073` discards
  the wait records with their acknowledgements.

Report metadata retains fingerprints and references, not a second message archive.
[Block ids](t3-integration.md#factory-mcp-and-block-ids) defines the tool contract.

## Worker thread completion

Factory trusts T3 to say when a Block's worker thread is finished. One shared rule decides it,
and handoff release, missing report, automatic settlement and Request report all use it. A worker
thread is finished when all of these hold:

- the `t3_thread_read` of the thread shows no active run and zero pending native requests;
- `t3_thread_wait` for its latest run, with `timeoutMs: 0` and
  `untilDelegatedWorkSettled: true`, answers that thread and run with a terminal status
  (`completed`, `failed`, `cancelled`, `interrupted` or `rolled_back`) and `timedOut: false`.

T3's `resultRun` is informational only: it names the run T3 answered from, which can be an
earlier run when a notification resumed the thread, so Factory never compares it with the
waited run. A timed-out wait, an active run, a pending native request, a wait answered for
another thread or run, or a read without a valid pending-request count keeps the thread
unfinished. Factory keeps no model of descendants, subagents, queues, peers or individual
executions and verifies no provider or model at final; delegated and background work count
only through T3's wait answer. Reads across threads are not an atomic cutoff: direct chat
can start a new run between Factory's read and its local decision.

## Observation and attention

Engine status, report status, native requests and freshness are independent facts. Each
observation reads the Block's worker thread and records its recent runs as work periods. An
unavailable observation preserves prior facts, marks them stale and cannot release work or
close the Run.

- **Missing report.** When the worker thread is finished, its latest run completed and the
  Block's current activation has no `finished` result or current `working` report, the Block shows a missing-report Problem for that run. The Problem persists through later
  runs until the Block reports or a linked Request report settles it.
- **Execution failure.** When the latest run of the thread failed, was cancelled, interrupted or
  rolled back, the Block shows an execution-failed Problem for that run, holding any prior result. It settles when a
  later run of the same thread completes or when the Block reports, and is not raised again for
  that run; a later failed run raises a new one. Factory never retries failed work automatically.
- A rejected report for a known Block of an open Run records a report-problem with a
  static rejection code, explanation and next step. It retains only existing
  execution/binding references, never rejected report content, call payloads or secrets.
  Repeated rejections update the pending diagnostic; any accepted report on that Block or
  confirmed linked recovery settles it while preserving its history. Unknown Block ids
  cannot attach Problems to a Run. Rejection changes no execution state.
  A later missing-report Problem means no report was accepted, not that none was attempted.
  Historical rejections made before this diagnostic existed are not backfilled.
- Native attention includes questions and permissions. Only a fresh read showing a zero
  pending count withdraws it; unavailable reads keep it pending. Reappearance creates a new
  matter.

Events retain causal identities, execution transitions and observation times. Unchanged
polls add no events; observation-only times are approximate. There is no transcript archive.

## Routing and independent queues

Each validated recipient of an accepted final result gets an independent handoff. Agent
handoffs stay held until the source activation has its `finished` result, its worker thread
is [finished](#worker-thread-completion) and no execution failure is pending on that Block.
The owner, authorization, gate and local generation must still match when release is
recorded. Release is recorded once per result version, only while that version is its
activation's newest result, and is never re-derived from saved presentation data. A Human
answer directly authorizes its outgoing handoffs.

A first visit launches that Block's own top-level worker. The message is `$factory-block`
followed by the captured Agent prompt. A revisit queues a turn on the same worker after
the previous activation's current result is released and, at send time, the worker thread is
finished. Two Blocks using the same
Agent still have separate workers. Parallel arrivals never join or batch their feedback.
Threads share the Run's workspace, the project-root checkout or the Run's worktree; Factory guarantees neither edit-conflict handling
nor agreement on one repository revision.

Partial fan-out survives restart. Each pending delivery retains its own body until
acknowledged; keys, fingerprints, targets and references remain afterwards. Initial input
and captured prompts are retained intentionally. Payload clearing is logical deletion,
not secure erasure.

### Continuations

Every handoff records its [worker provenance](../GLOSSARY.md#worker-provenance): an Agent result carries its
worker's binding, a Human answer the binding of the delivery it answered, a Continuation's result the thread
its prompt ran on and a pass-through or a Wait's forwarding the arrival's own binding. An Agent or Continuation
result also records the Block activation that produced it. Human occurrences retain their incoming delivery
reference; answers copy that delivery's binding and activation, as pass-throughs and Waits do. Neither a later
Agent activation nor another occurrence can replace that origin. Handoffs recorded before Continuations
existed carry no binding, and those recorded before Waits existed no activation; missing historical origins
stay unknown.

The first released handoff to a Continuation becomes its prompt visit: an activation, attributed to the
worker's captured Agent revision, delivered by a send queued on the handoff's thread by its T3 id. A Factory
send into an existing thread (revisit, Continuation prompt or Request report) waits until the thread is
finished and no other Block's delivered activation on that thread still lacks its `finished` result, so work
sharing a thread is serialized. Unknown send acceptance follows the ordinary recovery rules and is never
resent blindly.

Reports naming the Continuation's Block id apply to its prompt activation; `finished` takes no exit (or its
`output`) and requires a message. The result is held until the thread its prompt ran on is finished and no
execution failure is pending on the Continuation; Factory also attempts that release on every drive, so a
Continuation without recipients forwards too. Release records the response's handoffs and makes the
Continuation pass-through. Later handoffs to it are acknowledged and forwarded with their own binding as
released handoffs (cause `pass:`), each recorded as a pass-through visit; handoffs arriving while the prompt
is pending are recorded as queued and wait. A run of the thread that Factory queued for the prompt belongs to
the Continuation: its failure and a missing report after it are the Continuation's attention, while the
worker's Agent block shows the thread's activity. A Run neither settles automatically nor has that thread
settled natively while a Continuation is sent or a message waits.

### Waits

A released handoff to a Wait becomes one durable arrival in the same transition that acknowledges it: the
arrival takes the message, the handoff's provenance and, for an Agent result (directly or through earlier
Waits), the result version whose message it is. Its start is the time recorded when the handoff was released (the
result's release record, the Human answer, the Continuation pass-through or the earlier Wait's forwarding), so a
restart or dispatch delay before the arrival is created does not move it, and its deadline is the start plus the
captured Wait duration, stored as an absolute time. The handoff's identity is the
arrival's deduplication key: a repeated preparation after a crash or retry finds the handoff acknowledged and
records nothing. Parallel arrivals and later visits are separate rows with separate deadlines; nothing joins.

Forwarding is one guarded Run store transition, addressed by the arrival and given the reason it forwards;
the reasons are an elapsed deadline (`elapsed`) or Continue now by the user (`early`). In one transaction under the Run's lane it requires the backend owner, a Run that is not
Archived, an open gate and a pending arrival (for `elapsed`, a deadline not after now), then creates a released
handoff with the arrival's message and provenance for every recipient of the Wait's output (cause `wait:`),
records the outcome and clears the arrival's message. It needs no live authorization context and no T3 call; the
outgoing handoffs keep the ordinary delivery guards. A second attempt finds the arrival forwarded or cancelled
and changes nothing, so expiry, a restart and a later action produce one forwarding. A crash before the commit
leaves the arrival pending; after it, the handoffs are durable and dispatched once like any other.

Factory owns a wake-up for each pending arrival: a fiber in the Runner's scope that sleeps on the Runner's clock
until the stored deadline, then forwards due arrivals, drives the Run and tries to settle it. Wake-ups are
recreated from the stored deadlines whenever a pass finds a pending arrival without one, so startup reschedules
them without shifting a deadline. Every dispatch pass also forwards arrivals that are overdue, which covers
downtime and computer sleep with exactly one forwarding and no catch-up repetitions. Closing the Runner stops the
sleeping wake-ups; the deadlines stay in SQLite. Continue now disables the selected arrival's wake-up
and forwards through that same transaction. A stale wake-up ignores forwarded arrivals, including after restart.
Retries return an already-forwarded conflict without another outcome or delivery. Other arrivals keep their deadlines.
Continue now does not change manual settlement or bypass downstream authorization guards.

A visit a Wait's forwarding causes reads the result whose message waited as its incoming result in
`factory_get_block`, as a visit caused directly by that result does. Pending arrivals keep automatic settlement
waiting and keep a [Settled](#settled-runs) Run reconciled. A Wait shows `waiting` while any arrival is pending
and `finished` afterwards; it raises no attention and wakes no Snoozed Run.

### Human occurrences

Every arrival creates a distinct pending Human occurrence with no T3 thread. Parallel and
repeated arrivals stay independent. An answer names one of the fixed Human exits, `approve` or
`request-changes`; Request changes requires a non-empty message (up to 100,000 characters) and
Approve accepts an optional one. An exact retry of an answer accepted before the Agent-exit upgrade
names the new exit and so conflicts instead of repeating.

Answering atomically records the answer, settles only that occurrence and creates every
outgoing handoff. Identical retries return current detail; changed or competing answers
conflict. The incoming delivery reference keeps the worker origin across restart, answer fan-out and
context clearing; answers forward the person's text, with that origin, through either exit. Pending context is cleared after settlement. A Human Block stays waiting while
any occurrence is pending; it never settles the Run by itself. Archive cancels occurrences
without inventing answers.

## Settled Runs

A Run is Active, Settled or [Archived](#archive). Each reconciliation pass tries to
settle an Active Run with an open gate automatically. That requires all of the following:

- Every visited Block's current activation has its worker's accepted final result with no
  later `working` report, and no attention is pending; every Human occurrence is answered and no
  Wait arrival is pending.
  Unvisited branches need not run.
- Every delivery is acknowledged, with no outstanding launch, handoff or send. Handoffs
  cancelled because their result was replaced, and idle-worker preparations of
  [earlier Runs](#run-workspace), owe no delivery; a rejected launch still holds settlement.
- A fresh read finds every Block's worker thread [finished](#worker-thread-completion).

Engine termination or a final report alone is insufficient. The local decision must still
match the Run generation observed before the reads, its gate, authorization and owner;
concurrent local reports, answers or observations invalidate it. Unavailable or mismatched
reads keep the Run Active. Settling certifies that T3 reported every worker thread finished,
not result quality or a common repository revision. Automatic settlement records
`run-settled` (`automatic`), marks every result version completion-eligible and settles the
Blocks' report-rejection diagnostics.

The user can settle an Active or Snoozed Run at any time (`run-settled`, `manual`). Settling
changes no execution: the gate stays open, owed operations continue and attention stays
pending. Both ways clear Snooze and Woke.

A Settled Run is reconciled only while it owes an operation in pending, reserved or uncertain
state or a pending Wait arrival, so owed handoffs are still released and delivered and Waits still
forward at their deadlines. Otherwise Factory does not read its
worker threads: later turns without a report record no work periods or attention and leave
the Run Settled. Reports, Human answers and Request report are accepted as for an Active Run;
only an accepted report returns it to Active ([report acceptance](#report-acceptance)).

## Archive

Archive is final and completes in one transaction in the Run's lane: it closes the handoff
gate, records the Run Archived, cancels pending launches, handoffs, Human occurrences and Wait
arrivals (without forwarding them), clears pending delivery text and waiting messages, settles pending attention as `archived`, marks activated Blocks
that had not finished `stopped` and clears Snooze and Woke. No report, answer, Wait forwarding, dispatch or
replay crosses the closed gate, and Archived Runs are never reconciled again: in-flight or
uncertain operations keep their recorded state.

After the transaction, in the background and only under the Run's authorization context,
Factory sends one `t3_thread_interrupt` with `stop: true` to every bound worker thread, with a
request key derived from the Run and thread. T3 stops the thread and its delegated work.
Factory neither records nor confirms the outcome, so a backend crash before the request leaves
the threads running. Archive neither rolls back repository edits nor prevents later direct
T3 chat. Closing Factory is not Archive.

Archived Runs are excluded from navigation; every stored row stays and Run detail still
reads them. Runs stopped under an earlier contract keep their Stop events, interrupt
requests and closure evidence as history.

## Owned workers

New Runs have no Run conversation. A historical closed Run may still display a stored
conversation; Factory no longer observes, commands or changes it, also at restart.

- Subagents and background work a worker starts are not Factory obligations. They hold the
  worker's result only through T3's delegated wait answer.
- A failed worker execution stays a Problem until the thread recovers or the Block reports;
  Factory does not launch a replacement worker for it.
- Later turns of the worker thread, including ones after an accepted final, are ordinary
  thread work: they hold release until the thread is finished, and a `finished` report from
  one of them replaces the result under the [report rules](#report-acceptance).
- `factory_get_block` and `factory_get_run` are read-only. `factory_get_run` grants no
  routing authority. Both answer from the Block id even while a launch is still being
  confirmed.

## Manual Request report

**Request report** asks an idle Agent Block without a `finished` result for its current
activation to assess its existing work: one with a missing-report Problem, or one whose latest
report is `working`. It accepts one explicit request per idle run of the Block and queues an
ordinary turn on the same worker, linked to that run and the activation; its message states
the Block id. The request also links the Block's pending missing-report Problem for that run,
if there is one.
Eligibility needs the worker thread [finished](#worker-thread-completion) with that run as its
latest completed run, no `finished` result for the current activation, no unacknowledged
delivery to the Block, unchanged authorization and an open gate; this is checked again before
dispatch. Accepted results or competing work make the request stale; unknown acceptance never
authorizes another key.

A linked missing-report Problem settles only after the linked execution completes and reports
final (or reported waiting before waiting was retired), and the worker thread is finished. The original execution keeps its
missing-report history. A `working` reply simply becomes the Block's latest report.
Recovery can chain through completed reportless turns, but no failure path schedules it
automatically.

## Native thread organization

T3 Settled is separate from Factory attention. When native settle is supported, Factory
best-effort settles a Block's bound worker thread while the Run is still in progress when that
Block's current report is an accepted `finished` result, the [completion rule](#worker-thread-completion)
confirms the worker thread is done, no execution-failed attention is pending on the Block, and
the Run is not [Archived](#archive). A current `working` report, a missing-report Problem, or
open execution-failed attention leaves the thread unsettled. The sweep runs in each
reconciliation pass for Active, Snoozed and [Settled](#settled-runs) Runs that still owe
operations—handoff Blocks, terminal activations and long-running Flows alike.

[Run settlement](#settled-runs) keeps its thread sweep as fallback for threads without
`finished`, and shares one settlement claim keyed on Run, thread and T3 run so no thread is
requested twice. The claimed T3 run is the one that produced the Block's result, not the
thread's latest active run. The claim is recorded before the T3 request is sent; a possibly
issued request is never replayed. A replaced result or changed exit in the same T3 run does not
settle again; a revisited Block that starts a new T3 run on the same thread may be settled
again after it finishes.

Automatic Run settlement settles remaining threads within its reconciliation pass; manual
Settle triggers the Run sweep in the background. Factory never unsettles. New Runs have no Run
conversation to organize, and historical Run conversations are not settled. Runs created
before this behavior was introduced retain Run-level settlement only;
new Runs use per-Block settlement. The migration preserves existing data and does not
reorganize existing threads. Failure changes no results or Run state; without native settle support this is
a no-op. With no native compare-and-set or replay key, direct activity can still race the
request; that existing limitation now applies while the Run is still in progress.

## Navigation and presentation

[Run navigation](runs.md#run-list) lists Active and Settled Runs with their unsettled
attention, without settling any, and leaves out Archived Runs. Snooze, Restore and
acknowledging Woke change presentation only and apply to Active Runs. New attention identities
or an increased pending native count wake a snoozed Run; a replacement request with an
unchanged count is undetectable. Settling and archiving clear snooze and Woke.
