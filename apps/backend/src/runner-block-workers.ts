import { randomUUID } from "node:crypto";
import type { RunDefinitions, RunImage } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  LaunchRejected,
  type LaunchAttachment,
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
import {
  launchedInWorkspace,
  launchStrategy,
  sameStrategy,
  WORKTREE_REJECTED,
} from "./run-workspace.ts";
import type { RunWorkspace } from "./run-workspace.ts";
import { scopedThreadHref } from "./thread-link.ts";
import { now } from "./time.ts";
import { newId } from "./ids.ts";
import { attachmentName, RUN_IMAGE_MISSING, type RunImages } from "./run-images.ts";

const LAUNCH_RECOVERY =
  "Launch acknowledgement is uncertain. Factory will search for the worker and will not launch another.";

/** An initial-prompt image a Flow-input launch carries, in manifest order. */
export interface LaunchImage {
  readonly ordinal: number;
  readonly sha256: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
/** The saved launch: T3's request, plus the Run images uploaded anew for each dispatch. */
type StoredLaunchPayload = LaunchPayload & { readonly images?: readonly LaunchImage[] };

/**
 * The installed Block skill, the Block id its Factory tools take, how attached images map to the
 * initial prompt's references, and the turn to act on.
 */
export function workerTurn(body: string, blockId: string, images: readonly LaunchImage[] = []) {
  const names = images.map((image) => attachmentName(image.ordinal, image.name)).join(", ");
  return [
    "$factory-block",
    "",
    `Factory Block id: ${blockId}. Pass it as blockId to factory_get_block, factory_get_run and factory_update_block.`,
    ...(images.length
      ? [
          `Initial prompt images are attached to this message as ${names}; references like [Image N: name] in the initial prompt point to them.`,
        ]
      : []),
    "",
    body,
  ].join("\n");
}

/** Stable title saved with the launch. Later Block renames do not change recovery's target. */
function workerTitle(number: number, index: number, name: string) {
  return `Factory #${number} · ${index + 1} ${name}`.slice(0, 200);
}

/** A worker launch with the Agent's captured provider, model and options and its first turn. */
export function workerLaunchPayload(
  definitions: RunDefinitions,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  number: number,
  publicId: string,
  workspaceStrategy: LaunchPayload["workspaceStrategy"],
  images: readonly LaunchImage[] = [],
): StoredLaunchPayload {
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
    message: workerTurn(agent.prompt, publicId, images),
    ...(images.length ? { images } : {}),
  };
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
    const images =
      yield* sql<LaunchImage>`SELECT ordinal,sha256,name,mime_type AS "mimeType",size_bytes AS "sizeBytes" FROM run_images WHERE run_id=${plan.runId} ORDER BY ordinal`;
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
        images,
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

export function entryMessagesTooLong(definitions: RunDefinitions, images: readonly RunImage[]) {
  const launched = images.map((image, index) => ({ ...image, ordinal: index + 1 }));
  return definitions.flow.graph.flowInput.targetBlockIds.some((blockId) => {
    const agent = blockAgent(definitions, blockId);
    return !!agent && workerTurn(agent.prompt, "0".repeat(36), launched).length > 120000;
  });
}

function blockAgent(definitions: RunDefinitions, blockId: string) {
  const block = definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  return definitions.agents.find((entry) => block?.kind === "agent" && entry.id === block.agentId);
}

/** Pending launches are sent once. Reserved and uncertain ones are only searched. */
export function dispatchBlockLaunch(
  database: RunnerDatabase,
  t3: T3Adapter,
  images: RunImages,
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
      yield* sendPendingLaunch({ database, t3, images, runRow, intent }, checked.value);
      return;
    }
    yield* searchLaunchedWorker(database, t3, runRow, intent, checked.value);
  });
}

/** Uploads its images, reserves, then launches once; a lost reply leaves it uncertain. */
function sendPendingLaunch(context: LaunchContext, stored: StoredLaunchPayload) {
  const { database, t3, runRow, intent } = context;
  return Effect.gen(function* () {
    if (!runRow.gate_open) return;
    if (intent.recovery_not_before && intent.recovery_not_before > (yield* now)) return;
    const target = runTarget(runRow);
    const support = yield* Effect.promise(() =>
      t3.inspectLaunchSupport(target, runRow.workspace.mode).catch(() => null),
    );
    if (!support?.supported) {
      yield* database.problem(
        intent,
        support?.explanation ??
          "T3 launch capabilities are unavailable. Factory will retry this launch.",
      );
      return;
    }
    const { images: launchImages = [], ...payload } = stored;
    const attachments = yield* uploadLaunchImages(context, launchImages);
    if (!attachments) return;
    if (!(yield* database.reserveIntent(runRow, intent, support.retryScope))) return;
    const request = attachments.length ? { ...payload, attachments } : payload;
    yield* recoverOperation(
      Effect.gen(function* () {
        const reference = yield* Effect.tryPromise({
          try: () => t3.launchThread(target, request),
          catch: (error) => error,
        });
        yield* bindLaunchedWorker(database, runRow, intent, reference);
      }),
      (error) =>
        isLaunchRejected(error)
          ? failLaunch(database, runRow, intent, "T3 rejected the worker launch.")
          : noteLaunchUncertain(database, intent),
    );
  });
}

/** Name as well as class: a test adapter and the backend dist each load this error. */
function isLaunchRejected(error: unknown): error is LaunchRejected {
  return (
    error instanceof LaunchRejected || (error instanceof Error && error.name === "LaunchRejected")
  );
}

/** The stored launch still names the Run's environment, project, workspace, settings and turn. */
function verifiedStoredLaunch(run: RunRow, intent: IntentRow) {
  if (!intactPayload(intent)) return unverified("Stored launch payload cannot be verified.");
  const payload = JSON.parse(intent.payload_json) as StoredLaunchPayload;
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

/** A launch matches by its one execution. */
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
    const miss = noteLaunchSearchMiss(database, intent, current);
    const candidate = yield* soleTitledCandidate(t3, runRow, payload.title);
    if (!candidate || !sameWorkerSettings(payload, runRow, candidate)) return yield* miss;
    const executions = matchingExecutions(payload, candidate);
    if (executions.length !== 1) return yield* miss;
    yield* bindLaunchedWorker(database, runRow, intent, {
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      link: candidate.link ?? null,
      runId: executions[0]!.runId,
      status: executions[0]!.status,
    });
  });
}

/** A top-level thread of the Run's project with the saved workspace and Agent settings. */
function sameWorkerSettings(payload: LaunchPayload, run: RunRow, candidate: LaunchCandidate) {
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

/**
 * A launch that cannot happen is a Block error: T3 rejected it, or its Run images are gone. Without
 * the Run worktree no other Flow-input worker launches, and none falls back to the project root.
 */
function failLaunch(database: RunnerDatabase, runRow: RunRow, intent: IntentRow, problem: string) {
  return database.mutate(runRow.id, (sql) =>
    Effect.gen(function* () {
      if (!(yield* database.runHeldUnderContext(sql, runRow))) return;
      const time = yield* now;
      const cancelled =
        yield* sql`UPDATE operation_intents SET state='cancelled',payload_json=NULL,problem=${problem},reconciled_at=${time} WHERE id=${intent.id} AND state IN ('pending','reserved','uncertain') RETURNING id`;
      if (!cancelled.length) return;
      yield* sql`UPDATE run_blocks SET state='error',problem=${problem} WHERE run_id=${runRow.id} AND block_id=${intent.block_id} AND thread_id IS NULL`;
      const failed =
        yield* sql`UPDATE run_workspaces SET state='failed' WHERE run_id=${runRow.id} AND creator_block_id=${intent.block_id} AND state='preparing' RETURNING run_id`;
      const creatorProblem =
        problem === RUN_IMAGE_MISSING
          ? `The worker that creates the Run worktree could not launch: ${RUN_IMAGE_MISSING}.`
          : WORKTREE_REJECTED;
      if (failed.length)
        for (const blockId of runRow.definitions.flow.graph.flowInput.targetBlockIds)
          yield* sql`UPDATE run_blocks SET state='error',problem=${`${creatorProblem} This worker was not launched.`} WHERE run_id=${runRow.id} AND block_id=${blockId} AND block_id!=${intent.block_id} AND thread_id IS NULL`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${runRow.id}`;
    }),
  );
}

/** One retry delay schedule for launch searches and image uploads: 1 s doubling to 60 s. */
function retryNotBefore(current: string, attempt: number) {
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 16));
  return new Date(Date.parse(current) + delay).toISOString();
}

type LaunchContext = {
  database: RunnerDatabase;
  t3: T3Adapter;
  images: RunImages;
  runRow: RunRow;
  intent: IntentRow;
};

/**
 * Uploads the launch's Run images to T3 before reservation, anew for every dispatch: T3 ids are
 * never saved. Undefined leaves the launch pending (retried with backoff) or cancels it when
 * Factory no longer holds the bytes.
 */
function uploadLaunchImages(context: LaunchContext, launchImages: readonly LaunchImage[]) {
  return Effect.gen(function* () {
    if (!launchImages.length) return [];
    const { database, t3, images, runRow, intent } = context;
    const target = runTarget(runRow);
    const support = yield* Effect.promise(() =>
      t3.inspectAttachmentSupport(target, launchImages.length).catch(() => null),
    );
    if (!support?.supported) {
      yield* database.problem(
        intent,
        `T3 no longer accepts image attachments. Factory will retry this launch. ${support?.explanation ?? ""}`.trim(),
      );
      return undefined;
    }
    const attachments: LaunchAttachment[] = [];
    for (const image of launchImages) {
      const stored = yield* images.storedBytes(image.sha256).pipe(Effect.result);
      if (stored._tag === "Failure")
        return yield* noteUploadFailure(context, "Factory could not read the image.");
      const bytes = stored.success;
      if (bytes.kind === "missing") {
        yield* failLaunch(database, runRow, intent, RUN_IMAGE_MISSING);
        return undefined;
      }
      const upload = {
        name: attachmentName(image.ordinal, image.name),
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      };
      const uploaded = yield* Effect.tryPromise({
        try: () => t3.uploadAttachment(target, upload, bytes.data),
        catch: (error) => error,
      }).pipe(Effect.result);
      if (uploaded._tag === "Failure")
        return yield* noteUploadFailure(context, uploadFailureReason(uploaded.failure));
      attachments.push({ type: "image", id: uploaded.success, ...upload });
    }
    return attachments;
  });
}

const uploadFailureReason = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "T3 did not accept the upload.";

/** The launch stays pending: nothing was launched, so this is neither a Block error nor a Problem. */
function noteUploadFailure(context: LaunchContext, reason: string) {
  const { database, intent } = context;
  return Effect.gen(function* () {
    const current = yield* now;
    const notBefore = retryNotBefore(current, intent.recovery_attempt + 1);
    const problem = `Image upload to T3 failed: ${reason}`;
    yield* database.mutate(intent.run_id, (sql) =>
      Effect.gen(function* () {
        yield* sql`UPDATE operation_intents SET recovery_attempt=recovery_attempt+1,recovery_not_before=${notBefore},problem=${problem},reconciled_at=${current} WHERE id=${intent.id} AND state='pending'`;
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${intent.run_id}`;
      }),
    );
    return undefined;
  });
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
  const notBefore = retryNotBefore(current, intent.recovery_attempt + 1);
  return database.mutate(intent.run_id, (sql) =>
    Effect.gen(function* () {
      yield* sql`UPDATE operation_intents SET recovery_attempt=recovery_attempt+1,recovery_not_before=${notBefore},state=CASE WHEN state='reserved' THEN 'uncertain' ELSE state END,problem=${LAUNCH_RECOVERY},reconciled_at=${current} WHERE id=${intent.id} AND state IN ('reserved','uncertain')`;
      yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${intent.run_id}`;
    }),
  );
}
