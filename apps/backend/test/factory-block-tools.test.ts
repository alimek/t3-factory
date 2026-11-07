import { assert, expect, it } from "@effect/vitest";
import { uncertainLaunch } from "./support/lost-launch.ts";
import {
  directWorker,
  reportedWorker,
  revisitReportingWorker,
  workerFinal,
  workerNativeReply,
} from "./support/run-worker.ts";
import type { ControlledT3 } from "./support/controlled-t3.ts";
import { bindThreadReportCaller } from "./support/lifecycle-setup.ts";

const BLOCK_TOOL = "mcp__factory-runtime__factory_get_block";
const RUN_TOOL = "mcp__factory-runtime__factory_get_run";

function seedTool(
  t3: ControlledT3,
  projectId: string,
  toolName: string,
  callId: string,
  item: Record<string, unknown> = {},
  worker = { threadId: "thread-1", executionId: "execution-1" },
) {
  bindThreadReportCaller(t3, projectId, worker.threadId, worker.executionId, callId);
  t3.runtimeActivity = {
    thread: { threadId: worker.threadId, projectId, activeRunId: worker.executionId },
    items: [
      {
        visibility: "local",
        sourceThreadId: worker.threadId,
        textTruncated: false,
        nextTextOffset: null,
        itemId: `t:native-item:${callId}`,
        type: "dynamic_tool",
        runId: worker.executionId,
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

it("a worker can retrieve its assigned inputs with a native call id and no inherited thread hint", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call");

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    inputs: { input: "Improve search\nKeep it accessible." },
  });
});

it("factory_get_block binds a Cursor call from the in-flight timeline item", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(
    fixture.t3,
    fixture.project.projectId,
    "mcp__factory-runtime__factory_get_block",
    "call-cursor",
    {
      status: "running",
      itemId: "turn-item:provider:cursor:native-item:call-cursor",
      text: JSON.stringify({
        toolName: "mcp__factory-runtime__factory_get_block",
        input: { ref: "ref-cursor" },
      }),
    },
  );

  // Act
  const result = await fixture.f.runtime.block({ arguments: { ref: "ref-cursor" } });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", state: "working", visit: 1 });
});

it("native call lookup without a thread hint still rejects a subagent caller", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call", {
    subagentId: "subagent-1",
  });

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
  });

  // Assert
  expect(result).toStrictEqual({ code: "FOREIGN_CALLER" });
});

it("a user reply can read its Block before the next periodic worker observation", async (c) => {
  // Arrange
  const fixture = await workerNativeReply(c);
  const reply = fixture.t3.runtimeActivity.items.at(-1)!;
  seedTool(
    fixture.t3,
    fixture.project.projectId,
    BLOCK_TOOL,
    "block-call",
    {},
    {
      threadId: "thread-1",
      executionId: "answer-execution",
    },
  );
  fixture.t3.runtimeActivity = {
    ...fixture.t3.runtimeActivity,
    items: [...fixture.t3.runtimeActivity.items, reply],
  };

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
  });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", state: "working", visit: 1 });
});

it("a downstream worker retrieves its incoming result and the Block that produced it", async (c) => {
  // Arrange
  const fixture = await reportedWorker(c);
  assert((await fixture.f.reconcileRuns()).ok);
  seedTool(
    fixture.t3,
    fixture.project.projectId,
    BLOCK_TOOL,
    "block-call",
    {},
    {
      threadId: "thread-2",
      executionId: "execution-2",
    },
  );

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
  });

  // Assert
  expect(result).toMatchObject({
    code: "BLOCK",
    inputs: {
      input: fixture.input.input,
      results: [
        {
          blockId: "worker",
          blockName: "Entry worker",
          exitName: "Done",
          message: workerFinal().arguments.message,
          threadLink: expect.any(String),
        },
      ],
    },
  });
});

it("a revisit reads only the result that activated it rather than its own newer result", async (c) => {
  // Arrange
  const fixture = await revisitReportingWorker(c);
  assert((await fixture.f.runtime.submit(workerFinal())).code === "ACCEPTED");
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  seedTool(
    fixture.t3,
    fixture.project.projectId,
    BLOCK_TOOL,
    "block-call",
    {},
    {
      threadId: "thread-1",
      executionId: fixture.workerExecutionId,
    },
  );

  // Act
  const result = await fixture.f.runtime.block({
    arguments: {},
    metadata: { callId: "block-call" },
  });

  // Assert
  expect(result.code).toBe("BLOCK");
  expect(result.inputs?.results).toMatchObject([{ reportId: run.value.reports[0]?.id }]);
  expect(result.inputs?.results).toHaveLength(1);
});

it("factory_get_block binds a Grok call from tool_input on the in-flight item", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(
    fixture.t3,
    fixture.project.projectId,
    "factory-runtime__factory_get_block",
    "call-grok",
    {
      status: "pending",
      itemId: "turn-item:provider:grok:native-item:call-grok",
      text: JSON.stringify({
        toolName: "factory-runtime__factory_get_block",
        input: { tool_name: "factory-runtime__factory_get_block", tool_input: { ref: "ref-grok" } },
      }),
    },
  );

  // Act
  const result = await fixture.f.runtime.block({ arguments: { ref: "ref-grok" } });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", state: "working", visit: 1 });
});

it("factory_get_block accepts a call that omits arguments", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, BLOCK_TOOL, "block-call");

  // Act
  const result = await fixture.f.runtime.block({
    metadata: { callId: "block-call" },
    inheritedThreadId: "thread-1",
  });

  // Assert
  expect(result).toMatchObject({ code: "BLOCK", state: "working" });
});

it("factory_get_run returns the caller Run and each Block without routing authority", async (c) => {
  // Arrange
  const fixture = await directWorker(c, true, "");
  seedTool(fixture.t3, fixture.project.projectId, RUN_TOOL, "run-call");

  // Act
  const result = await fixture.f.runtime.run({
    arguments: {},
    metadata: { callId: "run-call" },
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
