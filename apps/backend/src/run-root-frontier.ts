import { standaloneTree } from "./run-root-standalone.ts";
import { commandSources, commandsObserved, type CommandSource } from "./native-command-creation.ts";
import { rootPeers } from "./run-root-peers.ts";
import { retainAssignedRootWork } from "./run-root-saved.ts";
import { recoveredRootFailures, rootControlDispatchAllowed } from "./run-control-recovery-proof.ts";
import {
  discover,
  verifyMember,
  readMember,
  quiet,
  type Member,
  type Frontier,
} from "./run-root-observation.ts";
type Ledger = ReturnType<typeof rootLedger>;
import * as Effect from "effect/Effect";

import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";

import { rootLedger, rootExecutionRows } from "./run-root-ledger.ts";
import { requestRootStop } from "./run-root-stop.ts";
import { runTarget, isTerminal } from "./runner-utils.ts";

/** Fresh Run-owned full-tree evidence. It grants no work or reporting authority. */
export function rootFrontier(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  stopping = false,
) {
  return Effect.tryPromise(async () => {
    const coordinators = await Effect.runPromise(
      database.transaction(
        (sql) =>
          sql<{ id: string }>`SELECT run_id AS id FROM run_coordinators WHERE run_id=${run.id}`,
      ),
    );
    if (!coordinators.length) {
      const workers = await Effect.runPromise(
        database.transaction(
          (sql) =>
            sql<{
              thread_id: string;
            }>`SELECT thread_id FROM run_thread_bindings WHERE run_id=${run.id} AND role='worker'`,
        ),
      );
      return {
        frontier: [],
        complete: true,
        trustedThreads: workers.map((worker) => worker.thread_id),
      };
    }
    const ledger = rootLedger(database, run);
    const { root, operationsClear } = await rootControl(database, run, ledger, stopping);
    if (root.state === "cancelled" && !root.thread_id && stopping)
      return { frontier: [], complete: operationsClear, trustedThreads: [] };
    if (!root.thread_id) throw Error("Run conversation identity unresolved");
    if (stopping) {
      const ids = (await ledger.read())
        .filter((r) => r.thread_id === root.thread_id && r.kind === "execution")
        .map((r) => r.reference);
      await Effect.runPromise(requestRootStop(database, t3, run, root.thread_id, ids));
    }
    const projects = await t3.listProjects(runTarget(run));
    if (
      !projects.some(
        (p) =>
          p.available &&
          p.projectId === run.t3_project_id &&
          p.workspaceRoot === run.workspace_root,
      )
    )
      throw Error("Root project changed");
    const assigned = await retainAssignedRootWork(database, run);
    const { members, complete: scanComplete } = await discover(t3, run, root.thread_id, ledger);
    const recovered = await Effect.runPromise(
      database.transaction((sql) => recoveredRootFailures(sql, run.id)),
    );
    const sweep = await sweepTree(
      database,
      t3,
      run,
      root.thread_id,
      ledger,
      members,
      stopping,
      recovered,
      assigned,
    );
    const { frontier, visited } = sweep;
    const aggregate = await rootAggregate(
      t3,
      run,
      frontier.find((f) => f.threadId === root.thread_id),
      stopping,
    );
    const retained = await ledger.read();
    const peers = await rootPeers(database, t3, run, retained, assigned, stopping);
    const commandsKnown = commandsObserved(
      commandSources(retained),
      sweep.commands,
      run.environment_id,
      new Set(sweep.trustedThreads),
    );
    const scopeKnown =
      [...members.keys()].every((id) => visited.has(id)) &&
      retained
        .filter((r) => r.kind === "execution")
        .every((r) =>
          frontier.some(
            (f) =>
              f.threadId === r.thread_id && f.executions.some((e) => e.executionId === r.reference),
          ),
        );
    const covered =
      scanComplete &&
      operationsClear &&
      (stopping || root.instruction_version !== 0) &&
      peers.complete &&
      commandsKnown &&
      scopeKnown;
    const complete = covered && sweep.complete && aggregate.complete;
    const observed = covered && sweep.observed && aggregate.observed;
    await Effect.runPromise(
      database.mutate(
        run.id,
        (sql) =>
          sql`UPDATE run_coordinators SET freshness=${frontier.some((f) => f.threadId === root.thread_id) ? "fresh" : "stale"},observed_at=${new Date().toISOString()},pending_request_count=${frontier.find((f) => f.threadId === root.thread_id)?.pendingRequestCount ?? null},queued_count=${frontier.find((f) => f.threadId === root.thread_id)?.queuedRunIds.length ?? null},problem=CASE WHEN ${observed ? 1 : 0}=1 THEN NULL ELSE COALESCE(problem,'Run conversation work, acceptance or tree coverage remains unresolved.') END WHERE run_id=${run.id} AND EXISTS(SELECT 1 FROM runs WHERE id=${run.id} AND closed_at IS NULL)`,
      ),
    );
    return {
      frontier: [...frontier, ...peers.frontier],
      complete,
      trustedThreads: sweep.trustedThreads,
    };
  });
}

async function stopMember(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  member: Member,
  ledger: Ledger,
) {
  const ids = (await ledger.read())
    .filter((r) => r.thread_id === member.threadId && r.kind === "execution")
    .map((r) => r.reference);
  await Effect.runPromise(requestRootStop(database, t3, run, member.threadId, ids));
  const queue = await t3.readQueue(runTarget(run), member.threadId).catch(() => null);
  if (queue?.threadId === member.threadId)
    for (const id of queue.queuedRunIds) {
      await ledger.retain(rootExecutionRows(member.threadId, [id]));
      await Effect.runPromise(requestRootStop(database, t3, run, member.threadId, ids, id));
    }
}
async function sweepTree(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  rootId: string,
  ledger: Ledger,
  members: Map<string, Member>,
  stopping: boolean,
  recovered: readonly { threadId: string; executionId: string }[],
  assigned: ReadonlySet<string>,
) {
  let complete = true,
    observed = true;
  const visited = new Set<string>(),
    trusted = new Set<string>(),
    frontier: Frontier[] = [];
  const commands: CommandSource[] = [];
  // Cover the known tree on every fresh sweep, with bounded native discovery growth.
  const visitLimit = members.size + 100;
  for (let pass = 0; pass < visitLimit; pass++) {
    const member = [...members.values()].find(
      (m) =>
        !visited.has(m.threadId) && (m.parentThreadId === null || trusted.has(m.parentThreadId)),
    );
    if (!member) break;
    visited.add(member.threadId);
    try {
      const standalone = await verifyMember(t3, run, member, rootId, ledger, trusted);
      trusted.add(member.threadId);
      if (standalone) {
        const known = await standaloneTree(t3, run, member, ledger, members);
        complete &&= known;
        observed &&= known;
      }
      const result = await readMember(t3, run, member, ledger, members, stopping);
      frontier.push(result.frontier);
      commands.push(...result.commands);
      if (standalone && stopping) {
        const aggregate = await rootAggregate(t3, run, result.frontier, true);
        complete &&= aggregate.complete;
        observed &&= aggregate.observed;
      }
      observed &&= result.complete;
      complete &&=
        result.complete &&
        quiet(result.frontier, stopping || assigned.has(member.threadId), recovered);
    } catch {
      complete = false;
      observed = false;
    }
    if (stopping && trusted.has(member.threadId))
      await stopMember(database, t3, run, member, ledger);
  }

  return { frontier, commands, visited, complete, observed, trustedThreads: [...trusted] };
}

async function rootControl(
  database: RunnerDatabase,
  run: RunRow,
  ledger: Ledger,
  stopping: boolean,
) {
  const [root] = await Effect.runPromise(
    database.transaction(
      (sql) =>
        sql<{
          thread_id: string | null;
          execution_id: string | null;
          state: string;
          instruction_version: number;
        }>`SELECT * FROM run_coordinators WHERE run_id=${run.id}`,
    ),
  );
  if (!root) throw Error("Missing Run conversation");
  const commands = await Effect.runPromise(
    database.transaction(
      (sql) =>
        sql<{
          parent_execution_id: string | null;
          state: string;
          cancelled_at: string | null;
          problem: string | null;
        }>`SELECT * FROM run_coordinator_commands WHERE run_id=${run.id}`,
    ),
  );
  const controls = await Effect.runPromise(
    database.transaction(
      (sql) =>
        sql<{
          thread_id: string;
          source_execution_id: string;
          state: string;
          acknowledgement_json: string | null;
          cancelled: number;
        }>`SELECT c.*,(EXISTS(SELECT 1 FROM run_root_cancelled_controls x WHERE x.run_id=c.run_id AND x.source_execution_id=c.source_execution_id)) AS cancelled FROM run_control_recoveries c WHERE c.run_id=${run.id}`,
    ),
  );
  await ledger.retain(
    controls.flatMap((c) =>
      rootExecutionRows(c.thread_id, [
        c.source_execution_id,
        c.acknowledgement_json
          ? (JSON.parse(c.acknowledgement_json) as { runId: string }).runId
          : null,
      ]),
    ),
  );
  const controlsClear = controls.every(
    (c) => c.state === "acknowledged" || (stopping && c.state === "pending" && !!c.cancelled),
  );
  const unknown = await Effect.runPromise(
    database.transaction(
      (sql) =>
        sql`SELECT source_key FROM run_coordinator_obligations o WHERE run_id=${run.id} AND json_type(evidence_json,'$.input')='object' AND (CASE WHEN ${stopping ? 1 : 0}=1 THEN json_extract(evidence_json,'$.result.childRunId') IS NULL ELSE NOT EXISTS(SELECT 1 FROM run_coordinator_commands c WHERE c.run_id=o.run_id AND c.accepted_json=o.evidence_json) END)`,
    ),
  );
  const dispatchAllowed =
    stopping ||
    (await Effect.runPromise(
      database.transaction((sql) => rootControlDispatchAllowed(sql, run.id)),
    ));
  const followupUnassigned = stopping
    ? false
    : (await ledger.read()).some((r) => r.thread_id === root.thread_id && r.kind === "followup");
  const operationsClear =
    !followupUnassigned &&
    dispatchAllowed &&
    controlsClear &&
    !unknown.length &&
    commands.every((c) =>
      stopping
        ? !!c.cancelled_at || ["issued", "accepted"].includes(c.state)
        : c.state === "accepted" && !c.problem,
    );

  if (root.state === "cancelled" && !root.thread_id && stopping) return { root, operationsClear };
  if (root.state !== "acknowledged" || !root.thread_id || !root.execution_id)
    throw Error("Run conversation acceptance unresolved");
  await ledger.retain(
    rootExecutionRows(root.thread_id, [
      root.execution_id,
      ...commands.map((c) => c.parent_execution_id),
    ]),
  );
  return { root, operationsClear };
}

async function rootAggregate(
  t3: T3Adapter,
  run: RunRow,
  frontier: Frontier | undefined,
  stopping: boolean,
) {
  if (!frontier?.latestRunId) return { complete: false, observed: false };
  const aggregate = await t3
    .readDelegatedSettlement(runTarget(run), frontier.threadId, frontier.latestRunId)
    .catch(() => null);
  if (!aggregate) return { complete: false, observed: false };
  const scoped =
    aggregate.threadId === frontier.threadId &&
    aggregate.runId === frontier.latestRunId &&
    (!aggregate.resultRun ||
      (aggregate.resultRun.runId === frontier.latestRunId &&
        aggregate.resultRun.status === aggregate.status));
  return {
    observed:
      scoped &&
      aggregate.status !== "unknown" &&
      (aggregate.state === "pending" || (aggregate.state === "settled" && !!aggregate.resultRun)),
    complete:
      scoped &&
      aggregate.state === "settled" &&
      aggregate.resultRun?.runId === frontier.latestRunId &&
      aggregate.resultRun.status === aggregate.status &&
      (stopping ? isTerminal(aggregate.status ?? "") : aggregate.status === "completed"),
  };
}
