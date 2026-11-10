import { vi, type Mock } from "vite-plus/test";
import type { AgentDefinition, FlowDraft } from "@t3-factory/contracts";
import {
  createStudioDefinitions,
  type StudioDefinitionsOperations,
} from "../../src/studio-definitions.ts";
import { memoryFactory, settled } from "./flow-draft.ts";
import { savedAgent } from "./agent-draft.ts";

type Operations = {
  [K in keyof StudioDefinitionsOperations]: Mock<StudioDefinitionsOperations[K]>;
};

/** A saved Flow named for a test, so a list read can be told apart from another one. */
export const savedFlow = (name: string): FlowDraft => ({ ...memoryFactory().latest(), name });

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
    deleteAgent: vi.fn<StudioDefinitionsOperations["deleteAgent"]>(async () => {
      agents = [];
    }),
  };
  return operations;
}

/** Studio opens over Factory's saved definitions; opening starts reading both lists. */
export function studioSession(factory = studioFactory()) {
  return { factory, definitions: createStudioDefinitions(factory) };
}

/** Studio is open and both of its opening reads have answered. */
export async function openedStudio() {
  const setup = studioSession();
  await settled();
  return setup;
}
