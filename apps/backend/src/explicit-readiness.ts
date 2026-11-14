import * as Effect from "effect/Effect";
import type {
  AgentDefinition,
  ReportingInstallation,
  Result,
  RuntimeReadiness,
} from "@t3-factory/contracts";

/**
 * Why Factory MCP is not installed for this provider instance's harness, or undefined when it is.
 * Installation is a prerequisite, not proof of live tool visibility or attribution.
 */
export function reportingInstallationProblem(
  providerInstanceId: string,
  targets: Result<readonly ReportingInstallation[]>,
): string | undefined {
  const target = targets.ok
    ? (targets.value.find((target) => target.instances.includes(providerInstanceId)) ??
      targets.value.find(
        (target) => target.instances.length === 0 && target.status === "needs-attention",
      ))
    : undefined;
  if (target?.status === "installed") return undefined;
  return !targets.ok
    ? targets.error.message
    : target?.status === "needs-attention" || target?.status === "unsupported"
      ? target.message
      : !target
        ? "Agent reporting lists no installation for this provider. If the provider is disabled in T3, enable it there and recheck, or choose another provider in Studio → Agents."
        : "Install Factory MCP for this provider's effective home in Settings → Agent reporting, then start a fresh session.";
}

export const explicitReadiness = Effect.fn(function* (
  readiness: Result<RuntimeReadiness>,
  execution: AgentDefinition["execution"],
  installations: () => Effect.Effect<Result<readonly ReportingInstallation[]>, unknown>,
): Generator<Effect.Effect<unknown, unknown>, Result<RuntimeReadiness>, never> {
  if (!readiness.ok) return readiness;
  const message = reportingInstallationProblem(
    execution.providerInstanceId,
    yield* installations(),
  );
  if (message === undefined) return readiness;
  return {
    ok: true,
    value: {
      ...readiness.value,
      ready: false,
      issues: [
        ...readiness.value.issues,
        {
          code: "reporting_installation",
          path: "runtime",
          message,
        },
      ],
    },
  };
});
