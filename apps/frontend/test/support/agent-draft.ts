import { vi } from "vite-plus/test";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { createAgentDraft, type AgentDraftOperations } from "../../src/agent-draft.ts";

export const capabilities: AgentCapabilities = {
  state: "ready",
  explanation: "",
  checkedAt: null,
  environments: [{ environmentId: "local", label: "Local" }],
  providers: [
    {
      providerInstanceId: "unsupported",
      displayName: "Unsupported",
      driverKind: "unsupported",
      reporting: { supported: false, explanation: "No reporting" },
      models: [{ id: "unsupported-model", label: null }],
    },
    {
      providerInstanceId: "primary",
      displayName: "Primary",
      driverKind: "codex",
      reporting: { supported: true, explanation: "" },
      models: [
        {
          id: "first",
          label: null,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: ["low", "high"],
              default: "low",
            },
            { id: "old", label: "Old", type: "boolean", default: true },
          ],
        },
        {
          id: "second",
          label: null,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: ["low", "high"],
              default: "low",
            },
            { id: "new", label: "New", type: "boolean", default: false },
          ],
        },
      ],
    },
    {
      providerInstanceId: "other",
      displayName: "Other",
      driverKind: "claude",
      reporting: { supported: true, explanation: "" },
      models: [
        {
          id: "other-first",
          label: null,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: ["low", "high"],
              default: "low",
            },
            { id: "new", label: "New", type: "boolean", default: false },
          ],
        },
      ],
    },
  ],
};

export function savedAgent(change: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent",
    revision: 3,
    name: "Reviewer",
    prompt: "Review the change.",
    execution: {
      environmentId: "local",
      providerInstanceId: "primary",
      modelId: "first",
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "old", value: true },
      ],
    },
    exits: [{ id: "done", name: "done", description: "", messageRequired: false }],
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    settingsStatus: {
      environment: { state: "available" },
      provider: { state: "available" },
      model: { state: "available" },
      options: [],
    },
    ...change,
  };
}

function memoryAgents() {
  let latest = savedAgent();
  return {
    latest: () => latest,
    createAgent: vi.fn<AgentDraftOperations["createAgent"]>(async (content) => {
      latest = savedAgent({ ...content, revision: 1 });
      return latest;
    }),
    updateAgent: vi.fn<AgentDraftOperations["updateAgent"]>(
      async (_id, { expectedRevision, ...content }) => {
        latest = savedAgent({ ...content, revision: expectedRevision + 1 });
        return latest;
      },
    ),
    deleteAgent: vi.fn<AgentDraftOperations["deleteAgent"]>(async () => undefined),
  };
}

export function agentDraft(
  agent: AgentDefinition | null = savedAgent(),
  offered: AgentCapabilities | null = capabilities,
) {
  const factory = memoryAgents();
  return { draft: createAgentDraft(agent, offered, factory), factory };
}

export function editedAgent() {
  const setup = agentDraft();
  setup.draft.edit({ name: "Edited" });
  return setup;
}

export async function failedDelete() {
  const setup = editedAgent();
  setup.factory.updateAgent.mockRejectedValueOnce(new Error("Save unavailable."));
  await setup.draft.save();
  setup.factory.deleteAgent.mockRejectedValueOnce(new Error("Agent is still used by a Flow."));
  await setup.draft.delete();
  return setup;
}
