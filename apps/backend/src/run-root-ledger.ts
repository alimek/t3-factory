import { recordRootWork } from "./run-root-history.ts";
import { observationLedger } from "./observation-ledger.ts";
import { fingerprint } from "./runner-utils.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import type { NativeCommand } from "./adapters/native-command.ts";
import { peerLedger } from "./coordinator-peer-ledger.ts";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";

export type RootObligation = {
  thread_id: string;
  kind: "member" | "execution" | "native" | "remote" | "command" | "followup";
  reference: string;
};
export function rootLedger(database: RunnerDatabase, run: RunRow) {
  const read = () =>
    Effect.runPromise(
      database.transaction(
        (sql) =>
          sql<RootObligation>`SELECT thread_id,kind,reference FROM run_root_obligations WHERE run_id=${run.id}`,
      ),
    );
  const retain = (rows: readonly RootObligation[]) =>
    Effect.runPromise(
      database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return;
          let changed = false;
          for (const row of rows) {
            const inserted =
              yield* sql`INSERT INTO run_root_obligations(run_id,thread_id,kind,reference) VALUES(${run.id},${row.thread_id},${row.kind},${row.reference}) ON CONFLICT DO NOTHING RETURNING reference`;
            changed ||= inserted.length > 0;
            const retained = yield* retainRootMutation(sql, run.id, row);
            changed ||= retained;
          }
          if (changed) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        }),
      ),
    );
  const retainRemoteCommands = async (commands: readonly NativeCommand[]) => {
    for (const command of commands)
      for (const reference of command.references) {
        if (
          reference.environmentId === null ||
          reference.environmentId === run.environment_id ||
          !reference.executionId
        )
          continue;
        await peerLedger(database, run, reference.environmentId, reference.threadId).retain([
          { threadId: reference.threadId, kind: "execution", reference: reference.executionId },
        ]);
      }
  };
  if (run.closed_at)
    return {
      ...observationLedger(read),
      retainRemoteCommands: async () => {},
      recordWork: async () => {},
    };
  return {
    read,
    retain,
    retainRemoteCommands,
    recordWork: (observation: import("./adapters/t3.ts").ExecutionObservation) =>
      Effect.runPromise(recordRootWork(database, run, observation)),
  };
}
export const rootExecutionRows = (
  thread_id: string,
  ids: readonly (string | null | undefined)[],
): RootObligation[] =>
  ids
    .filter((id): id is string => !!id)
    .map((reference) => ({ thread_id, kind: "execution", reference }));

/** An unavailable fresh read invalidates an older closure observation without erasing obligations. */
export function rootUnavailable(database: RunnerDatabase, runId: string) {
  return database.mutate(runId, (sql) =>
    Effect.gen(function* () {
      const changed =
        yield* sql`UPDATE run_coordinators SET freshness='stale',problem='Run conversation observations unavailable.' WHERE run_id=${runId} AND EXISTS(SELECT 1 FROM runs WHERE id=${runId} AND closed_at IS NULL) AND freshness!='stale' RETURNING run_id`;
      if (changed.length) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runId}`;
    }),
  );
}

/** Reuse the pre-existing Root recovery obligation index without inventing Block membership. */
function retainRootMutation(sql: SqlClient.SqlClient, runId: string, row: RootObligation) {
  return Effect.gen(function* () {
    if (!["command", "remote", "followup"].includes(row.kind)) return false;
    const retained =
      yield* sql`INSERT INTO run_coordinator_obligations(run_id,source_key,evidence_json) SELECT ${runId},${"root-mutation:" + row.kind + ":" + fingerprint(row.reference)},${row.reference} FROM run_coordinators WHERE run_id=${runId} AND thread_id=${row.thread_id} ON CONFLICT DO NOTHING RETURNING source_key`;
    return retained.length > 0;
  });
}
