import { commandsCovered } from "./native-command-creation.ts";
import { directWorkerSelection, factoryOwnedSelection } from "./run-worker-selection.ts";
import { retainedSelection, type LocalExecution } from "./coordinator-selection.ts";
import type { RetainLocal } from "./coordinator-local-observations.ts";
import { observeRemoteWork, REMOTE_HOLD, type RemoteSource } from "./coordinator-remote.ts";
import {
  nativeReferences,
  nativeThreads,
  type RetainNative,
} from "./coordinator-native-obligations.ts";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorEvidence } from "@t3-factory/contracts";
import type { T3Adapter, ExecutionObservation } from "./adapters/t3.ts";
import type { DelegationActivity } from "./adapters/delegation-activity.ts";
import type { BlockRow, RunRow } from "./runner-types.ts";
import { runTarget, isTerminal } from "./runner-utils.ts";

import type { CoordinationSaved, NativeSource } from "./coordinator-evidence-saved.ts";

type Invocation = DelegationActivity["invocations"][number];
type UnobservedMember = { threadId: string; parentThreadId: string | null };
function nativeSources(activity: DelegationActivity): NativeSource[] {
  return [
    ...activity.invocations,
    ...(activity.commands ?? []),
    ...(activity.taskResults ?? []),
    ...(activity.followups ?? []),
    ...(activity.remoteTasks ?? []),
  ].map((i) => ({
    threadId: activity.threadId,
    itemId: i.itemId,
    executionId: i.parentRunId,
    fingerprint: i.fingerprint,
  }));
}
export interface MemberObservation {
  threadId: string;
  parentThreadId: string | null;
  role: "worker" | "descendant";
  observation: ExecutionObservation;
  clear: boolean;
  requestsClear: boolean;
}
async function memberRead(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  parentThreadId: string | null,
  role: MemberObservation["role"],
  retainLocal: RetainLocal,
  localExecutions: readonly LocalExecution[],
  recovered: CoordinationSaved["recoveredFailures"] = [],
  executions: CoordinationSaved["executions"] = [],
  runlessNativeIdle = false,
): Promise<MemberObservation> {
  const target = runTarget(run);
  // Recent pages cannot discharge an older saved execution obligation after restart.
  const recorded = executions
    .filter((e) => e.thread_id === threadId)
    .map((e) => ({ runId: e.execution_id }));
  let observation = await t3.readExecution(target, threadId, recorded);
  if (
    observation.threadId !== threadId ||
    observation.projectId !== run.t3_project_id ||
    (observation.workspaceRoot !== null && observation.workspaceRoot !== run.workspace_root)
  )
    throw Error("Coordinator member scope changed.");
  await retainLocal({
    threadId,
    parentThreadId,
    executionIds: [
      observation.activeRunId,
      observation.latestRunId,
      ...observation.recentRuns.map((r) => r.runId),
    ],
    ordinals: observation.recentRuns,
  });
  observation = retainExecutionOrder(observation, localExecutions);
  verifyExecutionPointers(observation);
  if (!recorded.every((e) => observation.recentRuns.some((r) => r.runId === e.runId)))
    throw Error("Recorded coordinator execution coverage is incomplete.");
  const queue = await t3.readQueue(target, threadId);
  const native = await t3.readNativeRequests(target, threadId);
  if (
    queue.threadId !== threadId ||
    native.threadId !== threadId ||
    native.projectId !== run.t3_project_id
  )
    throw Error("Coordinator member scope changed.");
  const requestsClear =
    queue.queuedRunIds.length === 0 &&
    queue.nextCursor === null &&
    native.pendingRequestCount === 0 &&
    observation.pendingRequestCount === 0;
  return {
    threadId,
    parentThreadId,
    role,
    observation,
    requestsClear,
    clear: requestsClear && memberExecutionsComplete(observation, recovered, runlessNativeIdle),
  };
}

function memberExecutionsComplete(
  observation: ExecutionObservation,
  recovered: NonNullable<CoordinationSaved["recoveredFailures"]>,
  runlessNativeIdle: boolean,
) {
  const { activeRunId, latestRunId, recentRuns, threadId } = observation;
  if (activeRunId) return false;
  // Native projections have no execution to finish; aggregate settlement still gates release.
  if (runlessNativeIdle && latestRunId === null && recentRuns.length === 0) return true;
  return (
    !!latestRunId &&
    recentRuns.some((r) => r.runId === latestRunId) &&
    new Set(recentRuns.map((r) => r.runId)).size === recentRuns.length &&
    recentRuns.every(
      (r) =>
        r.status === "completed" ||
        (r.status === "failed" &&
          recovered.some((e) => e.threadId === threadId && e.executionId === r.runId)),
    )
  );
}
function retainExecutionOrder(
  observation: ExecutionObservation,
  localExecutions: readonly LocalExecution[],
) {
  return {
    ...observation,
    recentRuns: observation.recentRuns.map((r) => {
      const known = localExecutions.find(
        (e) => e.thread_id === observation.threadId && e.execution_id === r.runId,
      );
      if (
        typeof known?.ordinal === "number" &&
        r.ordinal !== undefined &&
        known.ordinal !== r.ordinal
      )
        throw Error("Historical execution order conflicts.");
      return { ...r, ...(typeof known?.ordinal === "number" ? { ordinal: known.ordinal } : {}) };
    }),
  };
}
function verifyExecutionPointers(observation: ExecutionObservation) {
  const { activeRunId, latestRunId, recentRuns } = observation;
  for (const id of [activeRunId, latestRunId])
    if (id && !recentRuns.some((r) => r.runId === id))
      throw Error("Current coordinator execution evidence is incomplete.");
  const active = recentRuns.find((r) => r.runId === activeRunId);
  const latest = recentRuns.find((r) => r.runId === latestRunId);
  if (
    (active && isTerminal(active.status)) ||
    (latest?.ordinal !== undefined &&
      recentRuns.some((r) => r.ordinal !== undefined && r.ordinal > latest.ordinal!))
  )
    throw Error("Current coordinator execution pointers conflict with observed work.");
}
type Candidate = { parentId: string | null; runId: string | null };
function candidatesFor(
  saved: CoordinationSaved,
  tree: Awaited<ReturnType<T3Adapter["readDescendants"]>>,
  activity: DelegationActivity,
) {
  const candidates = new Map<string, Candidate>();
  for (const member of saved.members)
    if (member.thread_id !== activity.threadId)
      candidates.set(member.thread_id, {
        parentId: member.parent_thread_id,
        runId: null,
      });
  for (const child of tree.descendants)
    if (!candidates.has(child.threadId))
      candidates.set(child.threadId, { parentId: child.parentThreadId!, runId: null });
  addInvocations(candidates, activity);
  return candidates;
}
function addInvocations(candidates: Map<string, Candidate>, activity: DelegationActivity) {
  for (const threadId of nativeThreads(activity)) {
    if (threadId === activity.threadId || candidates.has(threadId)) continue;
    candidates.set(threadId, { parentId: null, runId: null });
  }
}
function activityMatches(activity: DelegationActivity, run: RunRow, threadId: string) {
  return (
    activity.threadId === threadId && activity.projectId === run.t3_project_id && activity.complete
  );
}
async function readCandidate(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  candidate: Candidate,
  executions: CoordinationSaved["executions"][number][],
  retain: RetainNative,
  retainLocal: RetainLocal,
  localExecutions: readonly LocalExecution[],
  members: readonly MemberObservation[],
) {
  const target = runTarget(run);
  const lineage = await candidateLineage(t3, run, threadId, candidate, members);
  const { actualParent } = lineage;
  const pointers = [lineage.child.thread!.activeRunId, lineage.child.thread!.latestRunId];
  await retainLocal({ threadId, parentThreadId: actualParent, executionIds: pointers });
  if (lineage.child.problem) throw Error(lineage.child.problem);
  const child = retainedSelection(lineage.child, localExecutions);
  await retainLocal({
    threadId,
    parentThreadId: actualParent,
    executionIds: [],
    selections: child.execution ? [child.execution] : [],
  });
  executions.push(
    ...pointers
      .filter((id): id is string => id !== null)
      .map((execution_id) => ({ thread_id: threadId, execution_id, activation_id: null })),
  );
  const native: DelegationActivity = await t3
    .readDelegationActivity(target, threadId)
    .catch(() => ({
      threadId,
      projectId: run.t3_project_id,
      complete: false,
      invocations: [],
      problem: "Native obligations unavailable.",
    }));
  if (native.threadId !== threadId || native.projectId !== run.t3_project_id)
    throw Error("Native scope changed.");
  await retain(native);
  executions.push(...nativeReferences(native).map((r) => ({ ...r, activation_id: null })));
  const member = await memberRead(
    t3,
    run,
    threadId,
    actualParent,
    "descendant",
    retainLocal,
    localExecutions,
    [],
    executions,
    child.runlessNativeIdle === true,
  );
  const consistent =
    child.execution === null ||
    member.observation.recentRuns.some(
      (r) => r.runId === child.execution!.runId && r.status === child.execution!.status,
    );
  return { member, native, verified: consistent && activityMatches(native, run, threadId) };
}
function unreadCandidates(
  candidates: Map<string, Candidate>,
  members: readonly MemberObservation[],
) {
  return [...candidates]
    .filter(([threadId]) => !members.some((m) => m.threadId === threadId))
    .map(([threadId, candidate]) => ({ threadId, parentThreadId: candidate.parentId }));
}
async function readMembers(
  t3: T3Adapter,
  run: RunRow,
  candidates: Map<string, Candidate>,
  parent: MemberObservation,
  executions: CoordinationSaved["executions"][number][],
  retain: RetainNative,
  retainLocal: RetainLocal,
  localExecutions: readonly LocalExecution[],
) {
  const members = [parent];
  const sources: NativeSource[] = [];
  const workSources: NativeSource[] = [];
  const commands: import("./adapters/native-command.ts").NativeCommand[] = [];
  const remoteSources: RemoteSource[] = [];
  const attempted = new Set<string>();
  const visitLimit = candidates.size + 100;
  let verified = true;
  for (let visits = 0; visits < visitLimit; visits++) {
    const next = nextCandidate(candidates, attempted, members);
    if (!next) break;
    const [threadId, candidate] = next;
    attempted.add(threadId);
    const read = await readCandidate(
      t3,
      run,
      threadId,
      candidate,
      executions,
      retain,
      retainLocal,
      localExecutions,
      members,
    ).catch(() => null);
    if (!read) {
      verified = false;
      continue;
    }
    sources.push(...nativeSources(read.native));
    workSources.push(...nativeSources({ ...read.native, taskResults: [] }));
    commands.push(...(read.native.commands ?? []));
    remoteSources.push(
      ...(read.native.remoteTasks ?? []).map((s) => ({ ...s, parentThreadId: threadId })),
    );
    verified &&= read.verified;
    members.push(read.member);
    addInvocations(candidates, read.native);
  }
  const unobserved = unreadCandidates(candidates, members);
  verified &&= unobserved.length === 0;
  return {
    members,
    verified,
    sources,
    workSources,
    commands,
    unobserved,
    remoteSources,
  };
}
/** Persisted IDs and native listings have no ancestry ordering guarantee. */
function nextCandidate(
  candidates: Map<string, Candidate>,
  attempted: ReadonlySet<string>,
  members: readonly MemberObservation[],
) {
  const known = new Set(members.map((member) => member.threadId));
  const pending = [...candidates].filter(
    ([threadId]) => !attempted.has(threadId) && !known.has(threadId),
  );
  return (
    pending.find(([, candidate]) => candidate.parentId !== null && known.has(candidate.parentId)) ??
    pending.find(([, candidate]) => candidate.parentId === null)
  );
}

function aggregateSettled(
  aggregate: Awaited<ReturnType<T3Adapter["readDelegatedSettlement"]>> | null,
  parentId: string,
  latest: string | null | undefined,
) {
  return (
    aggregate?.threadId === parentId &&
    aggregate.runId === latest &&
    aggregate.state === "settled" &&
    aggregate.status === "completed" &&
    aggregate.resultRun?.runId === latest &&
    aggregate.resultRun?.status === "completed"
  );
}
function coordinationProblem(
  members: readonly MemberObservation[],
  designated: boolean,
  verified: boolean,
  recovered: CoordinationSaved["recoveredFailures"] = [],
) {
  if (
    members.some((m) =>
      m.observation.recentRuns.some(
        (r) =>
          ["failed", "cancelled", "interrupted"].includes(r.status) &&
          !recovered.some(
            (e) => e.threadId === m.threadId && e.executionId === r.runId && r.status === "failed",
          ),
      ),
    )
  )
    return "execution-failed";
  if (!designated) return "Worker delegation provenance or planned selection is unverified.";
  return verified ? null : "Coordinator descendant or native obligation coverage is unverified.";
}
function coordinationEvidence(
  members: readonly MemberObservation[],
  context: {
    designated: boolean;
    verified: boolean;
    remoteHeld: boolean;
    release: boolean;
    aggregate: Awaited<ReturnType<T3Adapter["readDelegatedSettlement"]>> | null;
    tree: Awaited<ReturnType<T3Adapter["readDescendants"]>>;
    recoveredFailures: CoordinationSaved["recoveredFailures"];
  },
): CoordinatorEvidence {
  const { designated, verified, remoteHeld, release, tree, aggregate, recoveredFailures } = context;
  return {
    version: 1,
    observedAt: new Date().toISOString(),
    designation: designated,
    lineageCoverage: tree.coverage,
    lineageScanComplete: tree.scanComplete,
    aggregateState: aggregate?.state ?? "unknown",
    holdReason: remoteHeld
      ? REMOTE_HOLD
      : release
        ? null
        : coordinationHold(members, designated, verified, aggregate, recoveredFailures),
    release,
    limitations: [
      "Local bounded observations are not atomic; remote coverage is unavailable.",
      "Independent child reads omit options; settings are verified against native acceptance.",
    ],
    members: members.map((m) => ({
      threadId: m.threadId,
      role: m.role,
      executionIds: m.observation.recentRuns.map((r) => r.runId),
    })),
  };
}

function coordinationHold(
  members: readonly MemberObservation[],
  designated: boolean,
  verified: boolean,
  aggregate: Awaited<ReturnType<T3Adapter["readDelegatedSettlement"]>> | null,
  recovered: CoordinationSaved["recoveredFailures"],
) {
  return (
    coordinationProblem(members, designated, verified, recovered) ??
    aggregate?.problem ??
    "Associated executions, queues or native requests remain unresolved."
  );
}

async function candidateLineage(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  candidate: Candidate,
  members: readonly MemberObservation[],
) {
  const target = runTarget(run);
  let child = await t3.readChildEvidence(target, {
    parentThreadId: candidate.parentId ?? "",
    projectId: run.t3_project_id,
    childThreadId: threadId,
    childRunId: candidate.runId,
  });
  const actualParent = child.thread?.parentThreadId;
  if (
    !actualParent ||
    !members.some((m) => m.threadId === actualParent) ||
    (candidate.parentId !== null && candidate.parentId !== actualParent)
  )
    throw Error("Unverified descendant lineage.");
  if (candidate.parentId === null)
    child = await t3.readChildEvidence(target, {
      parentThreadId: actualParent,
      projectId: run.t3_project_id,
      childThreadId: threadId,
      childRunId: candidate.runId,
    });
  const scope =
    child.scopeMatches &&
    (child.relationship === "t3-owned" || child.relationship === "provider-native") &&
    child.thread?.parentThreadId === actualParent &&
    child.thread.projectId === run.t3_project_id &&
    child.thread.threadId === threadId &&
    (child.thread.worktreePath === null || child.thread.worktreePath === run.workspace_root);
  if (!scope) throw Error("Unverified descendant scope.");
  return { child, actualParent };
}

function verifyNativeScope(activity: DelegationActivity, run: RunRow, threadId: string) {
  if (
    nativeReferences(activity).length &&
    (activity.threadId !== threadId || activity.projectId !== run.t3_project_id)
  )
    throw Error("Native scope changed.");
}
function coversNativeExecutions(
  executions: CoordinationSaved["executions"],
  members: readonly MemberObservation[],
) {
  return executions.every((e) =>
    members.some(
      (m) =>
        m.threadId === e.thread_id &&
        m.observation.recentRuns.some((r) => r.runId === e.execution_id),
    ),
  );
}

/** Checkpoint evidence is an immutable frontier, not permission for later commands. */
function checkpointWork(
  saved: CoordinationSaved,
  members: readonly MemberObservation[],
  sources: readonly NativeSource[],
  unobserved: readonly UnobservedMember[],
) {
  const checkpoint = saved.checkpointEvidence;
  if (!checkpoint) return false;
  const assignedElsewhere = (threadId: string, executionId: string) =>
    saved.executions.some(
      (e) =>
        e.thread_id === threadId &&
        e.execution_id === executionId &&
        e.activation_id !== null &&
        e.activation_id !== saved.id,
    );
  return (
    unobserved.some(
      (m) =>
        !checkpoint.members.some((old) => old.threadId === m.threadId) &&
        !saved.executions.some(
          (e) =>
            e.thread_id === m.threadId && e.activation_id !== null && e.activation_id !== saved.id,
        ),
    ) ||
    members.some((m) =>
      m.observation.recentRuns.some(
        (e) =>
          !checkpoint.members.some(
            (old) => old.threadId === m.threadId && old.executionIds.includes(e.runId),
          ) && !assignedElsewhere(m.threadId, e.runId),
      ),
    ) ||
    sources.some(
      (s) =>
        !checkpoint.sources.some((old) => isDeepStrictEqual(old, s)) &&
        !assignedElsewhere(s.threadId, s.executionId),
    )
  );
}

function observedProblem(
  unauthorized: boolean,
  remoteHeld: boolean,
  members: readonly MemberObservation[],
  designated: boolean,
  verified: boolean,
  saved: CoordinationSaved,
  commandsKnown: boolean,
) {
  if (unauthorized) return "Unauthorized post-checkpoint work requires attention.";
  if (!commandsKnown) return "Worker native command target or result is unverified.";
  if (!designated && saved.workerParentThreadId)
    return "Worker execution selection or lineage differs from the captured settings or is unavailable.";
  if (remoteHeld) return REMOTE_HOLD;
  return coordinationProblem(members, designated, verified, saved.recoveredFailures);
}

/** A bounded local frontier rooted at the direct worker; P and sibling Blocks stay outside it.
 * Never an atomic or remote completeness claim. */
export async function readCoordination(
  t3: T3Adapter,
  run: RunRow,
  block: BlockRow,
  saved: CoordinationSaved,
  retain: RetainNative,
  retainRemoteInput: Parameters<typeof observeRemoteWork>[4],
  retainLocal: RetainLocal,
) {
  const target = runTarget(run),
    threadId = block.thread_id!;
  const { activity, executions, tree } = await nativeFrontier(t3, run, threadId, saved, retain);
  const worker = await memberRead(
    t3,
    run,
    threadId,
    saved.workerParentThreadId ?? null,
    "worker",
    retainLocal,
    saved.localExecutions,
    saved.recoveredFailures,
    executions,
  );
  const accepted = saved.accepted_json
    ? (JSON.parse(saved.accepted_json) as Invocation)
    : undefined;
  const designated =
    saved.workerParentThreadId === threadId
      ? await factoryOwnedSelection(t3, run, block, saved)
      : !!accepted && (await directWorkerSelection(t3, run, block, saved, retainLocal));
  const candidates = candidatesFor(saved, tree, activity);
  const read = await readMembers(
    t3,
    run,
    candidates,
    worker,
    executions,
    retain,
    retainLocal,
    saved.localExecutions,
  );
  const { remoteSources, remoteObservations, remoteHeld } = await remoteFrontier(
    t3,
    run,
    saved,
    activity,
    read.remoteSources,
    retainRemoteInput,
  );
  const { sources, retained, unauthorized } = checkpointFrontier(saved, activity, read);
  const commandScope = commandsCovered(
    observedCommands(activity, read),
    run.environment_id,
    new Set(read.members.map((m) => m.threadId)),
  );
  const verified =
    !unauthorized &&
    commandScope &&
    activityMatches(activity, run, threadId) &&
    coversNativeExecutions(executions, read.members) &&
    retained &&
    read.verified &&
    tree.parentThreadId === threadId &&
    tree.scanComplete;
  const latest = worker.observation.activeRunId ?? worker.observation.latestRunId;
  const aggregate = latest ? await t3.readDelegatedSettlement(target, threadId, latest) : null;
  const quiet = !remoteHeld && designated && verified && read.members.every((m) => m.clear);
  const release = quiet && aggregateSettled(aggregate, threadId, latest);
  return {
    remoteSources,
    commands: [...(activity.commands ?? []), ...read.commands],
    remoteObservations,
    assessmentReady: designated && verified,
    members: read.members,
    sources,
    unobserved: read.unobserved,
    accepted,
    evidence: coordinationEvidence(read.members, {
      designated,
      verified,
      remoteHeld,
      release,
      aggregate,
      tree,
      recoveredFailures: saved.recoveredFailures,
    }),
    problem: observedProblem(
      unauthorized,
      remoteHeld,
      read.members,
      designated,
      verified,
      saved,
      commandScope,
    ),
  };
}

async function nativeFrontier(
  t3: T3Adapter,
  run: RunRow,
  threadId: string,
  saved: CoordinationSaved,
  retain: RetainNative,
) {
  const activity = await t3.readDelegationActivity(runTarget(run), threadId);
  verifyNativeScope(activity, run, threadId);
  await retain(activity);
  return {
    activity,
    executions: [
      ...saved.executions,
      ...nativeReferences(activity).map((r) => ({ ...r, activation_id: null })),
    ],
    tree: await t3.readDescendants(runTarget(run), threadId),
  };
}
async function remoteFrontier(
  t3: T3Adapter,
  run: RunRow,
  saved: CoordinationSaved,
  activity: DelegationActivity,
  descendants: RemoteSource[],
  retainRemoteInput: Parameters<typeof observeRemoteWork>[4],
) {
  const remoteSources = [
    ...(activity.remoteTasks ?? []).map((s) => ({ ...s, parentThreadId: activity.threadId })),
    ...descendants,
  ];
  return {
    remoteSources,
    remoteObservations: await observeRemoteWork(
      t3,
      run,
      remoteSources,
      saved.remoteWork,
      retainRemoteInput,
    ),
    remoteHeld: remoteSources.length > 0 || saved.remoteWork.length > 0,
  };
}
/** Read-only task observations extend evidence without extending executable work authority. */
function checkpointFrontier(
  saved: CoordinationSaved,
  activity: DelegationActivity,
  read: Awaited<ReturnType<typeof readMembers>>,
) {
  const sources = [...nativeSources(activity), ...read.sources];
  return {
    sources,
    retained: saved.sources.every((prior) =>
      sources.some((source) => isDeepStrictEqual({ ...prior }, source)),
    ),
    unauthorized: checkpointWork(
      saved,
      read.members,
      [...nativeSources({ ...activity, taskResults: [] }), ...read.workSources],
      read.unobserved,
    ),
  };
}

function observedCommands(
  activity: DelegationActivity,
  read: Awaited<ReturnType<typeof readMembers>>,
) {
  return [
    ...(activity.commands ?? []).map((command) => ({ threadId: activity.threadId, command })),
    ...read.commands.map((command) => {
      const sources = read.sources.filter(
        (s) =>
          s.itemId === command.itemId &&
          s.executionId === command.parentRunId &&
          s.fingerprint === command.fingerprint,
      );
      return { threadId: sources.length === 1 ? sources[0]!.threadId : "", command };
    }),
  ];
}

export type CoordinationObservation = Awaited<ReturnType<typeof readCoordination>>;
