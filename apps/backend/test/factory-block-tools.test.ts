import { assert, expect, it } from "@effect/vitest";
import { uncertainLaunch } from "./support/lost-launch.ts";
import { directWorker, workerFinal } from "./support/run-worker.ts";
import type { ControlledT3 } from "./support/controlled-t3.ts";

const BLOCK_TOOL = "mcp__factory-runtime__factory_get_block";
const RUN_TOOL = "mcp__factory-runtime__factory_get_run";

function seedTool(
  t3: ControlledT3,
  projectId: string,
  toolName: string,
  callId: string,
  item: Record<string, unknown> = {},
) {
  t3.runtimeActivity = {
    thread: { threadId: "thread-1", projectId, activeRunId: "execution-1" },
    items: [
      {
        visibility: "local",
        sourceThreadId: "thread-1",
        textTruncated: false,
        nextTextOffset: null,
        itemId: `t:native-item:${callId}`,
        type: "dynamic_tool",
        runId: "execution-1",
        text: JSON.stringify({ toolName }),
        ...item,
      },
    ],
    hasMore: false,
    nextPosition: null,
  };
}

it("factory_get_block returns the bound worker visit without a model-supplied id", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call");

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    state: "working",
    visit: 1,
    reason: "first",
    exits: [{ id: "done", name: "Done", requiresFeedback: false }],
    inputs: {
      input: "Improve search\nKeep it accessible.",
      results: [],
      feedback: null,
    },
    allowedTransitions: ["waiting", "finished"],
  });
  expect(result).not.toHaveProperty("retryAfterMs");
});

it("factory_get_run returns the caller Run and each Block without routing authority", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, RUN_TOOL, "run-call");

  // Act
  const result = await fixture.f.runtime.run({
    arguments: {},
    metadata: { callId: "run-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toMatchObject({
    code: "RUN",
    number: 1,
    title: "Improve search",
    input: "Improve search\nKeep it accessible.",
    state: "running",
    blocks: [{ blockId: "worker", name: "Entry worker", state: "working", result: null }],
  });
});

it("an unanswered worker launch stays BINDING_PENDING until Factory binds that thread", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c, false);
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call");

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toStrictEqual({ code: "BINDING_PENDING", retryAfterMs: 500 });
});

it("a worker title does not authorize factory_get_block before the native call is seen", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c, false);
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "other-call");

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toStrictEqual({ code: "UNBOUND_CALLER" });
});

it("a subagent calling factory_get_block stays a foreign caller during launch recovery", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c, false);
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call", {
    subagentId: "sub-1",
  });

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toStrictEqual({ code: "FOREIGN_CALLER" });
});

it("an accepted Block update names the resulting state and what Factory does next", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit(workerFinal());

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "working",
    allowedTransitions: [],
    next: "Factory keeps this final and releases downstream work after this execution settles.",
  });
});

it("a waiting Block update tells the worker to wait for a user reply", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { to: "waiting", message: "Which audience?" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "ACCEPTED",
    state: "waiting",
    allowedTransitions: [],
    next: "Factory waits for a user reply in this thread, then resumes this Block.",
  });
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(run.value.blocks.find((block) => block.blockId === "worker")?.state).toBe("waiting");
});

it("an unknown exit names the exits captured for that Block", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { to: "finished", exit: "nope", message: "Tried another exit." },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result).toMatchObject({ code: "INVALID_EXIT", allowedExits: ["Done"] });
});

it("a changed waiting report conflicts and returns the current Block state", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  expect(
    (
      await fixture.f.runtime.submit({
        arguments: { to: "waiting", message: "Which audience?" },
        metadata: { callId: "worker-report" },
      })
    ).code,
  ).toBe("ACCEPTED");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { to: "waiting", message: "Which tone?" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "KEY_CONFLICT",
    state: "waiting",
    allowedTransitions: [],
    allowedExits: ["Done"],
  });
});

it("a finished report without a message is accepted when that exit does not require feedback", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { to: "finished", exit: "Done" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result.code).toBe("ACCEPTED");
});

it("a finished report without a message is refused when that exit requires feedback", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "", true);

  // Act
  const result = await fixture.f.runtime.submit({
    arguments: { to: "finished", exit: "Done" },
    metadata: { callId: "worker-report" },
  });

  // Assert
  expect(result).toMatchObject({ code: "FEEDBACK_REQUIRED" });
});
