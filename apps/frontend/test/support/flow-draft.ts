import { vi, type Mock } from "vite-plus/test";
import type {
  AgentDefinition,
  FlowDraft,
  FlowGraph,
  FlowReadiness,
  OperationError,
  StudioLiveMessage,
} from "@t3-factory/contracts";
import { FACTORY_STUDIO_LIVE_PROTOCOL } from "@t3-factory/domain-validation";
import { api, ApiError } from "../../src/api.ts";
import { createFlowDraft } from "../../src/flow-draft.ts";
import {
  createStudioDefinitions,
  type StudioDefinitionsOperations,
} from "../../src/studio-definitions.ts";
import { OfflineError } from "../../src/transport.ts";
import { savedAgent } from "./agent-draft.ts";
import { envelope, liveHarness } from "./live.ts";

type FlowOperations = Pick<typeof api, "updateFlow" | "removeFlow" | "validateFlow">;
type Operations = { [K in keyof FlowOperations]: Mock<FlowOperations[K]> };

/** The Flow Factory holds, and its Flow operations over it in memory. */
interface MemoryFactory extends Operations {
  latest(): FlowDraft;
  /** Another client saves the Flow, appending the next revision. */
  saveElsewhere(name: string, readiness?: FlowReadiness): FlowDraft;
  /** Factory commits this editor's held save of `name`, whose reply has not been given yet. */
  commit(name: string): FlowDraft;
}

const ready: FlowReadiness = { ready: true, issues: [] };

export const notReady: FlowReadiness = {
  ready: false,
  issues: [{ code: "missing_target", path: "flowInput", message: "Connect the Flow input." }],
};

export const rejection = (detail: Partial<OperationError> = {}) =>
  new ApiError({ code: "validation", message: "Flow is invalid.", issues: [], ...detail });

/** A save whose request may have reached Factory before the connection was lost. */
export const lostReply = () => new OfflineError("unknown");

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
    commit: (name) => append({ name }),
    updateFlow: vi.fn<FlowOperations["updateFlow"]>(
      async (_id, { expectedRevision, name, graph, workspace }) => {
        if (removed) throw rejection({ code: "not_found", message: "Flow was removed." });
        if (expectedRevision !== latest.revision)
          throw rejection({ code: "conflict", message: "Flow changed in another window." });
        // Studio always sends a fully positioned graph, so no server layout is simulated.
        return append({ name, graph: graph as FlowGraph, ...(workspace && { workspace }) });
      },
    ),
    removeFlow: vi.fn<FlowOperations["removeFlow"]>(async () => {
      removed = true;
    }),
    validateFlow: vi.fn<FlowOperations["validateFlow"]>(async () => ready),
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

type StudioChange = Omit<Extract<StudioLiveMessage, { _tag: "changed" }>, "_tag">;

/**
 * Studio over the Flow Factory holds and one saved Agent, on a server speaking `protocol`, with
 * the window's live owner over scripted sockets. `listFlows` answers an older server's reads
 * with what Factory holds then; the Flow editor sends no other Studio write.
 */
function flowStudio(factory: MemoryFactory, protocol: number) {
  const live = liveHarness();
  const listFlows = vi.fn<StudioDefinitionsOperations["listFlows"]>(async () => [factory.latest()]);
  const definitions = createStudioDefinitions(live.owner, {
    ...api,
    listFlows,
    listAgents: async () => [savedAgent()],
    updateFlow: factory.updateFlow,
    removeFlow: factory.removeFlow,
  });
  definitions.open(protocol);
  return { live, definitions, listFlows };
}

/** A live Studio whose first snapshot holds `flows` and one saved Agent; `changed` delivers more. */
function liveFlowStudio(factory: MemoryFactory, flows: readonly FlowDraft[]) {
  const { live, definitions } = flowStudio(factory, FACTORY_STUDIO_LIVE_PROTOCOL);
  const socket = live.sessions[0]!;
  socket.connected();
  const subscription = socket.subscriptions[0]!;
  subscription.message(
    envelope<StudioLiveMessage>([{ _tag: "snapshot", studio: { agents: [savedAgent()], flows } }]),
  );
  return {
    definitions,
    socket,
    changed: (change: StudioChange) =>
      subscription.message(envelope<StudioLiveMessage>([{ _tag: "changed", ...change }])),
  };
}

/**
 * The Flow editor's draft of the Flow Factory holds, in a Studio that receives that Flow and one
 * saved Agent live. The returned deliveries are Studio's live updates of what Factory now holds.
 */
function flowDraft(factory = memoryFactory()) {
  const { definitions, socket, changed } = liveFlowStudio(factory, [factory.latest()]);
  const draft = createFlowDraft("flow", definitions, factory);
  draft.open();
  draft.reportProtocol(FACTORY_STUDIO_LIVE_PROTOCOL);
  return {
    factory,
    draft,
    /** Studio receives Factory's latest revision of the Flow. */
    published: (flow = factory.latest()) => changed({ flows: { upserts: [flow], removals: [] } }),
    /** Another client removes the Flow and Studio receives the removal. */
    removedElsewhere: async () => {
      await factory.removeFlow("flow");
      changed({ flows: { upserts: [], removals: ["flow"] } });
    },
    /** Studio receives a change to a saved Agent. */
    agentChanged: (agent: AgentDefinition = savedAgent({ revision: 2 })) =>
      changed({ agents: { upserts: [agent], removals: [] } }),
    /** The live connection drops, so Studio's saved definitions are no longer current. */
    disconnected: () => socket.disconnected(),
  };
}

/** The editor of a Flow that Studio's current saved Flows do not include, as from a fresh link. */
export function missingFlow() {
  const factory = memoryFactory();
  const { definitions } = liveFlowStudio(factory, []);
  const draft = createFlowDraft("flow", definitions, factory);
  draft.open();
  return { draft };
}

/** The editor of a Flow whose create answer arrived before Studio received it live. */
export function createdFlow() {
  const factory = memoryFactory();
  const { definitions } = liveFlowStudio(factory, []);
  const draft = createFlowDraft("flow", definitions, factory, factory.latest());
  draft.open();
  return { draft };
}

/** The Flow editor shows a loaded, clean Flow. */
export const openedFlow = () => flowDraft();

/** The opened Flow is hidden while the user visits another Studio page. */
export function hiddenFlow() {
  const setup = openedFlow();
  setup.draft.hide();
  return setup;
}

/** The opened Flow has an unsaved rename. */
export function editedFlow(name = "Edited") {
  const setup = openedFlow();
  setup.draft.edit({ name });
  return setup;
}

/** The opened Flow is being dragged, wired, arranged or typed into; `end` finishes it. */
export function interactingFlow() {
  const setup = openedFlow();
  return { ...setup, end: setup.draft.interact() };
}

/** Another client saved the Flow, and Studio received that revision, before this edit's save. */
function conflictedFlow() {
  const setup = editedFlow("Mine");
  setup.factory.saveElsewhere("Theirs");
  setup.published();
  return setup;
}

/** A save of an unsaved rename was refused because another client saved first unseen. */
export async function refusedFlow() {
  const setup = editedFlow("Mine");
  setup.factory.saveElsewhere("Theirs");
  await setup.draft.save();
  return setup;
}

/** The newer revision saved elsewhere is shown beside the local draft. */
export function comparedFlow() {
  const setup = conflictedFlow();
  setup.draft.compareLatest();
  return setup;
}

/** The opened Flow's rename is being saved; `reply` answers the save. */
export function savingFlow() {
  const setup = editedFlow("Mine");
  const reply = held(setup.factory.updateFlow);
  const saving = setup.draft.save();
  return { ...setup, reply, saving };
}

/**
 * The Flow editor of an older server's Studio (protocol 9–11), whose saved Flows are read over
 * HTTP; `listFlows` answers each read with what Factory holds then. Another client saved the
 * Flow unseen, and this editor's save of its rename was refused.
 */
export async function olderServerRefusedFlow() {
  const factory = memoryFactory();
  const olderProtocol = FACTORY_STUDIO_LIVE_PROTOCOL - 1;
  const { definitions, listFlows } = flowStudio(factory, olderProtocol);
  const draft = createFlowDraft("flow", definitions, factory);
  draft.open();
  draft.reportProtocol(olderProtocol);
  await settled();
  draft.edit({ name: "Mine" });
  factory.saveElsewhere("Theirs");
  await draft.save();
  return { draft, listFlows };
}
