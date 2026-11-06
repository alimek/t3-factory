import { assert, expect, it } from "@effect/vitest";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { restoreLaunches } from "./support/lifecycle-setup.ts";
import { dirname, join } from "node:path";
import { prepared } from "./support/prepared-runner.ts";

it("Start atomically deduplicates concurrent requests for the same Run", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);

  // Act
  const [one, two] = await Promise.all([f.startRun(input), f.startRun(input)]);

  // Assert
  assert(one.ok && two.ok);
  expect(one.value.id).toBe(two.value.id);
});

it("editing an Agent preserves the dispatched Run snapshot", async (c) => {
  // Arrange
  const { f, t3, input, agent } = await prepared(c);
  const started = await f.startRun(input);
  assert(started.ok);
  await f.reconcileRuns();

  // Act
  await f.updateAgent(agent.id, {
    ...agent,
    name: "Changed",
    prompt: "Changed prompt",
    expectedRevision: agent.revision,
  });

  // Assert
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.snapshot.agents[0]?.prompt).toBe("Follow repository instructions.");
  expect(t3.launches.size).toBe(1);
});

it("a lost Run conversation launch acknowledgement recovers the same thread and execution after restart", async (c) => {
  // Arrange
  const { h, f, t3, input } = await prepared(c);
  t3.loseLaunchReply = true;
  const accepted = await f.startRun(input);
  assert(accepted.ok);
  await f.reconcileRuns();
  const original = [...t3.launches.values()][0]!.reference;
  await f.close();
  t3.loseLaunchReply = false;

  // Act
  const restored = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  const r = await restored.getRun(accepted.value.id);
  assert(r.ok);
  expect(r.value.runCoordinator?.threadId).toBe(original.threadId);
  expect(r.value.runCoordinator?.executionId).toBe(original.runId);
  expect(t3.launches.size).toBe(1);
});

it("changed grant identity leaves an uncertain Run conversation launch unresolved", async (c) => {
  // Arrange
  const { h, f, t3, input } = await prepared(c);
  t3.loseLaunchReply = true;
  const accepted = await f.startRun(input);
  assert(accepted.ok);
  await f.reconcileRuns();
  await f.close();
  t3.loseLaunchReply = false;
  t3.approve("different-grant");

  // Act
  const changed = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  const r = await changed.getRun(accepted.value.id);
  assert(r.ok);
  expect(r.value.runCoordinator?.state).toBe("uncertain");
  expect(r.value.runCoordinator?.problem).toMatch(/authorization context/);
  expect(t3.launches.size).toBe(1);
});

it("runtime readiness without report support blocks Start", async (c) => {
  // Arrange
  const { f, t3, input } = await prepared(c);
  t3.reportSupported = false;

  // Act
  const blocked = await f.startRun(input);

  // Assert
  assert(!blocked.ok);
  expect(t3.launches.size).toBe(0);
});

it("a fresh process cannot displace a live database owner", async (c) => {
  // Arrange
  const { h, t3, input } = await prepared(c);
  const fixturePath = join(dirname(h.databasePath), "external-engine.json");
  await writeFile(fixturePath, JSON.stringify({ input, projects: t3.projects, launches: [] }));
  // Act
  const child = promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./support/runner-process.ts", import.meta.url)),
      h.databasePath,
      fixturePath,
      "read",
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dirname(h.databasePath) } },
  );

  // Assert
  await expect(child).rejects.toMatchObject({
    code: 73,
    stdout: expect.stringMatching(/OWNER_REJECTED/),
  });
});

it("SIGKILL of the live owner allows recovery of an uncertain Run conversation launch reservation", async (c) => {
  // Arrange
  const { h, f, t3, input } = await prepared(c);
  const fixturePath = join(dirname(h.databasePath), "external-engine.json");
  await writeFile(fixturePath, JSON.stringify({ input, projects: t3.projects, launches: [] }));
  function spawnChild(mode: string) {
    return spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./support/runner-process.ts", import.meta.url)),
        h.databasePath,
        fixturePath,
        mode,
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dirname(h.databasePath) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }
  await f.close();
  const holder = spawnChild("hold");
  await once(holder.stdout, "data");
  holder.kill("SIGKILL");
  await once(holder, "exit");
  const crash = spawnChild("crash");
  expect((await once(crash, "exit"))[0]).toBe(86);
  const external = JSON.parse(await readFile(fixturePath, "utf8"));
  restoreLaunches(t3, external.launches);

  // Act
  const recovered = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  const list = await recovered.listRuns(input.projectId);
  assert(list.ok && list.value[0]);
  const r = await recovered.getRun(list.value[0].id);
  assert(r.ok);
  expect(r.value.runCoordinator?.state).toBe("acknowledged");
});

it("runtime readiness rejects a saved model option outside the permitted domain", async (c) => {
  // Arrange
  const { f, t3, project, agent } = await prepared(c);
  t3.controlledProviders[0] = {
    ...t3.controlledProviders[0]!,
    models: [
      {
        ...t3.controlledProviders[0]!.models[0]!,
        options: [
          {
            id: "reasoning",
            label: "Reasoning",
            type: "select",
            values: [false, "auto"],
            default: "auto",
          },
        ],
      },
    ],
  };
  await f.updateAgent(agent.id, {
    ...agent,
    expectedRevision: agent.revision,
    execution: { ...agent.execution, modelOptions: [{ id: "reasoning", value: true }] },
  });

  // Act
  const rejected = await f.recheckRuntime({ projectId: project.id, agentId: agent.id });

  // Assert
  assert(rejected.ok && !rejected.value.ready);
  assert(rejected.value.issues.some((issue) => issue.code === "settings_unavailable"));
});
it("an unproven retry scope leaves a recovered Run conversation launch unresolved", async (c) => {
  // Arrange
  const { h, f, t3, input } = await prepared(c);
  t3.loseLaunchReply = true;
  const accepted = await f.startRun(input);
  assert(accepted.ok);
  await f.reconcileRuns();
  await f.close();
  t3.loseLaunchReply = false;
  t3.retryScope = null;

  // Act
  const changed = await h.open({ t3, connectionRetryMs: 60_000 });

  // Assert
  const r = await changed.getRun(accepted.value.id);
  assert(r.ok);
  expect(r.value.runCoordinator?.state).toBe("uncertain");
  expect(r.value.runCoordinator?.problem).toMatch(/unproven/);
  expect(t3.launches.size).toBe(1);
});

it("reusing a Start request key with different input is rejected", async (c) => {
  // Arrange
  const { f, input } = await prepared(c);
  assert((await f.startRun(input)).ok);

  // Act
  const result = await f.startRun({ ...input, input: "conflicting" });

  // Assert
  assert(!result.ok);
});
