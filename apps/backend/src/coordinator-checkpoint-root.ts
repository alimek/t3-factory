import { checkpointCommandCovered } from "./checkpoint-command.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { CoordinationObservation } from "./coordinator-evidence-frontier.ts";
import type { RootObligation } from "./run-root-ledger.ts";

type Proof = CoordinationObservation;

/** Root can learn source work before Block observation assigns a binding.
 * Follow only positive ancestry into this proof's subtree; siblings stay independent. */
export function rootCheckpointCovered(
  sql: SqlClient.SqlClient,
  runId: string,
  proof: Proof,
  commandEnvironment: string,
) {
  return Effect.gen(function* () {
    const rows =
      yield* sql<RootObligation>`SELECT thread_id,kind,reference FROM run_root_obligations WHERE run_id=${runId}`;
    const scope = new Set(proof.members.map((m) => m.threadId));
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.kind !== "member") continue;
      const member = JSON.parse(row.reference) as { parentThreadId: string | null };
      if (!member.parentThreadId) continue;
      children.set(member.parentThreadId, [
        ...(children.get(member.parentThreadId) ?? []),
        row.thread_id,
      ]);
    }
    for (const threadId of scope)
      for (const child of children.get(threadId) ?? []) scope.add(child);
    return rows
      .filter((r) => scope.has(r.thread_id))
      .every((r) => covered(r, proof, commandEnvironment));
  });
}

function covered(row: RootObligation, proof: Proof, commandEnvironment: string) {
  const member = proof.members.find((m) => m.threadId === row.thread_id);
  if (!member) return false;
  if (row.kind === "execution")
    return member.observation.recentRuns.some((r) => r.runId === row.reference);
  if (row.kind === "member") {
    const parent = (JSON.parse(row.reference) as { parentThreadId: string | null }).parentThreadId;
    return !parent || member.parentThreadId === parent;
  }
  if (row.kind === "command")
    return checkpointCommandCovered(
      { threadId: row.thread_id, command: JSON.parse(row.reference) },
      proof,
      commandEnvironment,
    );
  const [itemId, executionId, fingerprint] = nativeIdentity(row);
  return proof.sources.some(
    (s) =>
      s.threadId === row.thread_id &&
      s.itemId === itemId &&
      s.executionId === executionId &&
      s.fingerprint === fingerprint,
  );
}

function nativeIdentity(row: RootObligation): [string, string, string] {
  if (row.kind === "native") return JSON.parse(row.reference);
  const source = JSON.parse(row.reference) as {
    itemId: string;
    parentRunId: string;
    fingerprint: string;
  };
  return [source.itemId, source.parentRunId, source.fingerprint];
}
