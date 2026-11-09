import { assert, expect, it } from "@effect/vitest";
import { reviewedFlow, reviewerExits } from "./support/domain-setup.ts";
import { prepared } from "./support/prepared-runner.ts";

const escalate = {
  id: "escalate",
  name: "escalate",
  description: "Needs a maintainer.",
  messageRequired: true,
};

it("an Agent block offers its Agent's exits, so a wire from an inherited exit needs no Flow exit configuration", async (c) => {
  // Arrange
  const { save, review } = await reviewedFlow(c);

  // Act
  const saved = await save(review);

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness).toStrictEqual({ ready: true, issues: [] });
});

it("a local exit named like a hidden Agent exit is a readiness issue while the Flow still saves", async (c) => {
  // Arrange
  const { save, review } = await reviewedFlow(c);

  // Act
  const saved = await save({
    ...review,
    hiddenExitIds: ["pass"],
    localExits: [{ ...escalate, name: "pass" }],
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.revision).toBe(2);
  expect(saved.value.readiness).toStrictEqual({
    ready: false,
    issues: [
      {
        code: "exit_name_conflict",
        path: "graph.blocks.1.localExits.0.name",
        message:
          'Code review: local exit "pass" has the same name as an exit from its Agent. Rename or remove the local exit.',
      },
    ],
  });
});

it("a local exit whose name or ID is another Agent exit's ID or name is a readiness issue, since workers finish by either", async (c) => {
  // Arrange
  const { save, review, editReviewer } = await reviewedFlow(c);
  const [pass, fail] = reviewerExits;
  assert((await editReviewer([{ ...pass!, id: "agent-pass" }, fail!])).ok);

  // Act
  const saved = await save({
    ...review,
    localExits: [
      { ...escalate, id: "local-1", name: "agent-pass" },
      { ...escalate, id: "pass", name: "escalate" },
    ],
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["exit_name_conflict", "graph.blocks.1.localExits.0.name"],
    ["exit_name_conflict", "graph.blocks.1.localExits.1.name"],
  ]);
});

it("an Agent exit added later with a local exit's name makes every Flow using that Agent not ready", async (c) => {
  // Arrange
  const { factory, flowId, save, review, editReviewer } = await reviewedFlow(c);
  const saved = await save({ ...review, localExits: [escalate] });
  assert(saved.ok && saved.value.readiness.ready);

  // Act
  const edited = await editReviewer([...reviewerExits, { ...escalate, id: "agent-escalate" }]);

  // Assert
  assert(edited.ok);
  const flow = await factory.getFlow(flowId);
  assert(flow.ok);
  expect(flow.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["exit_name_conflict", "graph.blocks.1.localExits.0.name"],
  ]);
});

it("a wire from an exit the Agent removed is a readiness issue naming the Block and the exit", async (c) => {
  // Arrange
  const { factory, flowId, save, review, editReviewer } = await reviewedFlow(c);
  assert((await save(review)).ok);

  // Act
  const edited = await editReviewer([reviewerExits[0]!]);

  // Assert
  assert(edited.ok);
  const flow = await factory.getFlow(flowId);
  assert(flow.ok);
  expect(flow.value.readiness).toStrictEqual({
    ready: false,
    issues: [
      {
        code: "exit_missing",
        path: "graph.connections.1",
        message:
          'Code review: its Agent no longer has exit "fail". Remove its connection to Coder.',
      },
    ],
  });
});

it("a hidden exit that the Agent later removes is ignored", async (c) => {
  // Arrange
  const { factory, flowId, save, review, editReviewer } = await reviewedFlow(c);
  assert((await save({ ...review, hiddenExitIds: ["pass"] })).ok);

  // Act
  const edited = await editReviewer([reviewerExits[1]!]);

  // Assert
  assert(edited.ok);
  const flow = await factory.getFlow(flowId);
  assert(flow.ok);
  expect(flow.value.readiness).toStrictEqual({ ready: true, issues: [] });
  expect(flow.value.graph.blocks[1]).toMatchObject({ hiddenExitIds: ["pass"] });
});

it("a wire from an exit hidden in this Flow is a readiness issue while the Flow still saves", async (c) => {
  // Arrange
  const { save, review } = await reviewedFlow(c);

  // Act
  const saved = await save({ ...review, hiddenExitIds: ["fail"] });

  // Assert
  assert(saved.ok);
  expect(saved.value.readiness.issues).toStrictEqual([
    {
      code: "exit_hidden",
      path: "graph.connections.1",
      message:
        'Code review: exit "fail" is hidden in this Flow. Show the exit or remove its connection to Coder.',
    },
  ]);
});

it("Start is refused while a local exit shares a name with an Agent exit, and no Run is created", async (c) => {
  // Arrange
  const { f, flow, input, project } = await prepared(c);
  const [worker] = flow.graph.blocks;
  assert(worker?.kind === "agent");
  const conflicting = await f.updateFlow(flow.id, {
    ...flow,
    expectedRevision: flow.revision,
    graph: { ...flow.graph, blocks: [{ ...worker, localExits: [{ ...escalate, name: "Done" }] }] },
  });
  assert(conflicting.ok);

  // Act
  const started = await f.startRun(input);

  // Assert
  assert(!started.ok);
  expect(started.error.code).toBe("validation");
  expect(started.error.issues.map((issue) => issue.code)).toStrictEqual(["exit_name_conflict"]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
});
