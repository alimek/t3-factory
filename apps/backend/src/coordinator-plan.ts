import type { RunSnapshot } from "@t3-factory/contracts";

/** The native delegation request that creates a Block's direct worker with its captured settings. */
export function workerDelegationPlan(
  agent: RunSnapshot["agents"][number],
  task: string,
  requestKey: string,
) {
  return {
    clientRequestId: requestKey,
    task,
    target: {
      providerInstanceId: agent.execution.providerInstanceId,
      model: agent.execution.modelId,
      options: Object.fromEntries(agent.execution.modelOptions.map((o) => [o.id, o.value])),
    },
    mode: "async",
    isolation: "shared",
  };
}
