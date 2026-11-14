import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";
import { promptAnswered, promptOn, promptSent, responseForwarded } from "./support/continuation.ts";
import {
  REVISIT_INSTRUCTION,
  agentBlock,
  allTurnsEnd,
  chainedContinuationFlow,
  connection,
  continuationFlow,
  continuationLoopFlow,
  continuationStep,
  flowInput,
  humanContinuationFlow,
  instructedContinuationFlow,
  observeFor,
  queuedContinuationFlow,
  report,
  resultReleasedToHumanReview,
  resultReported,
  sentTurnBegins,
  workerAtWork,
  workerHandle,
} from "./support/scenarios.ts";
import { recordLaunchedThread } from "./support/controlled-thread.ts";

const blockState = (run: { blocks: readonly { blockId: string; state: string }[] }, id: string) =>
  run.blocks.find((block) => block.blockId === id)?.state;

it("a Continuation without a prompt is a readiness issue", async (c) => {
  // Arrange
  const f = await prepared(c);
  const draft = await f.f.createFlow({ name: "Unwritten prompt" });
  assert(draft.ok);

  // Act
  const saved = await f.f.updateFlow(draft.value.id, {
    name: draft.value.name,
    expectedRevision: draft.value.revision,
    graph: {
      flowInput: flowInput("worker"),
      blocks: [agentBlock("worker", "Worker", f.agent.id), continuationStep("spec", "Spec", "  ")],
      connections: [connection("worker", "done", "spec")],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.graph.blocks[1]).toMatchObject({ kind: "continuation", prompt: "" });
  expect(saved.value.readiness.issues.map((issue) => [issue.code, issue.path])).toStrictEqual([
    ["continuation_prompt_required", "graph.blocks.1.prompt"],
  ]);
});

it("a Continuation cannot receive the Flow input", async (c) => {
  // Arrange
  const f = await prepared(c);
  const draft = await f.f.createFlow({ name: "Continuation first" });
  assert(draft.ok);

  // Act
  const saved = await f.f.updateFlow(draft.value.id, {
    name: draft.value.name,
    expectedRevision: draft.value.revision,
    graph: {
      flowInput: flowInput("spec"),
      blocks: [continuationStep("spec", "Spec", "Write the spec.")],
      connections: [],
    },
  });

  // Assert
  assert(!saved.ok);
  expect(saved.error.issues?.map((issue) => issue.path)).toStrictEqual([
    "graph.flowInput.targetBlockIds.0",
  ]);
});

it("the first message reaching a Continuation queues its prompt once on the source worker's thread under the Continuation's own Block id", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);

  // Act
  const run = await observeFor(
    "observe the prompt",
    f.world,
    worker.runId,
    (detail) => blockState(detail, "spec") === "sent",
  );

  // Assert
  expect([...f.t3.sends.values()].map((send) => send.payload.threadId)).toStrictEqual([
    worker.threadId,
  ]);
  const prompt = promptOn(f.world, worker);
  expect(prompt.blockId).not.toBe(worker.blockId);
  expect(prompt.message).toContain("Write the spec from what we agreed.");
  expect(f.t3.launches.size).toBe(1);
  expect(run.continuationVisits).toMatchObject([
    { blockId: "spec", kind: "prompt", sourceBlockId: "worker", state: "sent" },
  ]);
});

it("a Continuation's response is forwarded on its output once its thread finishes, and the source worker keeps its own result", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const prompt = await promptSent(f.world, worker);
  await promptAnswered(f.world, worker, prompt);

  // Act
  const run = await observeFor("observe the forwarded response", f.world, worker.runId, (detail) =>
    detail.blocks.some((block) => block.blockId === "follow-up" && block.threadId),
  );

  // Assert
  expect(blockState(run, "spec")).toBe("pass-through");
  expect(run.activations.map((activation) => activation.blockId)).toStrictEqual([
    "worker",
    "spec",
    "follow-up",
  ]);
  expect(run.reports.map((entry) => [entry.blockId, entry.resultMessage])).toStrictEqual([
    ["worker", "Implemented the requested result."],
    ["spec", "Spec written: docs/spec.md."],
  ]);
  expect(f.t3.launches.size).toBe(2);
});

it("a message reaching a Continuation after its response passes through unchanged without another prompt", async (c) => {
  // Arrange
  const f = await prepared(c, continuationLoopFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const prompt = await promptSent(f.world, worker);
  const forwarded = await responseForwarded(f.world, worker, prompt);
  const launched = await observeFor("observe Follow-up", f.world, worker.runId, (detail) =>
    detail.blocks.some((block) => block.blockId === "follow-up" && block.threadId),
  );
  const followUp = workerHandle(f.world, launched, "follow-up");
  await recordLaunchedThread(f.t3, followUp.threadId);
  assert(
    (await report(f.world, followUp, {
      to: "finished",
      exit: "done",
      message: "Reviewed the spec.",
    })) === "ACCEPTED",
  );
  allTurnsEnd(f.world, followUp);

  // Act
  const run = await observeFor("observe the pass-through", f.world, worker.runId, () =>
    [...f.t3.sends.values()].some((send) => send.payload.threadId === followUp.threadId),
  );

  // Assert
  expect(forwarded.continuationVisits.map((visit) => visit.kind)).toStrictEqual(["prompt"]);
  expect(run.continuationVisits.map((visit) => [visit.kind, visit.state])).toStrictEqual([
    ["prompt", "forwarded"],
    ["pass-through", "forwarded"],
  ]);
  expect(
    [...f.t3.sends.values()].filter((send) => send.payload.threadId === worker.threadId),
  ).toHaveLength(1);
  expect(
    [...f.t3.sends.values()].find((send) => send.payload.threadId === followUp.threadId)?.payload
      .message,
  ).toContain("Reviewed the spec.");
});

it("a message arriving while the prompt is pending waits and passes through after the response", async (c) => {
  // Arrange
  const f = await prepared(c, queuedContinuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const prompt = await promptSent(f.world, worker);
  const parallelRun = await observeFor("observe Parallel work", f.world, worker.runId, (detail) =>
    detail.blocks.some((block) => block.blockId === "parallel-block" && block.threadId),
  );
  const parallel = workerHandle(f.world, parallelRun, "parallel-block");
  await recordLaunchedThread(f.t3, parallel.threadId);
  assert(
    (await report(f.world, parallel, {
      to: "finished",
      exit: "done",
      message: "Security notes ready.",
    })) === "ACCEPTED",
  );
  allTurnsEnd(f.world, parallel);
  const queued = await observeFor("observe the wait", f.world, worker.runId, (detail) =>
    detail.continuationVisits.some((visit) => visit.state === "queued"),
  );
  await promptAnswered(f.world, worker, prompt);

  // Act
  const run = await observeFor("observe both messages forwarded", f.world, worker.runId, (detail) =>
    detail.continuationVisits.every((visit) => visit.state === "forwarded"),
  );

  // Assert
  expect(blockState(queued, "follow-up")).toBe("not-started");
  expect(run.continuationVisits.map((visit) => [visit.kind, visit.sourceBlockId])).toStrictEqual([
    ["prompt", "worker"],
    ["pass-through", "parallel-block"],
  ]);
  const toFollowUp = run.intents.filter((intent) => intent.blockId === "follow-up");
  expect(
    toFollowUp.map((intent) => [intent.sourceBlockId, intent.reportId !== null]),
  ).toStrictEqual([
    ["spec", true],
    ["spec", false],
  ]);
  expect(
    [...f.t3.sends.values()].filter((send) => send.payload.threadId === worker.threadId),
  ).toHaveLength(1);
});

it("a chained Continuation sends its prompt to the original worker's thread", async (c) => {
  // Arrange
  const f = await prepared(c, chainedContinuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const spec = await promptSent(f.world, worker);
  await promptAnswered(f.world, worker, spec);

  // Act
  await observeFor(
    "observe the second prompt",
    f.world,
    worker.runId,
    (detail) => blockState(detail, "tickets") === "sent",
  );

  // Assert
  const sends = [...f.t3.sends.values()];
  expect(sends.map((send) => send.payload.threadId)).toStrictEqual([
    worker.threadId,
    worker.threadId,
  ]);
  const tickets = promptOn(f.world, worker);
  expect(tickets.blockId).not.toBe(spec.blockId);
  expect(tickets.message).toContain("Split the spec into tickets.");
});

it("after a Human step the prompt goes to the worker before it, followed by the person's reply", async (c) => {
  // Arrange
  const f = await prepared(c, humanContinuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const review = await resultReleasedToHumanReview(f.world, worker);
  assert(
    (
      await f.f.answerHumanOccurrence(review.occurrence.id, {
        exitId: "approve",
        message: "Ship it without SMS login.",
      })
    ).ok,
  );

  // Act
  await observeFor(
    "observe the prompt",
    f.world,
    worker.runId,
    (detail) => blockState(detail, "spec") === "sent",
  );

  // Assert
  const prompt = promptOn(f.world, worker);
  expect(prompt.message).toContain(
    'Write the spec from what we agreed.\n\nReply from the Human step "Review" (Approve):\nShip it without SMS login.',
  );
});

it("a prompt sent into a worker whose block has a Revisit instruction does not carry the instruction", async (c) => {
  // Arrange
  const f = await prepared(c, instructedContinuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);

  // Act
  await observeFor(
    "observe the prompt",
    f.world,
    worker.runId,
    (detail) => blockState(detail, "spec") === "sent",
  );

  // Assert
  const prompt = promptOn(f.world, worker);
  expect(prompt.message).toContain("Write the spec from what we agreed.");
  expect(prompt.message).not.toContain("Revisit instruction");
  expect(prompt.message).not.toContain(REVISIT_INSTRUCTION);
});

it("restart neither resends a sent prompt nor forgets it", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  await promptSent(f.world, worker);
  await f.f.close();
  const reopened = await f.h.open({ t3: f.t3 });
  c.onTestFinished(() => reopened.close());

  // Act
  const reconciled = await reopened.reconcileRuns();

  // Assert
  assert(reconciled.ok);
  const run = await reopened.getRun(worker.runId);
  assert(run.ok);
  expect(blockState(run.value, "spec")).toBe("sent");
  expect(f.t3.sends.size).toBe(1);
});

it("a prompt turn that ends without a report is a missing report on the Continuation", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  await promptSent(f.world, worker);
  const turn = sentTurnBegins(f.world, worker);
  allTurnsEnd(f.world, turn);

  // Act
  const run = await observeFor("observe the missing report", f.world, worker.runId, (detail) =>
    detail.attention.some((matter) => matter.kind === "missing-report" && !matter.settledAt),
  );

  // Assert
  expect(
    run.attention.filter((matter) => !matter.settledAt).map((matter) => matter.blockId),
  ).toStrictEqual(["spec"]);
  expect(blockState(run, "spec")).toBe("error");
  expect(blockState(run, "worker")).toBe("finished");
});

it("Archive stops a Continuation whose prompt is pending", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  await promptSent(f.world, worker);

  // Act
  const archived = await f.f.archiveRun(worker.runId);

  // Assert
  assert(archived.ok);
  const run = await f.f.getRun(worker.runId);
  assert(run.ok);
  expect(blockState(run.value, "spec")).toBe("stopped");
  expect(run.value.continuationVisits.map((visit) => visit.state)).toStrictEqual(["cancelled"]);
});

it("factory_get_block describes a Continuation's task by its prompt, without exits to name", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const prompt = await promptSent(f.world, worker);

  // Act
  const block = await f.f.runtime.block({ arguments: { blockId: prompt.blockId } });

  // Assert
  expect(block).toMatchObject({
    code: "BLOCK",
    state: "sent",
    reason: "continuation",
    prompt: "Write the spec from what we agreed.",
    exits: [],
  });
});

it("Request report on a Continuation asks the worker's thread once, under the Continuation's Block id", async (c) => {
  // Arrange
  const f = await prepared(c, continuationFlow);
  const worker = await workerAtWork(f.world, f.input);
  await resultReported(f.world, worker);
  const prompt = await promptSent(f.world, worker);
  allTurnsEnd(f.world, sentTurnBegins(f.world, worker));
  await observeFor("observe the missing report", f.world, worker.runId, (detail) =>
    detail.attention.some((matter) => matter.kind === "missing-report" && !matter.settledAt),
  );

  // Act
  const requested = await f.f.requestReport(worker.runId, { blockId: "spec" });

  // Assert
  assert(requested.ok);
  const sends = [...f.t3.sends.values()].filter(
    (send) => send.payload.threadId === worker.threadId,
  );
  expect(sends).toHaveLength(2);
  expect(promptOn(f.world, worker).blockId).toBe(prompt.blockId);
  expect(sends[1]!.payload.message).toContain("Factory Request report");
});
