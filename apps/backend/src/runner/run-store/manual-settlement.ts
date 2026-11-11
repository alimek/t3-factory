import type { Result, RunSettlement, RunSettlementWorker } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";
import { threadHref } from "../../thread-link.ts";
import { now } from "../../time.ts";
import type { RunRow } from "../runner-types.ts";
import type { RunnerDatabase } from "./database.ts";
import { guardsHold } from "./guards.ts";
import { withLifecycle } from "./lifecycle.ts";
import { writeBlockState } from "./blocks.ts";
import { currentReports } from "./current-report.ts";
import { cancelOwedWork } from "./owed-work.ts";
import type { BlockState } from "./states.ts";
import { markSettled } from "./settlement.ts";
import type { WorkerThread } from "../worker-thread.ts";
import { recordExecution } from "./observation.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** Every Block state but working. */
const NOT_WORKING: readonly BlockState[] = [
  "not-started",
  "waiting",
  "finished",
  "error",
  "stopped",
  "sent",
  "pass-through",
];

/** A send whose T3 reply was lost when its Run settled manually: it is never replayed again. */
const UNRESOLVED_SEND_ON_SETTLE =
  "The Run was settled before Factory confirmed whether T3 received this message; Factory will not resend it.";

/** Settle's refusal for a Run whose authorization context Factory knows was replaced. */
const REPLACED_AUTHORIZATION =
  "This Run started under an earlier T3 authorization, so Factory cannot read or stop its workers to settle it. Archive it instead.";

/** Whether Factory knows an authorization context other than the Run's while the Run has work
 * only T3 can confirm under the Run's context: a bound worker or a launch whose outcome is
 * unresolved. The known context is kept while T3 is unavailable and cleared while
 * reauthorization is pending. A Run without such work settles without reading T3. */
const authorizationReplaced = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.map(
    sql`SELECT 1 FROM runs r JOIN t3_connection c ON c.singleton=1 WHERE r.id=${runId} AND c.context_id IS NOT NULL AND c.context_id!=r.context_id AND (EXISTS(SELECT 1 FROM run_blocks b WHERE b.run_id=r.id AND b.thread_id IS NOT NULL) OR EXISTS(SELECT 1 FROM operation_intents o WHERE o.run_id=r.id AND o.kind='launch' AND o.state IN ('reserved','uncertain')))`,
    (rows) => rows.length > 0,
  );

/** A bound worker thread of a Run, which manual settlement reads and Archive interrupts. */
export type BoundWorker = {
  readonly block_id: string;
  readonly name: string;
  readonly thread_id: string;
  readonly link: string | null;
};

type SettlementRow = {
  readonly requested_at: string;
  readonly attempt: number;
  readonly attempt_owner: string;
  readonly attempted_at: string;
};

/** A worker's record in one settlement attempt: its progress and the Stop request, if any. */
export type SettlementWorkerRecord = {
  readonly thread_id: string;
  readonly state: "stopping" | "finished" | "unresolved";
  readonly stop_key: string | null;
  readonly stop_requested_at: string | null;
  readonly stop_outcome: "acknowledged" | "failed" | "unsupported" | null;
  readonly stop_problem: string | null;
};

/** What the caller's fresh read showed for a worker when it settles the Run: its latest T3 run,
 * finished, if T3 showed one. */
export type SettledWorker = {
  readonly blockId: string;
  readonly threadId: string;
  readonly execution: WorkerThread["latest"];
};

const boundWorkerRows = (sql: SqlClient.SqlClient, runId: string) =>
  sql<BoundWorker>`SELECT b.block_id,b.name,b.thread_id,t.link FROM run_blocks b LEFT JOIN run_thread_bindings t ON t.run_id=b.run_id AND t.thread_id=b.thread_id WHERE b.run_id=${runId} AND b.thread_id IS NOT NULL ORDER BY b.rowid`;

/** A launch T3 may have accepted though Factory has no acknowledgement for it: it is still
 * searched for, and its worker, if any, is not bound yet. */
type UnresolvedLaunch = { readonly block_id: string; readonly name: string };

const unresolvedLaunchRows = (sql: SqlClient.SqlClient, runId: string) =>
  sql<UnresolvedLaunch>`SELECT o.block_id,b.name FROM operation_intents o JOIN run_blocks b ON b.run_id=o.run_id AND b.block_id=o.block_id WHERE o.run_id=${runId} AND o.kind='launch' AND o.state IN ('reserved','uncertain') ORDER BY o.rowid`;

/** An unresolved launch as a settlement worker: it blocks settlement until the search binds its
 * worker, which then joins Stop and the completion reads, or finds that none started. */
function unresolvedLaunchWorker(launch: UnresolvedLaunch): RunSettlementWorker {
  return {
    blockId: launch.block_id,
    blockName: launch.name,
    threadId: null,
    link: null,
    state: "unresolved",
    stopRequestedAt: null,
    problem:
      "Factory has not confirmed whether T3 launched this worker. It keeps searching and stops the worker it finds.",
  };
}

/** Both unresolved launch outcomes and workers block a confirmed settlement. */
function settlementState(
  unresolvedWorker: boolean,
  unresolvedLaunch: boolean,
): RunSettlement["state"] {
  return unresolvedWorker || unresolvedLaunch ? "unresolved" : "stopping";
}

/** Navigation reads settlement progress for its listed Runs in three bulk queries. */
export function readRunSettlementStates(
  sql: SqlClient.SqlClient,
  runs: readonly { readonly id: string; readonly settled_at: string | null }[],
) {
  return Effect.gen(function* () {
    const ids = runs.filter((run) => !run.settled_at).map((run) => run.id);
    if (!ids.length) return new Map<string, RunSettlement["state"] | null>();
    const settlements = yield* sql<{
      run_id: string;
    }>`SELECT run_id FROM run_settlements WHERE run_id IN ${sql.in(ids)}`;
    const workers = yield* sql<{
      run_id: string;
    }>`SELECT DISTINCT w.run_id FROM run_settlement_workers w JOIN run_settlements s ON s.run_id=w.run_id AND s.attempt=w.attempt WHERE w.run_id IN ${sql.in(ids)} AND w.state='unresolved'`;
    const launches = yield* sql<{
      run_id: string;
    }>`SELECT DISTINCT run_id FROM operation_intents WHERE run_id IN ${sql.in(ids)} AND kind='launch' AND state IN ('reserved','uncertain')`;
    const confirmed = new Set(settlements.map((row) => row.run_id));
    const unresolvedWorkers = new Set(workers.map((row) => row.run_id));
    const unresolvedLaunches = new Set(launches.map((row) => row.run_id));
    return new Map(
      ids.map((id) => [
        id,
        confirmed.has(id)
          ? settlementState(unresolvedWorkers.has(id), unresolvedLaunches.has(id))
          : null,
      ]),
    );
  });
}

/** The confirmed manual settlement of a Run that has not settled yet, as Run detail shows it. */
export function readRunSettlement(
  sql: SqlClient.SqlClient,
  run: {
    readonly id: string;
    readonly settled_at: string | null;
    readonly archived_at: string | null;
  },
) {
  return Effect.gen(function* (): Effect.fn.Return<RunSettlement | null, unknown> {
    if (run.settled_at || run.archived_at) return null;
    const [row] = yield* sql<SettlementRow>`SELECT * FROM run_settlements WHERE run_id=${run.id}`;
    if (!row) return null;
    const workers = yield* sql<{
      block_id: string;
      name: string;
      thread_id: string;
      link: string | null;
      state: "stopping" | "finished" | "unresolved";
      stop_requested_at: string | null;
      problem: string | null;
    }>`SELECT w.block_id,b.name,w.thread_id,t.link,w.state,w.stop_requested_at,w.problem FROM run_settlement_workers w JOIN run_blocks b ON b.run_id=w.run_id AND b.block_id=w.block_id LEFT JOIN run_thread_bindings t ON t.run_id=w.run_id AND t.thread_id=w.thread_id WHERE w.run_id=${run.id} AND w.attempt=${row.attempt} ORDER BY b.rowid`;
    const launches = yield* unresolvedLaunchRows(sql, run.id);
    return {
      state: settlementState(
        workers.some((worker) => worker.state === "unresolved"),
        launches.length > 0,
      ),
      requestedAt: row.requested_at,
      attempt: row.attempt,
      attemptedAt: row.attempted_at,
      workers: [
        ...workers.map((worker): RunSettlementWorker => ({
          blockId: worker.block_id,
          blockName: worker.name,
          threadId: worker.thread_id,
          link: threadHref(worker.link),
          state: worker.state,
          stopRequestedAt: worker.stop_requested_at,
          problem: worker.problem,
        })),
        ...launches.map(unresolvedLaunchWorker),
      ],
    };
  });
}

/** Records a worker of the current attempt; one bound while stopping joins it. */
function recordWorker(
  sql: SqlClient.SqlClient,
  runId: string,
  attempt: number,
  worker: Pick<BoundWorker, "thread_id" | "block_id">,
) {
  return sql`INSERT INTO run_settlement_workers(run_id,attempt,thread_id,block_id,state) VALUES(${runId},${attempt},${worker.thread_id},${worker.block_id},'stopping') ON CONFLICT DO NOTHING`;
}

/** Records each worker's latest run as the completion reads showed it ended. The Run is never
 * observed again, so these reads are the last record of how its work ended. A requested Stop
 * raises no Problem, and one already recorded stays. */
function recordSettledExecutions(
  sql: SqlClient.SqlClient,
  runId: string,
  workers: readonly SettledWorker[],
  time: string,
) {
  return Effect.gen(function* () {
    for (const worker of workers) {
      if (!worker.execution) continue;
      // A recorded execution keeps its owner, such as the Continuation whose prompt ran on this
      // Agent's thread, so its end is attributed to it; a new record belongs to the worker.
      const [owner] = yield* sql<{
        block_id: string;
        binding_id: string | null;
      }>`SELECT block_id,binding_id FROM run_executions WHERE run_id=${runId} AND thread_id=${worker.threadId} AND execution_id=${worker.execution.runId}`;
      const [binding] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_thread_bindings WHERE run_id=${runId} AND thread_id=${worker.threadId}`;
      const bindingId = owner?.binding_id ?? binding?.id;
      if (bindingId)
        yield* recordExecution(
          sql,
          {
            runId,
            blockId: owner?.block_id ?? worker.blockId,
            threadId: worker.threadId,
            bindingId,
          },
          worker.execution,
          0,
          "keep",
          time,
        );
    }
  });
}

export function openRunManualSettlement(database: RunnerDatabase) {
  const ownerToken = database.owner.token;

  /** Skip Runs without a confirmed settlement before entering their drive lanes. */
  const runsWithSettlement = (ids: readonly string[]) =>
    ids.length
      ? database.transaction(
          (sql) =>
            sql<{
              run_id: string;
            }>`SELECT run_id FROM run_settlements WHERE run_id IN ${sql.in(ids)}`,
        )
      : Effect.succeed([]);

  /** A settlement transition on an unarchived Run this backend owns; it answers false otherwise.
   * Published when it answers true. */
  const settlementMutation = (
    run: RunRow,
    body: (sql: SqlClient.SqlClient) => Effect.Effect<boolean, unknown, SqlClient.SqlClient>,
  ) =>
    database.mutate(
      run.id,
      (sql) =>
        Effect.gen(function* () {
          if (!(yield* guardsHold(sql, ownerToken, run.id, { owner: true, notArchived: true })))
            return false;
          return yield* body(sql);
        }),
      (changed) => changed,
    );

  const boundWorkers = (runId: string) =>
    database.transaction((sql) => boundWorkerRows(sql, runId));

  /** The Run's launches whose outcome is unresolved, as unresolved settlement workers. */
  const unresolvedLaunches = (runId: string) =>
    database.transaction((sql) =>
      Effect.map(unresolvedLaunchRows(sql, runId), (rows) => rows.map(unresolvedLaunchWorker)),
    );

  /** Settle's conflict when the Run's known authorization context was replaced, else null. */
  const replacedAuthorization = (runId: string) =>
    database.transaction((sql) =>
      Effect.map(authorizationReplaced(sql, runId), (replaced) =>
        replaced ? failure("conflict", REPLACED_AUTHORIZATION) : null,
      ),
    );

  /** The current attempt of the Run's confirmed settlement, whether this backend accepted it, and
   * its workers' records. */
  const readSettlementAttempt = (runId: string) =>
    database.transaction((sql) =>
      Effect.gen(function* () {
        const [row] =
          yield* sql<SettlementRow>`SELECT * FROM run_settlements WHERE run_id=${runId}`;
        if (!row) return null;
        const workers =
          yield* sql<SettlementWorkerRecord>`SELECT thread_id,state,stop_key,stop_requested_at,stop_outcome,stop_problem FROM run_settlement_workers WHERE run_id=${runId} AND attempt=${row.attempt}`;
        return { attempt: row.attempt, owned: row.attempt_owner === ownerToken, workers };
      }),
    );

  /** The user confirms stopping the Run's workers to settle it. Guards: the Run exists, is not
   * Archived, this backend owns the database and no known authorization context replaced the
   * Run's, also while T3 is unavailable: such a settlement could never complete. A Settled Run
   * is left unchanged. The first
   * confirmation closes the handoff gate and starts attempt 1; a later one starts the next
   * attempt only while the current attempt has an unresolved worker or launch. Both record this
   * backend as the attempt's owner, the bound workers as stopping and "settlement requested", and advance the
   * generation. Answers whether an attempt started. */
  function acceptSettlement(id: string): Effect.Effect<Result<boolean>, unknown> {
    return withLifecycle<boolean>(database, id, (sql, run) =>
      Effect.gen(function* () {
        if (run.archived_at) return failure("conflict", "An archived Run cannot be settled.");
        if (run.settled_at) return { ok: true as const, value: false };
        if (!(yield* guardsHold(sql, ownerToken, id, { owner: true })))
          return failure("conflict", "Runner ownership changed.");
        if (yield* authorizationReplaced(sql, id))
          return failure("conflict", REPLACED_AUTHORIZATION);
        const [current] =
          yield* sql<SettlementRow>`SELECT * FROM run_settlements WHERE run_id=${id}`;
        const time = yield* now;
        if (current) {
          const settlement = yield* readRunSettlement(sql, { id, ...run });
          if (settlement?.state !== "unresolved") return { ok: true as const, value: false };
          yield* sql`UPDATE run_settlements SET attempt=attempt+1,attempt_owner=${ownerToken},attempted_at=${time},stop_pass_at=NULL WHERE run_id=${id}`;
        } else {
          yield* sql`UPDATE runs SET gate_open=0 WHERE id=${id}`;
          yield* sql`INSERT INTO run_settlements(run_id,requested_at,attempt,attempt_owner,attempted_at) VALUES(${id},${time},1,${ownerToken},${time})`;
        }
        const attempt = (current?.attempt ?? 0) + 1;
        for (const worker of yield* boundWorkerRows(sql, id))
          yield* recordWorker(sql, id, attempt, worker);
        yield* appendTimelineEvent(sql, {
          kind: "settlement-requested",
          runId: id,
          attempt,
          observedAt: time,
        });
        yield* advanceGeneration(sql, id);
        return { ok: true as const, value: true };
      }),
    );
  }

  /** Claims the one pass of `attempt` that requests Stop. Guards: this backend owns the database
   * and accepted the attempt, which is still current and unclaimed, on an unsettled Run that is
   * not Archived. A restarted backend never claims an earlier owner's attempt. */
  const claimStopPass = (run: RunRow, attempt: number) =>
    settlementMutation(run, (sql) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE run_settlements SET stop_pass_at=${yield* now} WHERE run_id=${run.id} AND attempt=${attempt} AND attempt_owner=${ownerToken} AND stop_pass_at IS NULL AND EXISTS(SELECT 1 FROM runs WHERE id=${run.id} AND settled_at IS NULL) RETURNING run_id`;
        return rows.length > 0;
      }),
    );

  /** Records Stop for `worker` before its one request in `attempt`. Guards: owner, not Archived,
   * the Run's live authorization context, the attempt is current and this backend accepted it, and
   * no Stop is recorded for the worker in it. Appends "worker stop requested"; does not advance the
   * generation. Answers whether the caller may send it. */
  const claimWorkerStop = (
    run: RunRow,
    attempt: number,
    worker: BoundWorker,
    request: { readonly key: string; readonly executionId: string | null },
  ) =>
    settlementMutation(run, (sql) =>
      Effect.gen(function* () {
        if (!(yield* guardsHold(sql, ownerToken, run.id, { liveContext: run.context_id })))
          return false;
        const time = yield* now;
        yield* recordWorker(sql, run.id, attempt, worker);
        const rows =
          yield* sql`UPDATE run_settlement_workers SET stop_key=${request.key},stop_requested_at=${time} WHERE run_id=${run.id} AND attempt=${attempt} AND thread_id=${worker.thread_id} AND stop_key IS NULL AND stop_outcome IS NULL AND EXISTS(SELECT 1 FROM run_settlements WHERE run_id=${run.id} AND attempt=${attempt} AND attempt_owner=${ownerToken}) RETURNING thread_id`;
        if (!rows.length) return false;
        yield* appendTimelineEvent(sql, {
          kind: "worker-stop-requested",
          runId: run.id,
          blockId: worker.block_id,
          executionId: request.executionId,
          requestKey: request.key,
          observedAt: time,
        });
        return true;
      }),
    );

  /** Records what became of Stop for `worker` in `attempt`: T3 acknowledged or refused the
   * request, or does not support Stop. Guards: owner, not Archived and the attempt is current. */
  const recordStopOutcome = (
    run: RunRow,
    attempt: number,
    worker: BoundWorker,
    outcome: "acknowledged" | "failed" | "unsupported",
    problem: string | null,
  ) =>
    settlementMutation(run, (sql) =>
      Effect.gen(function* () {
        yield* recordWorker(sql, run.id, attempt, worker);
        const rows =
          yield* sql`UPDATE run_settlement_workers SET stop_outcome=${outcome},stop_problem=${problem} WHERE run_id=${run.id} AND attempt=${attempt} AND thread_id=${worker.thread_id} AND EXISTS(SELECT 1 FROM run_settlements WHERE run_id=${run.id} AND attempt=${attempt}) RETURNING thread_id`;
        return rows.length > 0;
      }),
    );

  /** Records each worker's progress in `attempt` from the caller's fresh reads. Guards: owner, not
   * Archived and the attempt is current on an unsettled Run. Published only when a worker's
   * progress changed; the generation is not advanced. */
  const recordSettlementProgress = (
    run: RunRow,
    attempt: number,
    workers: readonly (BoundWorker & {
      readonly state: "stopping" | "finished" | "unresolved";
      readonly problem: string | null;
    })[],
  ) =>
    settlementMutation(run, (sql) =>
      Effect.gen(function* () {
        let changed = false;
        for (const worker of workers) {
          yield* recordWorker(sql, run.id, attempt, worker);
          const rows =
            yield* sql`UPDATE run_settlement_workers SET state=${worker.state},problem=${worker.problem} WHERE run_id=${run.id} AND attempt=${attempt} AND thread_id=${worker.thread_id} AND (state IS NOT ${worker.state} OR problem IS NOT ${worker.problem}) AND EXISTS(SELECT 1 FROM run_settlements s JOIN runs r ON r.id=s.run_id WHERE s.run_id=${run.id} AND s.attempt=${attempt} AND r.settled_at IS NULL) RETURNING thread_id`;
          changed ||= rows.length > 0;
        }
        return changed;
      }),
    );

  /** Settles `run` manually once the caller's fresh reads, made at `run`'s generation, confirmed
   * every bound worker finished. Guards: owner, not Archived, not Settled, the generation, no
   * launch whose outcome is unresolved and, when the Run has workers, its live authorization
   * context. Closes the gate, cancels owed automatic work with the manual-settlement reason,
   * leaves each reserved or uncertain send uncertain without its payload, records each worker's
   * latest run as the reads showed it ended, without raising attention or replacing a recorded
   * Problem, records "worker stopped" for each worker whose Stop T3 acknowledged, settles the Run (clearing Snooze and
   * Woke) and advances the generation. Answers whether the Run settled. */
  function completeSettlement(run: RunRow, workers: readonly SettledWorker[]) {
    const id = run.id;
    return database.mutate(id, (sql) =>
      Effect.gen(function* () {
        const held = yield* guardsHold(sql, ownerToken, id, {
          owner: true,
          notArchived: true,
          generation: run.generation,
          ...(workers.length ? { liveContext: run.context_id } : {}),
        });
        if (!held) return false;
        const [current] = yield* sql<{
          settled_at: string | null;
        }>`SELECT settled_at FROM runs WHERE id=${id}`;
        if (current?.settled_at) return false;
        if ((yield* unresolvedLaunchRows(sql, id)).length) return false;
        const time = yield* now;
        yield* sql`UPDATE runs SET gate_open=0 WHERE id=${id}`;
        // A working Block whose current report is its Final result finished: the reads confirmed
        // its thread finished, though no observation recorded that yet.
        for (const entry of yield* currentReports(sql, id))
          if (entry.report?.status === "finished")
            yield* writeBlockState(
              sql,
              { runId: id, blockId: entry.blockId },
              { keep: NOT_WORKING, otherwise: "finished" },
            );
        yield* cancelOwedWork(sql, id, time, "settle");
        // T3 has no read for a send's outcome and only a same-key replay can resolve it, which
        // the closed gate forbids. The send stays uncertain, never cancelled, and its payload,
        // needed for nothing but that replay, is cleared.
        const unresolvedSends = yield* sql<{
          id: string;
          block_id: string;
        }>`UPDATE operation_intents SET state='uncertain',payload_json=NULL,problem=${UNRESOLVED_SEND_ON_SETTLE},reconciled_at=${time} WHERE run_id=${id} AND kind='send' AND state IN ('reserved','uncertain') RETURNING id,block_id`;
        for (const send of unresolvedSends)
          yield* appendTimelineEvent(sql, {
            kind: "operation-unresolved",
            runId: id,
            blockId: send.block_id,
            intentId: send.id,
            observedAt: time,
          });
        yield* recordSettledExecutions(sql, id, workers, time);
        const stopped = yield* sql<{
          thread_id: string;
        }>`SELECT thread_id FROM run_settlement_workers WHERE run_id=${id} AND attempt=(SELECT attempt FROM run_settlements WHERE run_id=${id}) AND stop_outcome='acknowledged'`;
        for (const worker of workers)
          if (stopped.some((row) => row.thread_id === worker.threadId))
            yield* appendTimelineEvent(sql, {
              kind: "worker-stopped",
              runId: id,
              blockId: worker.blockId,
              executionId: worker.execution?.runId ?? null,
              engineStatus: worker.execution?.status ?? null,
              observedAt: time,
            });
        yield* markSettled(sql, id, "manual", time);
        yield* sql`UPDATE runtime_reports SET completion_eligible_at=COALESCE(completion_eligible_at,${time}) WHERE run_id=${id}`;
        yield* advanceGeneration(sql, id);
        return true;
      }),
    );
  }

  return {
    runsWithSettlement,
    boundWorkers,
    unresolvedLaunches,
    replacedAuthorization,
    readSettlementAttempt,
    acceptSettlement,
    claimStopPass,
    claimWorkerStop,
    recordStopOutcome,
    recordSettlementProgress,
    completeSettlement,
  };
}
