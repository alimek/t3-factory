import type { RuntimeReply } from "./runtime-types.ts";

const REJECTIONS: Readonly<Record<string, readonly [string, string]>> = {
  UNBOUND_ACTIVATION: [
    "This exact worker execution has no verified Block activation authority.",
    "Do not repeat the task or retry the same report. Inspect the worker continuation or user-reply provenance in T3; request an assessment in Factory only after work is quiet and recovery is eligible.",
  ],
  INVALID_EXIT: [
    "The selected exit does not identify exactly one captured Block exit.",
    "Use factory_get_block to read the allowed exits, then correct the report without repeating the task.",
  ],
  ASSESSMENT_UNVERIFIED: [
    "Factory could not verify the worker settings and activation work frontier for this final report.",
    "Inspect the worker and delegated work in T3. Resolve incomplete or foreign evidence before submitting a final; do not repeat the task.",
  ],
  HUMAN_REPLY_REQUIRED: [
    "An outstanding conversation question still requires the user's reply.",
    "Wait for the user to reply in this worker thread; a background completion cannot answer for them.",
  ],
  WORKER_FAILED: [
    "An execution in this activation failed, was cancelled or was interrupted.",
    "Inspect the execution failure in T3. Report recovery cannot retry or replace failed work.",
  ],
  FINAL_CONFLICT: [
    "This activation already has an immutable final result with different content or source execution.",
    "Read the accepted result with factory_get_run. Do not repeat the task or replace that final result.",
  ],
  KEY_CONFLICT: [
    "Different report content was already accepted for this report identity.",
    "Read the current Block and accepted result before choosing any remaining allowed transition.",
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
  STALE_EXECUTION: [
    "This call is not from the current active worker execution.",
    "Do not report for an earlier execution. Inspect the current worker in T3.",
  ],
  INCOMPLETE_EXECUTION_EVIDENCE: [
    "Factory's execution observation is not fresh and complete.",
    "Restore observation before reporting; do not start another task or assessment while evidence is unavailable.",
  ],
  RUN_CLOSED: [
    "The Run no longer accepts new reports.",
    "Read the Run's recorded outcome; do not retry work for this Run.",
  ],
  UNBOUND_CALLER: [
    "Factory could not uniquely verify this native tool call as an authorized worker call.",
    "Use the Factory tool ref from the worker launch message and inspect the native call in T3. A ref alone grants no authority; do not repeat the task.",
  ],
  FOREIGN_CALLER: [
    "This call does not have the worker's own local native provenance.",
    "Return the result to the owning worker. A subagent or forwarded call cannot report for it.",
  ],
};

/** Static explanations only: never echo model arguments, native payloads or credentials. */
export function reportDiagnostic(reply: RuntimeReply): RuntimeReply {
  if (reply.code === "ACCEPTED") return reply;
  const [reason, next] = REJECTIONS[reply.code] ?? [
    "Factory did not accept this report because the reporting contract or caller evidence could not be verified.",
    "Inspect this call in T3 and the current Block in Factory before reporting again. Do not repeat the task or start recovery while work or uncertain evidence remains.",
  ];
  return { ...reply, reason, next };
}
