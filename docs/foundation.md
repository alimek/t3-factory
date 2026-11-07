# Application foundation

## Workspace boundaries

Factory separates the browser UI, authoritative backend and desktop shell. Shared contracts
and validation have no application or I/O dependencies; clients may validate early, but the
backend remains authoritative. The desktop shell owns host lifecycle and client transport,
not business rules. T3 owns external execution; Factory owns Flow routing and Run state.

## Persistence model

Factory stores current definitions with revisions plus an execution log in SQLite. It is
neither full event sourcing nor a mirror of T3 conversations. Configuration, the database
and restricted OAuth credentials live outside project repositories.

- Agent and Flow definitions are editable. Saves compare revisions; stale writes conflict.
  Structural validity permits incomplete drafts, while readiness is a separate launch gate.
  Each Flow save appends an immutable relational revision and each Agent save an immutable
  Agent revision; removing either hides it from Studio and Start but keeps its revisions.
- Start atomically captures the Run input, full Flow graph and referenced Agent prompts,
  settings, labels and revisions. The Run references its Flow revision and freezes the
  current revision of every Agent that Flow references, including blocks it may never
  visit; each Agent activation references that frozen revision. Later definition changes
  cannot rewrite history.
  External skill files are not frozen.
- Each Start creates a new Task, Run and threads; a Task never has more than one
  non-closed Run, and closed Runs are never reopened.
- A Block reuses its worker conversation across visits. Exact execution identity, report
  status, engine status and observation freshness remain separate facts.
- External delivery records retain the exact request, target, key and authorization
  context needed to resolve uncertain outcomes. An acknowledgement is not completion.
- Reports derive identity from verified native evidence, never model-supplied references.
  Attention settlement and Run closure remain separate, with cancelled Human work never
  represented as an answer.

**Transactions and restart.** One backend owns a database. Start, reports, Human answers,
delivery reservations, Stop and closure have atomic durable boundaries before their effects
are acknowledged. Local mutations serialize per Run, and SQL transactions never span
network I/O. Restart reconciles open Runs before dispatching. Uncertain operations are not
new attempts, and failed Agent work is never retried automatically; see
[ownership and recovery](runner.md#ownership-and-restart).

**Retention.** History, input, snapshots, events, deduplication metadata and closure evidence
are kept indefinitely. Message payloads persist only while needed for pending Human context,
uncertain delivery or recovery, then are cleared while keys, fingerprints and references
remain. Initial input and prompt snapshots are intentional exceptions. There is no
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

## SQL migrations

Add the next unique `NNN_description.sql` under `apps/backend/src/migrations/`; never edit
a released migration. Each chunk contains **one SQLite statement**, separated by the exact
`-- statement-breakpoint` line. Do not add `BEGIN` or `COMMIT`: the migrator owns the
transaction. An unknown migration ledger fails closed.

Persisted JSON (Run snapshots and payloads) is versioned like the schema.
A shape change needs a migration that rewrites stored data and a
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
preparation in browser storage, never backend records, and blocked storage shows that a
draft lasts only while the window is open. Client-local state that belongs
to a server is scoped by that server: browsers are isolated by origin, while the desktop
renderer shares one origin and names its role and selected server. Backend idempotency
remains authoritative.

The UI must work over plain HTTP on a LAN or Tailscale address as well as loopback.
Browser APIs requiring a secure context must not be the only way to generate identifiers.
Canvas routing and viewport geometry are transient; pan, zoom and polling never modify
saved definitions or Run snapshots. Authoring positions change only through explicit
edits or Auto-arrange followed by Save; see [canvas behavior](studio.md#automatic-layout-and-canvas-view).
