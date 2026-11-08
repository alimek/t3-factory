import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow, BlockRow } from "./runner-types.ts";
import { savedCoordination, type CoordinationSaved } from "./coordinator-evidence-saved.ts";
import { readCoordination } from "./coordinator-evidence-frontier.ts";
import { nativeRetention } from "./coordinator-native-obligations.ts";
import { remoteInputRetention } from "./coordinator-remote-input.ts";
import { localRetention } from "./coordinator-local-observations.ts";

export type {
  MemberObservation,
  CoordinationObservation,
} from "./coordinator-evidence-frontier.ts";

/** Fresh worker evidence retains positive references before dependent reads can fail. */
export function collectCoordination(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  block: BlockRow,
  activationId?: string,
) {
  return Effect.gen(function* () {
    const saved = yield* database.transaction((sql) =>
      savedCoordination(sql, run, block, activationId),
    );
    return yield* retainedCoordination(database, t3, run, block, saved);
  });
}

function retainedCoordination(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  block: BlockRow,
  saved: CoordinationSaved,
) {
  return Effect.gen(function* () {
    let retainedGenerations = 0;
    const retained = () => {
      retainedGenerations++;
    };
    const result = yield* Effect.tryPromise(() =>
      readCoordination(
        t3,
        run,
        block,
        saved,
        nativeRetention(database, run, block.block_id, retained),
        remoteInputRetention(database, run, block.block_id, retained),
        localRetention(database, run, block.block_id, retained),
      ),
    );
    return {
      activationId: saved.id,
      executions: saved.executions,
      result,
      // Own retention may advance the generation; any other mutation invalidates this observation.
      isCurrent: (sql: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run))) return false;
          const [current] = yield* sql<{
            generation: number;
          }>`SELECT generation FROM runs WHERE id=${run.id}`;
          return current?.generation === run.generation + retainedGenerations;
        }),
    };
  });
}
