import type { Result, RunDetail } from "@t3-factory/contracts";
import { HUMAN_EXITS } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { createHandoffs } from "./runner-handoffs.ts";
import type { HumanRow, RunnerLifecycle, RunRow } from "./runner-types.ts";
import { fingerprint } from "./runner-utils.ts";
import { now } from "./time.ts";
export function openRunnerHuman(database: RunnerDatabase, lifecycle: RunnerLifecycle) {
  const { run, serial, row, transaction, owner } = database;
  const { isClosed, drive, getRun } = lifecycle;
  function answerHumanOccurrence(
    id: string,
    input: unknown,
  ): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed()) return failure("conflict", "Factory is shutting down.");
      if (!input || typeof input !== "object" || Array.isArray(input))
        return failure("validation", "Send an answer object.");
      const { exitId, message } = input as {
        exitId?: unknown;
        message?: unknown;
      };
      if (
        (exitId !== undefined && typeof exitId !== "string") ||
        (message !== undefined && (typeof message !== "string" || message.length > 100000))
      )
        return failure("validation", "Choose an exit and use text up to 100,000 characters.");
      const found = yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE id=${id}`)[0];
        }),
      );
      if (!found) return failure("not_found", "This Human occurrence does not exist.");
      return yield* serial(found.run_id, () => {
        return Effect.gen(function* () {
          const runRow = yield* row(found.run_id);
          if (!runRow) return failure("not_found", "This Run does not exist.");
          const accepted = yield* transaction((sql) =>
            Effect.gen(function* () {
              const [current] = yield* sql<RunRow>`SELECT * FROM runs WHERE id=${runRow.id}`;
              const [occurrence] =
                yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE id=${id}`;
              const [owned] = yield* sql`SELECT token FROM runner_owner WHERE token=${owner.token}`;
              if (!owned || !current?.gate_open)
                return failure("conflict", "This Run is archived and accepts no answers.");
              if (!occurrence) return failure("not_found", "This Human occurrence does not exist.");
              const exit = HUMAN_EXITS.find((candidate) => candidate.id === exitId);
              if (!exit) return failure("validation", "Choose Approve or Request changes.");
              if (exit.messageRequired && !message?.trim())
                return failure("validation", `${exit.name} requires a message.`);
              const content = fingerprint(JSON.stringify([exit.id, message ?? ""]));
              if (occurrence.state !== "pending")
                return occurrence.state === "answered" && occurrence.answer_fingerprint === content
                  ? { ok: true as const, value: undefined }
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
                      (edge) =>
                        edge.sourceBlockId === occurrence.block_id && edge.exitId === exit.id,
                    )
                    .map((edge) => edge.targetBlockId),
                ),
              ];
              yield* sql`UPDATE human_occurrences SET state='answered',pending_context=NULL,settled_at=${time},exit_id=${exit.id},answer_fingerprint=${content} WHERE id=${id} AND state='pending'`;
              yield* createHandoffs(
                sql,
                runRow,
                {
                  id,
                  block_id: occurrence.block_id,
                  exit_id: exit.id,
                  recipients_json: JSON.stringify(recipients),
                  pending_message: message ?? "",
                  accepted_at: time,
                },
                id,
              );
              yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason='answered' WHERE occurrence_id=${id} AND settled_at IS NULL`;
              yield* sql`UPDATE run_blocks SET state=CASE WHEN EXISTS(SELECT 1 FROM human_occurrences WHERE run_id=${runRow.id} AND block_id=${occurrence.block_id} AND state='pending') THEN 'waiting' ELSE 'finished' END WHERE run_id=${runRow.id} AND block_id=${occurrence.block_id}`;
              yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${occurrence.block_id},'human-answered',${"human-answer:" + id},${id},${time})`;
              yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${occurrence.block_id},'attention-settled',${"human-settled:" + id},${id},${time})`;
              yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
              return { ok: true as const, value: undefined };
            }),
          );
          if (!accepted.ok) return accepted;
          database.changes.runChanged(runRow.id);
          if (!isClosed()) yield* lifecycle.fork(drive(runRow.id, "dispatch"));
          return yield* getRun(runRow.id);
        });
      });
    });
  }
  return { answerHumanOccurrence };
}
