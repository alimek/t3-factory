# Durable Runner

The Runner turns accepted Starts, reports, Human answers and Stop requests into
durable operations against T3, and decides when a Run is permanently closed. It owns
the SQL tables, transaction boundaries and recovery rules below. Persistence
principles are in [Application foundation](foundation.md#persistence-model); user
behavior is in [Runs](runs.md); live-support limits are in
[Compatibility](installation.md).

## Current execution contract

Factory launches each Agent Block's first visit as its own top-level T3 worker. There is
no Run conversation and no native-delegation turn that copies the Agent. Migrations `050`
and `058` delete open Runs captured under replaced contracts. Closed Runs stay readable history.
Captured definitions carry no execution contract, coordination instruction version or
reporting protocol.

- Each Flow-input Agent starts independently. The worker uses that Agent's captured
  provider, model and options, the project-root workspace, and the runtime mode from T3
  and project defaults. Nothing is inherited from another thread. Two Blocks that share
  one Agent still get separate workers.
- The saved launch title is `Factory #<number> · <block position> <Block name>`, sliced to
  200 characters. The number is a durable Run sequence. The position is the 1-based index
  in the captured block list. Later renames do not change the title recovery searches for.
- Start mints a **Block id** for each Agent Block. The first message starts with
  `$factory-block`, then a `Factory Block id: <id>.` line; every later visit and Request
  report message repeats the same id. The worker passes it to `factory_get_block`, then
  `factory_update_block`. `factory_get_run` is read-only and grants no routing authority.
  Subagents do not call Factory tools.
- Factory alone owns routing, handoff release, Human occurrences, Stop and closure. A
  completed model turn is not a business result. A definitive launch rejection is an
  error. An uncertain launch is recovered by search, never by another launch.
- A later handoff or Human correction creates a new activation on the same bound worker.
  Waiting stays on that worker until a later turn in the same thread resumes it.

## Start and delivery guarantees

Start checks the connection, project, graph, saved Agent settings, the `$factory-block`
skill, reporting installation and launch support. It does not require a Run coordinator.
Accepted Start atomically creates the Run's Task, assigns the Run number, references the
Flow revision and freezes the current revision of each referenced Agent, and records each
launch intent before contacting T3. An accepted request key is
unique across the database: the same content returns the same Run; changed content
conflicts. Content is the project, Flow, input, title and creation time. Rejected requests record nothing, and the
accepted key is also the Run's navigation creation key. Flow input targets start independently and are not handoffs.

A worker is bound from the launch acknowledgement, or from exactly one search candidate
whose title matches and whose thread, workspace, provider, model, options and execution
match the saved launch. Title alone is not ownership. An empty, delayed or ambiguous
search never causes another launch or a guessed binding. An unresolved launch stays
visible, blocks closure and release, and resumes after restart.

Delivery can be pending, reserved, acknowledged or uncertain. A crash or lost response
after reservation leaves uncertainty, not a fresh attempt. An acknowledgement proves
acceptance only, not execution or completion. Later arrivals to the same Block wait for
its unresolved launch; unrelated branches may continue.

Start always resolves the current saved Flow and Agents on the backend; it never trusts a
client-supplied graph or launches from an earlier Run's captured revisions. The composer requires the
server's creation policy before Start.

## Ownership and restart

Only one backend may own a database. It holds an exclusive OS lock for its lifetime;
a second owner fails startup. Never delete a live lock file. Process exit releases
ownership without a takeover timer. Storage requires local-filesystem locking on macOS
or Linux; network filesystems and remote backend ownership are unsupported.

Startup reconciles every open Run before dispatching. Local changes serialize per Run,
and no SQL transaction spans T3 I/O. Shutdown releases ownership without requesting Stop.

An uncertain worker launch is never replayed, including with the same key. While Factory
is running, recovery searches the same T3 environment and project for the saved title,
then binds only a uniquely verified thread and its exact execution. A missing parent, a
non-string parent, or a missing workspace withholds the search. T3 reports a project-checkout
thread with a null workspace, and that null matches a root-strategy launch. Any other
workspace must equal the Run's project root. The first search is
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
- `finished` is unique per activation. An identical repeat returns the stored
  acknowledgement, also after Stop or closure; a changed final is `FINAL_CONFLICT` with the
  current Block state and `allowedExits`. Reports cannot erase engine failure, prove
  semantic correctness or close a Run. A new report on a closed Run is `RUN_CLOSED`.
- Exits must match the captured ID or unambiguous exact name, with non-empty feedback
  when required. Accepted results remain held until the
  [handoff release](#routing-and-independent-queues) rule passes.
- `waiting` requires a non-empty message and no exit. It is non-final, creates Needs input
  on that worker and releases nothing. Factory never infers a question by parsing chat.
  The user replies in the same worker thread. Any later turn of that thread settles the
  question; the worker reports again from that turn. A newer `waiting` replaces the pending
  question, an identical one returns its acknowledgement, and `finished` settles it. A later
  accepted report settles earlier missing-report and execution-failed attention on the Block.
- Earlier waiting history does not prevent closure once the activation has a final result
  and its worker thread is finished. A pending question keeps it open. An incoming handoff can
  take over a waiting conversation like a reply.

Report metadata retains fingerprints and references, not a second message archive.
[Block ids](t3-integration.md#factory-mcp-and-block-ids) defines the tool contract.

## Worker thread completion

Factory trusts T3 to say when a Block's worker thread is finished. One shared rule decides it,
and handoff release, missing report, closure, Stop and Request report all use it. A worker
thread is finished when all of these hold:

- the `t3_thread_read` of the thread shows no active run and zero pending native requests;
- `t3_thread_wait` for its latest run, with `timeoutMs: 0` and
  `untilDelegatedWorkSettled: true`, answers that thread and run with a terminal status
  (`completed`, `failed`, `cancelled` or `interrupted`) and `timedOut: false`.

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
  Block's current activation has neither a `finished` result nor a pending question, the
  Block shows a missing-report Problem for that run. The Problem persists through later
  runs until the Block reports or a linked Request report settles it.
- **Execution failure.** When the latest run of the thread failed, was cancelled or was
  interrupted, the Block shows an execution-failed Problem for that run. It settles when a
  later run of the same thread completes or when the Block reports. Factory never retries
  failed work automatically.
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
recorded. Release is recorded once per activation and is never re-derived from saved
presentation data. A Human answer directly authorizes its outgoing handoffs.

A first visit launches that Block's own top-level worker. The message is `$factory-block`
followed by the captured Agent prompt. A revisit queues a turn on the same worker after
the previous activation's result is released and, at send time, the worker thread is
finished. Two Blocks using the same
Agent still have separate workers. Parallel arrivals never join or batch their feedback.
Threads share the project-root checkout; Factory guarantees neither edit-conflict handling
nor agreement on one repository revision.

Partial fan-out survives restart. Each pending delivery retains its own body until
acknowledged; keys, fingerprints, targets and references remain afterwards. Initial input
and captured prompts are retained intentionally. Payload clearing is logical deletion,
not secure erasure.

### Human occurrences

Every arrival creates a distinct pending Human occurrence with no T3 thread. Parallel and
repeated arrivals stay independent. Answers validate against the Run's captured Flow revision: a sole exit may
be omitted, multiple exits require a configured ID, and feedback is required only when
that exit demands it (up to 100,000 characters).

Answering atomically records the answer, settles only that occurrence and creates every
outgoing handoff. Identical retries return current detail; changed or competing answers
conflict. Pending context is cleared after settlement. A Human Block stays waiting while
any occurrence is pending; it never closes the Run by itself. Stop cancels occurrences
without inventing answers.

## Closure

Successful closure requires all of the following:

- Every visited Block's current activation has its worker's accepted final result and no
  attention is pending; every Human occurrence is answered. Unvisited branches need not run.
- Every delivery is acknowledged, with no outstanding launch, handoff or send.
- A fresh read finds every Block's worker thread [finished](#worker-thread-completion), with
  no failed latest run.

Engine termination or a final report alone is insufficient. Before closure, native thread
settlement is best effort and every worker thread is read again. The confirmation must still
match the observed Run generation, gate, authorization and owner; concurrent local reports or
answers invalidate it. Only durable confirmation records Finished or Stopped, together with
each worker thread as observed. Closure evidence is immutable.

Unavailable or mismatched reads keep the Run open. Closure certifies that T3 reported every
worker thread finished, not result quality or a common repository revision.

Closed Runs never dispatch, reopen or extend their history after later T3 activity.
New reports and Human answers are rejected; an identical accepted report retry can still
return its original acknowledgement.

## Gate-first Stop

Stop first closes the handoff gate and cancels unsent work, including launches, handoffs and
pending Human occurrences. No new report, answer, dispatch or replay may cross that gate.
In-flight or uncertain pre-Stop operations stay unresolved until their outcomes are known;
Stop can close the gate while T3 I/O is still in flight.

Each pass reads every Block's worker thread. For each thread that is not finished, Factory
durably records one interrupt request per thread and latest run, then sends
`t3_thread_interrupt` with `stop: true`. T3 stops the thread and its delegated work without an
execution fence, so a run that starts later gets its own request. Acknowledgements do not
prove termination.

Stopped closure requires a later pass, after any interrupt request, in which every worker
thread is finished, every operation is acknowledged or locally cancelled and local state is
unchanged. Unavailable reads or unknown pre-Stop outcomes keep Stop uncertain and the Task
occupied through restart. Reconciliation continues automatically.

Confirmed Stop preserves finished and unvisited Blocks, marks unfinished activated Blocks
stopped and settles remaining attention as cancelled-on-Stop. Stop neither rolls back
repository edits nor prevents later direct T3 chat. Closing Factory is not Stop.

## Owned workers

New Runs have no Run conversation. A historical closed Run may still display a stored
conversation; Factory no longer observes or commands it.

- Subagents and background work a worker starts are not Factory obligations. They hold the
  worker's result only through T3's delegated wait answer.
- A failed worker execution stays a Problem until the thread recovers or the Block reports;
  Factory does not launch a replacement worker for it.
- Later turns of the worker thread, including ones after an accepted final, are ordinary
  thread work: they hold release until the thread is finished and never replace the
  accepted result.
- `factory_get_block` and `factory_get_run` are read-only. `factory_get_run` grants no
  routing authority. Both answer from the Block id even while a launch is still being
  confirmed.

## Manual missing-report recovery

**Request report** accepts one explicit recovery per missing-report occurrence. It queues
an ordinary turn on the same worker, linked to the original execution and activation; its
message states the Block id.
Eligibility needs the worker thread [finished](#worker-thread-completion) with the reportless
run as its latest completed run, unchanged authorization and an open gate; this is checked
again before dispatch. Accepted results or competing work make the request stale; unknown
acceptance never authorizes another key.

Recovery settles the original missing-report attention only after the linked execution
completes and reports final or waiting, and the worker thread is finished. The original
execution keeps its missing-report history.
Recovery can chain through completed reportless turns, but no failure path schedules it
automatically.

## Native thread organization

T3 Settled is separate from Factory closure and attention. When native settle is supported,
Factory best-effort settles each worker thread before recording Finished. New Runs have no
Run conversation to organize, and historical Run conversations are not settled after
closure. Factory never unsettles.

A possibly issued settlement is never replayed, protecting manual reopen. Failure does not
change results or closure, and existing closed Runs are not backfilled. With no native
compare-and-set or replay key, direct activity can race the final read.

## Navigation and presentation

[Run navigation](runs.md#run-list) reflects recorded closure and
unsettled attention without settling either. Snooze, Restore and acknowledging Woke change
presentation only. New attention identities or an increased pending native count wake a
snoozed open Run; a replacement request with an unchanged count is undetectable. Closure
clears snooze and Woke.
