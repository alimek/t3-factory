import type { BlockExit, RunDefinitions } from "@t3-factory/contracts";
import { HUMAN_EXITS } from "@t3-factory/domain-validation";
import type { LaunchPayload, SendPayload, T3Target } from "../adapters/t3.ts";
import { attachmentName } from "../run-images.ts";
import { conversationReportInstructions } from "./runner-handoffs.ts";

/* Worker messages and launch payloads, pure so the Run store can persist them inside its
 * transactions and orchestration can verify them before a T3 call. */

/** An initial-prompt image a Flow-input launch carries, in manifest order. */
export interface LaunchImage {
  readonly ordinal: number;
  readonly sha256: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
/** The saved launch: T3's request, plus the Run images uploaded anew for each dispatch. */
export type StoredLaunchPayload = LaunchPayload & { readonly images?: readonly LaunchImage[] };

/**
 * The installed Block skill, the Block id its Factory tools take, how attached images map to the
 * initial prompt's references, and the turn to act on.
 */
export function workerTurn(body: string, blockId: string, images: readonly LaunchImage[] = []) {
  const names = images.map((image) => attachmentName(image.ordinal, image.name)).join(", ");
  return [
    "$factory-block",
    "",
    `Factory Block id: ${blockId}. Pass it as blockId to factory_get_block, factory_get_run, factory_get_run_image and factory_update_block.`,
    ...(images.length
      ? [
          `Initial prompt images are attached to this message as ${names}; references like [Image N: name] in the initial prompt point to them.`,
        ]
      : []),
    "",
    body,
  ].join("\n");
}

/** Stable title saved with the launch. Later Block renames do not change recovery's target. */
function workerTitle(number: number, index: number, name: string) {
  return `Factory #${number} · ${index + 1} ${name}`.slice(0, 200);
}

/** A worker launch with the Agent's captured provider, model and options and its first turn. */
export function workerLaunchPayload(
  definitions: RunDefinitions,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  number: number,
  publicId: string,
  workspaceStrategy: LaunchPayload["workspaceStrategy"],
  images: readonly LaunchImage[] = [],
): StoredLaunchPayload {
  const blocks = definitions.flow.graph.blocks;
  const index = blocks.findIndex((entry) => entry.id === blockId);
  const block = blocks[index];
  if (!block || block.kind !== "agent") throw Error("Launch target is not an Agent Block");
  const agent = definitions.agents.find((entry) => entry.id === block.agentId);
  if (!agent) throw Error("Launch target Agent is not in the definitions");
  return {
    environmentId: target.environmentId,
    projectId: target.projectId,
    clientRequestId: key,
    title: workerTitle(number, index, block.name),
    workspaceStrategy,
    interactionMode: "default",
    modelSelection: {
      instanceId: agent.execution.providerInstanceId,
      model: agent.execution.modelId,
      options: Object.fromEntries(
        agent.execution.modelOptions.map((option) => [option.id, option.value]),
      ),
    },
    message: workerTurn(agent.prompt, publicId, images),
    ...(images.length ? { images } : {}),
  };
}

/** A revisit: the arrival's message queued as the next turn of the recipient's worker thread. */
export function workerRevisitPayload(
  target: Pick<T3Target, "environmentId">,
  threadId: string,
  key: string,
  message: string,
  publicId: string,
): SendPayload {
  return {
    environmentId: target.environmentId,
    threadId,
    mode: "queue",
    clientRequestId: key,
    message: workerTurn(message, publicId),
  };
}

/** How a Revisit instruction relates to the Agent's own requirements; stated with the instruction in
 * a later visit's message and in that visit's Block read. */
export const REVISIT_RULE =
  "It decides the scope of this visit; your Agent's role, criteria, exits and reporting rules still apply. A narrower scope never permits skipping a required check or accepting a defect that has evidence; if you cannot reconcile the two, say so in your report.";

/**
 * The body of a later visit to an Agent block, for a feedback return, Human answer or Wait arrival.
 * A captured Revisit instruction precedes the incoming message, each labelled; without one the
 * incoming message is the whole body, as before Revisit instructions existed. Continuation
 * prompts and Request report never use this, so they never carry the instruction.
 */
export function agentRevisitMessage(definitions: RunDefinitions, blockId: string, message: string) {
  const block = definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  if (!block || block.kind !== "agent") throw Error("Revisit target is not an Agent Block");
  if (!block.revisitInstruction) return message;
  return `Revisit instruction for this later visit of your Block. ${REVISIT_RULE} Your Block's previous finished result is available from factory_get_run.\n${block.revisitInstruction}\n\nIncoming message:\n${message.trim() ? message : "(no message)"}`;
}

/**
 * A Continuation's prompt, queued as the next turn of the worker thread it continues. A Human
 * step's reply follows it, labelled, because that worker has not seen it; a message from an Agent
 * or Continuation was written in this same thread and is not repeated. `arrival` names the block
 * that wrote the message, which for a message a Wait forwarded is that Wait's own source.
 */
export function continuationPromptMessage(
  definitions: RunDefinitions,
  blockId: string,
  arrival: { readonly sourceBlockId: string | null; readonly exitId: string | null },
  message: string,
) {
  const blocks = definitions.flow.graph.blocks;
  const block = blocks.find((entry) => entry.id === blockId);
  if (!block || block.kind !== "continuation") throw Error("Prompt target is not a Continuation");
  const lead = `This is a new Factory task for the Continuation "${block.name}" in this conversation. Report it with the Block id above, not with an earlier Block id; finish it without an exit, with your response as the message.`;
  const source = blocks.find((entry) => entry.id === arrival.sourceBlockId);
  const exit = HUMAN_EXITS.find((entry) => entry.id === arrival.exitId);
  const reply =
    source?.kind === "human"
      ? `\n\nReply from the Human step "${source.name}"${exit ? ` (${exit.name})` : ""}:\n${message.trim() || "(no message)"}`
      : "";
  return `${lead}\n\n${block.prompt}${reply}`;
}

/** Request report: a turn queued on a finished worker thread asking it to assess its existing work
 * and report. */
export function requestReportPayload(
  target: Pick<T3Target, "environmentId">,
  threadId: string,
  key: string,
  exits: readonly BlockExit[],
  publicId: string,
): SendPayload {
  return workerRevisitPayload(
    target,
    threadId,
    key,
    "Factory Request report: assess the existing work without repeating the task. If questions you asked the user are still unanswered, or CI, review, delegated or background work is still running, report working with what remains open instead of forcing completion; report finished only when the task, including its discussion, is actually complete.\n\n" +
      conversationReportInstructions(exits),
    publicId,
  );
}
