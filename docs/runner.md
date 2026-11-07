# Durable Runner

The Runner turns accepted Starts, reports, Human answers and Stop requests into
durable operations against T3, and decides when a Run is permanently closed. It owns
the SQL tables, transaction boundaries and recovery rules below. Persistence
principles are in [Application foundation](foundation.md#persistence-model); user
behavior is in [Runs](runs.md); live-support limits are in
[Compatibility](installation.md).

## Current execution contract

Factory launches each Agent Block's first visit as its own top-level T3 worker. There is
no Run conversation and no native-delegation turn that copies the Agent. Migration `050`
deletes open Runs captured under the replaced contract. Closed Runs stay readable history.
Snapshots no longer store an execution contract, coordination instruction version or
reporting protocol.

- Each Flow-input Agent starts independently. The worker uses that Agent's captured
  provider, model and options, the project-root workspace, and the runtime mode from T3
  and project defaults. Nothing is inherited from another thread. Two Blocks that share
  one Agent still get separate workers.
- The saved launch title is `Factory #<number> · <block position> <Block name>`, sliced to
  200 characters. The number is a durable Run sequence. The position is the 1-based index
  in the captured block list. Later renames do not change the title recovery searches for.
- The first message starts with `$factory-block`. The worker calls `factory_get_block`,
  then `factory_update_block`. `factory_get_run` is read-only and grants no routing
  authority. Subagents do not call Factory tools.
- Factory alone owns routing, handoff release, Human occurrences, Stop and closure. A
  completed model turn is not a business result. A definitive launch rejection is an
  error. An uncertain launch is recovered by search, never by another launch.
- A later handoff or Human correction creates a new activation on the same bound worker.
  Waiting stays on that worker until a positively attributed user reply in the same thread
  resumes it.

## Start and delivery guarantees

Start checks the connection, project, graph, saved Agent settings, the `$factory-block`
skill, reporting installation and launch support. It does not require a Run coordinator.
Accepted Start atomically claims the Task slot, assigns the Run number, captures the
snapshot and records each launch intent before contacting T3. An accepted request key is
unique across the database: the same content returns the same Run; changed content
conflicts. Flow input targets start independently and are not handoffs.

A worker is bound from the launch acknowledgement, or from exactly one search candidate
whose title matches and whose thread, workspace, provider, model, options and execution
match the saved launch. Title alone is not ownership. An empty, delayed or ambiguous
search never causes another launch or a guessed binding. An unresolved launch stays
visible, blocks closure and release, and resumes after restart.

Delivery can be pending, reserved, acknowledged or uncertain. A crash or lost response
after reservation leaves uncertainty, not a fresh attempt. An acknowledgement proves
acceptance only, not execution or completion. Later arrivals to the same Block wait for
its unresolved launch; unrelated branches may continue.

Run again resolves the source snapshot on the backend, validates its captured settings
against current availability and uses the same Task-slot and request-key rules. It never
trusts a client-supplied replacement graph. The composer requires the server's creation
policy before Start.

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
non-string parent, or a missing workspace withholds the search; neither is treated as a
top-level worker at the project root. The first search is
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

Report authority belongs to the exact worker execution of one activation. There is no Run
conversation. Identity and recipients come from verified
native evidence and the saved snapshot, never model arguments. New reports require an
open gate and fresh active-execution evidence. Acceptance and creation of outgoing
handoffs are durable before the acknowledgement is returned.

- Deduplication is scoped to Run, Block, exact execution and report key. The canonical
  status, exit and message distinguish changed content; omitted fields are null and
  whitespace is preserved. An identical accepted retry returns its stored acknowledgement
  after renewed work, Stop or closure. Reusing a key with changed content is `KEY_CONFLICT`.
  A conflict reply includes the current Block state, `allowedTransitions` and `allowedExits`.
- `finished` is immutable and unique per activation; a changed final is `FINAL_CONFLICT`.
  Failed worker executions cannot report (`WORKER_FAILED`), and a final while the worker's
  question is pending requires a reply (`HUMAN_REPLY_REQUIRED`). Reports cannot erase
  engine failure, prove semantic correctness or close a Run.
- Exits must match the captured ID or unambiguous exact name, with non-empty feedback
  when required. Accepted results remain held until the source completion checks pass.
- `waiting` requires a non-empty message and no exit. It is non-final, creates Needs input
  on that worker and releases nothing. Factory never infers a question by parsing chat.
  The user replies in the same worker thread; a verified later worker execution resumes
  the activation and reports for itself. Within one execution waiting → finished is allowed
  with a fresh key, while finished → waiting conflicts.
- Earlier waiting history does not prevent closure once the activation has a final result
  and all completion checks pass. A latest waiting report keeps it open. An incoming
  handoff can take over a waiting conversation like a reply.

Report metadata retains keys, fingerprints and references, not a second message archive.
[Caller correlation](t3-integration.md#bridge-and-caller-correlation) defines the native
attribution requirements.

## Observation and attention

Engine status, report status, native requests and freshness are independent facts. Each
recorded execution needs exact coverage; a missing one cannot be replaced by the latest
execution. New executions require explicit active/latest identity and increasing public
ordinals, not array order. Positive native references remain obligations through failed
reads, lost responses and restart. An unavailable observation preserves prior facts,
marks them stale and cannot authorize work or closure.

- Completed latest work without a report or pending native request shows a missing-report
  Problem. Native attention defers that classification until it clears.
- Failed, cancelled or interrupted work shows an execution-failed Problem. Renewed work
  does not dismiss earlier Problems, and Factory never retries failed work automatically.
- Native attention includes questions and permissions. Only a fresh independently read
  zero pending count withdraws it; unavailable reads keep it pending. Reappearance creates
  a new matter. A pending-request listing that omits permissions cannot prove zero.

Events retain causal identities, execution transitions and observation times. Unchanged
polls add no events; observation-only times are approximate. There is no transcript archive.

## Routing and independent queues

Each validated recipient of an accepted final result gets an independent handoff. Agent
handoffs stay held until fresh evidence proves the source activation's accepted result,
released work frontier, completed executions, empty queues and no native requests. The
owner, authorization, gate and local generation must still match when release is recorded.
A historical completion timestamp alone is insufficient. Saved presentation evidence grants
neither release nor new work. A Human answer directly authorizes its outgoing handoffs.

A first visit launches that Block's own top-level worker. The message is `$factory-block`
followed by the captured Agent prompt. A revisit queues a turn on the same worker after
the previous activation clears. Two Blocks using the same
Agent still have separate workers. Parallel arrivals never join or batch their feedback.
Threads share the project-root checkout; Factory guarantees neither edit-conflict handling
nor agreement on one repository revision.

Partial fan-out survives restart. Each pending delivery retains its own body until
acknowledged; keys, fingerprints, targets and references remain afterwards. Initial input
and captured prompts are retained intentionally. Payload clearing is logical deletion,
not secure erasure.

### Human occurrences

Every arrival creates a distinct pending Human occurrence with no T3 thread. Parallel and
repeated arrivals stay independent. Answers validate against the snapshot: a sole exit may
be omitted, multiple exits require a configured ID, and feedback is required only when
that exit demands it (up to 100,000 characters).

Answering atomically records the answer, settles only that occurrence and creates every
outgoing handoff. Identical retries return current detail; changed or competing answers
conflict. Pending context is cleared after settlement. A Human Block stays waiting while
any occurrence is pending; it never closes the Run by itself. Stop cancels occurrences
without inventing answers.

## Closure

Successful closure requires all of the following:

- Every visited activation has its worker's accepted final result, a released frontier
  and no Problem; every Human occurrence is answered. Unvisited branches need not run.
- Every recorded or observed worker and descendant execution completed, except failures
  settled by their verified assessment; queues and native requests are empty.
- Every delivery is acknowledged, with no outstanding launch, handoff or send.
- Every retained worker and descendant has fresh, complete, quiet evidence.

Engine termination, a final report or an aggregate settlement alone is insufficient.
Before closure, native thread settlement is best effort and a fresh frontier is checked
again. The confirmation must still match the observed Run generation, gate, authorization
and owner; concurrent local reports or answers invalidate it. Only durable confirmation
records Finished or Stopped and releases the Task slot. Closure evidence is immutable.

Bounded, unavailable or mismatched reads that miss any recorded execution, queue or native
request keep the Run open. Reads across T3 threads are not an atomic cutoff: direct chat
can arrive between observation and local confirmation. Closure certifies an observed
frontier, not result quality or a common repository revision.

Closed Runs never dispatch, reopen or extend their history after later T3 activity.
New reports and Human answers are rejected; an identical accepted report retry can still
return its original acknowledgement.

## Gate-first Stop

Stop first closes the handoff gate and cancels unsent work, including launches, handoffs and
pending Human occurrences. No new report, answer, dispatch or replay may cross that gate.
In-flight or uncertain pre-Stop operations stay unresolved until their outcomes are known;
Stop can close the gate while T3 I/O is still in flight.

Factory durably records tree-interrupt and queue-cancel requests before sending them.
Tree Stop addresses the thread and delegated work, not an exact execution fence. Queue
cancellation uses the exact queued execution identity. Peer members are stopped in their
own environment. Acknowledgements do not prove termination.

Stopped closure requires a later fresh sweep covering the full tree after the Stop
requests, terminal executions, empty queues and native requests, all operations acknowledged
or locally cancelled, and unchanged local state. Incomplete evidence, changed authorization
or unknown pre-Stop outcomes keep Stop uncertain and the Task occupied through restart.
Reconciliation continues automatically.

Confirmed Stop preserves finished and unvisited Blocks, marks unfinished activated Blocks
stopped and settles remaining attention as cancelled-on-Stop. Stop neither rolls back
repository edits nor prevents later direct T3 chat. Closing Factory is not Stop.

## Owned workers

New Runs have no Run conversation. Each Factory-launched worker, and every descendant
Factory has retained, carries its own safety and reporting obligations. A historical
closed Run may still display a stored conversation.

- Native references, child executions, queues and peer membership are retained before
  dependent reads; failed reads or restart never discard them.
- Closure needs every retained exact execution, complete bounded descendant coverage,
  empty queues, no native requests and settled aggregate work. Each sweep may discover
  at most 100 new members; unread members remain obligations.
- Factory does not recover a Run conversation or issue root commands. A failed worker
  execution stays a Problem; Factory does not launch a replacement worker for it.
- Unknown peer membership or inaccessible remote work keeps Stop uncertain. Peer work
  never becomes local execution membership merely because it was discovered.
- A worker final needs fresh provider/model proof against captured Agent settings and
  freezes its activation-scoped native frontier. Unverified proof is
  `ASSESSMENT_UNVERIFIED`. Later work raises attention and holds release without changing
  the accepted final result.
- `factory_get_block` and `factory_get_run` are read-only. `factory_get_run` grants no
  routing authority. Before the worker is bound, a proven in-flight launch returns
  `BINDING_PENDING` with `retryAfterMs`; that wait grants no authority. A title match,
  subagent or unseen call id does not.

## Manual missing-report recovery

**Request report** accepts one explicit recovery per missing-report occurrence. It queues
an ordinary turn on the same worker, linked to the original exact execution and activation.
Eligibility needs fresh execution, queue and native coverage, latest identity, unchanged
authorization and an open gate. Accepted results or competing work make the request stale;
unknown acceptance never authorizes another key.

Recovery settles the original missing-report attention only after the linked execution
completes, reports final or waiting, and has no active, queued or native work. The original
execution keeps its missing-report history; closure exempts only that linked obligation.
Recovery can chain through completed reportless turns, but no failure path schedules it
automatically.

## Native thread organization

T3 Settled is separate from Factory closure and attention. When native settle is supported,
Factory best-effort settles each worker in the closure frontier before recording Finished.
New Runs have no Run conversation to organize. A historical Run that still has an
acknowledged coordinator row can settle that thread after closure. Factory never unsettles.

A possibly issued settlement is never replayed, protecting manual reopen. Failure does not
change results or closure, and existing closed Runs are not backfilled. With no native
compare-and-set or replay key, direct activity can race the final read.

## Navigation and presentation

[Run navigation](runs.md#run-list-task-history-and-run-again) reflects recorded closure and
unsettled attention without settling either. Snooze, Restore and acknowledging Woke change
presentation only. New attention identities or an increased pending native count wake a
snoozed open Run; a replacement request with an unchanged count is undetectable. Closure
clears snooze and Woke.
