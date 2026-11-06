import { assert, type TestContext } from "@effect/vitest";
import { directWorker, finishWorker, workerFinal } from "./run-worker.ts";
import { nativeChild, nativeChildEnvelope, supplyChild } from "./native-root-evidence.ts";
import { nativeDelegation } from "./native-delegation.ts";
import { delegationActivity } from "../../src/adapters/delegation-activity.ts";

/** Genuine decoded command receipts and independently arranged owned-subtree lifecycle facts. */
export async function workerWithOwnedControl(
  c: TestContext,
  kind: "interrupt" | "cancel" = "interrupt",
  firstObservation: "completed" | "in-progress" | "unresolved" = "completed",
) {
  const f = await directWorker(c, true, "");
  const input = nativeDelegation().input;
  const delegated = nativeChild(input, "execution-2", 3, f.project.projectId);
  supplyChild(f.t3, delegated, f.project);
  const child = f.t3.childEvidence.get("thread-3")!;
  const completed = {
    ...child,
    target: { ...child.target, parentThreadId: "thread-2" },
    thread: { ...child.thread!, parentThreadId: "thread-2", activeRunId: null },
    execution: { ...child.execution!, status: "completed" },
  };
  f.t3.childEvidence.set("thread-3", completed);
  const observed = f.t3.executionObservations.get("thread-3")!;
  f.t3.executionObservations.set("thread-3", {
    ...observed,
    activeRunId: null,
    recentRuns: [{ runId: "execution-3", status: "completed", ordinal: 1 }],
  });
  const descendant = { ...completed.thread, relationship: "t3-owned" as const };
  f.t3.descendantEvidence.set("thread-2", {
    parentThreadId: "thread-2",
    descendants: [descendant],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded fixture scan",
  });
  const root = f.t3.descendantEvidence.get("thread-1")!;
  f.t3.descendantEvidence.set("thread-1", {
    ...root,
    descendants: [...root.descendants, descendant],
  });
  const control =
    kind === "cancel"
      ? {
          toolName: "t3-code.task_cancel",
          input: { taskId: delegated.result.taskId },
          output: { taskId: delegated.result.taskId, status: "completed" },
        }
      : {
          toolName: "t3-code.t3_thread_interrupt",
          input: { threadId: "thread-3" },
          output: { threadId: "thread-3", runId: null, status: "no_active_run" },
        };
  const envelopes = [nativeChildEnvelope(input, 3), control];
  f.t3.delegationActivities.set(
    "thread-2",
    delegationActivity({
      threadId: "thread-2",
      projectId: f.project.projectId,
      complete: true,
      items: envelopes.map((envelope, index) => ({
        position: index,
        itemId: `turn-item:provider:codex:native-item:control-${index}`,
        sourceThreadId: "thread-2",
        runId: "execution-2",
        visibility: "local",
        type: "dynamic_tool",
        status: "completed",
        updatedAt: "2026-11-05T10:00:00Z",
        complete: true,
        text: JSON.stringify(envelope),
      })),
    }),
  );
  const finalActivity = f.t3.delegationActivities.get("thread-2")!;
  if (firstObservation !== "completed") {
    const prior =
      firstObservation === "unresolved"
        ? {
            ...finalActivity,
            commands: finalActivity.commands!.map((command) => ({ ...command, references: [] })),
          }
        : delegationActivity({
            threadId: "thread-2",
            projectId: f.project.projectId,
            complete: true,
            items: envelopes.map((envelope, index) => ({
              position: index,
              itemId: `turn-item:provider:codex:native-item:control-${index}`,
              sourceThreadId: "thread-2",
              runId: "execution-2",
              visibility: "local",
              type: "dynamic_tool",
              status: index === 1 ? "inProgress" : "completed",
              complete: index !== 1,
              updatedAt: "2026-11-05T10:00:00Z",
              text: JSON.stringify(
                index === 1 ? { toolName: control.toolName, input: control.input } : envelope,
              ),
            })),
          });
    f.t3.delegationActivities.set("thread-2", prior);
    assert((await f.f.reconcileRuns()).ok);
    f.t3.delegationActivities.set("thread-2", finalActivity);
  }
  assert((await f.f.reconcileRuns()).ok);
  return f;
}

export async function reportedControlledWorker(
  c: TestContext,
  firstObservation: "completed" | "in-progress" | "unresolved" = "completed",
) {
  const f = await workerWithOwnedControl(c, "interrupt", firstObservation);
  assert((await f.f.runtime.submit(workerFinal())).code === "ACCEPTED");
  finishWorker(f);
  f.t3.engineStatus = "completed";
  f.t3.delegatedSettlements.set(JSON.stringify(["thread-1", "execution-1"]), {
    threadId: "thread-1",
    runId: "execution-1",
    state: "settled",
    status: "completed",
    resultRun: { runId: "execution-1", status: "completed" },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  return f;
}

export async function workerWithUnknownControl(c: TestContext) {
  const f = await workerWithOwnedControl(c);
  const extra = delegationActivity({
    threadId: "thread-2",
    projectId: f.project.projectId,
    complete: true,
    items: [
      {
        position: 3,
        itemId: "turn-item:provider:codex:native-item:foreign-control",
        sourceThreadId: "thread-2",
        runId: "execution-2",
        visibility: "local",
        type: "dynamic_tool",
        status: "completed",
        updatedAt: "2026-11-05T10:00:00Z",
        complete: true,
        text: JSON.stringify({
          toolName: "t3-code.t3_thread_interrupt",
          input: { threadId: "foreign" },
          output: { threadId: "foreign", runId: null, status: "no_active_run" },
        }),
      },
    ],
  });
  const activity = f.t3.delegationActivities.get("thread-2")!;
  f.t3.delegationActivities.set("thread-2", {
    ...activity,
    commands: [...activity.commands!, ...extra.commands!],
  });
  return f;
}

export async function workerWithLateControl(c: TestContext) {
  const f = await workerWithOwnedControl(c);
  assert((await f.f.runtime.submit(workerFinal())).code === "ACCEPTED");
  const activity = f.t3.delegationActivities.get("thread-2")!;
  const original = activity.commands![0]!;
  f.t3.delegationActivities.set("thread-2", {
    ...activity,
    commands: [
      ...activity.commands!,
      { ...original, itemId: "turn-item:provider:codex:native-item:late-control" },
    ],
  });
  finishWorker(f);
  return f;
}
