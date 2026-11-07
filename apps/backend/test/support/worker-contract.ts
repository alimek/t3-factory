import { assert, expect, type TestContext } from "@effect/vitest";
import { workerActivity } from "../fixtures/t3-worker-activity.ts";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";
import { waitingWorker, workerFinal } from "./run-worker.ts";
import { supplyChild } from "./native-root-evidence.ts";
import { beginNativeTurn, finishNativeTurn } from "../../../../scripts/dev/native-simulation.ts";
import type { RuntimeActivity } from "../../src/adapters/t3.ts";

/** Serve the reduced capture unchanged, including exact-item selection. */
export function capturedWorker(c: TestContext) {
  return authorizedLiveOAuth(c, {
    runtimeActivity: (args) => ({
      ...workerActivity,
      items: args.itemId
        ? workerActivity.items.filter((item) => item.itemId === args.itemId)
        : workerActivity.items,
    }),
  });
}

/** Synthetic lifecycle using captured wire metadata. Only reads cross the HTTP adapter;
 * launches, native engine progress and settlement remain controlled. */
export async function completedWireWorker(c: TestContext) {
  const f = await waitingWorker(c);
  const threadId = "thread-1";
  const reply = workerActivity.items[1];
  const notification = workerActivity.items[3];
  let items: readonly (RuntimeActivity["items"][number] & {
    position: number;
    updatedAt: string;
  })[] = [];
  let toolName = "factory-runtime.factory_get_block";
  let toolInput: object = {};
  const wire = await authorizedLiveOAuth(c, {
    runtimeActivity: (args) => {
      const observation = f.t3.executionObservations.get(threadId)!;
      const call = {
        ...workerActivity.items[0],
        itemId: "turn-item:provider:codex:native-item:worker-report",
        position: items.length,
        runId: observation.latestRunId!,
        status: "running",
        text: JSON.stringify({ toolName, input: toolInput }),
      };
      const activity = [...items, call];
      return {
        ...workerActivity,
        thread: {
          ...workerActivity.thread,
          projectId: f.project.projectId,
          activeRunId: observation.activeRunId,
          latestRunId: observation.latestRunId,
        },
        recentRuns: [...observation.recentRuns].reverse(),
        items: args.runLimit
          ? []
          : args.itemId
            ? activity.filter((item) => item.itemId === args.itemId)
            : activity,
        nextPosition: call.position,
      };
    },
  });
  const target = { endpoint: wire.endpoint };
  const readExecution = f.t3.readExecution.bind(f.t3);
  f.t3.readExecution = (t, id, recorded) =>
    id === threadId
      ? wire.adapter.readExecution(target, id, recorded)
      : readExecution(t, id, recorded);
  const readActivity = f.t3.readRuntimeActivity.bind(f.t3);
  f.t3.readRuntimeActivity = (t, id, cursor, itemId) =>
    id === threadId
      ? wire.adapter.readRuntimeActivity(target, id, cursor, itemId)
      : readActivity(t, id, cursor, itemId);

  beginNativeTurn(f.t3, threadId, "answer-execution");
  items = [{ ...reply, position: 0, runId: "answer-execution" }];
  assert(
    (await f.f.runtime.block({ arguments: {}, metadata: { callId: "worker-report" } })).code ===
      "BLOCK",
  );
  finishNativeTurn(f.t3, threadId, "answer-execution");
  assert((await f.f.reconcileRuns()).ok);

  beginNativeTurn(f.t3, threadId, "followup-execution");
  items = [
    ...items,
    { ...reply, position: 1, itemId: "turn-item:message:followup", runId: "followup-execution" },
  ];
  assert(
    (await f.f.runtime.block({ arguments: {}, metadata: { callId: "worker-report" } })).code ===
      "BLOCK",
  );
  items = [...items, { ...workerActivity.items[2], position: 2, runId: "followup-execution" }];
  const delegation = await wire.adapter.readDelegationActivity(target, threadId);
  assert(delegation.complete, delegation.problem);
  assert(delegation.invocations[0]);
  f.t3.delegationActivities.set(threadId, delegation);
  supplyChild(f.t3, delegation.invocations[0], f.project);
  finishNativeTurn(f.t3, threadId, "followup-execution");
  assert((await f.f.reconcileRuns()).ok);
  const yielded = await f.f.getRun(f.runId);
  assert(yielded.ok);
  expect(yielded.value.blocks[0]?.state).toBe("working");

  finishNativeTurn(f.t3, "thread-3", "execution-3");
  beginNativeTurn(f.t3, threadId, "continuation-execution");
  items = [...items, { ...notification, position: 3, runId: "continuation-execution" }];
  toolName = "factory-runtime.factory_update_block";
  toolInput = workerFinal().arguments;
  expect((await f.f.runtime.submit(workerFinal())).code).toBe("ACCEPTED");
  const held = await f.f.getRun(f.runId);
  assert(held.ok);
  expect(held.value.reports[0]?.completionEligibleAt).toBeNull();
  expect(f.t3.launches.size).toBe(1);
  await f.f.close();
  finishNativeTurn(f.t3, threadId, "continuation-execution");
  return f;
}
