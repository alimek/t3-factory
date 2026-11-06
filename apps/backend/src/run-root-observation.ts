import { localCommandReferences } from "./native-command-creation.ts";
import { verifyStandalone } from "./run-root-standalone.ts";
import type { RunClosure } from "@t3-factory/contracts";
import type { T3Adapter, ExecutionObservation } from "./adapters/t3.ts";
import type { RunRow } from "./runner-types.ts";
import { nativeReferences, nativeThreads } from "./coordinator-native-obligations.ts";
import { rootLedger, rootExecutionRows, type RootObligation } from "./run-root-ledger.ts";
import { isTerminal, runTarget } from "./runner-utils.ts";
export type Member = { threadId: string; parentThreadId: string | null };
export type Frontier = Omit<RunClosure["frontier"][number], "blockId">;
type Ledger = ReturnType<typeof rootLedger>;
type RecoveredRootFailures = readonly { threadId: string; executionId: string }[];
const memberRow = (member: Member): RootObligation => ({
  thread_id: member.threadId,
  kind: "member",
  reference: JSON.stringify(member),
});
const pointerRows = (o: ExecutionObservation) =>
  rootExecutionRows(o.threadId, [
    o.activeRunId,
    o.latestRunId,
    ...o.recentRuns.map((e) => e.runId),
  ]);
async function retainActivity(
  t3: T3Adapter,
  run: RunRow,
  member: Member,
  ledger: Ledger,
  members: Map<string, Member>,
  stopping: boolean,
) {
  const activity = await t3.readDelegationActivity(runTarget(run), member.threadId);
  if (activity.threadId !== member.threadId || activity.projectId !== run.t3_project_id)
    throw Error("Root native scope changed");
  const native = rootNativeMarkers(activity);
  await ledger.retain([
    ...native,
    ...(activity.followups ?? []).map((followup) => ({
      thread_id: member.threadId,
      kind: "followup" as const,
      reference: JSON.stringify(followup),
    })),
    ...localCommandReferences(activity.commands, run.environment_id).flatMap((r) =>
      rootExecutionRows(r.threadId, [r.executionId]),
    ),
    ...(activity.commands ?? []).map((command) => ({
      thread_id: member.threadId,
      kind: "command" as const,
      reference: JSON.stringify(command),
    })),
    ...nativeReferences(activity).map((r) => ({
      thread_id: r.thread_id,
      kind: "execution" as const,
      reference: r.execution_id,
    })),
    ...(activity.remoteTasks ?? []).map((r) => ({
      thread_id: member.threadId,
      kind: "remote" as const,
      reference: JSON.stringify(r),
    })),
  ]);
  for (const threadId of new Set([
    ...nativeThreads(activity),
    ...localCommandReferences(activity.commands, run.environment_id).map((r) => r.threadId),
  ])) {
    if (members.has(threadId)) continue;
    // A native pointer is an obligation; its actual parent is verified independently below.
    const candidate = { threadId, parentThreadId: null };
    await ledger.retain([memberRow(candidate)]);
    members.set(threadId, candidate);
  }
  await ledger.retainRemoteCommands(activity.commands ?? []);
  const saved = await ledger.read();
  return {
    commands: (activity.commands ?? []).map((command) => ({ threadId: member.threadId, command })),
    complete:
      (stopping ? (activity.stopComplete ?? activity.complete) : activity.complete) &&
      saved
        .filter((r) => r.thread_id === member.threadId && r.kind === "native")
        .every((r) => native.some((n) => n.reference === r.reference)),
  };
}
export async function verifyMember(
  t3: T3Adapter,
  run: RunRow,
  member: Member,
  rootId: string,
  ledger: Ledger,
  trusted: Set<string>,
) {
  if (member.threadId === rootId) return false;
  const child = await t3.readChildEvidence(runTarget(run), {
    parentThreadId: member.parentThreadId ?? "",
    projectId: run.t3_project_id,
    childThreadId: member.threadId,
    childRunId: null,
  });
  const thread = child.thread;
  if (member.parentThreadId === null && thread?.parentThreadId === null)
    return verifyStandalone(t3, run, member.threadId, ledger, trusted);
  if (
    (!child.scopeMatches && member.parentThreadId !== null) ||
    !thread ||
    thread.threadId !== member.threadId ||
    thread.projectId !== run.t3_project_id ||
    !thread.parentThreadId ||
    !trusted.has(thread.parentThreadId) ||
    (member.parentThreadId !== null && member.parentThreadId !== thread.parentThreadId) ||
    !["t3-owned", "provider-native"].includes(child.relationship) ||
    (thread.worktreePath !== null && thread.worktreePath !== run.workspace_root)
  )
    throw Error("Root descendant lineage unverified");
  await ledger.retain([
    memberRow({ threadId: member.threadId, parentThreadId: thread.parentThreadId }),
    ...rootExecutionRows(member.threadId, [
      thread.activeRunId,
      thread.latestRunId,
      child.execution?.runId,
    ]),
  ]);
  // Detail may carry positive pointers while its exact execution read failed.
  if (child.problem) throw Error(child.problem);
  return false;
}
export async function readMember(
  t3: T3Adapter,
  run: RunRow,
  member: Member,
  ledger: Ledger,
  members: Map<string, Member>,
  stopping: boolean,
) {
  const target = runTarget(run),
    time = new Date().toISOString();
  const activity = await retainActivity(t3, run, member, ledger, members, stopping);
  const window = await t3.readExecution(target, member.threadId);
  await retainMemberExecution(run, member, ledger, window);
  const recorded = (await ledger.read())
    .filter((r) => r.thread_id === member.threadId && r.kind === "execution")
    .map((r) => ({ runId: r.reference }));
  const execution = await t3.readExecution(target, member.threadId, recorded);
  await retainMemberExecution(run, member, ledger, execution);
  await ledger.recordWork(execution);
  const queue = await t3.readQueue(target, member.threadId);
  if (queue.threadId !== member.threadId) throw Error("Root queue scope changed");
  await ledger.retain(rootExecutionRows(member.threadId, queue.queuedRunIds));
  const native = await t3.readNativeRequests(target, member.threadId);
  if (native.threadId !== member.threadId || native.projectId !== run.t3_project_id)
    throw Error("Root request scope changed");
  const required = (await ledger.read()).filter(
    (r) => r.thread_id === member.threadId && r.kind === "execution",
  );
  const complete =
    activity.complete &&
    queue.nextCursor === null &&
    !!execution.latestRunId &&
    execution.recentRuns.every((execution) => execution.status !== "unknown") &&
    required.every((r) => execution.recentRuns.some((e) => e.runId === r.reference));
  return {
    complete,
    commands: activity.commands,
    frontier: {
      environmentId: run.environment_id,
      threadId: member.threadId,
      projectId: run.t3_project_id,
      workspaceRoot: run.workspace_root,
      projectObservedAt: time,
      executionObservedAt: time,
      queueObservedAt: time,
      nativeObservedAt: time,
      activeRunId: execution.activeRunId,
      latestRunId: execution.latestRunId ?? null,
      executions: execution.recentRuns.map((e) => ({
        executionId: e.runId,
        status: e.status,
        ordinal: e.ordinal ?? null,
        sourceAt: e.sourceAt ?? null,
      })),
      queuedRunIds: queue.queuedRunIds,
      queueNextCursor: queue.nextCursor,
      pendingRequestCount: Math.max(execution.pendingRequestCount, native.pendingRequestCount),
    },
  };
}
export function quiet(frontier: Frontier, stopping: boolean, recovered: RecoveredRootFailures) {
  return (
    !frontier.activeRunId &&
    !!frontier.latestRunId &&
    frontier.executions.some((e) => e.executionId === frontier.latestRunId) &&
    frontier.queueNextCursor === null &&
    !frontier.queuedRunIds.length &&
    frontier.pendingRequestCount === 0 &&
    frontier.executions.every((e) =>
      stopping
        ? isTerminal(e.status)
        : e.status === "completed" ||
          (["failed", "cancelled", "interrupted"].includes(e.status) &&
            recovered.some(
              (r) => r.threadId === frontier.threadId && r.executionId === e.executionId,
            )),
    )
  );
}
export async function discover(t3: T3Adapter, run: RunRow, rootId: string, ledger: Ledger) {
  const members = new Map<string, Member>([[rootId, { threadId: rootId, parentThreadId: null }]]);
  for (const row of (await ledger.read()).filter(
    (r) => r.kind === "member" && r.thread_id !== rootId,
  )) {
    const member = JSON.parse(row.reference) as Member;
    mergeMember(members, member);
  }
  const tree = await t3.readDescendants(runTarget(run), rootId);
  if (tree.parentThreadId !== rootId) throw Error("Root tree scope changed");
  for (const child of tree.descendants) {
    const member = { threadId: child.threadId, parentThreadId: child.parentThreadId };
    await ledger.retain([memberRow(member)]);
    mergeMember(members, member);
  }
  return {
    members,
    complete:
      tree.scanComplete &&
      tree.descendants.every((c) => c.projectId === run.t3_project_id && c.parentThreadId !== null),
  };
}

function mergeMember(members: Map<string, Member>, member: Member) {
  const prior = members.get(member.threadId);
  if (
    prior?.parentThreadId &&
    member.parentThreadId &&
    prior.parentThreadId !== member.parentThreadId
  )
    throw Error("Root lineage changed");
  if (!prior?.parentThreadId) members.set(member.threadId, member);
}

async function retainMemberExecution(
  run: RunRow,
  member: Member,
  ledger: Ledger,
  execution: ExecutionObservation,
) {
  if (
    execution.threadId !== member.threadId ||
    execution.projectId !== run.t3_project_id ||
    (execution.workspaceRoot !== null && execution.workspaceRoot !== run.workspace_root)
  )
    throw Error("Root execution scope changed");
  await ledger.retain(pointerRows(execution));
}

function rootNativeMarkers(
  activity: import("./adapters/delegation-activity.ts").DelegationActivity,
): RootObligation[] {
  return [
    ...activity.invocations,
    ...(activity.followups ?? []),
    ...(activity.taskResults ?? []),
    ...(activity.remoteTasks ?? []),
    ...(activity.commands ?? []),
  ].map((i) => ({
    thread_id: activity.threadId,
    kind: "native",
    reference: JSON.stringify([i.itemId, i.parentRunId, i.fingerprint]),
  }));
}
