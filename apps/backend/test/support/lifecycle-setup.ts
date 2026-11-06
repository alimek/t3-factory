import type { ControlledT3 } from "./controlled-t3.ts";

export function bindRuntimeReportCaller(
  t3: ControlledT3,
  projectId: string,
  executionId = "execution-1",
  callId = "report-call",
  threadId = "thread-1",
) {
  t3.runtimeActivity = {
    thread: { threadId, projectId, activeRunId: executionId, runtimeMode: "full-access" },
    items: [
      {
        visibility: "local",
        sourceThreadId: threadId,
        textTruncated: false,
        nextTextOffset: null,
        itemId: `t:native-item:${callId}`,
        type: "dynamic_tool",
        runId: executionId,
        text: '{"toolName":"mcp__factory-runtime__factory_report"}',
      },
    ],
    hasMore: false,
    nextPosition: null,
  };
}

/** Tool activity is local to one thread even in multi-block fixtures. */
export function bindThreadReportCaller(
  t3: ControlledT3,
  projectId: string,
  threadId: string,
  executionId: string,
  callId: string,
) {
  bindRuntimeReportCaller(t3, projectId, executionId, callId, threadId);
  t3.readRuntimeActivity = async (_target, candidate) =>
    candidate === threadId
      ? t3.runtimeActivity
      : {
          ...t3.runtimeActivity,
          thread: {
            ...t3.runtimeActivity.thread,
            threadId: candidate,
            projectId:
              [...t3.launches.values()].find((launch) => launch.reference.threadId === candidate)
                ?.payload.projectId ?? projectId,
          },
          items: [],
        };
}

export function restoreLaunches(
  t3: ControlledT3,
  entries: Iterable<[string, Parameters<ControlledT3["launches"]["set"]>[1]]>,
) {
  for (const [key, value] of entries) t3.launches.set(key, value);
}
