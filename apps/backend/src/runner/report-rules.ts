import type { RunDefinitions } from "@t3-factory/contracts";
import { effectiveExits } from "@t3-factory/domain-validation";
import { fingerprint, rejected } from "./runner-utils.ts";
import type { RuntimeReport } from "../runtime-types.ts";

/** Exact exit names and identities resolve against the Run's captured definitions, never a later
 * edit. */
export function reportRoute(definitions: RunDefinitions, blockId: string, report: RuntimeReport) {
  const block = definitions.flow.graph.blocks.find((block) => block.id === blockId);
  if (!block || block.kind !== "agent") return rejected("UNKNOWN_BLOCK");
  const exits = effectiveExits(block, definitions.agents);
  const matches = exits.filter(
    (candidate) => candidate.name === report.exit || candidate.id === report.exit,
  );
  const exit = matches[0];
  if (report.status === "finished" && matches.length !== 1)
    return {
      ok: false as const,
      reply: { code: "INVALID_EXIT", allowedExits: exits.map((exit) => exit.name) },
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
