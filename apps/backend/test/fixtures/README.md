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

`support/worker-contract.ts` composes a **synthetic** lifecycle from these wire shapes
and controlled native progress: waiting, a reportless user reply, another reply,
delegation, notification continuation, accepted final and handoff after restart.
It changes execution identities/statuses; the worker reports by Block id. Those
states were not captured live. Reads use the real HTTP/SDK adapter against local
OAuth/MCP fixtures; launches and settlement use `ControlledT3`. Existing #43/#45/#49
tests retain the separate rejection, race and closure regressions. This fixture adds
the wire-to-lifecycle seam without replacing those tests or proving live harness support.

Other adapter helpers (`launch-fixture`, `boundaries-setup`, `native-delegation`)
construct synthetic transport responses. They are not captured live sessions.

## Released upgrade fixture

Keep one representative released baseline: [`v0.2.0-upgrade-data.json`](v0.2.0-upgrade-data.json). Do not retain
intermediate implementation snapshots, source archives or historical application builds, and do not replace them with compressed blobs or generated historical data.

[`migration-data-upgrade.test.ts`](../migration-data-upgrade.test.ts) opens the capture through the current Factory and checks client access, current definitions, absence of removed definitions, retention of the closed Run with its captured definitions and Task, and removal of the active Run and its Task by migration `058` (Block id reporting). The capture's native call activity is not restored into the controlled adapter: it served only the retired call correlation.
Restoration uses disposable SQLite; business assertions use public operations. Tests need no old source, compiler subprocess, Git history or network.

Retain genuine schema, migration ledger, snapshots, keys, payloads, fingerprints and provenance. Never relabel a capture as another revision, rewrite its migration metadata or edit current state to
simulate an old release. A replacement baseline must come from the public operations of that released version on disposable data. Keep only the representative rows and observations its assertions
need; exclude transient process ownership, real credentials and user data. Raw capture scripts and logs stay outside Git.

See the [persistence contract](../../../../docs/foundation.md#sql-migrations) and [testing policy](../../../../docs/testing.md).

## Capture provenance

`v0.2.0-upgrade-data.json` captures released tag `v0.2.0` (commit `62e4e62cf71c1794db4ad8a2e1bce9d121c20ce0`). Its schema, migration ledger (through `050_factory_block_workers`) and durable rows come from that release, not current code.

Capture runs `v0.2.0`'s own Factory against an empty disposable database with the controlled T3 adapter and a synthetic repository path, using only its public operations: install reporting, add the repository, request an approved and a revoked client, then:

- Create an Agent and a single-worker Flow, Start a Run, accept its worker's completion report and reconcile until the Run closes as `finished`. Then edit both definitions and remove the Flow, then the Agent. The closed Run's snapshot is the only remaining record of those definitions.
- Create the current Agent and single-worker Flow, Start a Run and reconcile until its worker launch is observed, then edit the Agent. The Run stays open with its captured, pre-edit Agent.

Read the definitions, both Runs, Tasks and clients, close Factory, and capture schema DDL, named-column rows and the controlled adapter state. Exclude only ephemeral process ownership (`runner_owner`); synthetic repository identities and disposable client credentials are fixture inputs. Capture source and logs stay in ignored local storage. Tests restore this one data fixture without executing historical source, building an old application, reading Git or accessing a network.

Opening it applies every later migration. The captured Run snapshots are the only source of both Runs' definitions: migrations convert them into the Flow and Agent revisions the Runs reference, restoring the removed Flow and Agent as removed definitions, then drop the snapshots. This baseline does not represent every intermediate schema, and earlier pre-release upgrade paths are no longer captured.
