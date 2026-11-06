import { localCommandReferences } from "./native-command-creation.ts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { rootLedger, rootExecutionRows } from "./run-root-ledger.ts";

/** Workers retain their activation membership. Root keeps independent safety references. */
export async function retainAssignedRootWork(database: RunnerDatabase, run: RunRow) {
  const saved = await Effect.runPromise(
    database.transaction((sql) =>
      Effect.gen(function* () {
        const members = yield* sql<{
          threadId: string;
          parentThreadId: string | null;
        }>`SELECT b.thread_id AS threadId,COALESCE(p.thread_id,(SELECT parent_thread_id FROM run_worker_activations w WHERE w.binding_id=b.id LIMIT 1)) AS parentThreadId FROM run_thread_bindings b LEFT JOIN run_thread_bindings p ON p.id=b.parent_binding_id WHERE b.run_id=${run.id}`;
        const executions = yield* sql<{
          thread_id: string;
          execution_id: string;
        }>`SELECT thread_id,execution_id FROM run_executions WHERE run_id=${run.id} UNION SELECT thread_id,execution_id FROM coordinator_native_obligations WHERE run_id=${run.id}`;
        const native = yield* sql<{
          thread_id: string;
          item_id: string;
          execution_id: string;
          fingerprint: string;
        }>`SELECT n.* FROM coordinator_native_items n JOIN run_activations a ON a.id=n.activation_id WHERE a.run_id=${run.id} AND NOT EXISTS(SELECT 1 FROM coordinator_remote_work w WHERE w.activation_id=n.activation_id AND w.parent_thread_id=n.thread_id AND w.source_item_id=n.item_id AND w.source_execution_id=n.execution_id AND w.source_fingerprint=n.fingerprint AND w.resolved=1 AND w.task_id IS NULL AND w.thread_id IS NULL)`;
        const commands = yield* sql<{
          thread_id: string;
          evidence_json: string;
        }>`SELECT thread_id,evidence_json FROM coordinator_native_commands WHERE run_id=${run.id}`;
        return { members, executions, native, commands };
      }),
    ),
  );
  await rootLedger(database, run).retain([
    ...saved.members.map((m) => ({
      thread_id: m.threadId,
      kind: "member" as const,
      reference: JSON.stringify({
        threadId: m.threadId,
        parentThreadId: m.parentThreadId,
      }),
    })),
    ...saved.executions.flatMap((e) => rootExecutionRows(e.thread_id, [e.execution_id])),
    ...saved.native.map((n) => ({
      thread_id: n.thread_id,
      kind: "native" as const,
      reference: JSON.stringify([n.item_id, n.execution_id, n.fingerprint]),
    })),
    ...saved.commands.flatMap((n) => {
      const c = JSON.parse(n.evidence_json) as import("./adapters/native-command.ts").NativeCommand;
      return [
        ...rootExecutionRows(n.thread_id, [c.parentRunId]),
        ...localCommandReferences([c], run.environment_id).flatMap((r) => [
          {
            thread_id: r.threadId,
            kind: "member" as const,
            reference: JSON.stringify({ threadId: r.threadId, parentThreadId: null }),
          },
          ...rootExecutionRows(r.threadId, [r.executionId]),
        ]),
        { thread_id: n.thread_id, kind: "command" as const, reference: n.evidence_json },
        {
          thread_id: n.thread_id,
          kind: "native" as const,
          reference: JSON.stringify([c.itemId, c.parentRunId, c.fingerprint]),
        },
      ];
    }),
  ]);
  return new Set(saved.members.map((m) => m.threadId));
}
