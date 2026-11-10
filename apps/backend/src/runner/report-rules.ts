import type { RunBlock, RunDefinitions } from "@t3-factory/contracts";
import { effectiveExits } from "@t3-factory/domain-validation";
import { fingerprint, rejected } from "./runner-utils.ts";
import type { RuntimeReport } from "../runtime-types.ts";

type BlockState = RunBlock["state"];

/** Exact exit names and identities resolve against the Run's captured definitions, never a later
 * edit. */
export function reportRoute(definitions: RunDefinitions, blockId: string, report: RuntimeReport) {
  const block = definitions.flow.graph.blocks.find((block) => block.id === blockId);
  // Only Agent blocks and Continuations have a Block id; a Human step or Wait has no worker.
  if (!block || (block.kind !== "agent" && block.kind !== "continuation"))
    return rejected("UNKNOWN_BLOCK");
  const exits = effectiveExits(block, definitions.agents);
  // A Continuation has one unnamed output: its worker finishes without naming it.
  const matches = exits.filter(
    (candidate) =>
      (block.kind === "continuation" && report.exit === undefined) ||
      candidate.name === report.exit ||
      candidate.id === report.exit,
  );
  const exit = matches[0];
  if (report.status === "finished" && matches.length !== 1)
    return {
      ok: false as const,
      reply: {
        code: "INVALID_EXIT",
        allowedExits: exits.map((exit) => exit.name || exit.id),
      },
    };
  if (exit?.messageRequired && !report.message?.trim()) return rejected("FEEDBACK_REQUIRED");
  const recipients = exit
    ? definitions.flow.graph.connections
        .filter((edge) => edge.sourceBlockId === block.id && edge.exitId === exit.id)
        .map((edge) => edge.targetBlockId)
    : [];
  if (recipients.some((id) => !definitions.flow.graph.blocks.some((block) => block.id === id)))
    return rejected("INVALID_RECIPIENT");
  return { ok: true as const, exitId: exit?.id ?? null, recipients };
}
/** A working report is non-final: it never selects an exit and must carry a message. */
export function nonFinalRejection(report: RuntimeReport) {
  if (report.status === "finished") return undefined;
  if (report.exit !== undefined) return { code: "EXIT_NOT_ALLOWED" };
  if (!report.message?.trim()) return { code: "MESSAGE_REQUIRED" };
  return undefined;
}
export function reportFingerprint(report: RuntimeReport) {
  return fingerprint(
    JSON.stringify({
      status: report.status,
      exit: report.exit ?? null,
      message: report.message ?? null,
    }),
  );
}

/** The state a report writes: a Continuation stays `sent` until its response is forwarded, while
 * its worker's own Block shows the work; an Agent Block shows `agent`. */
export function reportedState(
  definitions: RunDefinitions,
  blockId: string,
  agent: BlockState,
): BlockState | { readonly keep: readonly BlockState[]; readonly otherwise: BlockState } {
  const block = definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  return block?.kind === "continuation" ? { keep: ["pass-through"], otherwise: "sent" } : agent;
}
