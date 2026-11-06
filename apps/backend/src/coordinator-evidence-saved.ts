import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { CoordinatorEvidence } from "@t3-factory/contracts";
import type { LocalExecution } from "./coordinator-selection.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { readRemoteReferences } from "./coordinator-remote.ts";

export interface CoordinationSaved {
  workerParentThreadId?: string | undefined;
  localExecutions: readonly LocalExecution[];
  remoteWork: readonly import("@t3-factory/contracts").RemoteWork[];
  checkpointEvidence?:
    | { members: CoordinatorEvidence["members"]; sources: readonly NativeSource[] }
    | undefined;
  recoveredFailures?: readonly { threadId: string; executionId: string }[];
  id: string;
  accepted_json: string | null;
  executions: readonly { thread_id: string; execution_id: string; activation_id: string | null }[];
  sources: readonly NativeSource[];
  members: readonly { thread_id: string; parent_thread_id: string | null; role: string }[];
}
export interface NativeSource {
  threadId: string;
  itemId: string;
  executionId: string;
  fingerprint: string;
}

export function savedCoordination(
  sql: SqlClient.SqlClient,
  run: RunRow,
  block: BlockRow,
  activationId?: string,
): Effect.Effect<CoordinationSaved, unknown> {
  return Effect.gen(function* () {
    const [saved] = yield* sql<{
      id: string;
      accepted_json: string | null;
    }>`SELECT a.id,d.accepted_json FROM run_activations a JOIN run_delegations d ON d.activation_id=a.id WHERE a.run_id=${run.id} AND a.block_id=${block.block_id} AND (${activationId ?? null} IS NULL OR a.id=${activationId ?? null}) ORDER BY a.rowid DESC LIMIT 1`;
    if (!saved) throw Error("Activation is missing.");
    const members = yield* sql<
      CoordinationSaved["members"][number]
    >`SELECT b.thread_id,b.role,p.thread_id AS parent_thread_id FROM run_thread_bindings b LEFT JOIN run_thread_bindings p ON p.id=b.parent_binding_id WHERE b.run_id=${run.id} AND b.block_id=${block.block_id}`;
    const sources = yield* sql<
      CoordinationSaved["sources"][number]
    >`SELECT thread_id AS threadId,item_id AS itemId,execution_id AS executionId,fingerprint FROM coordinator_native_items WHERE activation_id=${saved.id}`;
    const executions = yield* sql<
      CoordinationSaved["executions"][number]
    >`SELECT thread_id,execution_id,activation_id FROM run_executions WHERE run_id=${run.id} AND block_id=${block.block_id}
    UNION SELECT thread_id,execution_id,NULL FROM coordinator_native_obligations WHERE run_id=${run.id} AND block_id=${block.block_id} AND NOT EXISTS(SELECT 1 FROM run_executions e WHERE e.run_id=${run.id} AND e.thread_id=coordinator_native_obligations.thread_id AND e.execution_id=coordinator_native_obligations.execution_id)
    UNION SELECT o.thread_id,o.reference,NULL FROM run_root_obligations o JOIN run_thread_bindings b ON b.run_id=o.run_id AND b.thread_id=o.thread_id WHERE o.run_id=${run.id} AND b.block_id=${block.block_id} AND o.kind='execution' AND NOT EXISTS(SELECT 1 FROM run_executions e WHERE e.run_id=o.run_id AND e.thread_id=o.thread_id AND e.execution_id=o.reference)`;
    const [checkpoint] = yield* sql<{
      evidence_json: string;
    }>`SELECT evidence_json FROM assessment_checkpoints WHERE activation_id=${saved.id}`;
    return {
      ...saved,
      workerParentThreadId: (yield* sql<{
        parent_thread_id: string;
      }>`SELECT parent_thread_id FROM run_worker_activations WHERE activation_id=${saved.id}`)[0]
        ?.parent_thread_id,
      checkpointEvidence: checkpoint
        ? (JSON.parse(checkpoint.evidence_json) as CoordinationSaved["checkpointEvidence"])
        : undefined,
      localExecutions: yield* sql<
        import("./coordinator-selection.ts").LocalExecution
      >`SELECT thread_id,execution_id,parent_thread_id,provider_instance_id,model,ordinal FROM coordinator_local_executions WHERE run_id=${run.id}`,
      remoteWork: yield* readRemoteReferences(sql, run.id, block.block_id),
      members,
      sources,
      executions,
      recoveredFailures: yield* sql<{
        threadId: string;
        executionId: string;
      }>`SELECT c.reporter_thread_id AS threadId,c.reporter_execution_id AS executionId FROM assessment_checkpoints c JOIN run_activations a ON a.id=c.activation_id WHERE a.run_id=${run.id} AND a.block_id=${block.block_id}`,
    };
  });
}
