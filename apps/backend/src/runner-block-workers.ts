import { randomUUID } from "node:crypto";
import type { RunDefinitions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  LaunchRejected,
  type IdleLaunchPayload,
  type IdleLaunchReference,
  type LaunchCandidate,
  type LaunchDiscovery,
  type LaunchPayload,
  type LaunchReference,
  type T3Adapter,
  type T3Target,
} from "./adapters/t3.ts";
import { persistActivation } from "./runner-coordination.ts";
import { recoverOperation } from "./runner-effects.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { IntentRow, RunRow } from "./runner-types.ts";
import { fingerprint, intactPayload, runTarget, unverified, verified } from "./runner-utils.ts";
import { launchedInWorkspace, launchStrategy, sameStrategy } from "./run-workspace.ts";
import type { RunWorkspace } from "./run-workspace.ts";
import { scopedThreadHref } from "./thread-link.ts";
import { now } from "./time.ts";
import { newId } from "./ids.ts";

const LAUNCH_RECOVERY =
  "Launch acknowledgement is uncertain. Factory will search for the worker and will not launch another.";

const PREPARATION_REJECTED =
  "T3 rejected the idle worker. This Block's first activation launches its worker instead.";

const WORKTREE_REJECTED =
  "T3 rejected the worker that creates the Run worktree. This worker was not launched.";

/** The installed Block skill, the Block id its Factory tools take, and the turn to act on. */
export function workerTurn(body: string, blockId: string) {
  return `$factory-block\n\nFactory Block id: ${blockId}. Pass it as blockId to factory_get_block, factory_get_run and factory_update_block.\n\n${body}`;
}

/** Stable title saved with the launch. Later Block renames do not change recovery's target. */
function workerTitle(number: number, index: number, name: string) {
  return `Factory #${number} · ${index + 1} ${name}`.slice(0, 200);
}

/** A worker's thread settings: the Agent's captured provider, model and options. */
export function preparedWorkerPayload(
  definitions: RunDefinitions,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  number: number,
  workspaceStrategy: LaunchPayload["workspaceStrategy"],
): IdleLaunchPayload {
  const blocks = definitions.flow.graph.blocks;
  const index = blocks.findIndex((entry) => entry.id === blockId);
  const block = blocks[index];
  if (!block || block.kind !== "agent") throw Error("Launch target is not an Agent Block");
  const agent = definitions.agents.find((entry) => entry.id === block.agentId);
  if (!agent) throw Error("Launch target Agent is not in the definitions");
  return {
    environmentId: target.environmentId,
    projectId: target.projectId,
    clientRequestId: key,
    title: workerTitle(number, index, block.name),
    workspaceStrategy,
    interactionMode: "default",
    modelSelection: {
      instanceId: agent.execution.providerInstanceId,
      model: agent.execution.modelId,
      options: Object.fromEntries(
        agent.execution.modelOptions.map((option) => [option.id, option.value]),
      ),
    },
  };
}

export function workerLaunchPayload(
  definitions: RunDefinitions,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  number: number,
  publicId: string,
  workspaceStrategy: LaunchPayload["workspaceStrategy"],
): LaunchPayload {
  const payload = preparedWorkerPayload(
    definitions,
    blockId,
    target,
    key,
    number,
    workspaceStrategy,
  );
  return { ...payload, message: workerTurn(blockAgent(definitions, blockId)!.prompt, publicId) };
}

/** Flow-input targets that launch with the accepted Start; a worktree Run starts only its creator. */
export function startLaunchTargets(definitions: RunDefinitions, workspace: RunWorkspace) {
  const targets = definitions.flow.graph.flowInput.targetBlockIds;
  return workspace.mode === "checkout" ? targets : [workspace.creatorBlockId];
}

/** Entry launches are durable before any T3 call. One worker per given Flow-input target. */
export function persistEntryLaunches(
  sql: SqlClient.SqlClient,
  plan: {
    runId: string;
    number: number;
    definitions: RunDefinitions;
    workspace: RunWorkspace;
    project: Pick<T3Target, "endpoint" | "environmentId" | "projectId" | "workspaceRoot">;
    contextId: string;
    retryScope: string | null;
    time: string;
  },
  blockIds: readonly string[],
) {
  return Effect.gen(function* () {
    for (const blockId of blockIds) {
      const block = plan.definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
      const strategy = launchStrategy(plan.workspace, blockId);
      if (!block || block.kind !== "agent" || !strategy) continue;
      const activationId = yield* newId;
      const requestKey = yield* newId;
      const [saved] = yield* sql<{
        public_id: string;
      }>`SELECT public_id FROM run_blocks WHERE run_id=${plan.runId} AND block_id=${blockId}`;
      const payload = workerLaunchPayload(
        plan.definitions,
        blockId,
        plan.project,
        requestKey,
        plan.number,
        saved!.public_id,
        strategy,
      );
      yield* persistActivation(
        sql,
        plan.runId,
        blockId,
        plan.time,
        {
          activationId,
          requestKey,
          inputFingerprint: fingerprint(payload.message),
        },
        `start:${blockId}`,
      );
      const body = JSON.stringify(payload);
      const target = JSON.stringify({ ...plan.project, blockId });
      yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,retry_scope)
        VALUES(${yield* newId},${plan.runId},${blockId},'launch',${`start:${blockId}`},${target},${requestKey},${body},${fingerprint(body)},${plan.contextId},${plan.retryScope})`;
    }
  });
}

export function entryMessagesTooLong(definitions: RunDefinitions) {
  return definitions.flow.graph.flowInput.targetBlockIds.some((blockId) => {
    const agent = blockAgent(definitions, blockId);
    return !!agent && workerTurn(agent.prompt, "0".repeat(36)).length > 120000;
  });
}

function blockAgent(definitions: RunDefinitions, blockId: string) {
  const block = definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  return definitions.agents.find((entry) => block?.kind === "agent" && entry.id === block.agentId);
}

/** Pending launches, including idle worker preparations, are sent once. Reserved and uncertain
 * ones are only searched. */
export function dispatchBlockLaunch(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    const checked = verifiedStoredLaunch(runRow, intent);
    if (!checked.ok) {
      yield* database.problem(intent, checked.problem);
      return;
    }
    if (intent.state === "pending") {
      if (!runRow.gate_open) return;
      const target = runTarget(runRow);
      const support = yield* Effect.tryPromise({
        try: () =>
          (checked.value.workspaceStrategy.type === "root"
            ? t3.inspectLaunchSupport(target)
            : t3.inspectWorktreeLaunchSupport(target)
          ).catch(() => null),
        catch: () => null,
      });
      if (!support?.supported) {
        yield* database.problem(
          intent,
          support?.explanation ??
            "T3 launch capabilities are unavailable. Factory will retry this launch.",
        );
        return;
      }
      const payload = checked.value;
      const setup = payload.message === undefined && (yield* blockingSetupProblem(t3, target));
      if (setup) {
        yield* database.problem(intent, setup);
        return;
      }
      if (!(yield* database.reserveIntent(runRow, intent, support.retryScope))) return;
      yield* recoverOperation(
        Effect.gen(function* () {
          if (payload.message === undefined) {
            const reference = yield* Effect.tryPromise({
              try: () => t3.launchIdleThread(target, payload),
              catch: (error) => error,
            });
            yield* bindPreparedWorker(database, runRow, intent, reference);
            return;
          }
          const reference = yield* Effect.tryPromise({
            try: () => t3.launchThread(target, payload),
            catch: (error) => error,
          });
          yield* bindLaunchedWorker(database, runRow, intent, reference);
        }),
        (error) =>
          isLaunchRejected(error)
            ? rejectLaunchedWorker(database, runRow, intent)
            : noteLaunchUncertain(database, intent),
      );
      return;
    }
    yield* searchLaunchedWorker(database, t3, runRow, intent, checked.value);
  });
}

/** Name as well as class: a test adapter and the backend dist each load this error. */
function isLaunchRejected(error: unknown): error is LaunchRejected {
  return (
    error instanceof LaunchRejected || (error instanceof Error && error.name === "LaunchRejected")
  );
}

/** The stored launch still names the Run's environment, project, workspace and settings; an
 * idle worker preparation carries no message and every other launch one. */
function verifiedStoredLaunch(run: RunRow, intent: IntentRow) {
  if (!intactPayload(intent)) return unverified("Stored launch payload cannot be verified.");
  const payload = JSON.parse(intent.payload_json) as IdleLaunchPayload | LaunchPayload;
  const target = JSON.parse(intent.target_json) as T3Target;
  if (
    payload.clientRequestId !== intent.request_key ||
    target.environmentId !== run.environment_id ||
    target.projectId !== run.t3_project_id ||
    target.workspaceRoot !== run.workspace_root ||
    payload.environmentId !== run.environment_id ||
    payload.projectId !== run.t3_project_id ||
    !payload.workspaceStrategy ||
    !sameStrategy(payload.workspaceStrategy, launchStrategy(run.workspace, intent.block_id)) ||
    payload.interactionMode !== "default" ||
    !payload.title ||
    (intent.kind === "prepare") === !!payload.message ||
    !payload.modelSelection?.instanceId ||
    !payload.modelSelection.model
  )
    return unverified("Stored launch target cannot be verified.");
  return verified(payload);
}

function unavailableLaunch(): LaunchDiscovery {
  return { available: false };
}

/** The only thread in the project that carries the saved launch title, if exactly one does. */
function soleTitledCandidate(t3: T3Adapter, runRow: RunRow, title: string) {
  return Effect.tryPromise({
    try: () => t3.discoverLaunchCandidates(runTarget(runRow), title).catch(unavailableLaunch),
    catch: unavailableLaunch,
  }).pipe(
    Effect.map((discovery) => {
      if (!discovery.available) return undefined;
      const titled = discovery.candidates.filter((candidate) => candidate.title === title);
      return titled.length === 1 ? titled[0] : undefined;
    }),
  );
}

/** An idle worker matches only with no run yet; a launch with a message by its one execution. */
function searchLaunchedWorker(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
  payload: IdleLaunchPayload | LaunchPayload,
) {
  return Effect.gen(function* () {
    const current = yield* now;
    if (intent.recovery_not_before && intent.recovery_not_before > current) return;
    const miss = noteLaunchSearchMiss(database, intent, current);
    const candidate = yield* soleTitledCandidate(t3, runRow, payload.title);
    if (!candidate || !sameWorkerSettings(payload, runRow, candidate)) return yield* miss;
    const reference = {
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      link: candidate.link ?? null,
    };
    if (payload.message === undefined) {
      if (candidate.executions.length) return yield* miss;
      return yield* bindPreparedWorker(database, runRow, intent, reference);
    }
    const executions = matchingExecutions(payload, candidate);
    if (executions.length !== 1) return yield* miss;
    yield* bindLaunchedWorker(database, runRow, intent, {
      ...reference,
      runId: executions[0]!.runId,
      status: executions[0]!.status,
    });
  });
}

/** A top-level thread of the Run's project with the saved workspace and Agent settings. */
function sameWorkerSettings(
  payload: IdleLaunchPayload | LaunchPayload,
  run: RunRow,
  candidate: LaunchCandidate,
) {
  return (
    candidate.projectId === run.t3_project_id &&
    candidate.parentThreadId === null &&
    launchedInWorkspace(payload.workspaceStrategy, candidate, run.workspace_root) &&
    candidate.interactionMode === "default" &&
    candidate.providerInstanceId === payload.modelSelection.instanceId &&
    candidate.model === payload.modelSelection.model &&
    sameOptions(candidate.options, payload.modelSelection.options)
  );
}

function matchingExecutions(payload: LaunchPayload, candidate: LaunchCandidate) {
  return candidate.executions.filter(
    (execution) =>
      !!execution.runId &&
      execution.providerInstanceId === payload.modelSelection.instanceId &&
      execution.model === payload.modelSelection.model,
  );
}

function sameOptions(
  actual: LaunchCandidate["options"],
  expected: LaunchPayload["modelSelection"]["options"],
) {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function bindLaunchedWorker(
  database: RunnerDatabase,
  runRow: RunRow,
  intent: IntentRow,
  reference: LaunchReference,
) {
  return database.mutate(runRow.id, (sql) =>
    Effect.gen(function* () {
      if (!reference.threadId || !reference.runId || reference.projectId !== runRow.t3_project_id)
        return yield* Effect.fail(Error("Invalid launch reference; outcome is uncertain"));
      if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
      const [reserved] = yield* sql<{
        id: string;
      }>`SELECT id FROM operation_intents WHERE id=${intent.id} AND state IN ('reserved','uncertain') AND payload_json IS NOT NULL`;
      if (!reserved) return;
      const time = yield* now;
      const bindingId = randomUUID();
      const link = scopedThreadHref(runRow.environment_id, reference.threadId);
      yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,link) VALUES(${bindingId},${runRow.id},${intent.block_id},${runRow.environment_id},${reference.threadId},'worker',${link}) ON CONFLICT DO NOTHING`;
      const [binding] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_thread_bindings WHERE run_id=${runRow.id} AND thread_id=${reference.threadId}`;
      const [activation] = yield* sql<{
        id: string;
      }>`SELECT id FROM run_activations WHERE run_id=${runRow.id} AND block_id=${intent.block_id} ORDER BY rowid DESC LIMIT 1`;
      if (!binding || !activation) return yield* Effect.fail(Error("Worker binding is incomplete"));
      yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,activation_id,engine_status) VALUES(${runRow.id},${intent.block_id},${reference.threadId},${reference.runId},${binding.id},${activation.id},${reference.status}) ON CONFLICT DO NOTHING`;
      yield* sql`UPDATE run_blocks SET thread_id=${reference.threadId},execution_id=COALESCE(execution_id,${reference.runId}),state='working',link=${link},engine_status=${reference.status},problem=NULL WHERE run_id=${runRow.id} AND block_id=${intent.block_id} AND thread_id IS NULL`;
      yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at,engine_status) VALUES(${runRow.id},${intent.block_id},${reference.runId},'launch-acknowledged',${"ack:" + intent.id},${intent.id},${time},${reference.status})`;
    }),
  );
}

/** A rejected launch is a Block error. A Block without its idle worker is not: its first
 * activation launches one instead. */
function rejectLaunchedWorker(database: RunnerDatabase, runRow: RunRow, intent: IntentRow) {
  return database.mutate(runRow.id, (sql) =>
    Effect.gen(function* () {
      if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
      const time = yield* now;
      const preparation = intent.kind === "prepare";
      const problem = preparation ? PREPARATION_REJECTED : "T3 rejected the worker launch.";
      if (!preparation)
        yield* sql`UPDATE run_blocks SET state='error',problem=${problem} WHERE run_id=${runRow.id} AND block_id=${intent.block_id} AND thread_id IS NULL`;
      yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem=${problem},reconciled_at=${time} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      // Without the Run worktree no other Flow-input worker launches, and none falls back to the project root.
      const failed =
        yield* sql`UPDATE run_workspaces SET state='failed' WHERE run_id=${runRow.id} AND creator_block_id=${intent.block_id} AND state='preparing' RETURNING run_id`;
      if (failed.length)
        for (const blockId of runRow.definitions.flow.graph.flowInput.targetBlockIds)
          yield* sql`UPDATE run_blocks SET state='error',problem=${WORKTREE_REJECTED} WHERE run_id=${runRow.id} AND block_id=${blockId} AND block_id!=${intent.block_id} AND thread_id IS NULL`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    }),
  );
}

function noteLaunchUncertain(database: RunnerDatabase, intent: IntentRow) {
  return database.mutate(intent.run_id, (sql) =>
    Effect.gen(function* () {
      const time = yield* now;
      yield* sql`UPDATE operation_intents SET state='uncertain',problem=${LAUNCH_RECOVERY},reconciled_at=${time} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${intent.run_id}`;
    }),
  );
}

function noteLaunchSearchMiss(database: RunnerDatabase, intent: IntentRow, current: string) {
  const attempt = intent.recovery_attempt + 1;
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 16));
  const notBefore = new Date(Date.parse(current) + delay).toISOString();
  return database.mutate(intent.run_id, (sql) =>
    Effect.gen(function* () {
      yield* sql`UPDATE operation_intents SET recovery_attempt=recovery_attempt+1,recovery_not_before=${notBefore},state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${LAUNCH_RECOVERY},reconciled_at=${current} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${intent.run_id}`;
    }),
  );
}

/**
 * Start refused blocking setup, but the Project's scripts may have changed since. T3 shows no
 * setup completion for an idle thread, so a blocking script could still run at its first send.
 */
function blockingSetupProblem(t3: T3Adapter, target: T3Target) {
  return Effect.tryPromise(() => t3.readWorktreeSetupScripts(target)).pipe(
    Effect.map((scripts) => {
      const blocking = scripts.find((script) => script.blocking);
      return blocking
        ? `The Project runs "${blocking.name}" as a blocking worktree setup script, which idle workers do not support. Make it asynchronous in T3; Factory will retry creating this idle worker.`
        : undefined;
    }),
    Effect.orElseSucceed(
      () =>
        "T3 could not read the Project's setup scripts. Factory will retry creating this idle worker.",
    ),
  );
}

function bindPreparedWorker(
  database: RunnerDatabase,
  runRow: RunRow,
  intent: IntentRow,
  reference: IdleLaunchReference,
) {
  return database.mutate(runRow.id, (sql) =>
    Effect.gen(function* () {
      if (!reference.threadId || reference.projectId !== runRow.t3_project_id)
        return yield* Effect.fail(Error("Invalid idle launch reference; outcome is uncertain"));
      if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
      const [reserved] = yield* sql<{
        id: string;
      }>`SELECT id FROM operation_intents WHERE id=${intent.id} AND state IN ('reserved','uncertain') AND payload_json IS NOT NULL`;
      if (!reserved) return;
      const time = yield* now;
      const link = scopedThreadHref(runRow.environment_id, reference.threadId);
      yield* sql`INSERT INTO run_prepared_workers(run_id,block_id,thread_id,link,intent_id,prepared_at) VALUES(${runRow.id},${intent.block_id},${reference.threadId},${link},${intent.id},${time})`;
      yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${intent.id}`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    }),
  );
}
