import type { Result } from "@t3-factory/contracts";
import { HUMAN_EXITS } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import { failure } from "../../result.ts";
import type { HumanRow } from "../runner-types.ts";
import { fingerprint } from "../runner-utils.ts";
import { now } from "../../time.ts";
import { settleHumanAttention } from "./attention.ts";
import { guardsHold } from "./guards.ts";
import { createHeldHandoffs, storedOrigin } from "./handoffs.ts";
import type { DeliveryRecord } from "./records.ts";
import { readRunRow, type RunnerDatabase } from "./database.ts";
import { writeBlockState } from "./blocks.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** An answer as the public operation validated its shape. */
type HumanAnswer = { readonly exitId: string | undefined; readonly message: string | undefined };

export function openRunHuman(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Answers Human occurrence `id`. Guards: this backend owns the database and the gate is open
   * (otherwise the Run accepts no answers). The exit and its required message are validated
   * next, because the answer's fingerprint needs them; only then is an occurrence already
   * answered with the same answer acknowledged without change, and any other settlement a
   * conflict. An answer settles the occurrence and its attention, sets the Human step
   * waiting while another occurrence is pending and finished otherwise, creates its Handoffs and
   * advances the generation once. Only an applied or repeated answer is published. */
  function answerHumanOccurrence(
    id: string,
    { exitId, message }: HumanAnswer,
  ): Effect.Effect<Result<{ readonly runId: string }>, unknown> {
    return Effect.gen(function* () {
      const [found] = yield* database.transaction(
        (sql) => sql<HumanRow>`SELECT * FROM human_occurrences WHERE id=${id}`,
      );
      if (!found) return failure("not_found", "This Human occurrence does not exist.");
      const runId = found.run_id;
      return yield* database.mutate(
        runId,
        (sql) =>
          Effect.gen(function* (): Effect.fn.Return<Result<{ readonly runId: string }>, unknown> {
            const runRow = yield* readRunRow(sql, runId);
            if (!runRow) return failure("not_found", "This Run does not exist.");
            const [occurrence] =
              yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE id=${id}`;
            if (!(yield* guardsHold(sql, ownerToken, runId, { owner: true, gateOpen: true })))
              return failure("conflict", "This Run is archived and accepts no answers.");
            if (!occurrence) return failure("not_found", "This Human occurrence does not exist.");
            const exit = HUMAN_EXITS.find((candidate) => candidate.id === exitId);
            if (!exit) return failure("validation", "Choose Approve or Request changes.");
            if (exit.messageRequired && !message?.trim())
              return failure("validation", `${exit.name} requires a message.`);
            const content = fingerprint(JSON.stringify([exit.id, message ?? ""]));
            if (occurrence.state !== "pending")
              return occurrence.state === "answered" && occurrence.answer_fingerprint === content
                ? { ok: true as const, value: { runId } }
                : failure(
                    "conflict",
                    "This occurrence has already been settled with a different answer or reason.",
                  );
            const time = yield* now;
            const graph = runRow.definitions.flow.graph;
            const recipients = [
              ...new Set(
                graph.connections
                  .filter(
                    (edge) => edge.sourceBlockId === occurrence.block_id && edge.exitId === exit.id,
                  )
                  .map((edge) => edge.targetBlockId),
              ),
            ];
            const [incoming] = yield* sql<
              Pick<DeliveryRecord, "origin_activation_id" | "origin_thread_id">
            >`SELECT origin_activation_id,origin_thread_id FROM operation_intents WHERE id=${occurrence.incoming_intent_id}`;
            yield* sql`UPDATE human_occurrences SET state='answered',pending_context=NULL,settled_at=${time},exit_id=${exit.id},answer_fingerprint=${content} WHERE id=${id} AND state='pending'`;
            yield* createHeldHandoffs(sql, runRow, {
              kind: "human",
              id,
              blockId: occurrence.block_id,
              exitId: exit.id,
              recipients,
              message: message ?? "",
              at: time,
              origin: storedOrigin(incoming!),
            });
            yield* writeBlockState(
              sql,
              { runId, blockId: occurrence.block_id },
              { whileArrivalPending: "waiting", otherwise: "finished" },
            );
            yield* appendTimelineEvent(sql, {
              kind: "human-answered",
              runId,
              blockId: occurrence.block_id,
              occurrenceId: id,
              observedAt: time,
            });
            yield* settleHumanAttention(sql, runId, occurrence.block_id, id, time);
            yield* advanceGeneration(sql, runId);
            return { ok: true as const, value: { runId } };
          }),
        (answered) => answered.ok,
      );
    });
  }

  return { answerHumanOccurrence };
}
