import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { ReportActivityItem } from "./t3.ts";

export interface NativeCommand {
  itemId: string;
  parentRunId: string;
  fingerprint: string;
  envelope: string;
  references: readonly {
    threadId: string;
    executionId: string | null;
    environmentId: string | null;
  }[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Positive native mutations remain obligations even if their output cannot be decoded. */
export function nativeCommand(item: ReportActivityItem): NativeCommand | undefined {
  if (!item.complete || item.status !== "completed") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(item.text ?? "");
  } catch {
    return undefined;
  }
  if (
    !object(body) ||
    !string(body.toolName) ||
    !/(?:\.|__)(t3_thread_launch|create_threads|task_cancel|t3_thread_interrupt)$/.test(
      body.toolName,
    ) ||
    !item.runId ||
    !item.text
  )
    return undefined;
  return {
    itemId: item.itemId,
    parentRunId: item.runId,
    fingerprint: createHash("sha256").update(item.text).digest("hex"),
    envelope: item.text,
    references: commandReferences(body, item),
  };
}
function commandReferences(
  body: Record<string, unknown>,
  item: ReportActivityItem,
): NativeCommand["references"] {
  const output = commandOutput(body, item);
  if (!output || !string(body.toolName)) return [];
  const input = object(body.input) ? body.input : {};
  if (body.toolName.endsWith("t3_thread_interrupt")) {
    if (
      input.threadId !== output.threadId ||
      !string(input.threadId) ||
      ![
        "interrupt_requested",
        "no_active_run",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "rolled_back",
      ].includes(String(output.status))
    )
      return [];
    const actual = reference(output, input.environmentId);
    const requested = string(input.runId)
      ? reference({ threadId: input.threadId, runId: input.runId }, input.environmentId)
      : [];
    return [...actual, ...requested];
  }
  if (body.toolName.endsWith("t3_thread_launch")) return reference(output, input.environmentId);
  if (
    !body.toolName.endsWith("create_threads") ||
    !Array.isArray(output.threads) ||
    !Array.isArray(input.threads) ||
    output.threads.length !== input.threads.length
  )
    return [];
  const requests: unknown[] = input.threads;
  return output.threads.flatMap((output, index) => {
    const request = requests[index];
    const target = object(request) && object(request.target) ? request.target : {};
    return reference(output, target.environmentId);
  });
}
function reference(output: unknown, environment: unknown): NativeCommand["references"] {
  if (
    !object(output) ||
    !string(output.threadId) ||
    !(output.runId === null || string(output.runId)) ||
    !(environment === undefined || string(environment))
  )
    return [];
  return [
    {
      threadId: output.threadId,
      executionId: output.runId,
      environmentId: typeof environment === "string" ? environment : null,
    },
  ];
}

function commandOutput(
  body: Record<string, unknown>,
  item: Pick<ReportActivityItem, "complete" | "status" | "itemId">,
): Record<string, unknown> | undefined {
  if (
    !item.complete ||
    item.status !== "completed" ||
    !string(body.toolName) ||
    !object(body.output) ||
    body.output.error ||
    body.output.isError
  )
    return undefined;
  if (
    body.toolName.startsWith("t3-code.") &&
    item.itemId.startsWith("turn-item:provider:codex:native-item:")
  )
    return body.output;
  if (
    !body.toolName.startsWith("mcp__t3-code__") ||
    !item.itemId.startsWith("turn-item:provider:claudeAgent:native-item:") ||
    typeof body.output.content !== "string" ||
    !object(body.output.structuredContent)
  )
    return undefined;
  try {
    return isDeepStrictEqual(JSON.parse(body.output.content), body.output.structuredContent)
      ? body.output.structuredContent
      : undefined;
  } catch {
    return undefined;
  }
}

/** Cancellation returns a task ID, so only a matching local native task result supplies its target. */
export function resolveCommandTargets(
  commands: readonly NativeCommand[],
  tasks: readonly Pick<import("./delegation-activity.ts").DelegationInvocation, "result">[],
  items: readonly ReportActivityItem[],
) {
  return commands.map((command) => {
    const body: unknown = JSON.parse(command.envelope);
    if (!object(body) || !String(body.toolName).endsWith("task_cancel") || !object(body.input))
      return command;
    const item = items.find(
      (i) =>
        i.itemId === command.itemId &&
        i.runId === command.parentRunId &&
        i.text === command.envelope,
    );
    const output = item ? commandOutput(body, item) : undefined;
    if (
      !output ||
      output.taskId !== body.input.taskId ||
      !["cancel_requested", "completed", "failed", "cancelled", "interrupted"].includes(
        String(output.status),
      )
    )
      return command;
    const task = tasks.find((t) => t.result.taskId === output.taskId);
    if (!task) return command;
    return {
      ...command,
      references: [...new Set([task.result.childRunId, task.result.latestTerminalRunId])].map(
        (runId) => ({
          threadId: task.result.childThreadId,
          executionId: runId,
          environmentId: null,
        }),
      ),
    };
  });
}
