import { rootFrontier } from "./run-root-frontier.ts";
import { localClosureRetention } from "./coordinator-local-observations.ts";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { collectCoordination } from "./coordinator-evidence.ts";
import { gatherClosureAttempt } from "./runner-closure.ts";
import { runTarget } from "./runner-utils.ts";
/** Shared fresh release/settlement/closure gate; saved evidence is presentation, never authority. */
export function coordinatorGate(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  blockId?: string,
  activationId?: string,
) {
  return Effect.gen(function* () {
    const root = yield* wholeRunRoot(database, t3, run, blockId);
    if (!root.complete) return null;
    const saved = yield* database.transaction((sql) =>
      Effect.gen(function* () {
        const blocks = yield* sql<
          BlockRow & { gate_activation_id: string }
        >`SELECT b.*,a.id AS gate_activation_id FROM run_blocks b JOIN run_activations a ON a.run_id=b.run_id AND a.block_id=b.block_id WHERE b.run_id=${run.id} AND b.thread_id IS NOT NULL AND (${blockId ?? null} IS NULL OR b.block_id=${blockId ?? null}) AND (${activationId ?? null} IS NULL OR a.id=${activationId ?? null})`;
        const executions = yield* sql<{
          thread_id: string;
          execution_id: string;
          activation_id: string | null;
        }>`SELECT thread_id,execution_id,activation_id FROM run_executions WHERE run_id=${run.id}`;
        return { blocks, executions };
      }),
    );
    if (!saved.blocks.length) return null;
    const frontierTargets = [];
    const coordination = [];
    for (const block of saved.blocks) {
      const [report] = yield* database.transaction(
        (sql) =>
          sql`SELECT id FROM runtime_reports WHERE activation_id=${block.gate_activation_id}`,
      );
      if (!report) return null;
      const { result } = yield* collectCoordination(
        database,
        t3,
        run,
        block,
        block.gate_activation_id,
      );
      if (!result.evidence.release || result.problem) return null;
      coordination.push(result.evidence);
      const targets = memberTargets(result.members, saved.executions, block.block_id);
      if (!targets) return null;
      frontierTargets.push(...targets);
    }
    const attempt = yield* gatherClosureAttempt(
      { runId: run.id, generation: run.generation, gateOpen: true, contextId: run.context_id },
      t3,
      { ...runTarget(run), blocks: frontierTargets },
      localClosureRetention(database, run),
    );
    if (
      attempt.frontier.some(
        (f) =>
          f.activeRunId ||
          f.queuedRunIds.length ||
          f.queueNextCursor !== null ||
          f.pendingRequestCount !== 0 ||
          f.executions.some(
            (e) =>
              e.status !== "completed" ||
              !saved.executions.some(
                (s) => s.thread_id === f.threadId && s.execution_id === e.executionId,
              ),
          ),
      )
    )
      return null;
    return { ...attempt, coordination, ...root.evidence };
  });
}

function memberTargets(
  members: readonly import("./coordinator-evidence.ts").MemberObservation[],
  executions: readonly { thread_id: string; execution_id: string; activation_id: string | null }[],
  blockId: string,
) {
  const targets = [];
  for (const member of members) {
    const recorded = executions.filter((e) => e.thread_id === member.threadId);
    if (
      member.observation.recentRuns.some((e) => !recorded.some((r) => r.execution_id === e.runId))
    )
      return null;
    targets.push({
      blockId,
      threadId: member.threadId,
      recorded: recorded.map((r) => ({ runId: r.execution_id })),
    });
  }
  return targets;
}

function wholeRunRoot(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  blockId: string | undefined,
) {
  return Effect.gen(function* () {
    if (blockId) return { complete: true, evidence: {} };
    const root = yield* rootFrontier(database, t3, run);
    return { complete: root.complete, evidence: { rootFrontier: root.frontier } };
  });
}
