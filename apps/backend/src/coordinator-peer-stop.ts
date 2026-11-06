import { localCommandReferences } from "./native-command-creation.ts";
import {
  retainPeerCommands,
  peerCommandsCovered,
  peerStandalone,
  conflictingPeerMember,
  type PeerMember,
} from "./coordinator-peer-commands.ts";
import * as Effect from "effect/Effect";
import type { RemoteWork } from "@t3-factory/contracts";
import type { T3Adapter, T3Endpoint } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import type { ClosureAttempt } from "./runner-closure.ts";
import { peerLedger, type PeerObligation } from "./coordinator-peer-ledger.ts";
import { nativeReferences, nativeThreads } from "./coordinator-native-obligations.ts";
import { requestFrontierStop, requestRootStop } from "./run-root-stop.ts";
import { remoteInputRetention } from "./coordinator-remote-input.ts";
import { isTerminal } from "./runner-utils.ts";

type Member = PeerMember;
type Frontier = Omit<ClosureAttempt["frontier"][number], "blockId"> & { blockId: string | null };
type Ledger = ReturnType<typeof peerLedger>;
const memberRow = (member: Member): PeerObligation => ({
  threadId: member.threadId,
  kind: "member",
  reference: JSON.stringify(member),
});
const executionRows = (threadId: string, ids: readonly string[]): PeerObligation[] =>
  ids.map((reference) => ({ threadId, kind: "execution", reference }));

/** Only the explicitly named peer is routable. Nested peer references remain obligations. */
export async function collectPeerStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  work: readonly RemoteWork[],
) {
  const frontier: ClosureAttempt["frontier"][number][] = [];
  let complete = true;
  for (const root of work) {
    if (!root.threadId || !root.taskId || root.environmentId === run.environment_id) {
      complete = false;
      continue;
    }
    const [activation] = await Effect.runPromise(
      database.transaction(
        (sql) =>
          sql<{
            blockId: string;
          }>`SELECT block_id AS blockId FROM run_activations WHERE id=${root.activationId} AND run_id=${run.id}`,
      ),
    );
    if (!activation) {
      complete = false;
      continue;
    }
    try {
      const result = await collectTree(database, t3, run, root, activation.blockId);
      frontier.push(...result.frontier.map((f) => ({ ...f, blockId: activation.blockId })));
      complete &&= result.complete;
    } catch {
      complete = false;
    }
  }
  return { frontier, complete };
}
async function collectTree(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  root: Pick<RemoteWork, "environmentId" | "threadId">,
  blockId: string | null,
) {
  const target = { endpoint: run.endpoint, peerEnvironmentId: root.environmentId };
  const ledger = peerLedger(database, run, root.environmentId, root.threadId!);
  const saved = await ledger.read();
  const detail = await t3.readChildEvidence(target, {
    parentThreadId: "",
    projectId: "",
    childThreadId: root.threadId!,
    childRunId: null,
  });
  if (detail.thread?.threadId !== root.threadId || detail.thread.parentThreadId !== null)
    throw Error("Peer root identity unavailable");
  const rootMember = {
    threadId: root.threadId,
    parentThreadId: null,
    projectId: detail.thread.projectId,
  };
  await remoteInputRetention(
    database,
    run,
  )({
    environmentId: root.environmentId,
    threadId: rootMember.threadId,
    available: true,
    pendingRequestCount: detail.thread.pendingRequestCount,
  });
  await ledger.retain([memberRow(rootMember)]);
  await retainDetailExecutions(ledger, detail.thread, detail.execution, detail.problem);
  const { members, tree } = await discoverTree(t3, target, rootMember, ledger, saved);
  let complete = tree.parentThreadId === rootMember.threadId && tree.scanComplete;
  const frontier: Frontier[] = [];
  const visited = new Set<string>();
  const trustedMembers = new Set<string>();
  for (let pass = 0; pass < 100; pass++) {
    const member = [...members.values()].find(
      (m) =>
        !visited.has(m.threadId) &&
        (m.threadId === rootMember.threadId ||
          m.parentThreadId === null ||
          trustedMembers.has(m.parentThreadId)),
    );
    if (!member) break;
    visited.add(member.threadId);
    let trusted = false;
    try {
      if (member.threadId !== rootMember.threadId)
        await verifyChild(
          t3,
          target,
          member,
          ledger,
          remoteInputRetention(database, run),
          trustedMembers,
          members,
        );
      if (conflictingPeerMember(saved, member)) throw Error("Peer lineage changed");
      trusted = true;
      trustedMembers.add(member.threadId);
      const result = await observeMember(
        t3,
        target,
        member,
        ledger,
        members,
        blockId,
        remoteInputRetention(database, run),
      );
      frontier.push(result.frontier);
      complete &&= result.complete;
    } catch {
      complete = false;
    }
    if (trusted)
      await requestPeerMember(database, t3, run, ledger, member, blockId, root.environmentId);
  }
  complete &&= [...members.keys()].every((id) => visited.has(id));
  complete &&= peerCommandsCovered(await ledger.read(), root.environmentId, trustedMembers);
  return { frontier, complete };
}
async function verifyChild(
  t3: T3Adapter,
  target: T3Endpoint,
  member: Member,
  ledger: Ledger,
  retainInput: ReturnType<typeof remoteInputRetention>,
  trusted: ReadonlySet<string>,
  members: Map<string, Member>,
) {
  const child = await t3.readChildEvidence(target, {
    parentThreadId: member.parentThreadId!,
    projectId: member.projectId,
    childThreadId: member.threadId,
    childRunId: null,
  });
  if (child.thread?.parentThreadId === null) {
    await peerStandalone(t3, target, member, ledger, trusted, members);
    return;
  }
  if (
    !child.scopeMatches ||
    child.thread?.threadId !== member.threadId ||
    child.thread.parentThreadId !== member.parentThreadId ||
    child.thread.projectId !== member.projectId ||
    !["t3-owned", "provider-native"].includes(child.relationship)
  )
    throw Error("Foreign peer lineage");
  if (member.candidate) {
    member.candidate = false;
    await ledger.retain([memberRow(member)]);
  }
  await retainDetailExecutions(ledger, child.thread, child.execution, child.problem);
  await retainInput({
    environmentId: target.peerEnvironmentId!,
    threadId: member.threadId,
    available: true,
    pendingRequestCount: child.thread.pendingRequestCount,
  });
}
async function observeMember(
  t3: T3Adapter,
  target: T3Endpoint,
  member: Member,
  ledger: Ledger,
  members: Map<string, Member>,
  blockId: string | null,
  retainInput: ReturnType<typeof remoteInputRetention>,
) {
  const time = new Date().toISOString();
  const nativeComplete = await retainPeerActivity(t3, target, member, ledger, members);
  const queue = await t3.readQueue(target, member.threadId);
  if (queue.threadId !== member.threadId) throw Error("Peer queue scope changed");
  await ledger.retain([
    ...executionRows(member.threadId, queue.queuedRunIds),
    ...queue.queuedRunIds.map((reference) => ({
      threadId: member.threadId,
      kind: "queued" as const,
      reference,
    })),
  ]);
  const observation = await t3.readExecution(target, member.threadId);
  if (observation.threadId !== member.threadId || observation.projectId !== member.projectId)
    throw Error("Peer execution scope changed");
  await retainInput({
    environmentId: target.peerEnvironmentId!,
    threadId: member.threadId,
    available: true,
    pendingRequestCount: observation.pendingRequestCount,
  });
  await ledger.retain(
    executionRows(member.threadId, [
      ...observation.recentRuns.map((r) => r.runId),
      ...[observation.activeRunId, observation.latestRunId].filter((id): id is string => !!id),
    ]),
  );
  const obligations = await ledger.read();
  const recorded = obligations
    .filter((r) => r.threadId === member.threadId && r.kind === "execution")
    .map((r) => ({ runId: r.reference }));
  const exact = await t3.readExecution(target, member.threadId, recorded);
  if (exact.threadId !== member.threadId || exact.projectId !== member.projectId)
    throw Error("Peer exact scope changed");
  await retainInput({
    environmentId: target.peerEnvironmentId!,
    threadId: member.threadId,
    available: true,
    pendingRequestCount: exact.pendingRequestCount,
  });
  await ledger.retain(pointerRows(exact));
  await ledger.retain(
    executionRows(
      member.threadId,
      exact.recentRuns.map((r) => r.runId),
    ),
  );
  const requests = await t3.readNativeRequests(target, member.threadId);
  await retainInput({
    environmentId: target.peerEnvironmentId!,
    threadId: member.threadId,
    available: true,
    pendingRequestCount: requests.pendingRequestCount,
  });
  const frontier: Frontier = {
    environmentId: target.peerEnvironmentId!,
    blockId,
    threadId: member.threadId,
    projectId: member.projectId,
    workspaceRoot: exact.workspaceRoot ?? "",
    projectObservedAt: time,
    executionObservedAt: time,
    queueObservedAt: time,
    nativeObservedAt: time,
    activeRunId: exact.activeRunId,
    latestRunId: exact.latestRunId ?? null,
    executions: exact.recentRuns.map((r) => ({
      executionId: r.runId,
      status: r.status,
      ordinal: r.ordinal ?? null,
      sourceAt: r.sourceAt ?? null,
    })),
    queuedRunIds: queue.queuedRunIds,
    queueNextCursor: queue.nextCursor,
    pendingRequestCount: Math.max(
      observation.pendingRequestCount,
      exact.pendingRequestCount,
      requests.pendingRequestCount,
    ),
  };
  const covered = executionCoverage(member, exact, requests, recorded);
  let complete = covered && nativeComplete && terminalPeer(frontier);
  if (complete) {
    const aggregate = await t3.readDelegatedSettlement(
      target,
      member.threadId,
      frontier.latestRunId!,
    );
    complete =
      aggregate.state === "settled" &&
      aggregate.threadId === member.threadId &&
      aggregate.runId === frontier.latestRunId &&
      aggregate.resultRun?.runId === frontier.latestRunId &&
      isTerminal(aggregate.status ?? "") &&
      aggregate.status === aggregate.resultRun.status;
  }
  return { frontier, complete };
}
function terminalPeer(f: Frontier) {
  return (
    !f.activeRunId &&
    !!f.latestRunId &&
    f.executions.some((e) => e.executionId === f.latestRunId) &&
    f.executions.every((e) => isTerminal(e.status)) &&
    !f.queuedRunIds.length &&
    f.queueNextCursor === null &&
    f.pendingRequestCount === 0
  );
}

async function requestPeerMember(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  ledger: Ledger,
  member: Member,
  blockId: string | null,
  environmentId: string,
) {
  const saved = (await ledger.read()).filter((r) => r.threadId === member.threadId);
  const frontier = {
    threadId: member.threadId,
    projectId: member.projectId,
    blockId,
    activeRunId: null,
    latestRunId: null,
    executions: saved
      .filter((r) => r.kind === "execution")
      .map((r) => ({ executionId: r.reference, status: "unknown", ordinal: null, sourceAt: null })),
    queuedRunIds: saved.filter((r) => r.kind === "queued").map((r) => r.reference),
  };
  if (blockId === null) {
    const ids = frontier.executions.map((e) => e.executionId);
    await Effect.runPromise(
      requestRootStop(database, t3, run, member.threadId, ids, undefined, environmentId),
    );
    for (const id of frontier.queuedRunIds)
      await Effect.runPromise(
        requestRootStop(database, t3, run, member.threadId, ids, id, environmentId),
      );
    return;
  }
  const blockFrontier = { ...frontier, blockId };
  await Effect.runPromise(
    requestFrontierStop(database, t3, run, blockFrontier, undefined, environmentId),
  );
  for (const id of frontier.queuedRunIds)
    await Effect.runPromise(
      requestFrontierStop(database, t3, run, blockFrontier, id, environmentId),
    );
}

async function retainPeerActivity(
  t3: T3Adapter,
  target: T3Endpoint,
  member: Member,
  ledger: Ledger,
  members: Map<string, Member>,
) {
  const activity = await t3.readDelegationActivity(target, member.threadId);
  if (activity.threadId !== member.threadId || activity.projectId !== member.projectId)
    throw Error("Peer native scope changed");
  const native = [
    ...activity.invocations,
    ...(activity.taskResults ?? []),
    ...(activity.followups ?? []),
    ...(activity.remoteTasks ?? []),
    ...(activity.commands ?? []),
  ].map((item) => ({
    threadId: member.threadId,
    kind: "native" as const,
    reference: JSON.stringify([item.itemId, item.parentRunId, item.fingerprint]),
  }));
  await retainPeerCommands(ledger, activity, target.peerEnvironmentId!);
  await ledger.retain([
    ...native,
    ...nativeReferences(activity).map((r) => ({
      threadId: r.thread_id,
      kind: "execution" as const,
      reference: r.execution_id,
    })),
    ...(activity.remoteTasks ?? []).map((r) => ({
      threadId: member.threadId,
      kind: "nested" as const,
      reference: JSON.stringify(r.remote),
    })),
  ]);
  for (const threadId of new Set([
    ...nativeThreads(activity),
    ...localCommandReferences(activity.commands, target.peerEnvironmentId!).map((r) => r.threadId),
  ])) {
    if (members.has(threadId)) continue;
    const candidate = {
      threadId,
      projectId: member.projectId,
      parentThreadId: member.threadId,
      candidate: true,
    };
    await ledger.retain([memberRow(candidate)]);
    members.set(threadId, candidate);
  }
  const obligations = await ledger.read();
  return (
    activity.complete &&
    obligations
      .filter((r) => r.threadId === member.threadId && r.kind === "native")
      .every((r) => native.some((n) => n.reference === r.reference)) &&
    peerCommandsCovered(obligations, target.peerEnvironmentId!, new Set(members.keys()))
  );
}

function executionCoverage(
  member: Member,
  exact: import("./adapters/t3.ts").ExecutionObservation,
  requests: Awaited<ReturnType<T3Adapter["readNativeRequests"]>>,
  recorded: readonly { runId: string }[],
) {
  return (
    exact.threadId === member.threadId &&
    exact.projectId === member.projectId &&
    requests.threadId === member.threadId &&
    requests.projectId === member.projectId &&
    recorded.every((r) => exact.recentRuns.some((e) => e.runId === r.runId))
  );
}

async function discoverTree(
  t3: T3Adapter,
  target: T3Endpoint,
  rootMember: Member,
  ledger: Ledger,
  saved: readonly PeerObligation[],
) {
  const members = new Map<string, Member>([[rootMember.threadId, rootMember]]);
  // Saved candidates include previously discovered native identities even if lists lose them.
  for (const row of saved.filter((r) => r.kind === "member")) {
    const m: Member = JSON.parse(row.reference);
    if (
      m.threadId !== rootMember.threadId &&
      (!members.has(m.threadId) || members.get(m.threadId)?.candidate)
    )
      members.set(m.threadId, m);
  }
  const tree = await t3
    .readDescendants(target, rootMember.threadId)
    .catch(() => ({ parentThreadId: rootMember.threadId, descendants: [], scanComplete: false }));
  for (const child of tree.descendants) {
    const member = {
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      projectId: child.projectId,
    };
    await ledger.retain([memberRow(member)]);
    members.set(member.threadId, member);
  }
  return { members, tree };
}

function pointerRows(thread: {
  threadId: string;
  activeRunId: string | null;
  latestRunId?: string | null;
}) {
  return executionRows(
    thread.threadId,
    [thread.activeRunId, thread.latestRunId].filter((id): id is string => !!id),
  );
}

/** A Run-owned remote pointer has no activation or synthetic Block. */
export async function collectRunPeerStop(
  database: RunnerDatabase,
  t3: T3Adapter,
  run: RunRow,
  remote: { environmentId: string; threadId: string },
) {
  const result = await collectTree(database, t3, run, remote, null);
  return {
    ...result,
    frontier: result.frontier.map(({ blockId, ...entry }) => {
      if (blockId !== null) throw Error("Run-owned peer acquired Block membership");
      return entry;
    }),
  };
}

async function retainDetailExecutions(
  ledger: Ledger,
  thread: NonNullable<import("./adapters/coordination-evidence.ts").ChildEvidence["thread"]>,
  execution: import("./adapters/coordination-evidence.ts").ChildEvidence["execution"],
  problem: string | undefined,
) {
  await ledger.retain([
    ...pointerRows(thread),
    ...executionRows(thread.threadId, execution ? [execution.runId] : []),
  ]);
  if (problem) throw Error(problem);
}
