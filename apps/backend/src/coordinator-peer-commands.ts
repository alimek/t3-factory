import type { NativeCommand } from "./adapters/native-command.ts";
import type { DelegationActivity } from "./adapters/delegation-activity.ts";
import type { peerLedger, PeerObligation } from "./coordinator-peer-ledger.ts";
import { commandCreation, commandsCovered, type CommandSource } from "./native-command-creation.ts";
import type { T3Adapter, T3Endpoint } from "./adapters/t3.ts";

type Ledger = ReturnType<typeof peerLedger>;
export type PeerMember = {
  threadId: string;
  parentThreadId: string | null;
  projectId: string;
  candidate?: boolean;
};
function sources(rows: readonly PeerObligation[]): CommandSource[] {
  return rows
    .filter((r) => r.kind === "nested")
    .flatMap((row) => {
      const parsed = JSON.parse(row.reference) as { command?: NativeCommand };
      return parsed.command ? [{ threadId: row.threadId, command: parsed.command }] : [];
    });
}
export function peerCommandsCovered(
  rows: readonly PeerObligation[],
  environmentId: string,
  trusted: ReadonlySet<string>,
) {
  const nested = rows.filter((r) => r.kind === "nested");
  const commands = sources(rows);
  return nested.length === commands.length && commandsCovered(commands, environmentId, trusted);
}
export async function retainPeerCommands(
  ledger: Ledger,
  activity: DelegationActivity,
  environmentId: string,
) {
  await ledger.retain(
    (activity.commands ?? []).flatMap((command) => [
      {
        threadId: activity.threadId,
        kind: "nested" as const,
        reference: JSON.stringify({ command }),
      },
      ...command.references
        .filter(
          (r) =>
            (r.environmentId === null || r.environmentId === environmentId) &&
            r.executionId !== null,
        )
        .map((r) => ({
          threadId: r.threadId,
          kind: "execution" as const,
          reference: r.executionId!,
        })),
    ]),
  );
}
export async function peerStandalone(
  t3: T3Adapter,
  target: T3Endpoint,
  member: PeerMember,
  ledger: Ledger,
  trusted: ReadonlySet<string>,
  members: Map<string, PeerMember>,
) {
  const proof = commandCreation(
    sources(await ledger.read()),
    member.threadId,
    target.peerEnvironmentId!,
    trusted,
  );
  if (!proof?.executionId) throw Error("Peer standalone creation is unproven");
  const detail = await t3.readChildEvidence(target, {
    parentThreadId: "",
    projectId: member.projectId,
    childThreadId: member.threadId,
    childRunId: proof.executionId,
  });
  const thread = detail.thread;
  if (
    !thread ||
    thread.threadId !== member.threadId ||
    thread.parentThreadId !== null ||
    thread.projectId !== member.projectId ||
    thread.creationSource !== "mcp" ||
    thread.createdBy !== "agent" ||
    detail.target.childThreadId !== member.threadId ||
    detail.target.childRunId !== proof.executionId ||
    detail.target.projectId !== member.projectId ||
    (!detail.problem && detail.execution?.runId !== proof.executionId)
  )
    throw Error("Peer standalone creation scope changed");
  await ledger.retain(
    [proof.executionId, thread.activeRunId, thread.latestRunId, detail.execution?.runId]
      .filter((id): id is string => !!id)
      .map((reference) => ({ threadId: member.threadId, kind: "execution", reference })),
  );
  member.parentThreadId = null;
  member.candidate = false;
  await ledger.retain([
    { threadId: member.threadId, kind: "member", reference: JSON.stringify(member) },
  ]);
  const tree = await t3.readDescendants(target, member.threadId);
  if (tree.parentThreadId !== member.threadId || !tree.scanComplete)
    throw Error("Peer standalone descendants unavailable");
  for (const child of tree.descendants) {
    const candidate = {
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      projectId: child.projectId,
    };
    await ledger.retain([
      { threadId: child.threadId, kind: "member", reference: JSON.stringify(candidate) },
    ]);
    if (!members.has(child.threadId)) members.set(child.threadId, candidate);
  }
}
export function conflictingPeerMember(saved: readonly PeerObligation[], member: PeerMember) {
  return saved.some(
    (r) =>
      r.threadId === member.threadId &&
      r.kind === "member" &&
      !(JSON.parse(r.reference) as PeerMember).candidate &&
      r.reference !== JSON.stringify(member),
  );
}
