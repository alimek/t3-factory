import { delegationActivity } from "../../apps/backend/src/adapters/delegation-activity.ts";
import { nativeDelegation } from "../../apps/backend/test/support/native-delegation.ts";
import type { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";

type Plan = ReturnType<typeof nativeDelegation>["input"];

function pendingNativeTurn(t3: ControlledT3, threadId: string, runId: string) {
  t3.delegatedSettlements.set(JSON.stringify([threadId, runId]), {
    threadId,
    runId,
    state: "pending",
    status: "running",
    resultRun: null,
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
}

function observeChildTurn(t3: ControlledT3, threadId: string, runId: string, status: string) {
  const child = t3.childEvidence.get(threadId);
  const observation = t3.executionObservations.get(threadId);
  if (child?.thread && child.execution && observation) {
    const previousKey = JSON.stringify([threadId, child.execution.runId]);
    if (!t3.childEvidence.has(previousKey)) t3.childEvidence.set(previousKey, child);
    const updated = {
      ...child,
      target: { ...child.target, childRunId: runId },
      thread: {
        ...child.thread,
        activeRunId: observation.activeRunId,
        latestRunId: observation.latestRunId ?? null,
      },
      execution: { ...child.execution, runId, status },
    };
    t3.childEvidence.set(threadId, updated);
    t3.childEvidence.set(JSON.stringify([threadId, runId]), updated);
  }
}

/** Simulated external native engine facts, never Factory bindings or Run projections. */
export function beginNativeTurn(t3: ControlledT3, threadId: string, runId: string) {
  pendingNativeTurn(t3, threadId, runId);
  const prior = t3.executionObservations.get(threadId);
  if (!prior) throw Error(`Unknown simulated thread ${threadId}`);
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: runId,
    latestRunId: runId,
    recentRuns: [
      ...prior.recentRuns,
      {
        runId,
        status: "running",
        ordinal: 1 + Math.max(0, ...prior.recentRuns.map((r) => r.ordinal ?? 0)),
        startedAt: new Date().toISOString(),
      },
    ],
  });
  observeChildTurn(t3, threadId, runId, "running");
}

export function finishNativeTurn(
  t3: ControlledT3,
  threadId: string,
  runId: string,
  status = "completed",
) {
  const prior = t3.executionObservations.get(threadId);
  if (!prior) throw Error(`Unknown simulated thread ${threadId}`);
  t3.executionObservations.set(threadId, {
    ...prior,
    activeRunId: prior.activeRunId === runId ? null : prior.activeRunId,
    recentRuns: prior.recentRuns.map((r) =>
      r.runId === runId ? { ...r, status, completedAt: new Date().toISOString() } : r,
    ),
  });
  observeChildTurn(t3, threadId, runId, status);
  t3.delegatedSettlements.set(JSON.stringify([threadId, runId]), {
    threadId,
    runId,
    state: "settled",
    status,
    resultRun: { runId, status },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  for (const send of t3.sends.values())
    if (send.reference.runId === runId) send.reference = { ...send.reference, status };
}

function emptyNativeHistory(t3: ControlledT3, threadId: string, projectId: string) {
  t3.delegationActivities.set(threadId, { threadId, projectId, complete: true, invocations: [] });
  t3.descendantEvidence.set(threadId, {
    parentThreadId: threadId,
    descendants: [],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Simulated local native scan.",
  });
}

export async function recordRoot(t3: ControlledT3, threadId: string, projectId: string) {
  if (t3.executionObservations.has(threadId)) return;
  t3.executionObservations.set(threadId, await t3.readExecution({ endpoint: "demo" }, threadId));
  emptyNativeHistory(t3, threadId, projectId);
}

function publish(t3: ControlledT3, threadId: string, runId: string, wire: object) {
  const prior = t3.delegationActivities.get(threadId)!;
  const decoded = delegationActivity({
    threadId,
    projectId: prior.projectId,
    complete: true,
    items: [
      {
        position: prior.invocations.length + (prior.followups?.length ?? 0),
        itemId: `turn-item:provider:codex:native-item:${runId}`,
        sourceThreadId: threadId,
        runId,
        visibility: "local",
        type: "dynamic_tool",
        status: "completed",
        updatedAt: new Date().toISOString(),
        complete: true,
        text: JSON.stringify(wire),
      },
    ],
  });
  t3.delegationActivities.set(threadId, {
    ...prior,
    invocations: [...prior.invocations, ...decoded.invocations],
    followups: [...(prior.followups ?? []), ...(decoded.followups ?? [])],
  });
}

function delegate(t3: ControlledT3, parentThreadId: string, parentRunId: string, input: Plan) {
  const parent = t3.executionObservations.get(parentThreadId)!;
  const n = t3.childEvidence.size + 1;
  const threadId = `demo-native-${n}`,
    runId = `demo-execution-${n}`;
  const template = nativeDelegation();
  publish(t3, parentThreadId, parentRunId, {
    ...template,
    input,
    output: {
      ...template.output,
      taskId: `demo-task-${n}`,
      childNodeId: `demo-task-${n}`,
      childThreadId: threadId,
      childRunId: runId,
      providerInstanceId: input.target.providerInstanceId,
      model: input.target.model,
      options: Object.entries(input.target.options).map(([id, value]) => ({ id, value })),
    },
  });
  const identity = {
    threadId,
    projectId: parent.projectId,
    parentThreadId,
    relationshipToParent: "subagent",
    creationSource: "mcp",
    createdBy: "agent",
    providerInstanceId: input.target.providerInstanceId,
    model: input.target.model,
  };
  t3.childEvidence.set(threadId, {
    target: {
      parentThreadId,
      projectId: parent.projectId,
      childThreadId: threadId,
      childRunId: runId,
    },
    relationship: "t3-owned",
    scopeMatches: true,
    optionsCoverage: "unavailable",
    thread: {
      ...identity,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      activeRunId: runId,
      latestRunId: runId,
      pendingRequestCount: 0,
    },
    execution: {
      runId,
      status: "running",
      providerInstanceId: input.target.providerInstanceId,
      model: input.target.model,
    },
  });
  t3.executionObservations.set(threadId, {
    threadId,
    projectId: parent.projectId,
    workspaceRoot: parent.workspaceRoot,
    link: `t3://threads/${threadId}`,
    activeRunId: runId,
    latestRunId: runId,
    pendingRequestCount: 0,
    recentRuns: [{ runId, status: "running", ordinal: 1 }],
  });
  emptyNativeHistory(t3, threadId, parent.projectId);
  pendingNativeTurn(t3, threadId, runId);
  const tree = t3.descendantEvidence.get(parentThreadId)!;
  t3.descendantEvidence.set(parentThreadId, {
    ...tree,
    descendants: [...tree.descendants, { ...identity, relationship: "t3-owned" }],
  });
  finishNativeTurn(t3, parentThreadId, parentRunId);
}

function startIssuedTurn(t3: ControlledT3, threadId: string, runId: string) {
  const observation = t3.executionObservations.get(threadId)!;
  const execution = observation.recentRuns.find((r) => r.runId === runId);
  if (!execution || !["running", "starting", "queued"].includes(execution.status)) return false;
  if (observation.activeRunId && observation.activeRunId !== runId) return false;
  if (execution.status === "queued") {
    t3.executionObservations.set(threadId, {
      ...observation,
      activeRunId: runId,
      latestRunId: runId,
      recentRuns: observation.recentRuns.map((r) =>
        r.runId === runId ? { ...r, status: "running" } : r,
      ),
    });
    for (const send of t3.sends.values()) {
      if (send.reference.runId === runId)
        send.reference = { ...send.reference, status: "running", delivery: "started" };
    }
  }
  return true;
}

function executeMessage(t3: ControlledT3, threadId: string, runId: string, message: string) {
  if (!startIssuedTurn(t3, threadId, runId)) return;
  if (isRootCommand(message))
    delegate(t3, threadId, runId, JSON.parse(message.split("\n").at(-1)!));
}

function isRootCommand(message: string) {
  return message.includes("Factory-issued direct Block worker creation.");
}

/** Simulate the Run conversation executing its issued worker commands. */
export async function advanceNative(t3: ControlledT3) {
  for (const { payload, reference } of t3.launches.values()) {
    if (!isRootCommand(payload.message)) continue;
    await recordRoot(t3, reference.threadId, reference.projectId);
    executeMessage(t3, reference.threadId, reference.runId, payload.message);
  }
  for (const { payload, reference } of t3.sends.values())
    executeMessage(t3, payload.threadId, reference.runId, payload.message);
}
