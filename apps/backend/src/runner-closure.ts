import type { RunClosure } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter, T3Target } from "./adapters/t3.ts";
import { now } from "./time.ts";
/** Local token captured before I/O. Both completion and Stop use the same boundary. */
export interface ClosureToken {
  readonly runId: string;
  readonly generation: number;
  readonly gateOpen: boolean;
  readonly contextId: string;
}
export interface ClosureAttempt extends ClosureToken {
  readonly frontier: RunClosure["frontier"];
  readonly rootFrontier?: RunClosure["rootFrontier"];
  readonly coordination?: RunClosure["coordination"];
}
/** Fresh, separate reads. No transaction, saved poll reuse, or message body archive. */
export function gatherClosureAttempt(
  token: ClosureToken,
  t3: T3Adapter,
  target: T3Target & {
    blocks: readonly {
      blockId: string;
      threadId: string;
      recorded: readonly import("./adapters/t3.ts").RecordedExecution[];
    }[];
  },
  retainExecution?: (
    block: { blockId: string; threadId: string },
    execution: import("./adapters/t3.ts").ExecutionObservation,
  ) => Promise<void>,
): Effect.Effect<ClosureAttempt, unknown> {
  return Effect.gen(function* () {
    const projects = yield* Effect.tryPromise({
      try: () => t3.listProjects(target),
      catch: (error) => error,
    });
    const project = projects.find((project) => project.projectId === target.projectId);
    if (!project?.available || project.workspaceRoot !== target.workspaceRoot)
      return yield* Effect.fail(Error("Closure project coverage changed"));
    const projectObservedAt = yield* now;
    const frontier: RunClosure["frontier"][number][] = [];
    for (const block of target.blocks) {
      const execution = yield* Effect.tryPromise({
        try: () => t3.readExecution(target, block.threadId, block.recorded),
        catch: (error) => error,
      });
      if (
        execution.threadId !== block.threadId ||
        execution.projectId !== target.projectId ||
        (execution.workspaceRoot !== null && execution.workspaceRoot !== target.workspaceRoot)
      )
        return yield* Effect.fail(Error("Closure execution scope changed"));
      if (retainExecution) yield* Effect.tryPromise(() => retainExecution(block, execution));
      if (
        block.recorded.some(
          (saved) => !execution.recentRuns.some((candidate) => candidate.runId === saved.runId),
        )
      )
        return yield* Effect.fail(
          Error("Incomplete observation coverage: recorded execution absent."),
        );
      const executionObservedAt = yield* now;
      const queue = yield* Effect.tryPromise({
        try: () => t3.readQueue(target, block.threadId),
        catch: (error) => error,
      });
      const queueObservedAt = yield* now;
      const native = yield* Effect.tryPromise({
        try: () => t3.readNativeRequests(target, block.threadId),
        catch: (error) => error,
      });
      const nativeObservedAt = yield* now;
      if (
        queue.threadId !== block.threadId ||
        native.threadId !== block.threadId ||
        native.projectId !== target.projectId
      )
        return yield* Effect.fail(Error("Closure target coverage changed"));
      frontier.push({
        environmentId: target.environmentId,
        blockId: block.blockId,
        threadId: block.threadId,
        projectId: target.projectId,
        workspaceRoot: project.workspaceRoot,
        projectObservedAt,
        executionObservedAt,
        queueObservedAt,
        nativeObservedAt,
        activeRunId: execution.activeRunId,
        latestRunId: execution.latestRunId ?? null,
        executions: execution.recentRuns.map((observed) => ({
          executionId: observed.runId,
          status: observed.status,
          ordinal: observed.ordinal ?? null,
          sourceAt: observed.sourceAt ?? null,
        })),
        queuedRunIds: queue.queuedRunIds,
        queueNextCursor: queue.nextCursor,
        pendingRequestCount: Math.max(execution.pendingRequestCount, native.pendingRequestCount),
      });
    }
    return { ...token, frontier };
  });
}
/** Call inside the Run lane AND the policy-validation transaction. No I/O here.
 * The caller checks outcome-specific local/external predicates. #25 supplies its
 * stopped policy after reconciling cancellation/interrupts; this primitive does
 * not request Stop or manufacture its evidence. */
export function confirmClosure(
  sql: SqlClient.SqlClient,
  ownerToken: string,
  attempt: ClosureAttempt,
  outcome: RunClosure["outcome"],
) {
  return Effect.gen(function* () {
    const time = yield* now;
    const changed =
      yield* sql`UPDATE runs SET closed_at=${time},outcome=${outcome},gate_open=0,generation=generation+1
      WHERE id=${attempt.runId} AND closed_at IS NULL AND generation=${attempt.generation}
      AND gate_open=${attempt.gateOpen ? 1 : 0} AND context_id=${attempt.contextId}
      AND EXISTS(SELECT 1 FROM runner_owner WHERE token=${ownerToken})
      AND EXISTS(SELECT 1 FROM t3_connection WHERE context_id=${attempt.contextId}) RETURNING id`;
    if (!changed.length) return false;
    yield* sql`UPDATE run_root_stop_intents SET state='acknowledged' WHERE run_id=${attempt.runId}`;
    yield* sql`INSERT INTO run_closures(run_id,outcome,generation,confirmed_at,frontier_json,coordination_json,root_frontier_json)
      VALUES(${attempt.runId},${outcome},${attempt.generation},${time},${JSON.stringify(attempt.frontier)},${attempt.coordination ? JSON.stringify(attempt.coordination) : null},${attempt.rootFrontier ? JSON.stringify(attempt.rootFrontier) : null})`;
    const [primary] = yield* sql<{
      thread_id: string;
      environment_id: string;
    }>`SELECT p.thread_id,c.environment_id FROM run_coordinators p JOIN runs r ON r.id=p.run_id JOIN t3_authorization_contexts c ON c.id=r.context_id WHERE p.run_id=${attempt.runId} AND p.state='acknowledged'`;
    const root = attempt.rootFrontier?.find(
      (member) =>
        member.threadId === primary?.thread_id && member.environmentId === primary.environment_id,
    );
    if (root?.latestRunId)
      yield* sql`INSERT INTO run_root_settlements(run_id,thread_id,execution_id,created_at) VALUES(${attempt.runId},${root.threadId},${root.latestRunId},${time}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO run_events(run_id,kind,source_key,cause_id,observed_at)
      VALUES(${attempt.runId},'run-closed','closure',${attempt.runId},${time})`;
    return true;
  });
}
