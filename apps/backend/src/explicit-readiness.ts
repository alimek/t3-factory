import * as Effect from "effect/Effect";
import type {
  AgentDefinition,
  ReportingInstallation,
  Result,
  RuntimeReadiness,
} from "@t3-factory/contracts";

/** Installation is a prerequisite, not proof of live tool visibility or attribution. */
export const explicitReadiness = Effect.fn(function* (
  readiness: Result<RuntimeReadiness>,
  execution: AgentDefinition["execution"],
  installations: () => Effect.Effect<Result<readonly ReportingInstallation[]>, unknown>,
): Generator<Effect.Effect<unknown, unknown>, Result<RuntimeReadiness>, never> {
  if (!readiness.ok) return readiness;
  const targets = yield* installations();
  const target = targets.ok
    ? (targets.value.find((target) => target.instances.includes(execution.providerInstanceId)) ??
      targets.value.find(
        (target) => target.instances.length === 0 && target.status === "needs-attention",
      ))
    : undefined;
  if (target?.status === "installed") return readiness;
  const message = !targets.ok
    ? targets.error.message
    : target?.status === "needs-attention" || target?.status === "unsupported"
      ? target.message
      : !target
        ? "Agent reporting lists no installation for this provider; a provider disabled in T3 is not listed. Enable it in T3 and recheck, or choose another provider in Studio → Agents."
        : "Install Factory MCP for this provider's effective home in Settings → Agent reporting, then start a fresh session.";
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
