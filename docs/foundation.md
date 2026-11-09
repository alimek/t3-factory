# Application foundation

## Workspace boundaries

Factory separates the browser UI, authoritative backend and desktop shell. Shared contracts
and validation have no application or I/O dependencies; clients may validate early, but the
backend remains authoritative. Shared contracts also declare the desktop bridge between the
renderer and the desktop shell. The desktop shell owns host lifecycle and client transport,
not business rules. T3 owns external execution; Factory owns Flow routing and Run state.

## Persistence model

Factory stores current definitions with revisions plus an execution log in SQLite. It is
neither full event sourcing nor a mirror of T3 conversations. Configuration, the database
and restricted OAuth credentials live outside project repositories.

- Agent and Flow definitions are editable. Saves compare revisions; stale writes conflict.
  Structural validity permits incomplete drafts, while readiness is a separate launch gate.
  Each Flow save appends an immutable relational revision and each Agent save an immutable
  Agent revision; removing either hides it from Studio and Start but keeps its revisions.
- Start atomically records the Run input, references the current Flow revision and freezes
  the current revision of every Agent that Flow references, including blocks it may never
  visit; each Agent activation references that frozen revision. Runs keep no separate copy:
  execution, recovery and Run history read these revisions, so later edits and removals
  cannot rewrite history.
  External skill files are not frozen. Agent revisions hold the Agent's exits and Flow revisions
  hold each Agent block's hidden and Flow-local exits, so a Run's block exits come from the same
  frozen revisions. Migration `072` converted every stored Flow revision, including those Runs
  captured: Agents started with no exits, Agent block exits became Flow-local with the same IDs,
  and Human exits became Approve or Request changes by their feedback flag, with their wires,
  answers and handoffs following. Earlier Human exit names are not kept.
- Run images are bytes on disk under `FACTORY_HOME/images`, named by their SHA-256 digest, with
  staging metadata in SQLite. Start attaches the ordered manifest to the Run; the prompt segments
  and manifest are immutable and the Run's input keeps the worker-readable text. Migration `071`
  gives every existing Run one text segment and no images.
- Each Start creates a new Task, Run and threads. A Settled Run returns to Active when one of
  its Blocks reports; Archived Runs are final and never reopened.
- A Block reuses its worker conversation across visits. Exact execution identity, report
  status, engine status and observation freshness remain separate facts.
- External delivery records retain the exact request, target, key and authorization
  context needed to resolve uncertain outcomes. An acknowledgement is not completion.
- Reports name their Block by the Block id Factory issued; Run and Block identity never come
  from other model-supplied references.
  Attention settlement and the Run's Settled and Archived states remain separate, with cancelled Human work never
  represented as an answer.

**Transactions and restart.** One backend owns a database. Start, reports, Human answers,
delivery reservations, settling and Archive have atomic durable boundaries before their effects
are acknowledged. Local mutations serialize per Run, and SQL transactions never span
network I/O. Restart reconciles open Runs before dispatching. Uncertain operations are not
new attempts, and failed Agent work is never retried automatically; see
[ownership and recovery](runner.md#ownership-and-restart).

**Retention.** History, input, revisions, events, deduplication metadata and closure evidence
are kept indefinitely. Message payloads persist only while needed for pending Human context,
uncertain delivery or recovery, then are cleared while keys, fingerprints and references
remain. Initial input, including its images, and revision prompts are intentional exceptions;
staged images no Run references are deleted after 24 hours. There is no
transcript archive, and payload clearing is not secure erasure.

## Public operations

The public Factory API is the behavioral boundary for HTTP clients and integration tests.
`openFactory({ databasePath })` acquires ownership, opens SQLite with foreign keys, WAL and
full synchronous durability, and applies pending migrations before exposing operations.
Always close it with `await factory.close()`.

Operations return either a value or an error with `code`, `message` and field-addressed
issues. Storage failures are sanitized at this boundary. Validate untrusted input here;
keep transports limited to translating requests and responses. Product routes are shared
by host and approved clients, with explicit [host-only boundaries](desktop-and-clients.md#two-listeners-two-trust-domains).

## Live delivery

Run detail, sidebar navigation, shared T3 connection status and the Run composer's launch
choices use typed Effect RPC streams over WebSocket at `/api/live`; commands and other reads
remain HTTP operations. A window holds one connection-status subscription, one view
subscription carrying navigation and its open Runs, and, while the composer is shown, one
launch-choices subscription carrying the Project catalog and Flows with their readiness. Each read of a view covers navigation and those Runs in one
read transaction, and its changes travel in one delivery that the window applies at once,
so one commit's lifecycle, attention and report changes appear together in Run detail and
the sidebar. Opening or leaving a Run resubscribes the view with a fresh joint snapshot.
Each subscription starts with an authoritative snapshot, followed by committed changes. The
owning modules publish only after a successful durable commit, or an authoritative
in-memory connection or project-discovery transition. This covers reports, including
committed rejection diagnostics, as well as background observation, recovery and lifecycle
changes. Flow and Agent writes, project observation and selection, discovery problems and
connection transitions mark launch choices; Run changes do not. Each read of launch choices
covers the catalog and Flows in one read transaction and does not wait for a running
project reconcile, whose own publications would otherwise leave that read not current.
Subscription registration precedes the snapshot read. A relevant hint during that read
triggers a fresh read, up to three reads. A delivery is current only when no relevant
change arrived while it was read and no later read failed; a scope counts as synchronized,
and mutations are enabled, only while its latest applied delivery is current. A snapshot
or a later read raced by another commit stays unsynchronized until its catch-up arrives, and
a failed re-read keeps the last value, marks the scope unsynchronized and retries. An unknown
Run is final for that Run only, as is a Run beyond the view's capacity of 20 Runs per window;
any other refused subscription is retried with backoff and keeps mutations disabled.

Delivery replaces changed entities or logical sections by stable identity, sends navigation
upserts/removals and appends timeline entries by sequence. Worker executions use the pair
of binding id and execution id, including observation metadata, so later turns preserve
earlier executions. Observation-only timestamps of Runs and projects
travel as compact metadata rather than repeated Run or catalog data. Changes may coalesce into the
latest committed state; delivery is not a record of every intermediate state, but preserves
recorded timeline history.

Pending change hints are bounded to one dirty marker per subscription. Slow consumers
re-read committed state against the last value sent rather than accumulating a queue of
changes, and publication never waits for network delivery or turns an accepted mutation
into a failure. Snapshots and retained Run history still grow with the underlying data;
this is not a fixed byte limit on a Run or a durable delivery log.

Every reconnect or visibility gap starts fresh snapshots for active scopes. There is no
replay cursor or polling fallback for these consumers, and reconnect never replays commands.
Obsolete subscriptions cannot replace the current view. Runner observation, dispatch,
recovery and handoff scheduling belong to the server: zero subscribers stop no execution,
and additional subscribers create no additional Runner schedules. See [Run viewing](runs.md#live-viewing)
and [transport admission](desktop-and-clients.md#two-listeners-two-trust-domains).

## SQL migrations

Add the next unique `NNN_description.sql` under `apps/backend/src/migrations/`; never edit
a released migration. Each chunk contains **one SQLite statement**, separated by the exact
`-- statement-breakpoint` line. Do not add `BEGIN` or `COMMIT`: the migrator owns the
transaction. An unknown migration ledger fails closed.

Persisted JSON (operational payloads, evidence and Agent model options) is versioned like
the schema. Flow graphs and Run definitions are not stored as JSON: Flow and Agent revisions
are relational rows that Runs reference, so changing their shape is an ordinary SQL migration
over current and historical revisions. Such a migration converts every revision in place under
the guard rule below; it never appends, renumbers or drops revisions, because Runs reference
them. A JSON shape change needs a migration that rewrites stored data and a
[frozen-fixture upgrade test](../apps/backend/test/fixtures/README.md). Preserve records by
converting them to the current shape unless the user explicitly accepts discarding the
affected data. An accepted removal still needs a migration and an upgrade test proving
both the deletion and preservation of unaffected data. Record retained/lost data and any
operator action in the PR and update support limits.

A reset must be explicit, never a fallback after upgrade failure. The application reads
only the current shape; old-shape readers and dual-write paths do not replace migrations.
When rewriting immutable history, temporarily remove its guard and restore the identical
guard within the same migration. Upgrade tests restore genuine captured data and assert
public results; they never edit current data to fabricate an old contract. See the
[upgrade baseline policy](testing.md#database-upgrade-baseline).

## UI routes

Settings and Studio open over the current Run or composer. Closing them returns to that
screen with its draft intact; direct links fall back to `/runs/new` in a fresh session.
[Studio](studio.md) and [Keyboard shortcuts](keyboard-shortcuts.md) document navigation and
unsaved-change guards. Direct URLs must also work on reload.

Browser storage is optional: blocked or malformed storage must leave in-memory preferences
usable and must not turn a confirmed Start into an unknown outcome. Shortcut schema
changes must migrate or explicitly invalidate saved preferences under the
[current-contract policy](../AGENTS.md#one-current-contract). The composer retains an
unknown Start's identical key and payload for an explicit check, across reloads when
storage allows; only confirmed success clears its prompt. Run drafts are client-local
preparation in browser storage, never backend records: metadata in localStorage and image
bytes in IndexedDB, keyed by selected server, draft and image. Drafts and pending requests
saved before images become one text segment with the same request identity. Blocked storage
shows that a draft lasts only while the window is open. Client-local state that belongs
to a server is scoped by that server: browsers are isolated by origin, while the desktop
renderer shares one origin and names its role and selected server. Backend idempotency
remains authoritative.

The UI must work over plain HTTP on a LAN or Tailscale address as well as loopback.
Browser APIs requiring a secure context must not be the only way to generate identifiers.
Canvas routing and viewport geometry are transient; pan, zoom and live updates never modify
saved definitions or the revisions a Run captured. Authoring positions change only through explicit
edits or Auto-arrange followed by Save; see [canvas behavior](studio.md#automatic-layout-and-canvas-view).
