import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { workerMessage, workerStart } from "./support/run-worker.ts";
import { resultReported, workerAtWork } from "./support/scenarios.ts";

it("each Start of the same Flow revision shows the Agent revision, with its exits, current when it started", async (c) => {
  // Arrange
  const { f, input, agent } = await prepared(c);
  const first = await f.startRun(input);
  assert(first.ok);
  const blocked = { id: "blocked", name: "Blocked", description: "", messageRequired: true };
  const edited = await f.updateAgent(agent.id, {
    ...agent,
    prompt: "Follow repository instructions and update the changelog.",
    exits: [...agent.exits, blocked],
    expectedRevision: agent.revision,
  });
  assert(edited.ok);

  // Act
  const second = await f.startRun({ ...input, requestId: "start-two" });

  // Assert
  assert(second.ok);
  const before = await f.getRun(first.value.id);
  assert(before.ok);
  expect(before.value.definitions.agents).toMatchObject([
    { id: agent.id, revision: 1, prompt: "Follow repository instructions.", exits: agent.exits },
  ]);
  expect(second.value.definitions.agents).toMatchObject([
    {
      id: agent.id,
      revision: 2,
      prompt: "Follow repository instructions and update the changelog.",
      exits: [...agent.exits, blocked],
    },
  ]);
  expect(second.value.definitions.flow).toStrictEqual(before.value.definitions.flow);
});

it("a block first activated after its Agent was edited and removed and the backend restarted runs the captured Agent revision", async (c) => {
  // Arrange
  const setup = await workerStart(c);
  const atWork = await workerAtWork(setup.world, setup.input);
  const f = { ...setup, ...(await resultReported(setup.world, atWork)) };
  const edited = await f.f.updateAgent(f.agent.id, {
    ...f.agent,
    prompt: "Rewrite everything.",
    execution: { ...f.agent.execution, modelOptions: [{ id: "reasoning", value: "low" }] },
    expectedRevision: f.agent.revision,
  });
  assert(edited.ok);
  assert((await f.f.removeFlow(f.flow.id)).ok);
  assert((await f.f.removeAgent(f.agent.id)).ok);
  await f.f.close();

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
  const launches = [...f.t3.launches.values()].map((launch) => launch.payload);
  expect(launches[0]!.message).toMatch(workerMessage("Follow repository instructions."));
  expect(launches[1]!.message).toMatch(workerMessage("Follow repository instructions."));
  expect(launches[1]!.modelSelection).toEqual({
    instanceId: "codex-main",
    model: "gpt-6.1-sol",
    options: { reasoning: "high" },
  });
  expect(run.value.definitions.agents).toMatchObject([
    { id: f.agent.id, revision: 1, prompt: "Follow repository instructions." },
  ]);
});
