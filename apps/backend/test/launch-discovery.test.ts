import { expect, it } from "@effect/vitest";
import { discoverLaunches, threadIdentityRead } from "../src/launch-discovery.ts";

const title = "Factory #1 · 1 Entry";

function execution() {
  return {
    runId: "execution-1",
    providerInstanceId: "codex-main",
    model: "gpt-6.1-sol",
    status: "running",
  };
}

function thread(fields: Record<string, unknown>) {
  return {
    threadId: "thread-1",
    title,
    projectId: "project-1",
    workspaceRoot: "/repo",
    interactionMode: "default",
    providerInstanceId: "codex-main",
    model: "gpt-6.1-sol",
    options: { reasoning: "low" },
    recentRuns: [execution()],
    ...fields,
  };
}

it("a listed worker keeps the parent proved by its thread read", async () => {
  // Arrange
  const listed = thread({});
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return { projectId: "project-1", threads: [listed], nextCursor: null };
    reads += 1;
    return thread({ parentThreadId: "parent-9" });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(1);
  expect(found).toMatchObject({
    available: true,
    candidates: [{ parentThreadId: "parent-9" }],
  });
});

it("a listed worker with no parent in the list or the thread read stays unresolved", async () => {
  // Arrange
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return { projectId: "project-1", threads: [thread({})], nextCursor: null };
    return thread({});
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(found).toEqual({ available: false });
});

it("a non-string parent withholds the launch search", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [thread({ parentThreadId: 4 })],
        nextCursor: null,
      };
    reads += 1;
    return thread({ parentThreadId: null });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(0);
  expect(found).toEqual({ available: false });
});

it("an explicit top-level parent in the list is accepted without another read", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [thread({ parentThreadId: null })],
        nextCursor: null,
      };
    reads += 1;
    return thread({ parentThreadId: "parent-9" });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(0);
  expect(found).toMatchObject({
    available: true,
    candidates: [{ parentThreadId: null }],
  });
});

it("a null worktree is the project checkout and a missing workspace stays unproven", () => {
  // Arrange
  const checkout = {
    thread: {
      threadId: "thread-1",
      projectId: "project-1",
      parentThreadId: null,
      worktreePath: null,
      providerInstanceId: "codex-main",
      model: "gpt-6.1-sol",
    },
    recentRuns: [execution()],
  };
  const { worktreePath: _worktree, ...thread } = {
    threadId: "thread-1",
    projectId: "project-1",
    parentThreadId: null,
    worktreePath: "/repo",
    providerInstanceId: "codex-main",
    model: "gpt-6.1-sol",
  };

  // Act
  const identity = threadIdentityRead(checkout, "thread-1");

  // Assert
  expect(identity.workspaceRoot).toBeNull();
  expect(() => threadIdentityRead({ thread, recentRuns: [execution()] }, "thread-1")).toThrow(
    /workspace/i,
  );
});

it("a listed null worktree stays a project-checkout candidate", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [thread({ parentThreadId: null, workspaceRoot: null })],
        nextCursor: null,
      };
    reads += 1;
    return thread({ parentThreadId: null, workspaceRoot: "/other" });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(0);
  expect(found).toMatchObject({
    available: true,
    candidates: [{ workspaceRoot: null, parentThreadId: null }],
  });
});

it("a non-string workspace withholds the launch search", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [thread({ parentThreadId: null, workspaceRoot: 4 })],
        nextCursor: null,
      };
    reads += 1;
    return thread({ parentThreadId: null });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(0);
  expect(found).toEqual({ available: false });
});

it("a live thread read proves identity from the nested thread and its worktree", () => {
  // Arrange
  const body = {
    thread: {
      threadId: "thread-1",
      projectId: "project-1",
      parentThreadId: null,
      worktreePath: "/repo",
      providerInstanceId: "codex-main",
      model: "gpt-6.1-sol",
    },
    recentRuns: [execution()],
  };

  // Act
  const identity = threadIdentityRead(body, "thread-1");

  // Assert
  expect(identity).toMatchObject({
    threadId: "thread-1",
    projectId: "project-1",
    parentThreadId: null,
    workspaceRoot: "/repo",
    providerInstanceId: "codex-main",
    model: "gpt-6.1-sol",
    executions: [{ runId: "execution-1", providerInstanceId: "codex-main", model: "gpt-6.1-sol" }],
  });
});

it("a nested thread read supplies the project, parent and workspace the list omitted", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [
          {
            threadId: "thread-1",
            title,
            interactionMode: "default",
            providerInstanceId: "codex-main",
            model: "gpt-6.1-sol",
            options: { reasoning: "low" },
            recentRuns: [execution()],
          },
        ],
        nextCursor: null,
      };
    reads += 1;
    return {
      thread: {
        threadId: "thread-1",
        title,
        projectId: "project-from-thread",
        parentThreadId: null,
        worktreePath: "/repo",
        providerInstanceId: "codex-main",
        model: "gpt-6.1-sol",
      },
      recentRuns: [execution()],
    };
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(1);
  expect(found).toMatchObject({
    available: true,
    candidates: [
      { projectId: "project-from-thread", parentThreadId: null, workspaceRoot: "/repo" },
    ],
  });
});

it("a missing project id stays unproven when the thread read also omits it", async () => {
  // Arrange
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [
          {
            threadId: "thread-1",
            title,
            parentThreadId: null,
            workspaceRoot: "/repo",
            interactionMode: "default",
            providerInstanceId: "codex-main",
            model: "gpt-6.1-sol",
            options: { reasoning: "low" },
            recentRuns: [execution()],
          },
        ],
        nextCursor: null,
      };
    return thread({ projectId: undefined });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(found).toEqual({ available: false });
});

it("a non-string project id withholds the launch search", async () => {
  // Arrange
  let reads = 0;
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [thread({ projectId: 4, parentThreadId: null })],
        nextCursor: null,
      };
    reads += 1;
    return thread({ projectId: "project-1" });
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(reads).toBe(0);
  expect(found).toEqual({ available: false });
});

it("another titled thread that omits its parent does not withhold a proved worker", async () => {
  // Arrange
  const call = async (name: string) => {
    if (name === "t3_thread_list")
      return {
        projectId: "project-1",
        threads: [
          thread({ threadId: "thread-other", title: "Other" }),
          thread({ parentThreadId: null }),
        ],
        nextCursor: null,
      };
    return thread({});
  };

  // Act
  const found = await discoverLaunches(call, "project-1", title);

  // Assert
  expect(found).toMatchObject({
    available: true,
    candidates: [{ threadId: "thread-1", parentThreadId: null }],
  });
});
