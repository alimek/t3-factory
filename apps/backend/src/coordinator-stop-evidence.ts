import type { RetainLocal } from "./coordinator-local-observations.ts";
import type { RemoteSource } from "./coordinator-remote.ts";
import {
  nativeReferences,
  nativeThreads,
  type RetainNative,
} from "./coordinator-native-obligations.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { DelegationActivity } from "./adapters/delegation-activity.ts";
import type { RunRow } from "./runner-types.ts";
import { checkoutWorkspace, runTarget, isTerminal } from "./runner-utils.ts";

export interface StopMember {
  threadId: string;
  blockId: string;
  role: string;
  parentThreadId: string | null;
}
export interface StopSource {
  threadId: string;
  itemId: string;
  fingerprint: string;
  executionId: string;
}
function sources(activity: DelegationActivity): StopSource[] {
  return [
    ...activity.invocations,
    ...(activity.followups ?? []),
    ...(activity.taskResults ?? []),
    ...(activity.remoteTasks ?? []),
  ].map((i) => ({
    threadId: activity.threadId,
    itemId: i.itemId,
    fingerprint: i.fingerprint,
    executionId: i.parentRunId,
  }));
}
/** Discovery is not authority: independently check each candidate's lineage before targeting it. */
export async function collectStopMembers(
  t3: T3Adapter,
  run: RunRow,
  saved: readonly StopMember[],
  prior: readonly StopSource[],
  retain: (blockId: string) => RetainNative,
  retainLocal: (blockId: string) => RetainLocal,
) {
  const target = runTarget(run);
  const candidates = new Map(saved.map((m) => [m.threadId, m]));
  await resolveParents(t3, run, candidates);
  const references: ReturnType<typeof nativeReferences> = [];
  const members: StopMember[] = [];
  const rejected = new Set<string>();
  const native: StopSource[] = [];
  const remoteSources: RemoteSource[] = [];
  let complete = true;
  // Lineage pages need not be parent-first. Process only candidates whose parent is trusted.
  for (let pass = 0; pass < 100; pass++) {
    const next = [...candidates.values()].find(
      (c) =>
        !rejected.has(c.threadId) &&
        !members.some((m) => m.threadId === c.threadId) &&
        (c.parentThreadId === null ||
          c.parentThreadId === c.threadId ||
          members.some((m) => m.threadId === c.parentThreadId)),
    );
    if (!next) break;
    if (
      !(await trustedMember(t3, run, next, async (observation) => {
        await retainLocal(next.blockId)(observation);
        references.push(
          ...observation.executionIds
            .filter((id): id is string => id !== null)
            .map((execution_id) => ({ thread_id: next.threadId, execution_id })),
        );
      }))
    ) {
      complete = false;
      rejected.add(next.threadId);
      continue;
    }
    members.push(next);
    const activity = await t3.readDelegationActivity(target, next.threadId).catch(() => null);
    if (
      !activity ||
      activity.threadId !== next.threadId ||
      activity.projectId !== run.t3_project_id
    ) {
      complete = false;
      continue;
    }
    await retain(next.blockId)(activity);
    references.push(...nativeReferences(activity));
    complete &&= activity.stopComplete ?? activity.complete;
    remoteSources.push(
      ...(activity.remoteTasks ?? []).map((s) => ({ ...s, parentThreadId: next.threadId })),
    );
    native.push(...sources(activity));
    await addNativeCandidates(t3, run, next, activity, candidates);
  }
  complete &&= [...candidates.keys()].every((id) => members.some((m) => m.threadId === id));
  complete &&= saved.every((s) => members.some((m) => m.threadId === s.threadId));
  complete &&= prior.every((p) =>
    native.some(
      (n) =>
        n.threadId === p.threadId &&
        n.itemId === p.itemId &&
        n.executionId === p.executionId &&
        n.fingerprint === p.fingerprint,
    ),
  );
  return {
    members,
    native,
    remoteSources,
    references,
    complete,
    candidates: orderedCandidates(candidates),
  };
}
async function trustedMember(t3: T3Adapter, run: RunRow, member: StopMember, retain: RetainLocal) {
  if (member.parentThreadId === member.threadId) return factoryOwnedMember(t3, run, member, retain);
  if (member.parentThreadId === null) return false;
  const child = await t3
    .readChildEvidence(runTarget(run), {
      parentThreadId: member.parentThreadId,
      projectId: run.t3_project_id,
      childThreadId: member.threadId,
      childRunId: null,
    })
    .catch(() => null);
  const trusted =
    !!child?.scopeMatches &&
    !child.problem &&
    child.thread?.threadId === member.threadId &&
    child.thread.parentThreadId === member.parentThreadId &&
    child.thread.projectId === run.t3_project_id &&
    (child.thread.worktreePath === null || child.thread.worktreePath === run.workspace_root) &&
    (child.relationship === "t3-owned" || child.relationship === "provider-native");
  if (trusted)
    await retain({
      threadId: member.threadId,
      parentThreadId: member.parentThreadId,
      executionIds: [child.thread.activeRunId, child.thread.latestRunId],
    });
  return trusted;
}
export async function stopAggregate(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  runId: string | null,
) {
  if (!runId) return false;
  const aggregate = await t3.readDelegatedSettlement(runTarget(run), threadId, runId);
  return (
    aggregate.threadId === threadId &&
    aggregate.runId === runId &&
    aggregate.state === "settled" &&
    aggregate.resultRun?.runId === runId &&
    aggregate.status === aggregate.resultRun.status &&
    isTerminal(aggregate.status ?? "")
  );
}
/** Factory launched this worker. Its self marker is not T3 parentage, and a failed read is not idle. */
async function factoryOwnedMember(
  t3: T3Adapter,
  run: RunRow,
  member: StopMember,
  retain: RetainLocal,
) {
  try {
    const identity = await t3.readThreadIdentity(runTarget(run), member.threadId);
    if (
      identity.threadId !== member.threadId ||
      identity.projectId !== run.t3_project_id ||
      identity.parentThreadId !== null ||
      !checkoutWorkspace(identity.workspaceRoot, run.workspace_root)
    )
      return false;
    const observation = await t3.readExecution(runTarget(run), member.threadId);
    await retain({
      threadId: member.threadId,
      parentThreadId: member.parentThreadId,
      executionIds: [observation.activeRunId, observation.latestRunId],
    });
    return true;
  } catch {
    return true;
  }
}

/** Persist parents first even when offset pages or native outputs arrive child-first. */
function orderedCandidates(candidates: Map<string, StopMember>) {
  const pending = new Map(candidates);
  const ordered: StopMember[] = [];
  while (pending.size) {
    const next = [...pending.values()].find(
      (c) => c.parentThreadId === null || ordered.some((p) => p.threadId === c.parentThreadId),
    );
    if (!next) break;
    ordered.push(next);
    pending.delete(next.threadId);
  }
  return [...ordered, ...pending.values()];
}

async function resolveParents(t3: T3Adapter, run: RunRow, candidates: Map<string, StopMember>) {
  const target = runTarget(run);
  for (const member of candidates.values()) {
    if (member.parentThreadId === null && member.role === "descendant") {
      const detail = await t3
        .readChildEvidence(target, {
          parentThreadId: "",
          projectId: run.t3_project_id,
          childThreadId: member.threadId,
          childRunId: null,
        })
        .catch(() => null);
      member.parentThreadId = detail?.thread?.parentThreadId ?? null;
    }
  }
}
async function addNativeCandidates(
  t3: T3Adapter,
  run: RunRow,
  next: StopMember,
  activity: DelegationActivity,
  candidates: Map<string, StopMember>,
) {
  const target = runTarget(run);
  for (const threadId of nativeThreads(activity)) {
    if (candidates.has(threadId)) continue;
    const child = await t3
      .readChildEvidence(target, {
        parentThreadId: next.threadId,
        projectId: run.t3_project_id,
        childThreadId: threadId,
        childRunId: null,
      })
      .catch(() => null);
    candidates.set(threadId, {
      threadId,
      parentThreadId: child?.thread?.parentThreadId ?? null,
      blockId: next.blockId,
      role: "descendant",
    });
  }
}
