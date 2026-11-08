import { assert, expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { preparedServer } from "./support/prepared-runner.ts";
import {
  archivedWorker,
  directWorker,
  launchedBlockId,
  nextThreadInterrupt,
  pendingReview,
  reportedWorker,
  workerFinal,
  workerWorking,
} from "./support/run-worker.ts";

it("archiving closes the gate, cancels the unsent handoff and archives the Run at once", async (c) => {
  // Arrange
  const f = await reportedWorker(c);

  // Act
  const result = await f.f.archiveRun(f.runId);

  // Assert
  assert(result.ok);
  expect(result.value).toMatchObject({ lifecycle: "archived", gateOpen: false });
  expect(result.value.intents).toContainEqual(
    expect.objectContaining({ blockId: "parallel-block", kind: "handoff", state: "cancelled" }),
  );
  expect(result.value.events.at(-1)?.kind).toBe("run-archived");
});

it("archiving a working Run requests interruption of its worker thread without waiting for it to stop", async (c) => {
  // Arrange
  const f = await directWorker(c);
  const interrupt = nextThreadInterrupt(f.t3);

  // Act
  const result = await f.f.archiveRun(f.runId);

  // Assert
  assert(result.ok);
  expect(result.value.lifecycle).toBe("archived");
  expect(result.value.blocks[0]?.state).toBe("stopped");
  await interrupt;
  expect(f.t3.threadStops.map((stop) => stop.threadId)).toStrictEqual(["thread-1"]);
});

it("archiving cancels a pending Human occurrence and settles its attention", async (c) => {
  // Arrange
  const f = await pendingReview(c);

  // Act
  const result = await f.f.archiveRun(f.runId);

  // Assert
  assert(result.ok);
  expect(result.value.humanOccurrences[0]).toMatchObject({ state: "cancelled", context: null });
  expect(result.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
});

it("an archived Run is left out of navigation and keeps its history", async (c) => {
  // Arrange
  const f = await archivedWorker(c);

  // Act
  const navigation = await f.f.listRunNavigation();

  // Assert
  assert(navigation.ok);
  expect(navigation.value).toStrictEqual([]);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("archived");
  expect(run.value.reports).toHaveLength(1);
  expect(run.value.events.map((event) => event.kind)).toContain("report-accepted");
});

it("Factory launches nothing for an archived Run on later reconciliation", async (c) => {
  // Arrange
  const f = await archivedWorker(c);

  // Act
  await f.f.reconcileRuns();

  // Assert
  expect(f.t3.launches.size).toBe(1);
  const run = await f.f.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker"]);
});

it("a finished report for an archived Run succeeds without changing the Run", async (c) => {
  // Arrange
  const f = await archivedWorker(c);
  const before = await f.f.getRun(f.runId);

  // Act
  const result = await f.f.runtime.submit(workerFinal(f.blockId, "A later result."));

  // Assert
  expect(result).toMatchObject({ code: "RUN_ARCHIVED", next: expect.stringContaining("archived") });
  expect(await f.f.getRun(f.runId)).toStrictEqual(before);
});

it("a working report for an archived Run succeeds without changing the Run", async (c) => {
  // Arrange
  const f = await archivedWorker(c);
  const before = await f.f.getRun(f.runId);

  // Act
  const result = await f.f.runtime.submit(workerWorking(f.blockId));

  // Assert
  expect(result.code).toBe("RUN_ARCHIVED");
  expect(await f.f.getRun(f.runId)).toStrictEqual(before);
});

it("Factory MCP answers a report for an archived Run as a success that tells the worker to stop", async (c) => {
  // Arrange
  const { f, t3, mcp, input } = await preparedServer(c);
  const started = await f.startRun(input);
  assert(started.ok);
  assert((await f.reconcileRuns()).ok);
  assert((await f.archiveRun(started.value.id)).ok);
  const client = new Client({ name: "worker", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(mcp));
  c.onTestFinished(() => client.close());

  // Act
  const result = await client.callTool({
    name: "factory_update_block",
    arguments: { blockId: launchedBlockId(t3), to: "finished", exit: "done", message: "Done." },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(result.content).toMatchObject([
    {
      type: "text",
      text: expect.stringMatching(/RUN_ARCHIVED.*This Run is archived.*Stop work on this Block/),
    },
  ]);
});
