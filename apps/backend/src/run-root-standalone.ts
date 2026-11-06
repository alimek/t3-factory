import type { T3Adapter } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { runTarget } from "./runner-utils.ts";
import { rootLedger, rootExecutionRows } from "./run-root-ledger.ts";
import { commandCreation, commandSources } from "./native-command-creation.ts";
import type { Member } from "./run-root-observation.ts";

export async function verifyStandalone(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  ledger: ReturnType<typeof rootLedger>,
  trusted: ReadonlySet<string>,
) {
  const proof = commandCreation(
    commandSources(await ledger.read()),
    threadId,
    run.environment_id,
    trusted,
  );
  if (!proof?.executionId) throw Error("Standalone native creation is unproven");
  const child = await t3.readChildEvidence(runTarget(run), {
    parentThreadId: "",
    projectId: run.t3_project_id,
    childThreadId: threadId,
    childRunId: proof.executionId,
  });
  const thread = child.thread;
  if (
    !thread ||
    thread.threadId !== threadId ||
    thread.parentThreadId !== null ||
    thread.projectId !== run.t3_project_id ||
    thread.creationSource !== "mcp" ||
    thread.createdBy !== "agent" ||
    child.target.childThreadId !== threadId ||
    child.target.childRunId !== proof.executionId ||
    child.target.projectId !== run.t3_project_id ||
    (!child.problem && child.execution?.runId !== proof.executionId) ||
    (thread.worktreePath !== null && thread.worktreePath !== run.workspace_root)
  )
    throw Error("Standalone native creation scope changed");
  await ledger.retain(
    rootExecutionRows(threadId, [
      proof.executionId,
      thread.activeRunId,
      thread.latestRunId,
      child.execution?.runId,
    ]),
  );
  return true;
}
export async function standaloneTree(
  t3: T3Adapter,
  run: RunRow,
  member: Member,
  ledger: ReturnType<typeof rootLedger>,
  members: Map<string, Member>,
) {
  const tree = await t3.readDescendants(runTarget(run), member.threadId);
  if (tree.parentThreadId !== member.threadId) throw Error("Standalone tree scope changed");
  for (const child of tree.descendants) {
    const candidate = { threadId: child.threadId, parentThreadId: child.parentThreadId };
    await ledger.retain([
      { thread_id: child.threadId, kind: "member", reference: JSON.stringify(candidate) },
    ]);
    if (!members.has(child.threadId)) members.set(child.threadId, candidate);
  }
  return (
    tree.scanComplete &&
    tree.descendants.every((c) => c.projectId === run.t3_project_id && c.parentThreadId !== null)
  );
}
