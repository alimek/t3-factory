import type { RunCoordinationActions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "../runner-types.ts";

export function readCoordinationActions(sql: SqlClient.SqlClient, run: RunRow) {
  return Effect.gen(function* () {
    const questionReplies = yield* sql<
      RunCoordinationActions["questionReplies"][number]
    >`SELECT q.attention_id AS attentionId,q.request_id AS requestId,q.message,i.state,json_extract(i.result_json,'$.runId') AS executionId FROM coordinator_question_replies q JOIN operation_intents i ON i.id=q.intent_id WHERE q.run_id=${run.id} ORDER BY q.rowid`;
    return { questionReplies } satisfies RunCoordinationActions;
  });
}
