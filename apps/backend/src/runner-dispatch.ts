import { dispatchBlockLaunch } from "./runner-block-workers.ts";
import { prepareCoordinatorHandoff } from "./runner-coordinator-handoffs.ts";
import { UNOBSERVED_WORKER_HOLD } from "./runner-coordination.ts";
import type { EffectOperations } from "./effect-operations.ts";
import { recoverOperation } from "./runner-effects.ts";
import { recoveryDispatchGeneration } from "./runner-recovery.ts";
import type { FactoryOperations } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SendPayload, SendReference, T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner/run-store/run-store.ts";
import type {
  BlockRow,
  Checked,
  IntentRow,
  RunnerOptions,
  RunRow,
  StoredTarget,
} from "./runner-types.ts";
import {
  catalogProject,
  intactPayload,
  replayUnproven,
  runTarget,
  unverified,
  verified,
} from "./runner-utils.ts";
import { activatePendingHumanHandoff, reservePendingExplicitHandoff } from "./runner-release.ts";
import { inRunWorkspace } from "./run-workspace.ts";
import { now } from "./time.ts";
import type { RunImages } from "./run-images.ts";
function storedPayload(intent: IntentRow): Checked<SendPayload> {
  if (!intactPayload(intent)) return unverified("Stored operation payload cannot be verified.");
  const payload = JSON.parse(intent.payload_json) as SendPayload;
  if (payload.clientRequestId !== intent.request_key)
    return unverified("Stored operation request key cannot be verified.");
  return verified(payload);
}
/** The stored target must still name the Run's accepted endpoint, environment and checkout. */
function storedTarget(
  runRow: RunRow,
  intent: IntentRow,
  payload: SendPayload,
): Checked<StoredTarget> {
  const target = JSON.parse(intent.target_json) as StoredTarget;
  if (
    target.endpoint !== runRow.endpoint ||
    target.environmentId !== runRow.environment_id ||
    payload.environmentId !== runRow.environment_id ||
    target.projectId !== runRow.t3_project_id ||
    target.workspaceRoot !== runRow.workspace_root ||
    payload.threadId !== target.threadId ||
    payload.mode !== "queue"
  )
    return unverified("Stored operation target cannot be verified.");
  return verified(target);
}
export function openRunnerDispatch(
  database: RunnerDatabase,
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  checkAgent: RunnerOptions["checkAgent"],
  observe: (run: RunRow, block: BlockRow, contextId: string | null) => Effect.Effect<void, unknown>,
  images: RunImages,
) {
  const { run, mutate, row, owner, problem, reserveIntent } = database;
  /** Agent handoffs become worker commands or revisit sends; Human handoffs become occurrences. */
  function prepareHandoff(
    runRow: RunRow,
    intent: IntentRow,
  ): Effect.Effect<IntentRow | undefined, unknown> {
    return Effect.gen(function* () {
      const { definitions } = runRow;
      if (
        definitions.flow.graph.blocks.find((block) => block.id === intent.block_id)?.kind !==
        "agent"
      ) {
        yield* activatePendingHumanHandoff(database, t3, runRow, intent);
        return;
      }
      return yield* prepareCoordinatorHandoff(database, t3, runRow, intent);
    });
  }
  /** Commits a reserved send's T3 reference with its execution record, generation and event. */
  function acknowledgeSend(
    runRow: RunRow,
    intent: IntentRow,
    reference: SendReference,
    payload: SendPayload,
  ) {
    return Effect.gen(function* () {
      if (reference.threadId !== payload.threadId)
        return yield* Effect.fail(Error("Unexpected send target"));
      yield* mutate(runRow.id, (sql) =>
        Effect.gen(function* () {
          const [reserved] = yield* sql<{
            id: string;
          }>`SELECT id FROM operation_intents WHERE id=${intent.id} AND state='reserved' AND reserved_by=${owner.token}`;
          if (!reserved) return;
          const time = yield* now;
          yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${intent.id}`;
          yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,engine_status,binding_id,activation_id) VALUES(${runRow.id},${intent.block_id},${reference.threadId},${reference.runId},${reference.status},COALESCE((SELECT binding_id FROM coordinator_question_replies WHERE intent_id=${intent.id}),(SELECT id FROM run_thread_bindings WHERE run_id=${runRow.id} AND thread_id=${reference.threadId})),COALESCE((SELECT activation_id FROM coordinator_question_replies WHERE intent_id=${intent.id}),(SELECT id FROM run_activations WHERE run_id=${runRow.id} AND block_id=${intent.block_id} ORDER BY rowid DESC LIMIT 1))) ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE run_blocks SET state='working',execution_id=${reference.runId},engine_status=${reference.status},report_status=NULL,problem=${UNOBSERVED_WORKER_HOLD},freshness='unknown' WHERE run_id=${runRow.id} AND block_id=${intent.block_id}`;
          yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
          yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at,engine_status) VALUES(${runRow.id},${intent.block_id},${reference.runId},'send-acknowledged',${"ack:" + intent.id},${intent.id},${time},${reference.status})`;
        }),
      );
    });
  }
  function dispatchIntent(runRow: RunRow, saved: IntentRow, contextId: string | null) {
    return Effect.gen(function* () {
      const launchRecovery = saved.kind === "launch" && saved.state !== "pending";
      if (
        (!runRow.gate_open && !launchRecovery) ||
        !["launch", "handoff", "send"].includes(saved.kind)
      )
        return;
      if (contextId !== saved.context_id) {
        yield* problem(
          saved,
          "Authorization context changed or is unavailable; operation remains unresolved.",
        );
        return;
      }
      if (saved.kind === "launch") {
        yield* dispatchBlockLaunch(database, t3, images, runRow, saved);
        const [block] = yield* run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${saved.block_id}`;
          }),
        );
        if (block?.thread_id && (yield* row(runRow.id))?.gate_open)
          yield* observe(runRow, block, contextId);
        return;
      }
      let intent = saved;
      return yield* recoverOperation(
        Effect.gen(function* () {
          if (intent.kind === "handoff") {
            const prepared = yield* prepareHandoff(runRow, intent);
            if (!prepared) return;
            intent = prepared;
          }
          if (intent.kind === "launch") {
            yield* dispatchBlockLaunch(database, t3, images, runRow, intent);
            return;
          }
          const checked = yield* verifyDispatch(runRow, intent);
          if (!checked.ok) {
            yield* problem(intent, checked.problem);
            return;
          }
          const { payload, retryScope } = checked.value;
          if (!(yield* reserveDelivery(runRow, intent, retryScope))) return;
          const reference = yield* Effect.tryPromise({
            try: () => t3.sendMessage(runTarget(runRow), payload),
            catch: (error) => error,
          });
          yield* acknowledgeSend(runRow, intent, reference, payload);
          const [block] = yield* run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runRow.id} AND block_id=${intent.block_id}`;
            }),
          );
          if (block && (yield* row(runRow.id))?.gate_open) yield* observe(runRow, block, contextId);
        }),
        (_error) =>
          Effect.gen(function* () {
            yield* problem(
              intent,
              "Operation response is uncertain. Only supported same-key reconciliation may recover it.",
            );
          }),
      );
    });
  }
  function reserveDelivery(runRow: RunRow, intent: IntentRow, retryScope: string | null) {
    return Effect.gen(function* () {
      const gated = Boolean(intent.report_id || intent.occurrence_id) && intent.state === "pending";
      if (gated)
        return yield* reservePendingExplicitHandoff(database, t3, runRow, intent, retryScope);
      const generation = yield* recoveryDispatchGeneration(database, t3, runRow, intent);
      if (generation === null) return false;
      return yield* reserveIntent(runRow, intent, retryScope, generation);
    });
  }
  /** Stored payload, adapter support, replay scope, checkout and target must all hold before reservation. */
  function verifyDispatch(
    runRow: RunRow,
    intent: IntentRow,
  ): Effect.Effect<
    Checked<{
      payload: SendPayload;
      retryScope: string | null;
    }>,
    unknown
  > {
    return Effect.gen(function* () {
      const payload = storedPayload(intent);
      if (!payload.ok) return payload;
      const support = yield* Effect.tryPromise({
        try: () => t3.inspectSendSupport(runTarget(runRow)),
        catch: (error) => error,
      });
      if (!support.supported) return unverified(support.explanation);
      if (replayUnproven(intent, support.retryScope))
        return unverified(
          "Same-key replay continuity/retention is unproven; operation remains unresolved.",
        );
      const rebind = yield* rebindOrReadinessProblem(runRow);
      if (rebind) return unverified(rebind);
      const target = storedTarget(runRow, intent, payload.value);
      if (!target.ok) return target;
      if (
        !(intent.cause.startsWith("recovery:") && intent.state === "pending") &&
        (yield* sendTargetChanged(runRow, payload.value, target.value))
      )
        return unverified(
          "The target thread project or workspace changed; this send remains unresolved.",
        );
      return verified({ payload: payload.value, retryScope: support.retryScope });
    });
  }
  /** Even replay may create work if the original request never reached T3. */
  function rebindOrReadinessProblem(runRow: RunRow) {
    return Effect.gen(function* () {
      const ready = yield* agentsReady(runRow);
      const target = catalogProject(yield* ops.listProjects(), runRow.project_id);
      if (
        !target ||
        target.workspaceRoot !== runRow.workspace_root ||
        target.projectId !== runRow.t3_project_id
      )
        return "Project checkout changed; the accepted Run cannot be rebound.";
      if (!ready)
        return "Project/runtime readiness is unavailable; accepted operation remains pending.";
      return null;
    });
  }
  function agentsReady(runRow: RunRow) {
    return Effect.gen(function* () {
      const { definitions } = runRow;
      for (const agent of definitions.agents) {
        const readiness = yield* checkAgent(runRow.project_id, agent);
        if (!readiness.ok || !readiness.value.ready) return false;
      }
      return true;
    });
  }
  function sendTargetChanged(runRow: RunRow, payload: SendPayload, target: StoredTarget) {
    return Effect.gen(function* () {
      const observed = yield* Effect.tryPromise({
        try: () => t3.readExecution(runTarget(runRow), payload.threadId),
        catch: (error) => error,
      });
      return (
        observed.threadId !== target.threadId ||
        observed.projectId !== runRow.t3_project_id ||
        !inRunWorkspace(runRow, observed)
      );
    });
  }
  return { dispatchIntent };
}
