import { assert, type TestContext } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { waitingWorker, supplyWorkerReply } from "./run-worker.ts";
import { contextCaller, nativeChild, supplyChild } from "./native-root-evidence.ts";
import { twoTargetStart } from "./root-control-recovery.ts";
import { bindThreadReportCaller } from "./lifecycle-setup.ts";
import type { ControlledT3 } from "./controlled-t3.ts";
import type { RuntimeActivity } from "../../src/adapters/t3.ts";

/** Publish the reply only after reopening under TestClock, so no timer can pre-bind it. */
export const workerReplyContext = Effect.fn(function* (c: TestContext) {
  const fixture = yield* Effect.promise(() => waitingWorker(c));
  yield* Effect.promise(() => fixture.f.close());
  const f = yield* fixture.h.service({ t3: fixture.t3, connectionRetryMs: 60_000 });
  supplyWorkerReply(fixture);
  const items = fixture.t3.runtimeActivity.items;
  contextCaller(fixture.t3, fixture.project.projectId, "thread-2", "answer-execution");
  fixture.t3.runtimeActivity = {
    ...fixture.t3.runtimeActivity,
    items: [...items, ...fixture.t3.runtimeActivity.items],
  };
  return {
    ...fixture,
    f,
    call: { arguments: {}, metadata: { callId: "context" }, inheritedThreadId: "thread-2" },
  };
});

/** Both callers capture their Run before either can begin observing its worker. */
export function synchronizeContextCallers(t3: ControlledT3) {
  const read = t3.readRuntimeActivity.bind(t3);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  t3.readRuntimeActivity = async (...args) => {
    const page = await read(...args);
    if (["thread-2", "thread-3"].includes(args[1]) && args[3] === undefined && arrivals < 2) {
      arrivals++;
      if (arrivals === 2) release();
      await ready;
    }
    return page;
  };
}

/** Bind two independent workers through their issued commands and let both ask in chat. */
async function parallelWaitingWorkers(c: TestContext) {
  const fixture = await twoTargetStart(c);
  const { t3, project } = fixture;
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);
  const launch = [...t3.launches.values()][0]!;
  const first = nativeChild(
    JSON.parse(launch.payload.message.split("\n").at(-1)!),
    "execution-1",
    2,
    project.projectId,
  );
  supplyChild(t3, first, project);
  contextCaller(t3, project.projectId, "thread-2", "execution-2");
  t3.delegationActivities.set("thread-1", {
    threadId: "thread-1",
    projectId: project.projectId,
    complete: true,
    invocations: [first],
  });
  t3.descendantEvidence.set("thread-1", {
    parentThreadId: "thread-1",
    descendants: [{ ...t3.childEvidence.get("thread-2")!.thread!, relationship: "t3-owned" }],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded fixture scan",
  });
  assert((await fixture.f.reconcileRuns()).ok);
  const send = [...t3.sends.values()][0]!;
  const second = nativeChild(
    JSON.parse(send.payload.message.split("\n").at(-1)!),
    send.reference.runId,
    3,
    project.projectId,
  );
  supplyChild(t3, second, project);
  const root = t3.delegationActivities.get("thread-1")!;
  t3.delegationActivities.set("thread-1", { ...root, invocations: [first, second] });
  const tree = t3.descendantEvidence.get("thread-1")!;
  t3.descendantEvidence.set("thread-1", {
    ...tree,
    descendants: [
      ...tree.descendants,
      { ...t3.childEvidence.get("thread-3")!.thread!, relationship: "t3-owned" },
    ],
  });
  assert((await fixture.f.reconcileRuns()).ok);
  for (const threadId of ["thread-2", "thread-3"]) {
    const child = t3.childEvidence.get(threadId)!;
    bindThreadReportCaller(t3, project.projectId, threadId, child.execution!.runId, "question");
    const report = await fixture.f.runtime.submit({
      arguments: { key: "question", status: "waiting", message: "Which audience?" },
      metadata: { callId: "question" },
      inheritedThreadId: threadId,
    });
    assert(report.code === "ACCEPTED");
    const prior = t3.executionObservations.get(threadId)!;
    t3.executionObservations.set(threadId, {
      ...prior,
      activeRunId: null,
      recentRuns: prior.recentRuns.map((r) => ({ ...r, status: "completed" })),
    });
    t3.childEvidence.set(threadId, {
      ...child,
      thread: { ...child.thread!, activeRunId: null },
      execution: { ...child.execution!, status: "completed" },
    });
  }
  assert((await fixture.f.reconcileRuns()).ok);
  return { ...fixture, runId: started.value.id };
}

/** Each reply has its own native caller and exact execution on an independent worker. */
export const parallelReplyContexts = Effect.fn(function* (c: TestContext) {
  const fixture = yield* Effect.promise(() => parallelWaitingWorkers(c));
  yield* Effect.promise(() => fixture.f.close());
  const f = yield* fixture.h.service({ t3: fixture.t3, connectionRetryMs: 60_000 });
  const activities = new Map<string, RuntimeActivity>();
  for (const threadId of ["thread-2", "thread-3"]) {
    const executionId = `${threadId}-answer`;
    const prior = fixture.t3.executionObservations.get(threadId)!;
    fixture.t3.executionObservations.set(threadId, {
      ...prior,
      activeRunId: executionId,
      latestRunId: executionId,
      recentRuns: [...prior.recentRuns, { runId: executionId, ordinal: 2, status: "running" }],
    });
    const child = fixture.t3.childEvidence.get(threadId)!;
    fixture.t3.childEvidence.set(JSON.stringify([threadId, child.execution!.runId]), child);
    const next = {
      ...child,
      target: { ...child.target, childRunId: executionId },
      thread: { ...child.thread!, activeRunId: executionId, latestRunId: executionId },
      execution: { ...child.execution!, runId: executionId, status: "running" },
    };
    fixture.t3.childEvidence.set(threadId, next);
    fixture.t3.childEvidence.set(JSON.stringify([threadId, executionId]), next);
    contextCaller(fixture.t3, fixture.project.projectId, threadId, executionId);
    activities.set(threadId, {
      ...fixture.t3.runtimeActivity,
      items: [
        ...fixture.t3.runtimeActivity.items,
        {
          itemId: `${threadId}-reply`,
          type: "message",
          runId: executionId,
          text: "Public audience.",
          visibility: "local",
          sourceThreadId: threadId,
          createdBy: "user",
        },
      ],
    });
  }
  const empty = fixture.t3.runtimeActivity;
  fixture.t3.readRuntimeActivity = async (_target, threadId) =>
    activities.get(threadId) ?? {
      ...empty,
      thread: { ...empty.thread, threadId },
      items: [],
    };
  return { ...fixture, f };
});
