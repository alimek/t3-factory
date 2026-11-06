import type { RunSnapshot } from "@t3-factory/contracts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { ChildEvidence } from "./adapters/coordination-evidence.ts";
import type { CoordinationSaved } from "./coordinator-evidence-saved.ts";
import type { RetainLocal } from "./coordinator-local-observations.ts";
import { retainedSelection } from "./coordinator-selection.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";

/** A thread's current model cannot prove the immutable selection of its earlier executions. */
export async function directWorkerSelection(
  t3: T3Adapter,
  run: RunRow,
  block: BlockRow,
  saved: CoordinationSaved,
  retain: RetainLocal,
) {
  const snapshot = JSON.parse(run.snapshot_json) as RunSnapshot;
  const node = snapshot.flow.graph.blocks.find((b) => b.id === block.block_id);
  const expected = snapshot.agents.find(
    (a) => node?.kind === "agent" && a.id === node.agentId,
  )?.execution;
  const parent = saved.workerParentThreadId;
  if (!expected || !parent || !block.thread_id) return false;
  const executions = saved.executions.filter(
    (e) => e.thread_id === block.thread_id && e.activation_id === saved.id,
  );
  if (!executions.length) return false;
  for (const execution of executions) {
    const read = await t3.readChildEvidence(runTarget(run), {
      parentThreadId: parent,
      projectId: run.t3_project_id,
      childThreadId: block.thread_id,
      childRunId: execution.execution_id,
    });
    let child;
    try {
      child = retainedSelection(read, saved.localExecutions);
    } catch {
      return false;
    }
    if (!exactWorkerExecution(child, run, parent, block.thread_id, execution.execution_id))
      return false;
    await retain({
      threadId: block.thread_id,
      parentThreadId: parent,
      executionIds: [execution.execution_id],
      selections: [child.execution!],
    });
    if (
      child.thread!.providerInstanceId !== expected.providerInstanceId ||
      child.thread!.model !== expected.modelId ||
      child.execution!.providerInstanceId !== expected.providerInstanceId ||
      child.execution!.model !== expected.modelId
    )
      return false;
  }
  return true;
}

function exactWorkerExecution(
  child: ChildEvidence,
  run: RunRow,
  parent: string,
  threadId: string,
  executionId: string,
) {
  return (
    child.scopeMatches &&
    !child.problem &&
    child.relationship === "t3-owned" &&
    child.thread?.threadId === threadId &&
    child.thread.projectId === run.t3_project_id &&
    child.thread.parentThreadId === parent &&
    child.execution?.runId === executionId
  );
}
