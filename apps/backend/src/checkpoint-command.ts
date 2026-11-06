import type { CoordinationObservation } from "./coordinator-evidence-frontier.ts";
import { commandsCovered, type CommandSource } from "./native-command-creation.ts";

type Proof = CoordinationObservation;

/** Old unresolved rows need fresh matching evidence; a command never grants its target ownership. */
export function checkpointCommandCovered(
  source: CommandSource,
  proof: Proof,
  environmentId: string,
) {
  const { command } = source;
  const current = proof.commands.find(
    (c) =>
      c.itemId === command.itemId &&
      c.parentRunId === command.parentRunId &&
      c.fingerprint === command.fingerprint,
  );
  if (
    !current ||
    !proof.sources.some(
      (s) =>
        s.threadId === source.threadId &&
        s.itemId === current.itemId &&
        s.executionId === current.parentRunId &&
        s.fingerprint === current.fingerprint,
    )
  )
    return false;
  return commandsCovered(
    [{ threadId: source.threadId, command: current }],
    environmentId,
    new Set(proof.members.map((m) => m.threadId)),
  );
}
