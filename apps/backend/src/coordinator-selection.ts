import type { ChildEvidence } from "./adapters/coordination-evidence.ts";

export interface LocalExecution {
  thread_id: string;
  execution_id: string;
  parent_thread_id: string | null;
  provider_instance_id: string | null;
  model: string | null;
  ordinal: number | null;
}

/** Only fill omitted immutable fields, never status, identity, lineage or conflicts. */
export function retainedSelection(child: ChildEvidence, saved: readonly LocalExecution[]) {
  if (!child.execution || !child.thread || !child.scopeMatches || child.problem) return child;
  const known = saved.find(
    (e) =>
      e.thread_id === child.thread!.threadId &&
      e.execution_id === child.execution!.runId &&
      e.parent_thread_id === child.thread!.parentThreadId,
  );
  if (!known) return child;
  const execution = child.execution;
  if (
    (execution.providerInstanceId !== null &&
      known.provider_instance_id !== null &&
      execution.providerInstanceId !== known.provider_instance_id) ||
    (execution.model !== null && known.model !== null && execution.model !== known.model)
  )
    throw Error("Historical execution selection conflicts with fresh metadata.");
  return {
    ...child,
    execution: {
      ...execution,
      providerInstanceId: execution.providerInstanceId ?? known.provider_instance_id,
      model: execution.model ?? known.model,
    },
  };
}
