import type { Result, RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
import { failure } from "./result.ts";
import { newId } from "./ids.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";

export function openCoordinatorQuestionReplies(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
) {
  return (
    runId: string,
    input: { attentionId: string; requestId: string; message: string },
  ): Effect.Effect<Result<RunDetail>, unknown> =>
    Effect.gen(function* () {
      if (
        !input ||
        ![input.attentionId, input.requestId, input.message].every(
          (v) => typeof v === "string" && v.trim(),
        ) ||
        input.message.length > 100000
      )
        return failure(
          "validation",
          "Select a question and supply a request ID and nonempty answer.",
        );
      const run = yield* database.row(runId);
      if (!run) return failure("not_found", "This Run does not exist.");
      const accepted = yield* database.mutate(runId, (sql) =>
        Effect.gen(function* () {
          const [prior] = yield* sql<{
            attention_id: string;
            request_id: string;
            message: string;
          }>`SELECT * FROM coordinator_question_replies WHERE run_id=${runId} AND (attention_id=${input.attentionId} OR request_id=${input.requestId})`;
          if (prior)
            return prior.attention_id === input.attentionId &&
              prior.request_id === input.requestId &&
              prior.message === input.message
              ? { ok: true as const, value: false }
              : failure(
                  "conflict",
                  "This question or request already has a different immutable answer.",
                );
          if (!(yield* database.runHeldUnderContext(sql, run, true)))
            return failure("conflict", "This Run no longer accepts answers.");
          const [question] = yield* sql<{
            activation_id: string;
            block_id: string;
            binding_id: string;
            thread_id: string;
          }>`SELECT w.activation_id,a.block_id,b.id AS binding_id,b.thread_id FROM coordinator_waits w JOIN run_attention a ON a.id=w.attention_id JOIN run_thread_bindings b ON b.id=w.target_binding_id WHERE a.id=${input.attentionId} AND a.run_id=${runId} AND a.settled_at IS NULL AND (b.role='coordinator' OR (b.role='worker' AND EXISTS(SELECT 1 FROM run_worker_activations x WHERE x.activation_id=w.activation_id AND x.binding_id=b.id)))`;
          if (!question)
            return failure(
              "conflict",
              "Select an exact pending question in the responsible conversation.",
            );
          const intentId = yield* newId;
          const body = JSON.stringify({
            environmentId: run.environment_id,
            threadId: question.thread_id,
            mode: "queue",
            clientRequestId: intentId,
            message: input.message,
          });
          yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id) VALUES(${intentId},${runId},${question.block_id},'send',${"question:" + input.attentionId},${JSON.stringify({ ...runTarget(run), blockId: question.block_id, threadId: question.thread_id })},${intentId},${body},${fingerprint(body)},${run.context_id})`;
          yield* sql`INSERT INTO coordinator_question_replies VALUES(${input.attentionId},${runId},${input.requestId},${input.message},${intentId},${question.activation_id},${question.binding_id})`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runId}`;
          return { ok: true as const, value: true };
        }),
      );
      if (!accepted.ok) return accepted;
      if (accepted.value) yield* lifecycle.drive(runId, "dispatch");
      return yield* lifecycle.getRun(runId);
    });
}
