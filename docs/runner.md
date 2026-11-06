# Durable Runner

The Runner turns accepted Starts, reports, Human answers and Stop requests into
durable operations against T3, and decides when a Run is permanently closed. It owns
the SQL tables, transaction boundaries and recovery rules below. Persistence
principles are in [Application foundation](foundation.md#persistence-model); user
behavior is in [Runs](runs.md); live-support limits are in
[Compatibility](installation.md).

## Current execution contract

Every Run uses `run-worker-v1`: explicit MCP reporting (`explicit-mcp-v2`) and coordination
instruction version 5. It is the only execution contract;
migration `049` deleted Runs captured under earlier contracts or reporting protocols.

- One **Run conversation** (P), configured by the Flow's explicit Run coordinator
  setting, receives exact Factory-issued commands and native-delegates directly to one
  **worker** (W) per eligible Block activation. Agent definitions select only the
  worker's provider, model and options.
- Each activation binds its exact worker and executions. W receives the Agent prompt,
  activation input and reporting instructions, asks questions in its own conversation
  and reports its own result. P never reports a Block result or decides a Human step.
- Factory alone owns routing, handoff release, Human occurrences and closure. A completed
  model turn is not a business result. Unknown native acceptance never authorizes
  replacement work. Stop closes dispatch first and requires fresh evidence across the
  whole owned tree and queues.
- A later handoff or Human correction creates a new activation on the same bound worker.
  Waiting and reply turns stay within their activation.

## Start and delivery guarantees

Start checks the connection, project, graph, saved Agent and Run coordinator settings,
reporting installation and launch support. Accepted Start atomically claims the Task slot,
captures the snapshot and records the intended work before contacting T3. An accepted
request key is unique across the database: the same content returns the same Run; changed
content conflicts. Flow input targets start independently and are not handoffs.

A worker is bound only when fresh native evidence proves the exact issued command,
captured selection, parentage, workspace and inherited permission mode. Unknown or
conflicting acceptance holds that command; it never authorizes replacement work.

Delivery can be pending, reserved, acknowledged or uncertain. A crash or lost response
after reservation leaves uncertainty, not a fresh attempt. An acknowledgement proves
acceptance only, not execution or completion. Later arrivals to the same Block wait for
its unresolved command; unrelated branches may continue.

Run again resolves the source snapshot on the backend, validates its captured settings
against current availability and uses the same Task-slot and request-key rules. It never
trusts a client-supplied replacement graph or infers a missing coordinator. The composer
requires the server's creation policy before Start.

## Ownership and restart

Only one backend may own a database. It holds an exclusive OS lock for its lifetime;
a second owner fails startup. Never delete a live lock file. Process exit releases
ownership without a takeover timer. Storage requires local-filesystem locking on macOS
or Linux; network filesystems and remote backend ownership are unsupported.

Startup reconciles every open Run before dispatching. Local changes serialize per Run,
and no SQL transaction spans T3 I/O. Shutdown releases ownership without requesting Stop.

An uncertain launch or send may replay only with the identical saved body, key, target
and authorization context, plus independent operation-specific proof of server continuity
and key retention. The live adapter supplies no such proof by default. A matching version
or OAuth grant is insufficient; launch proof does not authorize send replay. Without proof,
the operation and Task slot remain unresolved with a visible reason. Acknowledged threads
are observed, never relaunched. There is no Resume or fresh-attempt escape hatch.

## Report acceptance

Report authority belongs to the exact worker execution of one activation. The Run
conversation has no Block-report authority. Identity and recipients come from verified
native evidence and the saved snapshot, never model arguments. New reports require an
open gate and fresh active-execution evidence. Acceptance and creation of outgoing
handoffs are durable before the acknowledgement is returned.

- Deduplication is scoped to Run, Block, exact execution and report key. The canonical
  status, exit and message distinguish changed content; omitted fields are null and
  whitespace is preserved. An identical accepted retry returns its stored acknowledgement
  after renewed work, Stop or closure. Reusing a key with changed content is `KEY_CONFLICT`.
- `finished` is immutable and unique per activation; a changed final is `FINAL_CONFLICT`.
  Failed worker executions cannot report (`WORKER_FAILED`), and a final while the worker's
  question is pending requires a reply (`HUMAN_REPLY_REQUIRED`). Reports cannot erase
  engine failure, prove semantic correctness or close a Run.
- Exits must match the captured ID or unambiguous exact name, with non-empty feedback
  when required. Accepted results remain held until the source completion checks pass.
- `waiting` requires a non-empty message and no exit. It is non-final, creates Needs input
  on that worker and releases nothing. Factory never infers a question by parsing chat.
  The user replies in the same T3 conversation; a verified later worker execution resumes
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

A first visit uses the Run conversation's exact worker command; a revisit queues a turn
on the same Block worker after the previous activation clears. Two Blocks using the same
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
- Every delivery is acknowledged, with no outstanding worker command or control recovery.
- The whole Run-owned conversation and worker tree has fresh, complete, quiet evidence.

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

Stop first closes the handoff gate and cancels unsent work, including worker commands and
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

## Run-owned conversation and worker tree

The primary Run conversation never becomes a Block worker or report authority. Whole-Run
safety and activation-scoped worker reporting are separate obligations.

- Native references, child executions, queues and peer membership are retained before
  dependent reads; failed reads or restart never discard them.
- Closure needs every retained exact execution, complete bounded descendant coverage,
  empty queues, no native requests and settled aggregate work. Each sweep may discover
  at most 100 new members; unread members remain obligations.
- A failed, cancelled or interrupted owned control execution blocks successful closure
  and new worker commands until explicit **Recover Run control** succeeds. Recovery needs
  that failed execution to be the latest, an idle primary conversation, empty queues,
  no native requests and complete native evidence. It queues one continuation carrying
  the next unissued command or no new Block work. Later arbitrary chat is not recovery;
  a rolled-back control execution requires Stop.
- Unknown peer membership or inaccessible remote work keeps Stop uncertain. Peer work
  never becomes local execution membership merely because it was discovered.
- A worker final needs fresh provider/model proof against captured Agent settings and
  freezes its activation-scoped native frontier. Unverified proof is
  `ASSESSMENT_UNVERIFIED`. Later work raises attention and holds release without changing
  the accepted final result.
- `factory_context` is read-only and grants no Block or Human authority, including after
  Stop or closure.

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

T3 Settled is separate from Factory closure and attention. Worker threads are best-effort
settled before successful closure; after Finished or Stopped, the primary conversation is
settled only with fresh quiet evidence of no later chat. Factory never unsettles.

A possibly issued settlement is never replayed, protecting manual reopen. Failure does not
change results or closure, and existing closed Runs are not backfilled. With no native
compare-and-set or replay key, direct activity can race the final read.

## Navigation and presentation

[Run navigation](runs.md#run-list-task-history-and-run-again) reflects recorded closure and
unsettled attention without settling either. Snooze, Restore and acknowledging Woke change
presentation only. New attention identities or an increased pending native count wake a
snoozed open Run; a replacement request with an unchanged count is undetectable. Closure
clears snooze and Woke.
