import * as Effect from "effect/Effect";
import type { RunClosure } from "@t3-factory/contracts";
import type { ExecutionObservation, T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle, RunRow } from "./runner-types.ts";
import { rootFrontier } from "./run-root-frontier.ts";
import { recoverOperation } from "./runner-effects.ts";
import { isTerminal, runTarget } from "./runner-utils.ts";
import { now } from "./time.ts";

type Frontier = NonNullable<RunClosure["rootFrontier"]>[number];
type Settlement = { thread_id: string; execution_id: string };

function samePrimary(frontier: Frontier, candidate: Settlement, saved: Frontier) {
  return (
    frontier.threadId === candidate.thread_id &&
    frontier.latestRunId === candidate.execution_id &&
    !frontier.activeRunId &&
    !frontier.queuedRunIds.length &&
    frontier.queueNextCursor === null &&
    frontier.pendingRequestCount === 0 &&
    frontier.executions.length === saved.executions.length &&
    saved.executions.every((e) =>
      frontier.executions.some(
        (current) =>
          current.executionId === e.executionId &&
          current.status === e.status &&
          isTerminal(current.status),
      ),
    )
  );
}
function sameExecution(observed: ExecutionObservation, run: RunRow, saved: Frontier) {
  return (
    observed.threadId === saved.threadId &&
    observed.projectId === run.t3_project_id &&
    (observed.workspaceRoot === null || observed.workspaceRoot === run.workspace_root) &&
    observed.latestRunId === saved.latestRunId &&
    !observed.activeRunId &&
    observed.pendingRequestCount === 0 &&
    observed.recentRuns.length === saved.executions.length &&
    saved.executions.every((e) =>
      observed.recentRuns.some(
        (current) =>
          current.runId === e.executionId &&
          current.status === e.status &&
          isTerminal(current.status),
      ),
    )
  );
}

/** Best-effort native organization after permanent business closure; never model work. */
export function openRootSettlement(
  database: RunnerDatabase,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  liveContextId: () => Effect.Effect<string | null, unknown>,
) {
  const pending = (id: string) =>
    database.transaction(
      (sql) =>
        sql<Settlement>`SELECT s.thread_id,s.execution_id FROM run_root_settlements s
      JOIN runs r ON r.id=s.run_id JOIN run_coordinators p ON p.run_id=r.id
      WHERE s.run_id=${id} AND s.attempted_at IS NULL AND s.retired_at IS NULL
      AND r.closed_at IS NOT NULL AND r.outcome IN ('finished','stopped')
      AND p.state='acknowledged' AND p.thread_id=s.thread_id
      AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=r.context_id)
      AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${database.owner.token})`,
    );
  function settleRoot(id: string) {
    return recoverOperation(
      Effect.gen(function* () {
        if (lifecycle.isClosed()) return;
        const [candidate] = yield* pending(id);
        if (!candidate) return;
        const run = yield* database.row(id);
        if (!run || (yield* liveContextId()) !== run.context_id) return;
        const [closure] = yield* database.transaction(
          (sql) =>
            sql<{
              root_frontier_json: string;
            }>`SELECT root_frontier_json FROM run_closures WHERE run_id=${id}`,
        );
        const saved = (JSON.parse(closure!.root_frontier_json) as readonly Frontier[]).find(
          (f) => f.threadId === candidate.thread_id && f.environmentId === run.environment_id,
        );
        if (!saved || saved.latestRunId !== candidate.execution_id) return;
        const support = yield* Effect.tryPromise(() => t3.inspectSettleSupport(runTarget(run)));
        if (!support.supported) return;
        // A closed-Run frontier uses scan-local safety ledgers, and cannot dispatch Stop or work.
        const current = yield* rootFrontier(database, t3, run, run.outcome === "stopped");
        const primary = current.frontier.find(
          (f) => f.threadId === candidate.thread_id && f.environmentId === run.environment_id,
        );
        if (!primary) return;
        if (yield* retireSuperseded(run, candidate, primary, saved)) return;
        if (!current.complete || !samePrimary(primary, candidate, saved)) return;
        if (!(yield* freshPrimary(run, candidate, saved))) return;
        if ((yield* liveContextId()) !== run.context_id) return;
        yield* invoke(run, candidate);
      }),
      () => Effect.void,
    );
  }
  function retireSuperseded(
    run: RunRow,
    candidate: Settlement,
    primary: Frontier,
    saved: Frontier,
  ) {
    return Effect.gen(function* () {
      const before = saved.executions.find(
        (e) => e.executionId === candidate.execution_id,
      )?.ordinal;
      const after = primary.executions.find((e) => e.executionId === primary.latestRunId)?.ordinal;
      if (
        primary.latestRunId !== candidate.execution_id &&
        typeof before === "number" &&
        typeof after === "number" &&
        after > before
      ) {
        if ((yield* liveContextId()) !== run.context_id) return true;
        yield* database.mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_root_settlements SET retired_at=${new Date().toISOString()} WHERE run_id=${run.id} AND attempted_at IS NULL AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${run.context_id}) AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${database.owner.token})`,
        );
        return true;
      }

      return false;
    });
  }
  function freshPrimary(run: RunRow, candidate: Settlement, saved: Frontier) {
    return Effect.gen(function* () {
      const exact = yield* Effect.tryPromise(() =>
        t3.readExecution(
          runTarget(run),
          candidate.thread_id,
          saved.executions.map((e) => ({
            runId: e.executionId,
            ...(e.ordinal === null ? {} : { ordinal: e.ordinal }),
          })),
        ),
      );
      if (!sameExecution(exact, run, saved)) return false;
      const queue = yield* Effect.tryPromise(() =>
        t3.readQueue(runTarget(run), candidate.thread_id),
      );
      if (
        queue.threadId !== candidate.thread_id ||
        queue.queuedRunIds.length ||
        queue.nextCursor !== null
      )
        return false;
      const native = yield* Effect.tryPromise(() =>
        t3.readNativeRequests(runTarget(run), candidate.thread_id),
      );
      if (
        native.threadId !== candidate.thread_id ||
        native.projectId !== run.t3_project_id ||
        native.pendingRequestCount !== 0
      )
        return false;

      return true;
    });
  }
  function invoke(run: RunRow, candidate: Settlement) {
    return database.serial(run.id, () =>
      Effect.gen(function* () {
        if (lifecycle.isClosed()) return;
        const claimed = yield* database.transaction((sql) =>
          Effect.gen(function* () {
            const changed =
              yield* sql`UPDATE run_root_settlements SET attempted_at=${yield* now},outcome='uncertain'
          WHERE run_id=${run.id} AND thread_id=${candidate.thread_id} AND execution_id=${candidate.execution_id}
          AND attempted_at IS NULL AND retired_at IS NULL
          AND EXISTS(SELECT 1 FROM runs WHERE id=${run.id} AND generation=${run.generation} AND closed_at IS NOT NULL AND context_id=${run.context_id})
          AND EXISTS(SELECT 1 FROM run_coordinators WHERE run_id=${run.id} AND state='acknowledged' AND thread_id=${candidate.thread_id})
          AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${run.context_id})
          AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${database.owner.token}) RETURNING run_id`;
            return changed.length > 0;
          }),
        );
        if (!claimed) return;
        const outcome = yield* recoverOperation(
          Effect.tryPromise(() =>
            t3.settleThread(runTarget(run), { threadId: candidate.thread_id }),
          ).pipe(Effect.as("acknowledged")),
          () => Effect.succeed("uncertain"),
        );
        yield* database.transaction(
          (sql) => sql`UPDATE run_root_settlements SET outcome=${outcome} WHERE run_id=${run.id}`,
        );
      }),
    );
  }
  return { settleRoot };
}
