import type { NativeCommand } from "./adapters/native-command.ts";
import { fingerprint } from "./runner-utils.ts";

export type CommandSource = { threadId: string; command: NativeCommand };
/** Only an exact accepted creation result is causal evidence; cancellation/interrupt pointers grant no ownership. */
export function commandCreation(
  sources: readonly CommandSource[],
  threadId: string,
  environmentId: string,
  trusted: ReadonlySet<string>,
) {
  return sources
    .find(
      ({ threadId: source, command }) =>
        trusted.has(source) &&
        completeCreation(command) &&
        command.references.some(
          (r) =>
            r.threadId === threadId &&
            !!r.executionId &&
            (r.environmentId === null || r.environmentId === environmentId),
        ),
    )
    ?.command.references.find(
      (r) =>
        r.threadId === threadId && (r.environmentId === null || r.environmentId === environmentId),
    );
}
function completeCreation(command: NativeCommand) {
  if (fingerprint(command.envelope) !== command.fingerprint) return false;
  const body = JSON.parse(command.envelope) as {
    toolName?: string;
    input?: { threads?: unknown[] };
  };
  if (!command.references.every((r) => !!r.executionId)) return false;
  if (body.toolName?.endsWith("t3_thread_launch")) return command.references.length === 1;
  return (
    !!body.toolName?.endsWith("create_threads") &&
    !!body.input?.threads?.length &&
    command.references.length === body.input.threads.length
  );
}
export function commandSources(
  rows: readonly { thread_id: string; kind: string; reference: string }[],
): CommandSource[] {
  return rows
    .filter((r) => r.kind === "command")
    .map((r) => ({ threadId: r.thread_id, command: JSON.parse(r.reference) as NativeCommand }));
}
export function commandsCovered(
  sources: readonly CommandSource[],
  environmentId: string,
  trusted: ReadonlySet<string>,
) {
  return sources.every(
    ({ threadId, command }) =>
      trusted.has(threadId) &&
      (completeCreation(command) || completeControl(command)) &&
      command.references.every(
        (r) =>
          (r.environmentId === null || r.environmentId === environmentId) &&
          trusted.has(r.threadId),
      ),
  );
}

export function localCommandReferences(
  commands: readonly NativeCommand[] | undefined,
  environmentId: string,
) {
  return (commands ?? []).flatMap((c) =>
    c.references.filter((r) => r.environmentId === null || r.environmentId === environmentId),
  );
}

function completeControl(command: NativeCommand) {
  if (fingerprint(command.envelope) !== command.fingerprint || !command.references.length)
    return false;
  const body = JSON.parse(command.envelope) as { toolName?: string };
  return !!body.toolName && /(?:\.|__)(task_cancel|t3_thread_interrupt)$/.test(body.toolName);
}

/** Resolve old decoder output only from this sweep's exact unchanged native item. */
export function commandsObserved(
  retained: readonly CommandSource[],
  fresh: readonly CommandSource[],
  environmentId: string,
  trusted: ReadonlySet<string>,
) {
  return retained.every((source) => {
    const matching = fresh.filter(
      (candidate) =>
        candidate.threadId === source.threadId &&
        candidate.command.itemId === source.command.itemId &&
        candidate.command.parentRunId === source.command.parentRunId &&
        candidate.command.fingerprint === source.command.fingerprint &&
        candidate.command.envelope === source.command.envelope,
    );
    return matching.length === 1 && commandsCovered(matching, environmentId, trusted);
  });
}
