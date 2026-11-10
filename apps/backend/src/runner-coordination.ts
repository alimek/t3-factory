import { threadHref } from "./thread-link.ts";
import type { RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export function coordinationRead(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      blockId: string;
      cause: string;
      phase: RunDetail["activations"][number]["phase"];
      problem: string | null;
      createdAt: string;
      requestKey: string;
      inputFingerprint: string;
      accepted_json: string | null;
    }>`SELECT a.id,a.block_id AS blockId,a.cause,a.phase,a.created_at AS createdAt,a.problem,d.request_key AS requestKey,d.input_fingerprint AS inputFingerprint,d.accepted_json FROM run_activations a JOIN activation_messages d ON d.activation_id=a.id WHERE a.run_id=${id} ORDER BY a.rowid`;
    const threadBindings = yield* sql<
      RunDetail["threadBindings"][number]
    >`SELECT id,block_id AS blockId,environment_id AS environmentId,thread_id AS threadId,role,link,parent_binding_id AS parentBindingId FROM run_thread_bindings WHERE run_id=${id} ORDER BY rowid`;
    return {
      activations: rows.map(({ requestKey, inputFingerprint, accepted_json, ...activation }) => ({
        ...activation,
        delegation: {
          requestKey,
          inputFingerprint,
          state: accepted_json ? ("accepted" as const) : ("planned" as const),
          ...(accepted_json ? { accepted: acceptedReference(accepted_json) } : {}),
        },
      })),
      threadBindings: threadBindings.map((binding) => ({
        ...binding,
        link: threadHref(binding.link),
      })),
    };
  });
}

/** Native delegation acceptance stored by the retired Run conversation, kept as closed history. */
type StoredAcceptance = {
  itemId: string;
  parentRunId: string;
  result: { taskId: string; childThreadId: string; childRunId: string | null };
};
function acceptedReference(json: string) {
  const source = JSON.parse(json) as StoredAcceptance;
  return {
    taskId: source.result.taskId,
    childThreadId: source.result.childThreadId,
    childExecutionId: source.result.childRunId,
    sourceExecutionId: source.parentRunId,
    itemId: source.itemId,
  };
}
