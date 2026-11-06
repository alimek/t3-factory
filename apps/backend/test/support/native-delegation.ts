import type { TestContext } from "@effect/vitest";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";

/** Sanitized installed Codex dynamic_tool shape; identities are opaque fixture values.
 * Source/version and the limits of this transport reconstruction are in the evidence doc. */
export function nativeDelegation() {
  return {
    toolName: "t3-code.delegate_task",
    input: {
      task: "Implement the requested change and summarize the outcome.",
      clientRequestId: "worker-request",
      mode: "async",
      isolation: "shared",
      target: { providerInstanceId: "codex", model: "gpt-6-astra", options: {} },
    },
    output: {
      taskId: "task-opaque",
      childThreadId: "child-opaque",
      childRunId: "child-run-opaque",
      childNodeId: "task-opaque",
      status: "running",
      workState: "working",
      hasPendingChildRuns: false,
      latestTerminalRunId: null,
      latestTerminalStatus: null,
      latestTerminalSummary: null,
      latestTerminalResultContextTransferId: null,
      providerInstanceId: "codex",
      model: "gpt-6-astra",
      options: [],
      summary: null,
      resultContextTransferId: null,
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
      next: "Completion wakes this thread, so end your turn. Do not wait on it or poll it.",
    },
  };
}

export async function delegationWire(
  c: TestContext,
  payload: unknown = nativeDelegation(),
  settings: {
    item?: Record<string, unknown>;
    changedText?: string;
    chunkSize?: number;
    inFlightReport?: boolean;
    additionalPayloads?: readonly unknown[];
    threadId?: string;
    projectId?: string;
    contextActivity?: import("../../src/adapters/t3.ts").RuntimeActivity;
  } = {},
) {
  const original = JSON.stringify(payload);
  const item = {
    position: 0,
    itemId: "turn-item:provider:codex:native-item:opaque-call",
    sourceThreadId: "parent",
    runId: "parent-run",
    visibility: "local",
    type: "dynamic_tool",
    status: "completed",
    updatedAt: "2026-11-04T16:46:26.084Z",
    ...settings.item,
  };
  const extra = (settings.additionalPayloads ?? []).map((payload, index) => ({
    ...item,
    position: index + 1,
    itemId: `turn-item:provider:codex:native-item:extra-${index}`,
    text: JSON.stringify(payload),
    textTruncated: false,
    nextTextOffset: null,
  }));
  const thread = {
    threadId: settings.threadId ?? "parent",
    projectId: settings.projectId ?? "project",
    activeRunId: settings.item?.runId ?? "parent-run",
    runtimeMode: "full-access",
  };
  const reads: Record<string, unknown>[] = [];
  const fixture = await authorizedLiveOAuth(c, {
    runtimeActivity: (args) => {
      reads.push(args);
      if (settings.contextActivity && args.threadId === settings.contextActivity.thread.threadId)
        return settings.contextActivity;
      const selected = extra.find((i) => i.itemId === args.itemId);
      if (selected)
        return {
          thread,
          items: [selected],
          hasMore: false,
          nextPosition: 0,
        };
      const text = args.itemId && settings.changedText ? settings.changedText : original;
      const offset = typeof args.textOffset === "number" ? args.textOffset : 0;
      const end = offset + (settings.chunkSize ?? 50_000);
      return {
        thread,
        items: [
          {
            ...item,
            text: text.slice(offset, end),
            textTruncated: end < text.length,
            nextTextOffset: end < text.length ? end : null,
          },
          ...(!args.itemId ? extra : []),
          ...(settings.inFlightReport && !args.itemId
            ? [
                {
                  ...item,
                  position: 1,
                  itemId: "turn-item:provider:codex:native-item:report",
                  status: "running",
                  text: JSON.stringify({ toolName: "factory-runtime.factory_report" }),
                  textTruncated: false,
                  nextTextOffset: null,
                },
              ]
            : []),
        ],
        hasMore: false,
        nextPosition: 0,
      };
    },
  });
  return { ...fixture, reads };
}
