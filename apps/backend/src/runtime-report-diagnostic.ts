import { SUCCESS_CODES, type RuntimeReply } from "./runtime-types.ts";

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
  EXIT_NOT_ALLOWED: [
    "Only a finished report selects an exit; working and waiting reports cannot.",
    "Remove the exit. Report finished with an exit only when the task is complete.",
  ],
  MESSAGE_REQUIRED: [
    "A working or waiting report needs a message.",
    "For working, say what you are still doing or waiting on; for waiting, add the question or decision you need from the user.",
  ],
  FEEDBACK_REQUIRED: [
    "The selected exit requires a result message.",
    "Add the required feedback without repeating the task.",
  ],
};

/** Static explanations only: never echo model arguments, native payloads or credentials. */
export function reportDiagnostic(reply: RuntimeReply): RuntimeReply {
  if (SUCCESS_CODES.includes(reply.code)) return reply;
  const [reason, next] = REJECTIONS[reply.code] ?? [
    "Factory could not record this report.",
    "Read your Block with factory_get_block before reporting again. Do not repeat the task.",
  ];
  return { ...reply, reason, next };
}
