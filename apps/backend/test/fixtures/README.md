# Released-main upgrade fixture

Keep one representative published-main baseline: [`main-client-access-data.json`](main-client-access-data.json). Do not retain
intermediate implementation snapshots, source archives or historical application builds, and do not replace them with compressed blobs or generated historical data.

[`migration-data-upgrade.test.ts`](../migration-data-upgrade.test.ts) opens the capture through the current Factory and checks client access, definitions, removal of the obsolete Run and preservation of current pending work in one upgrade.
Restoration uses disposable SQLite; business assertions use public operations. Tests need no old source, compiler subprocess, Git history or network.

Retain genuine schema, migration ledger, snapshots, keys, payloads, fingerprints and provenance. Never relabel a capture as another revision, rewrite its migration metadata or edit current state to
simulate an old release. A replacement baseline must come from the public operations of that released version on disposable data. Keep only the representative rows and observations its assertions
need; exclude transient process ownership, real credentials and user data. Raw capture scripts and logs stay outside Git.

See the [persistence contract](../../../../docs/foundation.md#sql-migrations) and [testing policy](../../../../docs/testing.md).

## Capture provenance

`main-client-access-data.json` captures pre-publication application revision `21e3cf767d93a12e542cc5b13849e284a7621447` from the private development archive. Its schema, migration ledger and durable rows come from that application, not current code. Historical revision IDs record the fixture's provenance; those commits are intentionally absent from the public repository's new history.

Capture starts by restoring the earlier released baseline from commit `90400660eb7781e14500876c8375c83d6e879b25`: approved and revoked clients, an authored single-worker Flow, an Agent and a running `direct-worker-v1` Run. Open it with revision `21e3cf767d93a12e542cc5b13849e284a7621447` and the restored controlled T3 observations, allowing that release to apply its own migrations. Through its public operations, install reporting in a disposable harness home, create a second Agent and a two-Agent Flow with an explicit Run coordinator, then Start and reconcile a `run-worker-v1` / `explicit-mcp-v2` Run. Its Run conversation launch is acknowledged and its first worker command remains pending native acceptance.

Read both Runs and the controlled adapter state, close Factory, and capture schema DDL and named-column rows. Exclude only ephemeral process ownership; synthetic repository identities and disposable client credentials are fixture inputs. Capture source and logs stay in ignored local storage. Tests restore this one data fixture without executing historical source, building an old application, reading Git or accessing a network.

Migration 049 removes the retired direct-worker Run while retaining its Task, clients and definitions. Migration 050 then deletes every remaining open Run, including the `run-worker-v1` Run this fixture captured. Clients, Agents, Flows, projects and Tasks remain. The fixture contains no closed Run, so closed-history retention is the migration predicate rather than a row in this file. Reopening does not recreate those Runs or launch replacement work. This baseline does not represent every intermediate schema.
