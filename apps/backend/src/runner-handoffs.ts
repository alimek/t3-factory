import type { BlockExit } from "@t3-factory/contracts";
function reportExitChoices(exits: readonly BlockExit[]) {
  const choices = exits.map(
    (exit) =>
      `- ${JSON.stringify(exit.name)}${exit.messageRequired ? " (message required)" : ""}${exit.description ? `: ${JSON.stringify(exit.description)}` : ""}`,
  );
  return choices.join("\n");
}
/** Explicit reporting: working when the visit's work starts, finished when the task is complete;
 * conversation in between needs no report. */
export function conversationReportInstructions(exits: readonly BlockExit[]) {
  return `Report through factory_update_block. Chat alone is not a report. When you start this visit's work, call {to: "working", message: nonempty summary of what you are doing}, with no exit. Working is non-final, does not advance the Flow, keeps Factory from reporting a missing report and stays current across later turns of this visit: asking the user questions, reading their replies, and waiting for CI, review, delegated or background work need no further report. End a questioning turn with the questions as your final message. Report working again only to replace its message or when you reopen the task after a result. Only when the task is actually complete, call {to: "finished", exit: exact name below, message: context for the next step; nonempty when the exit requires a message}. Your newest finished report is the result. To change it, report finished again from a later turn: before hand-off only the newest result is passed on; afterwards the same exit only updates the result, and a different exit also starts that exit's next Blocks. An identical retry returns the original acknowledgement. Never treat unanswered questions or your recommendations as user decisions.\nExits:\n${reportExitChoices(exits)}`;
}
