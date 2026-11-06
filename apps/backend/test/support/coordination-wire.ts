import type { TestContext } from "@effect/vitest";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";

export const childTarget = {
  parentThreadId: "parent",
  projectId: "project",
  childThreadId: "child",
  childRunId: "child-run",
};
export function childRead(thread: Record<string, unknown> = {}, runs?: unknown[]) {
  return {
    thread: {
      threadId: "child",
      projectId: "project",
      parentThreadId: "parent",
      relationshipToParent: "subagent",
      creationSource: "mcp",
      createdBy: "agent",
      providerInstanceId: "codex",
      model: "gpt-6-astra",
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      activeRunId: "child-run",
      latestRunId: "child-run",
      pendingRequestCount: 0,
      ...thread,
    },
    recentRuns: runs ?? [
      {
        runId: "child-run",
        status: "running",
        ordinal: 1,
        providerInstanceId: "codex",
        model: "gpt-6-astra",
      },
    ],
    items: [],
    hasMore: false,
    nextPosition: null,
  };
}
export async function coordinationWire(
  c: TestContext,
  options: {
    read?: ReturnType<typeof childRead>;
    wait?: Record<string, unknown>;
    list?: (args: Record<string, unknown>) => unknown;
  } = {},
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fixture = await authorizedLiveOAuth(c, {
    runtimeActivity: (args) => {
      calls.push({ name: "read", args });
      return options.read ?? childRead();
    },
    wait: (args) => {
      calls.push({ name: "wait", args });
      return (
        options.wait ?? {
          threadId: "parent",
          runId: "parent-run",
          status: "completed",
          timedOut: false,
          resultRun: { runId: "parent-run", status: "completed" },
        }
      );
    },
    threads: (args) => {
      calls.push({ name: "list", args });
      return (
        options.list?.(args) ?? {
          projectId: null,
          threads: [],
          nextCursor: null,
          total: 0,
        }
      );
    },
  });
  return { ...fixture, calls };
}
