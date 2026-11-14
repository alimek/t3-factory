# Test fixtures

## T3 worker activity provenance

[`t3-worker-activity.ts`](t3-worker-activity.ts) is a reduced, anonymized `t3_thread_read`
response read on 2026-11-07 from an existing Factory-launched Codex worker. No new
model workload was started. The native delegation item was also read by exact item
ID with `maxCharsPerItem: 50000` to obtain its complete envelope. The T3 build version
was not recorded; this sample establishes response shapes, not provider qualification.

The sample retains the nested thread, null checkout workspace, newest-first execution
ordinals, a failed Factory read, a direct user reply with omitted `senderThreadId`,
native delegation and a continuation notification with null actor/source metadata.
Only three executions and four activity items are retained; their original positions
and pagination metadata remain. Identifiers, links, provider-instance identity,
task title, task text and message text were replaced with public fixture values.
Delegation selections, omitted input options/request key, empty returned options,
statuses, timestamps, metadata omissions and explicit nulls were preserved.
This is a reviewed test input, not a transcript or a complete lifecycle replay.

Factory now reads only the thread and its recent runs from this response; the activity
items stay as provenance and are no longer interpreted. `support/worker-contract.ts`
serves the capture unchanged to check that read, and reuses its thread metadata for a
controlled worker whose `t3_thread_read` and `t3_thread_wait` calls cross the real
HTTP/SDK adapter against local OAuth/MCP fixtures. The test controls launches, sends,
run statuses and the **synthetic** `t3_thread_wait` answers; the worker reports by Block
id. Those lifecycle states were not captured live and do not prove live harness support.

`support/worker-thread-wire.ts` (wait answers) and `support/launch-fixture.ts` (launch
schemas) construct synthetic transport responses, served by `support/oauth-t3.ts` through
`support/boundaries-setup.ts`. They are not captured live sessions.

## T3 built-in theme provenance

[`t3-builtin-themes.json`](t3-builtin-themes.json) is the output of T3 Code's own resolver
(`apps/web/src/themePalette.ts`, `getThemeColorsForMode`) for every built-in theme in both modes at
upstream revision `d2c25950b4d9183ea342d5d5fc14c326b9e0172a` (MIT, © 2026 T3 Tools Inc.), produced on
2026-11-11 by bundling that unmodified upstream code with stubs only for its React atom registry and
server-state atom and running it outside T3. It records all 61 roles; Factory's parity tests compare
the roles its pinned port reads. Regenerating it for another pin is part of moving the resolver to that
pin; the harness and its logs stay outside Git.

[`t3-published-themes.json`](t3-published-themes.json) comes from the same harness, revision and date for
published theme definitions (`publishedThemeDefinitions` and `getThemeColorsForMode`). `themes` holds each
definition exactly as T3 streams it (`input`) and the 61 roles upstream resolved for both modes (`resolved`,
null where the definition has no colors for a mode): dark and light seeds, seeds with color overrides that
include an unknown role and an unparseable color, dark seeds with a sparse Light variant, partial colors with a
partial Dark variant and no seeds, and a definition giving every role a color. `filtered` holds two definitions
upstream drops, one under a built-in id and one without a usable color. `canonicalColors` maps color texts to
upstream's canonical `oklch()` text (`toCanonicalThemeColor`). The controlled UI fixture publishes the dark-seed
and Light-variant definitions as its T3 owner's theme files.

## Upgrade fixtures

Keep one representative released baseline: [`v0.2.0-upgrade-data.json`](v0.2.0-upgrade-data.json). A second capture,
[`flow-exits-upgrade-data.json`](flow-exits-upgrade-data.json), holds the outcome-exit data the Agent-exit migration (`072`)
converts and that baseline lacks: Human steps, their answers and fan-out wires. Do not retain
intermediate implementation snapshots, source archives or historical application builds, and do not replace them with compressed blobs or generated historical data.

[`migration-data-upgrade.test.ts`](../migration-data-upgrade.test.ts) opens the capture through the current Factory and checks client access, current definitions, absence of removed definitions, the Finished Run becoming Settled (migration `062`) and the Stopped Run becoming Archived (migration `063`) with their captured definitions, history and Tasks, every retained Run keeping its title with legacy title provenance (migration `079`), and removal of the active Run and its Task by migration `058` (Block id reporting). The capture's native call activity is not restored into the controlled adapter: it served only the retired call correlation.
Restoration uses disposable SQLite; business assertions use public operations. Tests need no old source, compiler subprocess, Git history or network.

Retain genuine schema, migration ledger, snapshots, keys, payloads, fingerprints and provenance. Never relabel a capture as another revision, rewrite its migration metadata or edit current state to
simulate an old release. A replacement baseline must come from the public operations of that released version on disposable data. Keep only the representative rows and observations its assertions
need; exclude transient process ownership, real credentials and user data. Raw capture scripts and logs stay outside Git.

[`migration-flow-exits-upgrade.test.ts`](../migration-flow-exits-upgrade.test.ts) opens the outcome-exit capture and checks, through public reads only, that Agent block exits became Flow-local with the same IDs, the Agent has no exits, Human exits became Approve and Request changes with their wires merged into one fan-out without duplicates, and that the in-progress and settled Runs keep their captured graph in that shape, their reports and their Human answers and handoffs under the new exit IDs.

See the [persistence contract](../../../../docs/foundation.md#sql-migrations) and [testing policy](../../../../docs/testing.md).

## Capture provenance

`v0.2.0-upgrade-data.json` captures released tag `v0.2.0` (commit `62e4e62cf71c1794db4ad8a2e1bce9d121c20ce0`). Its schema, migration ledger (through `050_factory_block_workers`) and durable rows come from that release, not current code.

Capture runs `v0.2.0`'s own Factory against an empty disposable database with the controlled T3 adapter and a synthetic repository path, using only its public operations: install reporting, add the repository, request an approved and a revoked client, then:

- Create an Agent and a single-worker Flow, Start a Run, accept its worker's completion report and reconcile until the Run closes as `finished`. Then edit both definitions and remove the Flow, then the Agent. The closed Run's snapshot is the only remaining record of those definitions.
- Create the current Agent and single-worker Flow, Start a Run and reconcile until its worker launch is observed, then edit the Agent. The Run stays open with its captured, pre-edit Agent.

Read the definitions, both Runs, Tasks and clients, close Factory, and capture schema DDL, named-column rows and the controlled adapter state.

A second step extends that capture with a Stopped Run, again with `v0.2.0`'s own Factory and only its public operations: restore the capture into a disposable database and adapter, open it (which reconciles the open Run and rechecks the project, refreshing their observation times), reinstall reporting into the disposable harness home, Start a third Run on the current Flow with the controlled worker evidence `v0.2.0`'s worker fixtures supply (quiet descendant scan, complete delegation activity), reconcile until its launch is observed, **Stop** it, let the controlled adapter report the worker thread interrupted and settled, and reconcile until the Run closes as `stopped`. Then re-read the definitions, all three Runs, Tasks and clients and capture again. The schema and migration ledger are unchanged; the step adds that Run's rows and refreshes the open Run's observation rows and the adapter state. Exclude only ephemeral process ownership (`runner_owner`); synthetic repository identities and disposable client credentials are fixture inputs. Capture source and logs stay in ignored local storage. Tests restore this one data fixture without executing historical source, building an old application, reading Git or accessing a network.

A third step extends the same baseline through `v0.2.0` public operations with a fourth Run: Start it on the current Flow, observe its worker, request Stop and leave the worker running without confirmation. Capture the Run with `closedAt: null`, a non-null `stopRequestedAt` and its gate closed. Re-read all Runs and Tasks and capture the database and adapter again, without changing schema or migration metadata. The upgrade test verifies this pending Stop survives migration `058` and becomes Archived in `063`, retaining its exact history and Task.

Opening it applies every later migration. The captured Run snapshots are the only source of the Runs' definitions: migrations convert them into the Flow and Agent revisions the Runs reference, restoring the removed Flow and Agent as removed definitions, then drop the snapshots. This baseline does not represent every intermediate schema, and earlier pre-release upgrade paths are no longer captured.

`flow-exits-upgrade-data.json` captures commit `cd0d25daf1b35326d0f49846ba89421eeea7b667` on `main`, the last build with outcome-based block exits (migration ledger through `071_run_images`). Capture runs that commit's own backend test harness against an empty disposable database with the controlled T3 adapter, using only public operations: connect T3, install reporting, add a synthetic repository and create one Agent, then save a checkout Flow where **Entry worker** (exits `done` and `blocked`, the second requiring feedback) hands to the Human step **Review** with two exits without the feedback flag (`looks-good` and `ship`, both wired to **Deploy**, `ship` also to **Notify**) and two with it (`changes` and `reject`, both wired back to Entry worker). Three Runs of that revision follow: one where Review requested changes and the correction was sent to Entry worker's running thread, one waiting on Review, and one where Review shipped and Deploy and Notify finished until the Run settled. Read the Flow, Agent, Runs and Tasks, close the backend, and capture table and index DDL (indexes load with the tables because foreign keys reference their unique keys), triggers as post-data schema, named-column rows except `runner_owner`, and the controlled adapter state. The capture script and logs stay outside Git.

