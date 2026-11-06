import type { T3Adapter } from "./adapters/t3.ts";
import type { DelegationActivity } from "./adapters/delegation-activity.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import type { RootObligation } from "./run-root-ledger.ts";
import type { Frontier } from "./run-root-observation.ts";
import { collectRunPeerStop } from "./coordinator-peer-stop.ts";

/** Known reachable peers can be stopped in their explicit environment; unknown membership stays held. */
export async function rootPeers(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  rows: readonly RootObligation[],
  assigned: ReadonlySet<string>,
  stopping: boolean,
) {
  const frontier: Frontier[] = [];
  let complete = true;
  for (const row of rows.filter((r) => r.kind === "remote" && !assigned.has(r.thread_id))) {
    const source = JSON.parse(row.reference) as NonNullable<
      DelegationActivity["remoteTasks"]
    >[number];
    const remote = source.remote;
    if (
      !stopping ||
      !remote?.threadId ||
      !remote.environmentId ||
      !remote.taskId ||
      remote.environmentId === run.environment_id
    ) {
      complete = false;
      continue;
    }
    const observed = await collectRunPeerStop(database, t3, run, {
      environmentId: remote.environmentId,
      threadId: remote.threadId,
    }).catch(() => null);
    if (!observed) {
      complete = false;
      continue;
    }
    frontier.push(...observed.frontier);
    complete &&= observed.complete;
  }
  return { frontier, complete };
}
