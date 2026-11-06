import { assert, expect, it } from "@effect/vitest";
import { authorizedLiveOAuth } from "./support/boundaries-setup.ts";

const liveCatalog = {
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      models: [
        {
          id: "gpt-6.1-sol",
          options: [
            { id: "reasoningEffort", values: ["low", "medium", "high"], default: "low" },
            { id: "fastMode", values: [false], default: false },
            { id: "mixed", values: [false, "auto"], default: "auto" },
            { id: "legacy", type: "boolean", default: true },
          ],
        },
      ],
    },
  ],
};

it("orchestrator capability reads preserve live model option values and choices", async (c) => {
  // Arrange
  const { adapter, endpoint } = await authorizedLiveOAuth(c, { capabilities: () => liveCatalog });

  // Act
  const providers = await adapter.orchestratorCapabilities({ endpoint });

  // Assert
  expect(providers[0]!.models[0]!.options).toStrictEqual([
    {
      id: "reasoningEffort",
      label: "reasoningEffort",
      type: "select",
      values: ["low", "medium", "high"],
      default: "low",
      choices: [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
    },
    { id: "fastMode", label: "fastMode", type: "boolean", values: [false], default: false },
    { id: "mixed", label: "mixed", type: "select", values: [false, "auto"], default: "auto" },
    { id: "legacy", label: "legacy", type: "boolean", default: true },
  ]);
});

it("agent settings mark fastMode unavailable when the live catalog allows only false", async (c) => {
  // Arrange
  const { factory } = await authorizedLiveOAuth(c, { capabilities: () => liveCatalog });

  // Act
  const saved = await factory.createAgent({
    name: "fastMode-true",
    prompt: "Work",
    execution: {
      environmentId: "fixture-environment",
      providerInstanceId: "codex",
      modelId: "gpt-6.1-sol",
      modelOptions: [{ id: "fastMode", value: true }],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.settingsStatus.options[0]?.state).toBe("unavailable");
});

it("agent settings mark mixed values outside the live catalog as unavailable", async (c) => {
  // Arrange
  const { factory } = await authorizedLiveOAuth(c, { capabilities: () => liveCatalog });

  // Act
  const saved = await factory.createAgent({
    name: "mixed-true",
    prompt: "Work",
    execution: {
      environmentId: "fixture-environment",
      providerInstanceId: "codex",
      modelId: "gpt-6.1-sol",
      modelOptions: [{ id: "mixed", value: true }],
    },
  });

  // Assert
  assert(saved.ok);
  expect(saved.value.settingsStatus.options[0]?.state).toBe("unavailable");
});
