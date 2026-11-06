import { nativeDelegation } from "./native-delegation.ts";
import { delegationActivity } from "../../src/adapters/delegation-activity.ts";
import type { ControlledT3 } from "./controlled-t3.ts";
/** Actual native envelope decoding; no bindings, activations or SQL seeded in setup. */
export function nativeChild(
  input: ReturnType<typeof nativeDelegation>["input"],
  parentRunId: string,
  child: number,
  projectId: string,
) {
  const wire = nativeChildEnvelope(input, child);
  const source = delegationActivity({
    threadId: "thread-1",
    projectId,
    complete: true,
    items: [
      {
        position: 0,
        itemId: `turn-item:provider:codex:native-item:command-${child}`,
        sourceThreadId: "thread-1",
        runId: parentRunId,
        visibility: "local",
        type: "dynamic_tool",
        status: "completed",
        updatedAt: "2026-11-05T10:00:00Z",
        text: JSON.stringify(wire),
        complete: true,
      },
    ],
  });
  return source.invocations[0]!;
}
export function nativeChildEnvelope(
  input: ReturnType<typeof nativeDelegation>["input"],
  child: number,
) {
  const sourceWire = nativeDelegation();
  return {
    ...sourceWire,
    input,
    output: {
      ...sourceWire.output,
      childThreadId: `thread-${child}`,
      childRunId: `execution-${child}`,
      childNodeId: `native-task-${child}`,
      taskId: `native-task-${child}`,
      providerInstanceId: input.target.providerInstanceId,
      model: input.target.model,
      options: Object.entries(input.target.options).map(([id, value]) => ({ id, value })),
    },
  };
}
export function supplyChild(
  t3: ControlledT3,
  invocation: ReturnType<typeof nativeChild>,
  project: { projectId: string; workspaceRoot: string },
) {
  const result = invocation.result;
  const identity = {
    threadId: result.childThreadId,
    projectId: project.projectId,
    parentThreadId: "thread-1",
    relationshipToParent: "subagent",
    creationSource: "mcp",
    createdBy: "agent",
    providerInstanceId: result.providerInstanceId,
    model: result.model,
  };
  t3.delegationActivities.set(result.childThreadId, {
    threadId: result.childThreadId,
    projectId: project.projectId,
    complete: true,
    invocations: [],
  });
  t3.descendantEvidence.set(result.childThreadId, {
    parentThreadId: result.childThreadId,
    descendants: [],
    scanComplete: true,
    coverage: "incomplete",
    problem: "Bounded native child scan.",
  });
  t3.childEvidence.set(result.childThreadId, {
    target: {
      parentThreadId: "thread-1",
      projectId: project.projectId,
      childThreadId: result.childThreadId,
      childRunId: result.childRunId,
    },
    relationship: "t3-owned",
    scopeMatches: true,
    optionsCoverage: "unavailable",
    thread: {
      ...identity,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      activeRunId: result.childRunId,
      latestRunId: result.childRunId,
      pendingRequestCount: 0,
    },
    execution: {
      runId: result.childRunId!,
      status: "running",
      providerInstanceId: result.providerInstanceId,
      model: result.model,
    },
  });
  t3.executionObservations.set(result.childThreadId, {
    threadId: result.childThreadId,
    projectId: project.projectId,
    workspaceRoot: project.workspaceRoot,
    link: `t3://threads/${result.childThreadId}`,
    activeRunId: result.childRunId,
    latestRunId: result.childRunId,
    pendingRequestCount: 0,
    recentRuns: [{ runId: result.childRunId!, status: "running", ordinal: 1 }],
  });
}

/** A worker's own factory_context call, visible only in its thread's native activity. */
export function contextCaller(
  t3: ControlledT3,
  projectId: string,
  threadId: string,
  executionId: string,
  callId = "context",
) {
  t3.runtimeActivity = {
    thread: { threadId, projectId, activeRunId: executionId, runtimeMode: "full-access" },
    items: [
      {
        itemId: `turn-item:provider:codex:native-item:${callId}`,
        type: "dynamic_tool",
        runId: executionId,
        sourceThreadId: threadId,
        visibility: "local",
        textTruncated: false,
        nextTextOffset: null,
        text: JSON.stringify({ toolName: "factory-runtime.factory_context" }),
      },
    ],
    hasMore: false,
    nextPosition: null,
  };
  t3.readRuntimeActivity = async (_target, candidate) =>
    candidate === threadId
      ? t3.runtimeActivity
      : {
          ...t3.runtimeActivity,
          thread: { threadId: candidate, projectId, activeRunId: null, runtimeMode: "full-access" },
          items: [],
        };
}
