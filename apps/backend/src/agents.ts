import { resolveAgentModel } from "@t3-factory/domain-validation";
import type { T3ProviderCapability } from "./adapters/t3.ts";
import { providerReporting } from "./reporting-drivers.ts";
import { failure } from "./result.ts";
import type {
  AgentCapabilities,
  AgentExecutionSettingsStatus,
  AgentExecutionSettings,
  AgentSettingAvailability,
  AgentSettingStatus,
  Result,
} from "@t3-factory/contracts";

/**
 * A save may not choose a provider T3 offers but Factory cannot take reports from, as Studio's
 * menu prevents. Providers T3 does not list right now are an availability matter for settings
 * status, not a save error.
 */
export function unsupportedReportingFailure(
  execution: AgentExecutionSettings,
  capabilities: AgentCapabilities,
): Result<never> | undefined {
  const provider = capabilities.providers.find(
    (entry) => entry.providerInstanceId === execution.providerInstanceId,
  );
  if (!provider || provider.reporting.supported) return undefined;
  return failure("validation", provider.reporting.explanation, [
    {
      code: "harness_unsupported",
      path: "execution.providerInstanceId",
      message: "Choose a provider whose reporting is supported in Agent capabilities.",
    },
  ]);
}

export function agentSettingsStatus(
  execution: AgentExecutionSettings,
  capabilities: AgentCapabilities | null,
): AgentExecutionSettingsStatus {
  if (!capabilities || capabilities.state !== "ready") {
    const unknown = (explanation?: string): AgentSettingStatus => ({
      state: "unknown",
      ...(explanation ? { explanation } : {}),
    });
    const explanation = capabilities?.explanation;
    return {
      environment: unknown(explanation),
      provider: unknown(explanation),
      model: unknown(explanation),
      options: execution.modelOptions.map((option) => ({
        id: option.id,
        state: "unknown" as const,
      })),
    };
  }
  const environmentKnown = capabilities.environments.some(
    (entry) => entry.environmentId === execution.environmentId,
  );
  const { provider, model } = environmentKnown ? resolveAgentModel(execution, capabilities) : {};
  const optionState = (id: string): AgentSettingAvailability => {
    const descriptor = model?.options?.find((entry) => entry.id === id);
    if (!descriptor) return "unavailable";
    const selected = execution.modelOptions.find((entry) => entry.id === id);
    if (!selected) return "available";
    if (descriptor.values)
      return descriptor.values.includes(selected.value) ? "available" : "unavailable";
    if (descriptor.type === "boolean")
      return typeof selected.value === "boolean" ? "available" : "unavailable";
    if (typeof selected.value !== "string") return "unavailable";
    return descriptor.choices?.some((choice) => choice.id === selected.value)
      ? "available"
      : "unavailable";
  };
  return {
    environment: environmentKnown
      ? { state: "available" }
      : {
          state: "unavailable",
          explanation: "This environment is not available from T3 right now.",
        },
    provider: provider
      ? { state: "available" }
      : {
          state: "unavailable",
          explanation: "This provider is not offered for the selected environment.",
        },
    model: model
      ? { state: "available" }
      : {
          state: "unavailable",
          explanation: "This model is not offered for the selected provider.",
        },
    options: execution.modelOptions.map((option) => ({
      id: option.id,
      state: optionState(option.id),
    })),
  };
}

export function emptyCapabilities(explanation: string, checkedAt: string): AgentCapabilities {
  return {
    state: "unavailable",
    explanation,
    checkedAt,
    environments: [],
    providers: [],
  };
}

export function readyCapabilities(
  environments: AgentCapabilities["environments"],
  providers: readonly T3ProviderCapability[],
  checkedAt: string,
): AgentCapabilities {
  return {
    state: "ready",
    explanation: "Provider, model and thinking options come from the live T3 catalog.",
    checkedAt,
    environments,
    providers: providers.map((provider) => ({
      ...provider,
      reporting: providerReporting(provider.driverKind),
    })),
  };
}
