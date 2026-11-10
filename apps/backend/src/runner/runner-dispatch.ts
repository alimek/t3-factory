import { dispatchBlockLaunch } from "./runner-block-workers.ts";
import { prepareCoordinatorHandoff } from "./runner-coordinator-handoffs.ts";
import { prepareContinuationHandoff } from "./runner-continuations.ts";
import type { EffectOperations } from "../effect-operations.ts";
import { recoverOperation } from "./runner-effects.ts";
import { recoveryDispatchGeneration } from "./runner-recovery.ts";
import type { FactoryOperations } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type { SendPayload, SendReference, T3Adapter } from "../adapters/t3.ts";
import type { Delivery, Handoff, RunStore, ScheduledWait } from "./run-store/run-store.ts";
import type { BlockRow, Checked, RunnerOptions, RunRow, StoredTarget } from "./runner-types.ts";
import {
  catalogProject,
  intactPayload,
  passedThrough,
  runTarget,
  unverified,
  verified,
} from "./runner-utils.ts";
import {
  activatePendingHumanHandoff,
  activatePendingWaitHandoff,
  reservePendingExplicitHandoff,
} from "./runner-release.ts";
import { inRunWorkspace } from "./run-workspace.ts";
import type { RunImages } from "../run-images.ts";
/** Uncertain work may be replayed only within the retry scope recorded at reservation. */
const replayUnproven = (delivery: Delivery, retryScope: string | null) =>
  delivery.state !== "pending" && (!delivery.retry_scope || delivery.retry_scope !== retryScope);
function storedPayload(intent: Delivery): Checked<SendPayload> {
  if (!intactPayload(intent)) return unverified("Stored operation payload cannot be verified.");
  const payload = JSON.parse(intent.payload_json) as SendPayload;
  if (payload.clientRequestId !== intent.request_key)
    return unverified("Stored operation request key cannot be verified.");
  return verified(payload);
}
/** The stored target must still name the Run's accepted endpoint, environment and checkout. */
function storedTarget(
  runRow: RunRow,
  intent: Delivery,
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
  store: RunStore,
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  checkAgent: RunnerOptions["checkAgent"],
  observe: (run: RunRow, block: BlockRow, contextId: string | null) => Effect.Effect<void, unknown>,
  images: RunImages,
  scheduleWait: (wait: ScheduledWait) => Effect.Effect<void, unknown>,
) {
  /** Agent handoffs become worker commands or revisit sends, Continuation handoffs a prompt send
   * or a pass-through; Human handoffs become occurrences; Wait handoffs become arrivals whose
   * wake-up is scheduled. */
  function prepareHandoff(
    runRow: RunRow,
    handoff: Handoff,
  ): Effect.Effect<Delivery | undefined, unknown> {
    return Effect.gen(function* () {
      const kind = runRow.definitions.flow.graph.blocks.find(
        (block) => block.id === handoff.block_id,
      )?.kind;
      if (kind === "continuation")
        return yield* prepareContinuationHandoff(store, t3, runRow, handoff);
      if (kind === "human") {
        yield* activatePendingHumanHandoff(store, t3, runRow, handoff);
        return;
      }
      if (kind === "wait") {
        const arrival = yield* activatePendingWaitHandoff(store, t3, runRow, handoff);
        if (arrival) yield* scheduleWait(arrival);
        return;
      }
      return yield* prepareCoordinatorHandoff(store, t3, runRow, handoff);
    });
  }
  /** Commits a reserved send's T3 reference with its execution record, generation and event. */
  function acknowledgeSend(
    runRow: RunRow,
    delivery: Delivery,
    reference: SendReference,
    payload: SendPayload,
  ) {
    return Effect.gen(function* () {
      if (reference.threadId !== payload.threadId)
        return yield* Effect.fail(Error("Unexpected send target"));
      yield* store.acknowledgeSend(runRow, delivery, reference);
    });
  }
  function dispatchIntent(runRow: RunRow, saved: Handoff | Delivery, contextId: string | null) {
    return Effect.gen(function* () {
      const launchRecovery = saved.kind === "launch" && saved.state !== "pending";
      if (!runRow.gate_open && !launchRecovery) return;
      if (contextId !== saved.context_id) {
        yield* store.noteUnresolved(
          saved,
          "Authorization context changed or is unavailable; operation remains unresolved.",
        );
        return;
      }
      if (saved.kind === "launch") {
        yield* dispatchBlockLaunch(store, t3, images, runRow, saved);
        const block = yield* store.readBlock(runRow.id, saved.block_id);
        if (block?.thread_id && (yield* store.readRun(runRow.id))?.gate_open)
          yield* observe(runRow, block, contextId);
        return;
      }
      let intent: Handoff | Delivery = saved;
      return yield* recoverOperation(
        Effect.gen(function* () {
          if (intent.kind === "handoff") {
            const prepared = yield* prepareHandoff(runRow, intent);
            if (!prepared) return;
            intent = prepared;
          }
          if (intent.kind === "launch") {
            yield* dispatchBlockLaunch(store, t3, images, runRow, intent);
            return;
          }
          const checked = yield* verifyDispatch(runRow, intent);
          if (!checked.ok) {
            yield* store.noteUnresolved(intent, checked.problem);
            return;
          }
          const { payload, retryScope } = checked.value;
          if (!(yield* reserveSend(runRow, intent, retryScope))) return;
          const reference = yield* Effect.tryPromise({
            try: () => t3.sendMessage(runTarget(runRow), payload),
            catch: (error) => error,
          });
          yield* acknowledgeSend(runRow, intent, reference, payload);
          const block = yield* store.readBlock(runRow.id, intent.block_id);
          if (block && (yield* store.readRun(runRow.id))?.gate_open)
            yield* observe(runRow, block, contextId);
        }),
        (_error) =>
          Effect.gen(function* () {
            yield* store.noteUnresolved(
              intent,
              "Operation response is uncertain. Only supported same-key reconciliation may recover it.",
            );
          }),
      );
    });
  }
  function reserveSend(runRow: RunRow, intent: Delivery, retryScope: string | null) {
    return Effect.gen(function* () {
      const gated =
        Boolean(
          intent.report_id ||
          intent.occurrence_id ||
          intent.wait_arrival_id ||
          passedThrough(intent),
        ) && intent.state === "pending";
      if (gated) return yield* reservePendingExplicitHandoff(store, t3, runRow, intent, retryScope);
      const generation = yield* recoveryDispatchGeneration(store, t3, runRow, intent);
      if (generation === null) return false;
      return yield* store.reserveDelivery(runRow, intent, retryScope, generation);
    });
  }
  /** Stored payload, adapter support, replay scope, checkout and target must all hold before reservation. */
  function verifyDispatch(
    runRow: RunRow,
    intent: Delivery,
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
