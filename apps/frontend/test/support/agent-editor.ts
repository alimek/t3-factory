import { vi } from "vite-plus/test";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { ApiError } from "../../src/api.ts";
import { createAgentDraft, type AgentDraftOperations } from "../../src/agent-draft.ts";
import type { StudioDelivery } from "../../src/studio-definitions.ts";
import { capabilities, savedAgent } from "./agent-draft.ts";
import { held } from "./flow-draft.ts";
import {
  liveStudio,
  studioChanged,
  studioFactory,
  studioSession,
  studioSnapshot,
} from "./studio-definitions.ts";

/** The Agents Factory holds, and the Agent writes Studio sends, in memory. */
function memoryAgents() {
  let latest = savedAgent();
  return {
    latest: () => latest,
    /** Another client saves the Agent, appending its next revision. */
    saveElsewhere(change: Partial<AgentDefinition>) {
      latest = { ...latest, ...change, revision: latest.revision + 1 };
      return latest;
    },
    createAgent: vi.fn<AgentDraftOperations["createAgent"]>(async (content) => {
      latest = savedAgent({ ...content, id: "created", revision: 1 });
      return latest;
    }),
    updateAgent: vi.fn<AgentDraftOperations["updateAgent"]>(
      async (_id, { expectedRevision, ...content }) => {
        if (expectedRevision !== latest.revision)
          throw new ApiError({ code: "conflict", message: "Saved elsewhere.", issues: [] });
        latest = savedAgent({ ...latest, ...content, revision: expectedRevision + 1 });
        return latest;
      },
    ),
    duplicateAgent: vi.fn<AgentDraftOperations["duplicateAgent"]>(async () =>
      savedAgent({ id: "copy", name: "Reviewer copy" }),
    ),
    removeAgent: vi.fn<AgentDraftOperations["removeAgent"]>(async () => undefined),
  };
}

/**
 * An Agent editor over Studio's saved definitions on a server speaking `protocol`: the live
 * Studio subscription has delivered `agents` (the opened Agent by default), and the draft
 * follows it. `null` opens the new-Agent form.
 */
export function agentDraft(
  agent: AgentDefinition | null = savedAgent(),
  offered: AgentCapabilities | null = capabilities,
  delivery: StudioDelivery = "live",
) {
  const factory = memoryAgents();
  const operations = { ...studioFactory(), ...factory };
  operations.listAgents.mockImplementation(async () => [factory.latest()]);
  const { definitions, studio, socket } =
    delivery === "live"
      ? liveStudio(operations)
      : { ...studioSession(operations), studio: undefined, socket: undefined };
  studio?.message(studioSnapshot({ agents: [savedAgent()], flows: [] }));
  const draft = createAgentDraft(agent, offered, definitions);
  const disconnect = draft.connect();
  return { draft, factory, studio: studio!, socket, definitions, disconnect };
}

type AgentEditor = ReturnType<typeof agentDraft>;

/** Studio delivers these Agents as one committed change. */
export function deliver(
  setup: AgentEditor,
  upserts: readonly AgentDefinition[],
  removals: readonly string[] = [],
) {
  setup.studio.message(
    studioChanged({ agents: { upserts: [...upserts], removals: [...removals] } }),
  );
}

/** Another client saves the Agent and Studio delivers that revision. */
export function savedElsewhere(
  setup: AgentEditor,
  change: Partial<AgentDefinition> = { name: "Saved elsewhere" },
) {
  const agent = setup.factory.saveElsewhere(change);
  deliver(setup, [agent]);
  return agent;
}

/** Another client removes the Agent and Studio delivers the removal. */
export function removedElsewhere(setup: AgentEditor) {
  deliver(setup, [], [setup.factory.latest().id]);
}

/** Studio delivers the revision Factory now holds, such as the echo of this editor's save. */
export function echoed(setup: AgentEditor) {
  deliver(setup, [setup.factory.latest()]);
}

/**
 * An opened Agent with an unsaved name, on a live server or (`refreshed`) an older one whose
 * opening list reads have answered.
 */
export function editedAgent(delivery: StudioDelivery = "live") {
  const setup = agentDraft(savedAgent(), capabilities, delivery);
  setup.draft.edit({ name: "Edited" });
  return setup;
}

/** The new-Agent form created its Agent; Studio has not delivered it yet. */
export async function createdAgent() {
  const setup = agentDraft(null);
  setup.draft.edit({ name: "New reviewer", prompt: "Review the change." });
  await setup.draft.save();
  return setup;
}

/** The editor sends its save; the reply waits until the test answers it. */
export function pendingSave(setup: AgentEditor) {
  const reply = held(setup.factory.updateAgent);
  return { reply, saving: setup.draft.save() };
}

/** An edited Agent compares its draft with revision 4, saved elsewhere. */
export function comparedAgent() {
  const setup = editedAgent();
  savedElsewhere(setup, { name: "Saved elsewhere" });
  setup.draft.compare();
  return setup;
}

export async function failedDelete() {
  const setup = editedAgent();
  setup.factory.updateAgent.mockRejectedValueOnce(new Error("Save unavailable."));
  await setup.draft.save();
  setup.factory.removeAgent.mockRejectedValueOnce(new Error("Agent is still used by a Flow."));
  await setup.draft.delete();
  return setup;
}
