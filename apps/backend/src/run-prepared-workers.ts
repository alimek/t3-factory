import type { RunDefinitions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Target } from "./adapters/t3.ts";
import { preparedWorkerPayload } from "./runner-block-workers.ts";
import type { RunRow } from "./runner-types.ts";
import { fingerprint } from "./runner-utils.ts";
import { launchStrategy, type RunWorkspace } from "./run-workspace.ts";
import { newId } from "./ids.ts";

/**
 * A worktree Run's Agent Blocks that no Flow input starts, visited or not, each get one idle
 * worker on the bound worktree. The intents are durable before any T3 call.
 */
export function persistWorkerPreparations(
  sql: SqlClient.SqlClient,
  plan: {
    runId: string;
    number: number;
    definitions: RunDefinitions;
    workspace: RunWorkspace;
    project: Pick<T3Target, "endpoint" | "environmentId" | "projectId" | "workspaceRoot">;
    contextId: string;
  },
) {
  return Effect.gen(function* () {
    const { graph } = plan.definitions.flow;
    for (const block of graph.blocks) {
      const strategy = launchStrategy(plan.workspace, block.id);
      if (block.kind !== "agent" || graph.flowInput.targetBlockIds.includes(block.id) || !strategy)
        continue;
      const requestKey = yield* newId;
      const body = JSON.stringify(
        preparedWorkerPayload(
          plan.definitions,
          block.id,
          plan.project,
          requestKey,
          plan.number,
          strategy,
        ),
      );
      const target = JSON.stringify({ ...plan.project, blockId: block.id });
      yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id)
        VALUES(${yield* newId},${plan.runId},${block.id},'prepare',${`prepare:${block.id}`},${target},${requestKey},${body},${fingerprint(body)},${plan.contextId})`;
    }
  });
}

/** The Block's prepared worker thread, once T3 created it; a visit only after its first send. */
export function preparedWorkerThread(sql: SqlClient.SqlClient, runId: string, blockId: string) {
  return Effect.gen(function* () {
    const [prepared] = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM run_prepared_workers WHERE run_id=${runId} AND block_id=${blockId}`;
    return prepared?.thread_id;
  });
}

/**
 * An acknowledged first send to a prepared worker makes its thread the Block's worker: bound,
 * observed and reported like a launched one. Returns whether this send activated it.
 */
export function activatePreparedWorker(
  sql: SqlClient.SqlClient,
  runRow: Pick<RunRow, "id" | "environment_id">,
  blockId: string,
  threadId: string,
) {
  return Effect.gen(function* () {
    const [bound] = yield* sql<{
      link: string | null;
    }>`UPDATE run_blocks SET thread_id=${threadId},link=(SELECT link FROM run_prepared_workers WHERE run_id=${runRow.id} AND block_id=${blockId}) WHERE run_id=${runRow.id} AND block_id=${blockId} AND thread_id IS NULL AND EXISTS(SELECT 1 FROM run_prepared_workers WHERE run_id=${runRow.id} AND block_id=${blockId} AND thread_id=${threadId}) RETURNING link`;
    if (!bound) return false;
    yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,link) VALUES(${yield* newId},${runRow.id},${blockId},${runRow.environment_id},${threadId},'worker',${bound.link}) ON CONFLICT DO NOTHING`;
    return true;
  });
}
