import { vi, type Mock } from "vite-plus/test";
import type { FlowDraft, FlowGraph, FlowReadiness, OperationError } from "@t3-factory/contracts";
import { ApiError } from "../../src/api.ts";
import { createFlowDraft, type FlowDraftOperations } from "../../src/flow-draft.ts";

type Operations = { [K in keyof FlowDraftOperations]: Mock<FlowDraftOperations[K]> };

/** The Flow Factory holds, and its Flow operations over it in memory. */
interface MemoryFactory extends Operations {
  latest(): FlowDraft;
  /** Another client saves the Flow, appending the next revision. */
  saveElsewhere(name: string, readiness?: FlowReadiness): FlowDraft;
}

const ready: FlowReadiness = { ready: true, issues: [] };

export const notReady: FlowReadiness = {
  ready: false,
  issues: [{ code: "missing_target", path: "flowInput", message: "Connect the Flow input." }],
};

export const rejection = (detail: Partial<OperationError> = {}) =>
  new ApiError({ code: "validation", message: "Flow is invalid.", issues: [], ...detail });

export function memoryFactory(): MemoryFactory {
  let removed = false;
  let latest: FlowDraft = {
    id: "flow",
    name: "Review",
    revision: 1,
    graph: {
      blocks: [],
      connections: [],
      flowInput: { position: { x: 0, y: 0 }, targetBlockIds: [] },
    },
    workspace: { mode: "checkout" },
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    readiness: ready,
  };
  function append(change: Partial<FlowDraft>) {
    latest = { ...latest, readiness: ready, ...change, revision: latest.revision + 1 };
    return latest;
  }
  return {
    latest: () => latest,
    saveElsewhere: (name, readiness = ready) => append({ name, readiness }),
    getFlow: vi.fn<FlowDraftOperations["getFlow"]>(async () => latest),
    updateFlow: vi.fn<FlowDraftOperations["updateFlow"]>(
      async (_id, { expectedRevision, name, graph, workspace }) => {
        if (removed) throw rejection({ code: "not_found", message: "Flow was removed." });
        if (expectedRevision !== latest.revision)
          throw rejection({ code: "conflict", message: "Flow changed in another window." });
        // Studio always sends a fully positioned graph, so no server layout is simulated.
        return append({ name, graph: graph as FlowGraph, ...(workspace && { workspace }) });
      },
    ),
    removeFlow: vi.fn<FlowDraftOperations["removeFlow"]>(async () => {
      removed = true;
    }),
    validateFlow: vi.fn<FlowDraftOperations["validateFlow"]>(async () => ready),
  };
}

/** Lets every answer the fakes already gave reach the draft. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The next call of `operation` waits until the test answers it. */
export function held<T>(operation: Mock<(...args: never[]) => Promise<T>>) {
  let answer!: (value: T) => void;
  let fail!: (error: Error) => void;
  operation.mockReturnValueOnce(
    new Promise<T>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    }),
  );
  return { answer: (value: T) => answer(value), fail: (error: Error) => fail(error) };
}

/** A Flow draft over a Flow Factory holds in memory; creating it starts loading the Flow. */
export function flowDraft(factory = memoryFactory()) {
  return { factory, draft: createFlowDraft("flow", factory) };
}

/** The Flow editor shows a loaded, clean Flow whose readiness refresh has answered. */
export async function openedFlow() {
  const setup = flowDraft();
  setup.draft.reportVisibility(true);
  await settled();
  return setup;
}

/** The opened Flow is hidden while the user visits another Studio page. */
export async function hiddenFlow() {
  const setup = await openedFlow();
  setup.draft.reportVisibility(false);
  return setup;
}

/** The opened Flow has an unsaved rename. */
export async function editedFlow(name = "Edited") {
  const setup = await openedFlow();
  setup.draft.edit({ name });
  return setup;
}

/** A save of an unsaved rename was refused because another client saved first. */
export async function conflictedFlow() {
  const setup = await editedFlow("Mine");
  setup.factory.saveElsewhere("Theirs");
  await setup.draft.save();
  return setup;
}

/** The conflicted save's latest saved Flow is loaded beside the local draft. */
export async function comparedFlow() {
  const setup = await conflictedFlow();
  await setup.draft.compareLatest();
  return setup;
}
