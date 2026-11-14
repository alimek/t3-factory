import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";

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
