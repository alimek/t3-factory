import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import type { NativeCommand } from "./adapters/native-command.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow, BlockRow } from "./runner-types.ts";
import type { RuntimeBinding } from "./runtime-types.ts";
import { savedCoordination, type CoordinationSaved } from "./coordinator-evidence-saved.ts";
import { readCoordination } from "./coordinator-evidence-frontier.ts";
import { nativeRetention } from "./coordinator-native-obligations.ts";
import { remoteInputRetention } from "./coordinator-remote-input.ts";
import { localRetention } from "./coordinator-local-observations.ts";
import { checkpointReads } from "./coordinator-checkpoint-reads.ts";
import { checkpointCommandCovered } from "./checkpoint-command.ts";
import { rootCheckpointCovered } from "./coordinator-checkpoint-root.ts";

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
      recoveredFailures: saved.recoveredFailures,
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

/** Gather outside the Run lane; revalidate this frontier against scoped durable state at acceptance. */
export function prepareCheckpoint(
  database: RunnerDatabase,
  t3: T3Adapter,
  binding: RuntimeBinding,
) {
  return Effect.gen(function* () {
    const run = yield* database.row(binding.factoryRunId);
    if (!run) return null;
    const [block] = yield* database.transaction(
      (sql) =>
        sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${run.id} AND block_id=${binding.blockId}`,
    );
    if (!block || !run.gate_open || run.closed_at) return null;
    const saved = yield* database.transaction((sql) => savedCoordination(sql, run, block));
    const before = yield* database.transaction((sql) =>
      checkpointExecutions(sql, run.id, block.block_id),
    );
    const reads = checkpointReads(t3);
    const { result: proof } = yield* retainedCoordination(
      database,
      reads.adapter,
      run,
      block,
      saved,
    );
    if (!proof.assessmentReady || proof.members[0]?.observation.activeRunId !== binding.runId)
      return null;
    reads.freeze();
    return {
      validate: (sql: import("effect/sql/SqlClient").SqlClient) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
          const current = yield* savedCoordination(sql, run, block);
          if (current.id !== saved.id) return false;
          if (JSON.stringify(current.recoveredFailures) !== JSON.stringify(saved.recoveredFailures))
            return false;
          const executions = yield* checkpointExecutions(sql, run.id, block.block_id);
          if (
            !executions.every(
              (e) =>
                before.some((old) => JSON.stringify(old) === JSON.stringify(e)) ||
                proof.members.some(
                  (m) =>
                    m.threadId === e.thread_id &&
                    m.observation.pendingRequestCount === e.native_request_count &&
                    m.observation.recentRuns.some(
                      (r) => r.runId === e.execution_id && r.status === e.engine_status,
                    ),
                ),
            )
          )
            return false;
          if (!(yield* rootCheckpointCovered(sql, run.id, proof, run.environment_id))) return false;
          const commands = yield* sql<{
            thread_id: string;
            evidence_json: string;
          }>`SELECT thread_id,evidence_json FROM coordinator_native_commands WHERE run_id=${run.id} AND block_id=${block.block_id}`;
          if (
            commands.some(
              (c) =>
                !checkpointCommandCovered(
                  { threadId: c.thread_id, command: JSON.parse(c.evidence_json) as NativeCommand },
                  proof,
                  run.environment_id,
                ),
            )
          )
            return false;
          const checked = yield* Effect.tryPromise(() =>
            readCoordination(
              reads.adapter,
              run,
              block,
              current,
              async () => {},
              async () => {},
              async () => {},
            ),
          );
          return (
            checked.assessmentReady && checked.members[0]?.observation.activeRunId === binding.runId
          );
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
      activationId: saved.id,
      evidence: JSON.stringify({ members: proof.evidence.members, sources: proof.sources }),
    };
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));
}

export type Checkpoint = NonNullable<Effect.Success<ReturnType<typeof prepareCheckpoint>>>;

function checkpointExecutions(
  sql: import("effect/sql/SqlClient").SqlClient,
  runId: string,
  blockId: string,
) {
  return sql<{
    thread_id: string;
    execution_id: string;
    engine_status: string;
    native_request_count: number;
  }>`SELECT thread_id,execution_id,engine_status,native_request_count FROM run_executions WHERE run_id=${runId} AND block_id=${blockId}`;
}
