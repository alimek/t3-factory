import { vi, type Mock } from "vite-plus/test";
import type {
  AgentDefinition,
  FlowDraft,
  StudioDefinitions as SavedDefinitions,
  StudioLiveMessage,
} from "@t3-factory/contracts";
import { FACTORY_STUDIO_LIVE_PROTOCOL } from "@t3-factory/domain-validation";
import {
  createStudioDefinitions,
  type StudioDefinitionsOperations,
} from "../../src/studio-definitions.ts";
import { memoryFactory, settled } from "./flow-draft.ts";
import { savedAgent } from "./agent-draft.ts";
import { connectionScope } from "../../src/live/scopes.ts";
import { envelope, liveHarness, snapshot } from "./live.ts";

type Operations = {
  [K in keyof StudioDefinitionsOperations]: Mock<StudioDefinitionsOperations[K]>;
};

/** A server that serves Studio's saved definitions only through HTTP reads (protocol 9–11). */
export const olderProtocol = FACTORY_STUDIO_LIVE_PROTOCOL - 1;

/** A saved Flow named for a test, so a list read can be told apart from another one. */
export const savedFlow = (name: string, change: Partial<FlowDraft> = {}): FlowDraft => ({
  ...memoryFactory().latest(),
  name,
  ...change,
});

/** The saved Flows and Agents Factory holds, and Studio's operations over them in memory. */
export function studioFactory() {
  let flows: readonly FlowDraft[] = [savedFlow("Review")];
  let agents: readonly AgentDefinition[] = [savedAgent()];
  const operations: Operations = {
    listFlows: vi.fn<StudioDefinitionsOperations["listFlows"]>(async () => flows),
    listAgents: vi.fn<StudioDefinitionsOperations["listAgents"]>(async () => agents),
    createFlow: vi.fn<StudioDefinitionsOperations["createFlow"]>(async ({ name }) => {
      const flow = savedFlow(name);
      flows = [...flows, flow];
      return flow;
    }),
    updateFlow: vi.fn<StudioDefinitionsOperations["updateFlow"]>(async (_id, { name }) => {
      const flow = savedFlow(name);
      flows = [flow];
      return flow;
    }),
    removeFlow: vi.fn<StudioDefinitionsOperations["removeFlow"]>(async () => {
      flows = [];
    }),
    createAgent: vi.fn<StudioDefinitionsOperations["createAgent"]>(async (content) => {
      const agent = savedAgent({ ...content, id: "created" });
      agents = [...agents, agent];
      return agent;
    }),
    updateAgent: vi.fn<StudioDefinitionsOperations["updateAgent"]>(async (_id, content) => {
      const agent = savedAgent(content);
      agents = [agent];
      return agent;
    }),
    duplicateAgent: vi.fn<StudioDefinitionsOperations["duplicateAgent"]>(async () => {
      const agent = savedAgent({ id: "copy", name: "Reviewer copy" });
      agents = [...agents, agent];
      return agent;
    }),
    removeAgent: vi.fn<StudioDefinitionsOperations["removeAgent"]>(async () => {
      agents = [];
    }),
  };
  return operations;
}

/**
 * Studio opens over Factory's saved definitions on a server speaking `protocol`, with the
 * window's live owner over scripted sockets. `close` is Studio closing.
 */
export function studioSession(factory = studioFactory(), protocol = olderProtocol) {
  const live = liveHarness();
  const definitions = createStudioDefinitions(live.owner, factory);
  const close = definitions.open(protocol);
  return { factory, live, definitions, close };
}

/** Studio is open on an older server and both of its opening reads have answered. */
export async function openedStudio() {
  const setup = studioSession();
  await settled();
  return setup;
}

/**
 * Studio is open on a server that delivers it live, with the window's socket connected; the
 * Studio subscription has delivered nothing yet.
 */
export function liveStudio(factory = studioFactory()) {
  const setup = studioSession(factory, FACTORY_STUDIO_LIVE_PROTOCOL);
  const socket = setup.live.sessions[0]!;
  socket.connected();
  return { ...setup, socket, studio: socket.subscriptions[0]! };
}

/** One joint read of both lists, as the Studio subscription delivers it. */
export const studioSnapshot = (studio: SavedDefinitions, current = true) =>
  envelope<StudioLiveMessage>([{ _tag: "snapshot", studio }], current);

/** One committed change set of both lists. */
export const studioChanged = (
  change: Omit<Extract<StudioLiveMessage, { _tag: "changed" }>, "_tag">,
) => envelope<StudioLiveMessage>([{ _tag: "changed", ...change }]);

/** Studio is open live and its first snapshot of `studio` applied. */
export function deliveredStudio(studio: SavedDefinitions) {
  const setup = liveStudio();
  setup.studio.message(studioSnapshot(studio));
  return setup;
}

/**
 * A window whose only held scope, the T3 connection status, is current, so mutations are
 * allowed, and a Studio session over it that has not opened yet.
 */
export function currentWindow(factory = studioFactory()) {
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  const socket = live.sessions[0]!;
  socket.connected();
  socket.subscriptions[0]!.message(snapshot("ready"));
  return { factory, live, socket, definitions: createStudioDefinitions(live.owner, factory) };
}

/**
 * The connection was renegotiated at `protocol`: Studio retires its implementation and opens
 * the one for that protocol over the same session. Returns the new implementation's `close`.
 */
export function renegotiated(
  setup: { close: () => void; definitions: ReturnType<typeof createStudioDefinitions> },
  protocol: number,
) {
  setup.close();
  return setup.definitions.open(protocol);
}
