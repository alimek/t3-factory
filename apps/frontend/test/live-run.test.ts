import { expect, it } from "vite-plus/test";
import type { RunHeader } from "@t3-factory/contracts";
import { runScope } from "../src/live/run.ts";
import { block, event, runDetail } from "./support/run.ts";

it("a committed Run update preserves entity order and untouched identities without duplicating history", () => {
  // Arrange
  const run = runDetail();
  const replacement = { ...block("worker"), workingMessage: "Updated" };
  const appended = block("new");
  const header: RunHeader = {
    id: run.id,
    number: run.number,
    title: "Renamed",
    titleProvenance: "manual",
    titleGeneration: null,
    lifecycle: "settled",
    task: run.task,
    flowId: run.flowId,
    flowName: run.flowName,
    currentFlowRevision: run.currentFlowRevision,
    repositories: run.repositories,
    startedAt: run.startedAt,
    input: run.input,
    segments: run.segments,
    images: run.images,
    workspace: run.workspace,
    coordinationActions: run.coordinationActions,
    runCoordinator: run.runCoordinator,
    gateOpen: run.gateOpen,
    settlement: run.settlement,
  };

  // Act
  const next = runScope(run.id).apply(run, {
    _tag: "changed",
    header,
    entities: { blocks: { upserts: [appended, replacement], removals: ["removed"] } },
    events: [event(2), event(3), event(3), event(4)],
  });

  // Assert
  expect(next.title).toBe("Renamed");
  expect(next.lifecycle).toBe("settled");
  expect(next.blocks).toStrictEqual([replacement, run.blocks[1], appended]);
  expect(next.blocks[0]).toBe(replacement);
  expect(next.blocks[1]).toBe(run.blocks[1]);
  expect(next.executions).toBe(run.executions);
  expect(next.definitions).toBe(run.definitions);
  expect(next.events.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3, 4]);
  expect(next.events[0]).toBe(run.events[0]);
  expect(run.blocks).toHaveLength(3);
  expect(run.events).toHaveLength(2);
});

it("observation metadata updates only matching Blocks, bindings and the historical Run coordinator", () => {
  // Arrange
  const run = runDetail();
  const coordinator: NonNullable<typeof run.runCoordinator> = {
    freshness: "fresh",
    observedAt: "earlier",
    pendingRequestCount: 0,
    queuedCount: 0,
    pendingOperationCount: 0,
    pendingStopCount: 0,
    selection: {
      environmentId: "env",
      providerInstanceId: "codex",
      modelId: "model",
      modelOptions: [],
    },
    state: "acknowledged",
    threadId: null,
    executionId: null,
    link: null,
    engineStatus: null,
    problem: null,
  };
  const otherTurn = { ...run.executions[0]!, executionId: "other-turn" };
  const before = {
    ...run,
    executions: [...run.executions, otherTurn],
    runCoordinator: coordinator,
  };

  // Act
  const next = runScope(run.id).apply(before, {
    _tag: "observed",
    blocks: [{ blockId: "worker", observedAt: "later" }],
    executions: [{ bindingId: "binding", executionId: "execution", observedAt: "later" }],
    runCoordinatorObservedAt: null,
  });

  // Assert
  expect(next.blocks[0]).toStrictEqual({ ...run.blocks[0], observedAt: "later" });
  expect(next.blocks[1]).toBe(run.blocks[1]);
  expect(next.executions[0]).toStrictEqual({ ...run.executions[0], observedAt: "later" });
  expect(next.executions[1]).toBe(run.executions[1]);
  expect(next.executions[2]).toBe(otherTurn);
  expect(next.runCoordinator).toStrictEqual({ ...coordinator, observedAt: null });
  expect(next.events).toBe(run.events);
  expect(next.reports).toBe(run.reports);
  expect(before.runCoordinator.observedAt).toBe("earlier");
});
