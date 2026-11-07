# Released upgrade fixture

Keep one representative released baseline: [`v0.2.0-upgrade-data.json`](v0.2.0-upgrade-data.json). Do not retain
intermediate implementation snapshots, source archives or historical application builds, and do not replace them with compressed blobs or generated historical data.

[`migration-data-upgrade.test.ts`](../migration-data-upgrade.test.ts) opens the capture through the current Factory and checks client access, current definitions, absence of removed definitions, and retention of a closed and an active Run with their captured definitions in one upgrade.
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
