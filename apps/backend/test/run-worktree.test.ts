import { assert, expect, it } from "@effect/vitest";
import {
  preparedIdleWorkers,
  preparedWorktreeFlow,
  preparedWorktreeReviewFlow,
} from "./support/prepared-runner.ts";
import {
  answeredReview,
  finishedParallelWork,
  launchedBlockId,
  settleThread,
  workerFinal,
} from "./support/run-worker.ts";

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

it("a creator thread that shows its worktree path before its branch is observed without a scope change", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeFlow(c);
  t3.worktreeBranchPending = true;
  const started = await f.startRun(input);
  assert(started.ok);

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({ freshness: "fresh", problem: null });
  expect(run.value.workspace).toMatchObject({ state: "preparing", path: null });
  expect(t3.launches.size).toBe(1);
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

it("a worker thread that reports a worktree other than the Run's is a scope change", async (c) => {
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
  expect(run.value.blocks[1]).toMatchObject({
    freshness: "stale",
    problem: "Worker thread observation unavailable.",
  });
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
  expect(run.value.workspace).toMatchObject({
    state: "failed",
    path: null,
    problem:
      "T3 rejected the worker that creates the Run worktree. No worker was launched into it.",
  });
});

it("once the worktree is bound, every later Agent Block gets one idle worker on its path and branch, none of them visited", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeReviewFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;

  // Act
  await f.reconcileRuns();

  // Assert
  const [creator] = [...t3.launches.values()].map((launch) => launch.payload);
  const joined = {
    type: "existing_worktree",
    worktreePath: "/t3-worktrees/thread-1",
    branch: (creator!.workspaceStrategy as { branch: string }).branch,
  };
  expect(t3.launches.size).toBe(1);
  expect(
    [...t3.idleLaunches.values()].map(({ payload }) => [payload.title, payload.workspaceStrategy]),
  ).toStrictEqual([
    ["Factory #1 · 3 Parallel work", joined],
    ["Factory #1 · 4 Unused branch", joined],
  ]);
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks.map(({ threadId, state }) => ({ threadId, state }))).toStrictEqual([
    { threadId: "thread-1", state: "working" },
    { threadId: null, state: "not-started" },
    { threadId: null, state: "not-started" },
    { threadId: null, state: "not-started" },
  ]);
  expect(run.value.attention).toStrictEqual([]);
  expect(run.value.workspace).toStrictEqual({
    mode: "worktree",
    baseRef: "origin/main",
    state: "bound",
    path: "/t3-worktrees/thread-1",
    branch: joined.branch,
    problem: null,
    preparedWorkers: [
      expect.objectContaining({ blockId: run.value.blocks[2]!.blockId, threadId: "thread-2" }),
      expect.objectContaining({ blockId: run.value.blocks[3]!.blockId, threadId: "thread-3" }),
    ],
  });
});

it("after a Human step, the first arrival at a prepared Block queues its task on the prepared thread in the Run worktree and launches nothing", async (c) => {
  // Arrange
  const { f, t3, runId } = await answeredReview(c);

  // Act
  await f.reconcileRuns();

  // Assert
  const sends = [...t3.sends.values()].map(({ payload }) => payload);
  expect(t3.launchCalls).toBe(3);
  expect(sends).toStrictEqual([
    expect.objectContaining({
      threadId: "thread-2",
      mode: "queue",
      message: expect.stringMatching(/^\$factory-block\n\nFactory Block id: [0-9a-f-]{36}\./),
    }),
  ]);
  const run = await f.getRun(runId);
  assert(run.ok);
  expect(run.value.workspace).toMatchObject({ path: "/t3-worktrees/thread-1" });
  expect(run.value.blocks.map(({ threadId }) => threadId)).toStrictEqual([
    "thread-1",
    null,
    "thread-2",
    null,
  ]);
  expect(run.value.blocks[2]).toMatchObject({ freshness: "fresh", problem: null });
});

it("a Flow that returns to an earlier Block revisits its thread in the same worktree and launches nothing", async (c) => {
  // Arrange
  const { f, t3, runId } = await finishedParallelWork(c);

  // Act
  await f.reconcileRuns();

  // Assert
  const sends = [...t3.sends.values()].map(({ payload }) => payload.threadId);
  expect(sends).toStrictEqual(["thread-2", "thread-1"]);
  expect(t3.launchCalls).toBe(3);
  const run = await f.getRun(runId);
  assert(run.ok);
  expect(run.value.workspace).toMatchObject({
    state: "bound",
    path: "/t3-worktrees/thread-1",
    branch: expect.stringMatching(/^factory\/run-1-/),
  });
  expect(run.value.blocks[0]).toMatchObject({
    threadId: "thread-1",
    state: "working",
    freshness: "fresh",
  });
});

it("a send that fails while the worker's worktree is missing stays unresolved and is delivered once T3 accepts it", async (c) => {
  // Arrange
  const { f, t3, runId } = await answeredReview(c);
  t3.beforeSend = () => Promise.reject(Error("Worktree directory does not exist"));
  await f.reconcileRuns();
  delete t3.beforeSend;

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(runId);
  assert(run.ok);
  expect([...t3.sends.values()].map(({ payload }) => payload.threadId)).toStrictEqual(["thread-2"]);
  expect(run.value.blocks[2]).toMatchObject({ threadId: "thread-2", state: "working" });
});

it("a lost idle-worker reply is recovered by search without creating another thread", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeReviewFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;
  t3.loseLaunchReply = true;
  t3.discoverAvailable = false;
  await f.reconcileRuns();
  t3.loseLaunchReply = false;
  t3.discoverAvailable = true;

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(t3.launchCalls).toBe(3);
  expect(
    run.value.intents
      .filter(({ kind }) => kind === "prepare")
      .map(({ state, reference }) => [state, reference?.threadId]),
  ).toStrictEqual([
    ["acknowledged", "thread-2"],
    ["acknowledged", "thread-3"],
  ]);
});

it("restart during idle-worker preparation resumes it without a duplicate thread", async (c) => {
  // Arrange
  const { h, f, t3, input } = await preparedWorktreeReviewFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;
  t3.loseLaunchReply = true;
  t3.discoverAvailable = false;
  await f.reconcileRuns();
  await f.close();
  t3.loseLaunchReply = false;
  t3.discoverAvailable = true;

  // Act
  const reopened = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  const run = await reopened.getRun(started.value.id);
  assert(run.ok);
  expect(t3.launchCalls).toBe(3);
  expect(
    run.value.intents.filter(({ kind }) => kind === "prepare").map(({ state }) => state),
  ).toStrictEqual(["acknowledged", "acknowledged"]);
});

it("a worktree Run whose unvisited Blocks kept their idle workers settles once its visited Block finishes", async (c) => {
  // Arrange
  const { f, t3, runId, entryBlockId } = await preparedIdleWorkers(c);
  assert(
    (await f.runtime.submit(workerFinal(entryBlockId, "Shipped.", "ship"))).code === "ACCEPTED",
  );
  t3.engineStatus = "completed";
  settleThread(t3, "execution-1", "completed", "settled", "thread-1");

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(runId);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
});

it("a worktree setup script that became blocking after Start holds idle-worker creation", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeReviewFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;
  t3.worktreeSetupScripts = [{ name: "Install", blocking: true }];

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(t3.idleLaunches.size).toBe(0);
  expect(run.value.blocks.map(({ recovery }) => recovery)).toStrictEqual([
    null,
    null,
    "pending",
    "pending",
  ]);
  expect(
    run.value.intents
      .filter(({ kind }) => kind === "prepare")
      .map(({ state, problem }) => [state, problem]),
  ).toStrictEqual([
    [
      "pending",
      'The Project runs "Install" as a blocking worktree setup script, which idle workers do not support. Make it asynchronous in T3; Factory will retry creating this idle worker.',
    ],
    [
      "pending",
      'The Project runs "Install" as a blocking worktree setup script, which idle workers do not support. Make it asynchronous in T3; Factory will retry creating this idle worker.',
    ],
  ]);
});

it("idle-worker preparations held by a blocking setup script do not keep a finished worktree Run from settling", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorktreeReviewFlow(c);
  t3.worktreeMetadataPending = true;
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();
  t3.worktreeMetadataPending = false;
  t3.worktreeSetupScripts = [{ name: "Install", blocking: true }];
  await f.reconcileRuns();
  const entryBlockId = launchedBlockId(t3);
  assert(
    (await f.runtime.submit(workerFinal(entryBlockId, "Shipped.", "ship"))).code === "ACCEPTED",
  );
  t3.engineStatus = "completed";
  settleThread(t3, "execution-1", "completed", "settled", "thread-1");

  // Act
  await f.reconcileRuns();

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.lifecycle).toBe("settled");
  expect(t3.idleLaunches.size).toBe(0);
  expect(
    run.value.intents.filter(({ kind }) => kind === "prepare").map(({ state }) => state),
  ).toStrictEqual(["cancelled", "cancelled"]);
});
