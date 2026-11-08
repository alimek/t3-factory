import { assert, expect, it } from "@effect/vitest";
import { preparedWorktreeFlow } from "./support/prepared-runner.ts";

it("a worktree Start launches exactly one worktree-creating worker from the resolved base ref", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeFlow(c);
  t3.worktreeMetadataPending = true;
  assert((await f.startRun(input)).ok);

  // Act
  await f.reconcileRuns();

  // Assert
  const launches = [...t3.launches.values()].map((launch) => launch.payload);
  expect(launches.map((launch) => launch.title)).toStrictEqual(["Factory #1 · 1 Entry worker"]);
  expect(launches[0]!.workspaceStrategy).toStrictEqual({
    type: "worktree",
    baseRef: "origin/main",
    branch: expect.stringMatching(/^factory\/run-1-[0-9a-f]{8}$/),
  });
});

it("once T3 shows the worktree path and branch, the other Flow-input worker launches once on that worktree", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeFlow(c);
  t3.worktreeMetadataPending = true;
  assert((await f.startRun(input)).ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;

  // Act
  await f.reconcileRuns();

  // Assert
  const [creator, second] = [...t3.launches.values()].map((launch) => launch.payload);
  expect(t3.launches.size).toBe(2);
  expect(second!.title).toBe("Factory #1 · 2 Second entry");
  expect(second!.workspaceStrategy).toStrictEqual({
    type: "existing_worktree",
    worktreePath: "/t3-worktrees/thread-1",
    branch: (creator!.workspaceStrategy as { branch: string }).branch,
  });
});

it("a lost creator reply is recovered by search without a second worktree, and the other worker waits for it", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeFlow(c);
  t3.loseLaunchReply = true;
  t3.discoverAvailable = false;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.loseLaunchReply = false;
  t3.discoverAvailable = true;
  const waiting = t3.launches.size;

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  const strategies = [...t3.launches.values()].map((launch) => launch.payload.workspaceStrategy);
  expect(waiting).toBe(1);
  expect(t3.launchCalls).toBe(2);
  expect(strategies.map((strategy) => strategy.type)).toStrictEqual([
    "worktree",
    "existing_worktree",
  ]);
  expect(run.value.blocks[0]).toMatchObject({ threadId: "thread-1", recovery: null });
});

it("restart before the worktree is bound binds it and launches the other worker once", async (c) => {
  // Arrange
  const { h, f, t3, input } = await preparedWorktreeFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  await f.close();
  t3.worktreeMetadataPending = false;

  // Act
  const reopened = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  expect(t3.launchCalls).toBe(2);
  const strategies = [...t3.launches.values()].map((launch) => launch.payload.workspaceStrategy);
  expect(strategies).toMatchObject([
    { type: "worktree" },
    { type: "existing_worktree", worktreePath: "/t3-worktrees/thread-1" },
  ]);
  const run = await reopened.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks.map((block) => block.threadId)).toStrictEqual(["thread-1", "thread-2"]);
});

it("restart with a joining launch unresolved recovers it by search without another launch", async (c) => {
  // Arrange
  const { h, f, t3, input } = await preparedWorktreeFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;
  t3.loseLaunchReply = true;
  t3.discoverAvailable = false;
  await f.reconcileRuns();
  assert(t3.launches.size === 2);
  await f.close();
  t3.loseLaunchReply = false;
  t3.discoverAvailable = true;

  // Act
  const reopened = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  expect(t3.launchCalls).toBe(2);
  const run = await reopened.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks[1]).toMatchObject({ threadId: "thread-2", recovery: null });
});

it("a worker thread that reports a different worktree is a scope change, while the bound worktree is observed", async (c) => {
  // Arrange
  const { f, t3, input, project } = await preparedWorktreeFlow(c);
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  const moved = await t3.readExecution(project, "thread-2");
  t3.executionObservations.set("thread-2", { ...moved, workspaceRoot: "/t3-worktrees/other" });

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks.map(({ freshness, problem }) => ({ freshness, problem }))).toStrictEqual([
    { freshness: "fresh", problem: null },
    { freshness: "stale", problem: "Worker thread observation unavailable." },
  ]);
});

it("a rejected worktree-creating launch is a Block error and launches no other worker into the project root", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeFlow(c);
  t3.rejectLaunch = true;
  const started = await f.startRun(input);
  assert(started.ok);

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(t3.launchCalls).toBe(1);
  expect(run.value.blocks.map(({ state, problem }) => ({ state, problem }))).toStrictEqual([
    { state: "error", problem: "T3 rejected the worker launch." },
    {
      state: "error",
      problem:
        "T3 rejected the worker that creates the Run worktree. This worker was not launched.",
    },
  ]);
});
