import type { RunDefinitions, RunImage } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import {
  LaunchRejected,
  type LaunchAttachment,
  type LaunchCandidate,
  type LaunchDiscovery,
  type LaunchPayload,
  type T3Adapter,
  type T3Target,
} from "../adapters/t3.ts";
import { recoverOperation } from "./runner-effects.ts";
import type { Delivery, RunStore } from "./run-store/run-store.ts";
import type { RunRow } from "./runner-types.ts";
import { intactPayload, runTarget, unverified, verified } from "./runner-utils.ts";
import {
  launchedInWorkspace,
  launchStrategy,
  sameStrategy,
  WORKTREE_REJECTED,
} from "./run-workspace.ts";
import { now } from "../time.ts";
import { attachmentName, RUN_IMAGE_MISSING, type RunImages } from "../run-images.ts";
import { workerTurn, type LaunchImage, type StoredLaunchPayload } from "./worker-payloads.ts";

const LAUNCH_REJECTED = { block: "T3 rejected the worker launch.", worktree: WORKTREE_REJECTED };
const IMAGE_MISSING = {
  block: RUN_IMAGE_MISSING,
  worktree: `The worker that creates the Run worktree could not launch: ${RUN_IMAGE_MISSING}.`,
};

const LAUNCH_RECOVERY =
  "Launch acknowledgement is uncertain. Factory will search for the worker and will not launch another.";

/** Flow-input targets that launch with the accepted Start; a worktree Run starts only its creator. */
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
  store: RunStore,
  t3: T3Adapter,
  images: RunImages,
  runRow: RunRow,
  launch: Delivery,
) {
  return Effect.gen(function* () {
    const checked = verifiedStoredLaunch(runRow, launch);
    if (!checked.ok) {
      yield* store.noteUnresolved(launch, checked.problem);
      return;
    }
    if (launch.state === "pending") {
      yield* sendPendingLaunch({ store, t3, images, runRow, launch }, checked.value);
      return;
    }
    yield* searchLaunchedWorker(store, t3, runRow, launch, checked.value);
  });
}

/** Uploads its images, reserves, then launches once; a lost reply leaves it uncertain. */
function sendPendingLaunch(context: LaunchContext, stored: StoredLaunchPayload) {
  const { store, t3, runRow, launch } = context;
  return Effect.gen(function* () {
    if (!runRow.gate_open) return;
    if (launch.recovery_not_before && launch.recovery_not_before > (yield* now)) return;
    const target = runTarget(runRow);
    const support = yield* Effect.promise(() =>
      t3.inspectLaunchSupport(target, runRow.workspace.mode).catch(() => null),
    );
    if (!support?.supported) {
      yield* store.noteUnresolved(
        launch,
        support?.explanation ??
          "T3 launch capabilities are unavailable. Factory will retry this launch.",
      );
      return;
    }
    const { images: launchImages = [], ...payload } = stored;
    const attachments = yield* uploadLaunchImages(context, launchImages);
    if (!attachments) return;
    if (!(yield* store.reserveDelivery(runRow, launch, support.retryScope))) return;
    const request = attachments.length ? { ...payload, attachments } : payload;
    yield* recoverOperation(
      Effect.gen(function* () {
        const reference = yield* Effect.tryPromise({
          try: () => t3.launchThread(target, request),
          catch: (error) => error,
        });
        yield* store.bindLaunchedWorker(runRow, launch, reference);
      }),
      (error) =>
        error instanceof LaunchRejected
          ? store.failLaunch(runRow, launch, LAUNCH_REJECTED)
          : store.noteLaunchUncertain(launch, LAUNCH_RECOVERY),
    );
  });
}

/** The stored launch still names the Run's environment, project, workspace, settings and turn. */
function verifiedStoredLaunch(run: RunRow, launch: Delivery) {
  if (!intactPayload(launch)) return unverified("Stored launch payload cannot be verified.");
  const payload = JSON.parse(launch.payload_json) as StoredLaunchPayload;
  const target = JSON.parse(launch.target_json) as T3Target;
  if (
    payload.clientRequestId !== launch.request_key ||
    target.environmentId !== run.environment_id ||
    target.projectId !== run.t3_project_id ||
    target.workspaceRoot !== run.workspace_root ||
    payload.environmentId !== run.environment_id ||
    payload.projectId !== run.t3_project_id ||
    !payload.workspaceStrategy ||
    !sameStrategy(payload.workspaceStrategy, launchStrategy(run.workspace, launch.block_id)) ||
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

/** Where a launch was sent: the Run's T3 environment, project and project root. */
type LaunchScope = Pick<RunRow, "endpoint" | "environment_id" | "t3_project_id" | "workspace_root">;

/** The only thread in the project that carries the saved launch title, if exactly one does. */
function soleTitledCandidate(t3: T3Adapter, scope: LaunchScope, title: string) {
  return Effect.tryPromise({
    try: () => t3.discoverLaunchCandidates(runTarget(scope), title).catch(unavailableLaunch),
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
  store: RunStore,
  t3: T3Adapter,
  runRow: RunRow,
  launch: Delivery,
  payload: LaunchPayload,
) {
  return Effect.gen(function* () {
    const current = yield* now;
    if (launch.recovery_not_before && launch.recovery_not_before > current) return;
    const miss = store.retryLaunchSearchLater(
      launch,
      LAUNCH_RECOVERY,
      current,
      retryNotBefore(current, launch.recovery_attempt + 1),
    );
    const launched = yield* verifiedLaunchedThread(t3, runRow, payload);
    if (!launched) return yield* miss;
    yield* store.bindLaunchedWorker(runRow, launch, launched);
  });
}

/**
 * The thread an uncertain launch created, found only by uniquely verified provenance: the one
 * thread in the project with the saved title, top-level with the saved workspace and settings,
 * and exactly one matching execution. Undefined when evidence is missing, ambiguous or incomplete.
 */
export function verifiedLaunchedThread(t3: T3Adapter, scope: LaunchScope, payload: LaunchPayload) {
  return Effect.gen(function* () {
    const candidate = yield* soleTitledCandidate(t3, scope, payload.title);
    if (!candidate || !sameWorkerSettings(payload, scope, candidate)) return undefined;
    const executions = matchingExecutions(payload, candidate);
    if (executions.length !== 1) return undefined;
    return {
      projectId: candidate.projectId,
      threadId: candidate.threadId,
      link: candidate.link ?? null,
      runId: executions[0]!.runId,
      status: executions[0]!.status,
    };
  });
}

/** A top-level thread of the Run's project with the saved workspace and Agent settings. */
function sameWorkerSettings(payload: LaunchPayload, run: LaunchScope, candidate: LaunchCandidate) {
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

/** One retry delay schedule for launch searches and image uploads: 1 s doubling to 60 s. */
function retryNotBefore(current: string, attempt: number) {
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 16));
  return new Date(Date.parse(current) + delay).toISOString();
}

type LaunchContext = {
  store: RunStore;
  t3: T3Adapter;
  images: RunImages;
  runRow: RunRow;
  launch: Delivery;
};

/**
 * Uploads the launch's Run images to T3 before reservation, anew for every dispatch: T3 ids are
 * never saved. Undefined leaves the launch pending (retried with backoff) or cancels it when
 * Factory no longer holds the bytes.
 */
function uploadLaunchImages(context: LaunchContext, launchImages: readonly LaunchImage[]) {
  return Effect.gen(function* () {
    if (!launchImages.length) return [];
    const { store, t3, images, runRow, launch } = context;
    const target = runTarget(runRow);
    const support = yield* Effect.promise(() =>
      t3.inspectAttachmentSupport(target, launchImages.length).catch(() => null),
    );
    if (!support?.supported) {
      yield* store.noteUnresolved(
        launch,
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
        yield* store.failLaunch(runRow, launch, IMAGE_MISSING);
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
  const { store, launch } = context;
  return Effect.gen(function* () {
    const current = yield* now;
    const notBefore = retryNotBefore(current, launch.recovery_attempt + 1);
    yield* store.retryImageUploadLater(
      launch,
      `Image upload to T3 failed: ${reason}`,
      current,
      notBefore,
    );
    return undefined;
  });
}
