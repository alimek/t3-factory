import { randomUUID } from "node:crypto";
import type { RunSnapshot } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  LaunchRejected,
  type LaunchCandidate,
  type LaunchDiscovery,
  type LaunchPayload,
  type LaunchReference,
  type T3Adapter,
  type T3Target,
} from "./adapters/t3.ts";
import { persistActivation } from "./runner-coordination.ts";
import { recoverOperation } from "./runner-effects.ts";
import { launchPayload } from "./runner-handoffs.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { IntentRow, RunRow } from "./runner-types.ts";
import {
  checkoutWorkspace,
  fingerprint,
  intactPayload,
  runTarget,
  unverified,
  verified,
} from "./runner-utils.ts";
import { scopedThreadHref } from "./thread-link.ts";
import { now } from "./time.ts";
import { newId } from "./ids.ts";

const LAUNCH_RECOVERY =
  "Launch acknowledgement is uncertain. Factory will search for the worker and will not launch another.";

/** The installed Block skill plus the turn the worker should act on. */
export function workerTurn(body: string) {
  return `$factory-block\n\n${body}`;
}

/** Stable title saved with the launch. Later Block renames do not change recovery's target. */
function workerTitle(number: number, index: number, name: string) {
  return `Factory #${number} · ${index + 1} ${name}`.slice(0, 200);
}

export function workerLaunchPayload(
  snapshot: RunSnapshot,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  number: number,
): LaunchPayload {
  const blocks = snapshot.flow.graph.blocks;
  const index = blocks.findIndex((entry) => entry.id === blockId);
  const block = blocks[index];
  if (!block || block.kind !== "agent") throw Error("Launch target is not an Agent Block");
  const agent = snapshot.agents.find((entry) => entry.id === block.agentId);
  if (!agent) throw Error("Launch target Agent is not in the snapshot");
  const payload = launchPayload(snapshot, blockId, target, key, "");
  return {
    ...payload,
    title: workerTitle(number, index, block.name),
    message: workerTurn(agent.prompt),
  };
}

/** Entry launches are durable before any T3 call. One worker per Flow-input target. */
export function persistEntryLaunches(
  sql: SqlClient.SqlClient,
  plan: {
    runId: string;
    number: number;
    snapshot: RunSnapshot;
    project: Pick<T3Target, "endpoint" | "environmentId" | "projectId" | "workspaceRoot">;
    contextId: string;
    retryScope: string | null;
    time: string;
  },
) {
  return Effect.gen(function* () {
    for (const blockId of plan.snapshot.flow.graph.flowInput.targetBlockIds) {
      const block = plan.snapshot.flow.graph.blocks.find((entry) => entry.id === blockId);
      if (!block || block.kind !== "agent") continue;
      const activationId = yield* newId;
      const requestKey = yield* newId;
      const payload = workerLaunchPayload(
        plan.snapshot,
        blockId,
        plan.project,
        requestKey,
        plan.number,
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

export function entryMessagesTooLong(snapshot: RunSnapshot) {
  return snapshot.flow.graph.flowInput.targetBlockIds.some((blockId) => {
    const block = snapshot.flow.graph.blocks.find((entry) => entry.id === blockId);
    const agent = snapshot.agents.find(
      (entry) => block?.kind === "agent" && entry.id === block.agentId,
    );
    return !!agent && workerTurn(agent.prompt).length > 120000;
  });
}

/** Pending launches are sent once. Reserved and uncertain launches are only searched. */
export function dispatchBlockLaunch(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
) {
  return Effect.gen(function* () {
    const checked = verifiedLaunchPayload(runRow, intent);
    if (!checked.ok) {
      yield* database.problem(intent, checked.problem);
      return;
    }
    if (intent.state === "pending") {
      if (!runRow.gate_open) return;
      const support = yield* Effect.tryPromise({
        try: () => t3.inspectLaunchSupport(runTarget(runRow)).catch(() => null),
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
      if (!(yield* database.reserveIntent(runRow, intent, support.retryScope))) return;
      yield* recoverOperation(
        Effect.gen(function* () {
          const reference = yield* Effect.tryPromise({
            try: () => t3.launchThread(runTarget(runRow), checked.value),
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

function verifiedLaunchPayload(run: RunRow, intent: IntentRow) {
  if (!intactPayload(intent)) return unverified("Stored launch payload cannot be verified.");
  const payload = JSON.parse(intent.payload_json) as LaunchPayload;
  const target = JSON.parse(intent.target_json) as T3Target;
  if (
    payload.clientRequestId !== intent.request_key ||
    target.environmentId !== run.environment_id ||
    target.projectId !== run.t3_project_id ||
    target.workspaceRoot !== run.workspace_root ||
    payload.environmentId !== run.environment_id ||
    payload.projectId !== run.t3_project_id ||
    payload.workspaceStrategy?.type !== "root" ||
    payload.interactionMode !== "default" ||
    !payload.title ||
    !payload.message ||
    !payload.modelSelection?.instanceId ||
    !payload.modelSelection.model
  )
    return unverified("Stored launch target cannot be verified.");
  return verified(payload);
}

function unavailableLaunch(): LaunchDiscovery {
  return { available: false };
}

function searchLaunchedWorker(
  database: RunnerDatabase,
  t3: T3Adapter,
  runRow: RunRow,
  intent: IntentRow,
  payload: LaunchPayload,
) {
  return Effect.gen(function* () {
    const current = yield* now;
    if (intent.recovery_not_before && intent.recovery_not_before > current) return;
    const discovery = yield* Effect.tryPromise({
      try: () =>
        t3.discoverLaunchCandidates(runTarget(runRow), payload.title).catch(unavailableLaunch),
      catch: unavailableLaunch,
    });
    const candidate = soleVerifiedCandidate(payload, runRow, discovery);
    if (!candidate) {
      yield* noteLaunchSearchMiss(database, intent, current);
      return;
    }
    const execution = matchingExecutions(payload, candidate)[0]!;
    yield* bindLaunchedWorker(database, runRow, intent, {
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      runId: execution.runId,
      link: candidate.link ?? null,
      status: execution.status,
    });
  });
}

function soleVerifiedCandidate(payload: LaunchPayload, run: RunRow, discovery: LaunchDiscovery) {
  if (!discovery.available) return undefined;
  const titled = discovery.candidates.filter((candidate) => candidate.title === payload.title);
  const candidate = titled[0];
  if (titled.length !== 1 || !candidate || !launchMatches(payload, run, candidate))
    return undefined;
  return candidate;
}

function launchMatches(payload: LaunchPayload, run: RunRow, candidate: LaunchCandidate) {
  return (
    candidate.projectId === run.t3_project_id &&
    candidate.parentThreadId === null &&
    payload.workspaceStrategy.type === "root" &&
    checkoutWorkspace(candidate.workspaceRoot, run.workspace_root) &&
    candidate.interactionMode === "default" &&
    candidate.providerInstanceId === payload.modelSelection.instanceId &&
    candidate.model === payload.modelSelection.model &&
    sameOptions(candidate.options, payload.modelSelection.options) &&
    matchingExecutions(payload, candidate).length === 1
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
      yield* sql`INSERT INTO run_worker_activations(activation_id,binding_id,initial_execution_id,parent_thread_id) VALUES(${activation.id},${binding.id},${reference.runId},${reference.threadId}) ON CONFLICT DO NOTHING`;
      yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify(reference)},payload_json=NULL,problem=NULL,reconciled_at=${time} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
      yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at,engine_status) VALUES(${runRow.id},${intent.block_id},${reference.runId},'launch-acknowledged',${"ack:" + intent.id},${intent.id},${time},${reference.status})`;
    }),
  );
}

function rejectLaunchedWorker(database: RunnerDatabase, runRow: RunRow, intent: IntentRow) {
  return database.mutate(runRow.id, (sql) =>
    Effect.gen(function* () {
      if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
      const time = yield* now;
      yield* sql`UPDATE run_blocks SET state='error',problem='T3 rejected the worker launch.' WHERE run_id=${runRow.id} AND block_id=${intent.block_id} AND thread_id IS NULL`;
      yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem='T3 rejected the worker launch.',reconciled_at=${time} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
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
