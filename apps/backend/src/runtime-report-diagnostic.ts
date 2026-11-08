import type { RuntimeReply } from "./runtime-types.ts";

const REJECTIONS: Readonly<Record<string, readonly [string, string]>> = {
  UNKNOWN_BLOCK: [
    "No Factory Block has this Block id.",
    "Copy the Block id exactly from the Factory Block id line of this thread's latest Factory message. Only the Block's own worker reports; do not repeat the task.",
  ],
  BLOCK_ID_REQUIRED: [
    "Factory tools need the Block id to know which Block you are working on.",
    "Pass blockId from the Factory Block id line of this thread's latest Factory message.",
  ],
  INVALID_ARGUMENT: [
    "The call has an unexpected argument or argument type.",
    "Read the tool's input schema and send only its documented arguments.",
  ],
  INVALID_EXIT: [
    "The selected exit does not identify exactly one captured Block exit.",
    "Use factory_get_block to read the allowed exits, then correct the report without repeating the task.",
  ],
  FINAL_CONFLICT: [
    "This visit already has a final result with different content.",
    "Read the accepted result with factory_get_run. Do not repeat the task or replace that final result.",
  ],
  WAITING_EXIT_NOT_ALLOWED: [
    "A waiting report cannot select an exit.",
    "Remove the exit and report what you need from the user.",
  ],
  WAITING_MESSAGE_REQUIRED: [
    "A waiting report must explain what you need from the user.",
    "Add the unanswered question or decision to the waiting message.",
  ],
  FEEDBACK_REQUIRED: [
    "The selected exit requires a result message.",
    "Add the required feedback without repeating the task.",
  ],
  RUN_CLOSED: [
    "The Run no longer accepts new reports.",
    "Read the Run's recorded outcome; do not retry work for this Run.",
  ],
};

/** Static explanations only: never echo model arguments, native payloads or credentials. */
export function reportDiagnostic(reply: RuntimeReply): RuntimeReply {
  if (reply.code === "ACCEPTED") return reply;
  const [reason, next] = REJECTIONS[reply.code] ?? [
    "Factory could not record this report.",
    "Read your Block with factory_get_block before reporting again. Do not repeat the task.",
  ];
  return { ...reply, reason, next };
}
