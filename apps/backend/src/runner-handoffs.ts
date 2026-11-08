import { newId } from "./ids.ts";
import type { RunDefinitions } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { LaunchPayload, T3Target } from "./adapters/t3.ts";
import type { ReportRow, RunRow } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
function reportExitChoices(exits: RunDefinitions["flow"]["graph"]["blocks"][number]["exits"]) {
  const choices = exits.map(
    (exit) =>
      `- ${JSON.stringify(exit.name)} (${exit.outcome}${exit.requiresFeedback ? "; feedback required" : ""})${exit.description ? `: ${JSON.stringify(exit.description)}` : ""}`,
  );
  return choices.join("\n");
}
/** Explicit reporting: the newest finished report is the activation's result; waiting is a non-final question. */
export function conversationReportInstructions(
  exits: RunDefinitions["flow"]["graph"]["blocks"][number]["exits"],
) {
  return `Report through factory_update_block. Chat alone is not a report. If you still need a user reply, call {to: "waiting", message: nonempty summary of what you need}, with no exit, then end this turn. Waiting is non-final and does not advance the Flow. The user replies in this T3 thread; Factory resumes this Block. If you end this turn while CI, review, delegated or background work is still running, call {to: "working", message: nonempty summary of what you are waiting on}, with no exit; working is non-final, does not advance the Flow and keeps Factory from reporting a missing report. Only when the task is actually complete, call {to: "finished", exit: exact name below, message: context for the next step; nonempty when feedback is required}. Your newest finished report is the result. To change it, report finished again from a later turn: before hand-off only the newest result is passed on; afterwards the same exit only updates the result, and a different exit also starts that exit's next Blocks. An identical retry returns the original acknowledgement. Never treat unanswered questions or your recommendations as user decisions.\nExits:\n${reportExitChoices(exits)}`;
}
/** A worker's launch settings; its first message is the worker's own activation message. */
export function launchPayload(
  definitions: RunDefinitions,
  blockId: string,
  target: Pick<T3Target, "environmentId" | "projectId">,
  key: string,
  input: string,
): LaunchPayload {
  const entry = definitions.flow.graph.blocks.find((block) => block.id === blockId)!;
  const agent = definitions.agents.find(
    (agent) => entry.kind === "agent" && agent.id === entry.agentId,
  )!;
  return {
    environmentId: target.environmentId,
    projectId: target.projectId,
    clientRequestId: key,
    title: `${definitions.flow.name}: ${entry.name}`.slice(0, 200),
    message: `${agent.prompt}\n\n${conversationReportInstructions(entry.exits)}\n\nFlow input:\n${input}`,
    workspaceStrategy: { type: "root" },
    interactionMode: "default",
    modelSelection: {
      instanceId: agent.execution.providerInstanceId,
      model: agent.execution.modelId,
      options: Object.fromEntries(
        agent.execution.modelOptions.map((option) => [option.id, option.value]),
      ),
    },
  };
}
export function createHandoffs(
  sql: SqlClient.SqlClient,
  runRow: Pick<
    RunRow,
    "id" | "context_id" | "endpoint" | "environment_id" | "t3_project_id" | "workspace_root"
  >,
  report: Pick<
    ReportRow,
    "id" | "block_id" | "exit_id" | "recipients_json" | "pending_message" | "accepted_at"
  >,
  occurrenceId: string | null = null,
) {
  return Effect.gen(function* () {
    for (const blockId of JSON.parse(report.recipients_json) as string[]) {
      const id = yield* newId,
        cause = `${occurrenceId ? "human" : "report"}:${report.id}/recipient:${blockId}`;
      const payload = JSON.stringify({ message: report.pending_message ?? "" });
      const inserted =
        yield* sql`INSERT INTO operation_intents(id,run_id,block_id,kind,cause,target_json,request_key,payload_json,fingerprint,context_id,report_id,source_block_id,exit_id,occurrence_id)
          VALUES(${id},${runRow.id},${blockId},'handoff',${cause},${JSON.stringify({ ...runTarget(runRow), blockId })},${fingerprint(cause)},${payload},${fingerprint(payload)},${runRow.context_id},${occurrenceId ? null : report.id},${report.block_id},${report.exit_id},${occurrenceId}) ON CONFLICT(run_id,cause) DO NOTHING RETURNING id`;
      if (inserted.length)
        yield* sql`INSERT INTO run_events(run_id,block_id,kind,source_key,cause_id,observed_at) VALUES(${runRow.id},${blockId},${occurrenceId ? "handoff-created" : "handoff-held"},${cause},${id},${report.accepted_at})`;
    }
    if (!occurrenceId)
      yield* sql`UPDATE runtime_reports SET pending_message=NULL WHERE id=${report.id}`;
  });
}
