import { nativeCommand, resolveCommandTargets, type NativeCommand } from "./native-command.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ReportActivity, ReportActivityItem } from "./t3.ts";

/** Native output evidence only. It does not prove lineage, activation ownership or settlement. */
export interface DelegationActivity {
  readonly threadId: string;
  readonly projectId: string;
  readonly complete: boolean;
  readonly commands?: readonly NativeCommand[];
  /** Native scan coverage for Stop; remote result membership remains unproven. */
  readonly stopComplete?: boolean;
  readonly problem?: string;
  readonly invocations: readonly DelegationInvocation[];
  readonly remoteTasks?: readonly NativeRemoteTask[];
  readonly followups?: readonly NativeFollowup[];
  readonly taskResults?: readonly NativeTaskResult[];
}
/** Remote task identity belongs to the local caller; child identity belongs to the peer.
 * No exact child execution, options or request-absence evidence is exposed by this result. */
export interface NativeRemoteTask {
  readonly itemId: string;
  readonly parentRunId: string;
  readonly updatedAt: string;
  readonly fingerprint: string;
  readonly remote: {
    readonly taskId: string | null;
    readonly environmentId: string;
    readonly threadId: string | null;
    readonly label: string;
    readonly status: string;
    readonly providerInstanceId: string | null;
    readonly model: string | null;
  };
}
interface NativeSendReceipt {
  readonly itemId: string;
  readonly parentRunId: string;
  readonly updatedAt: string;
  readonly fingerprint: string;
  readonly messageFingerprint: string;
  readonly threadId: string;
  readonly runId: string;
}
export interface NativeQueuedFollowup extends NativeSendReceipt {
  readonly mode?: "queue";
  readonly requestKey: string;
  readonly taskId: string;
}
export interface NativeSteer extends NativeSendReceipt {
  readonly mode: "steer";
  readonly requestKey: string | null;
  readonly taskId: null;
}
export type NativeFollowup = NativeQueuedFollowup | NativeSteer;
export type NativeTaskResult = Omit<DelegationInvocation, "input" | "inputFingerprint">;
export interface DelegationInvocation {
  readonly itemId: string;
  readonly parentRunId: string;
  readonly updatedAt: string;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly input: DelegationInput;
  readonly result: {
    readonly taskId: string;
    readonly childThreadId: string;
    readonly childRunId: string | null;
    readonly childNodeId: string;
    readonly providerInstanceId: string;
    readonly model: string;
    readonly options: Readonly<Record<string, string | boolean>>;
    readonly status: string;
    readonly workState: string;
    readonly hasPendingChildRuns: boolean;
    readonly hasPendingQuestion: boolean;
    readonly pendingApproval: { requestId: string; kind: string; runId: string } | null;
    readonly latestTerminalRunId: string | null;
    readonly latestTerminalStatus: string | null;
    readonly resultContextTransferId: string | null;
    readonly latestTerminalResultContextTransferId: string | null;
  };
}
/** Null means omitted or unsupported, never an inherited/default selection. */
interface DelegationInput {
  readonly clientRequestId: string | null;
  readonly taskFingerprint: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly options: Readonly<Record<string, string | boolean>> | null;
  readonly mode: "async" | "wait" | null;
  readonly isolation: "shared" | "worktree" | null;
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly problem?: string;
}
const normalizedText = (value: unknown) => (text(value) ? value.trim() : null);
function invocationInput(value: Record<string, unknown>): DelegationInput {
  const target = record(value.target) ? value.target : {};
  let options = null;
  let problem: string | undefined;
  try {
    const entries = record(target.options)
      ? Object.entries(target.options).map(([id, value]) => ({ id, value }))
      : target.options;
    options = selectedOptions(entries);
  } catch {
    problem = "Explicit worker options are unavailable.";
  }
  return {
    clientRequestId: normalizedText(value.clientRequestId),
    taskFingerprint: text(value.task) ? digest(value.task.trim()) : null,
    providerInstanceId: normalizedText(target.providerInstanceId),
    model: normalizedText(target.model),
    options,
    mode: value.mode === "async" || value.mode === "wait" ? value.mode : null,
    isolation:
      value.isolation === "shared" || value.isolation === "worktree" ? value.isolation : null,
    environmentId: normalizedText(target.environmentId),
    projectId: normalizedText(target.projectId),
    runtimeMode: normalizedText(value.runtimeMode),
    interactionMode: normalizedText(value.interactionMode),
    ...(problem ? { problem } : {}),
  };
}
/** Same full normalization used by native activity decoding, including omitted selectors. */
function delegationFingerprint(value: Record<string, unknown>) {
  const known = new Set([
    "clientRequestId",
    "task",
    "target",
    "mode",
    "isolation",
    "runtimeMode",
    "interactionMode",
  ]);
  const knownTarget = new Set([
    "providerInstanceId",
    "model",
    "options",
    "environmentId",
    "projectId",
  ]);
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
  const targetExtras = Object.fromEntries(
    Object.entries(record(value.target) ? value.target : {}).filter(
      ([key]) => !knownTarget.has(key),
    ),
  );
  return digest(
    canonical({
      ...invocationInput(value),
      ...(Object.keys(extras).length ? { extras } : {}),
      ...(Object.keys(targetExtras).length ? { targetExtras } : {}),
    }),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const terminal = ["completed", "failed", "cancelled", "interrupted"];
const statuses = ["preparing", "queued", "starting", "running", "waiting", ...terminal];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function selectedOptions(value: unknown): Record<string, string | boolean> {
  if (!Array.isArray(value)) throw Error("Native worker options are unavailable.");
  const selections = new Map<string, string | boolean>();
  for (const entry of value) {
    if (
      !record(entry) ||
      !text(entry.id) ||
      selections.has(entry.id) ||
      !(typeof entry.value === "string" || typeof entry.value === "boolean")
    )
      throw Error("Native worker options are malformed or duplicated.");
    selections.set(entry.id, entry.value);
  }
  return Object.fromEntries(selections);
}
function approval(value: unknown) {
  if (value === null) return null;
  if (!record(value) || !text(value.requestId) || !text(value.kind) || !text(value.runId))
    throw Error("Native approval evidence is malformed.");
  return { requestId: value.requestId, kind: value.kind, runId: value.runId };
}
function resultIdentity(value: Record<string, unknown>) {
  if (
    !text(value.taskId) ||
    !text(value.childThreadId) ||
    !nullableText(value.childRunId) ||
    value.childNodeId !== value.taskId ||
    value.remoteChild !== undefined ||
    !text(value.providerInstanceId) ||
    !text(value.model)
  )
    throw Error("Local delegation identity or worker selection is unavailable.");
  return {
    taskId: value.taskId,
    childThreadId: value.childThreadId,
    childRunId: value.childRunId,
    childNodeId: value.childNodeId,
    providerInstanceId: value.providerInstanceId,
    model: value.model,
    options: selectedOptions(value.options),
  };
}
function resultProgress(value: Record<string, unknown>) {
  if (
    !text(value.status) ||
    !statuses.includes(value.status) ||
    !text(value.workState) ||
    !["working", "waiting_for_children", "result_available"].includes(value.workState) ||
    typeof value.hasPendingChildRuns !== "boolean" ||
    typeof value.hasPendingQuestion !== "boolean" ||
    typeof value.waitTimedOut !== "boolean"
  )
    throw Error("Native task progress is malformed.");
  return {
    status: value.status,
    workState: value.workState,
    hasPendingChildRuns: value.hasPendingChildRuns,
    hasPendingQuestion: value.hasPendingQuestion,
    pendingApproval: approval(value.pendingApproval),
  };
}
function resultReferences(value: Record<string, unknown>) {
  if (
    !nullableText(value.latestTerminalRunId) ||
    !nullableText(value.latestTerminalStatus) ||
    (value.latestTerminalStatus !== null && !terminal.includes(value.latestTerminalStatus)) ||
    !nullableText(value.resultContextTransferId) ||
    !nullableText(value.latestTerminalResultContextTransferId)
  )
    throw Error("Native result references are malformed.");
  return {
    latestTerminalRunId: value.latestTerminalRunId,
    latestTerminalStatus: value.latestTerminalStatus,
    resultContextTransferId: value.resultContextTransferId,
    latestTerminalResultContextTransferId: value.latestTerminalResultContextTransferId,
  };
}
function decodeResult(value: unknown) {
  if (
    !record(value) ||
    (value.isError !== undefined && value.isError !== false) ||
    value.error !== undefined ||
    value.content !== undefined ||
    value.structuredContent !== undefined
  )
    throw Error("Native delegation output is unavailable or reports an error.");
  if (value.remoteChild !== undefined) return remoteResult(value);
  return { ...resultIdentity(value), ...resultProgress(value), ...resultReferences(value) };
}
function remoteResult(value: Record<string, unknown>) {
  const remote = value.remoteChild;
  if (
    !record(remote) ||
    !text(remote.environmentId) ||
    !text(remote.threadId) ||
    typeof remote.label !== "string" ||
    !text(value.taskId) ||
    value.childNodeId !== value.taskId ||
    value.childThreadId !== null ||
    value.childRunId !== null ||
    !text(value.providerInstanceId) ||
    !nullableText(value.model)
  )
    throw Error("Remote task identity is unavailable.");
  const progress = resultProgress(value);
  resultReferences(value);
  return {
    taskId: value.taskId,
    environmentId: remote.environmentId,
    threadId: remote.threadId,
    label: remote.label,
    status: progress.status,
    providerInstanceId: value.providerInstanceId,
    model: value.model,
  };
}
function nativeOutput(toolName: string, output: unknown) {
  if (toolName.startsWith("t3-code.")) return decodeResult(output);
  if (
    !record(output) ||
    (output.isError !== undefined && output.isError !== false) ||
    output.error !== undefined ||
    typeof output.content !== "string" ||
    !record(output.structuredContent)
  )
    throw Error("Unsupported Claude native delegation wrapper.");
  const structured = decodeResult(output.structuredContent);
  if (!isDeepStrictEqual(decodeResult(JSON.parse(output.content)), structured))
    throw Error("Native delegation wrapper representations disagree.");
  return structured;
}
/** Unknown envelopes and orchestration spellings cannot prove absence of work. */
export function nativeToolKind(
  raw: string | null,
): "delegation" | "task-result" | "followup" | "orchestration" | "unrelated" | "unknown" {
  try {
    const body: unknown = JSON.parse(raw ?? "");
    if (!record(body) || !text(body.toolName)) return "unknown";
    const name = body.toolName;
    if (["t3-code.delegate_task", "mcp__t3-code__delegate_task"].includes(name))
      return "delegation";
    if (["t3-code.task_status", "mcp__t3-code__task_status"].includes(name)) return "task-result";
    if (["t3-code.t3_thread_send", "mcp__t3-code__t3_thread_send"].includes(name))
      return "followup";
    if (name.startsWith("t3-code.") || name.startsWith("mcp__t3-code__")) return "orchestration";
    if (
      /(delegate_task|task_status|task_cancel|t3_thread_(launch|send|wait|interrupt)|create_threads)$/.test(
        name,
      )
    )
      return "unknown";
    return "unrelated";
  } catch {
    return "unknown";
  }
}
function nativeInvocation(
  item: ReportActivityItem,
): DelegationInvocation | NativeTaskResult | NativeFollowup | NativeRemoteTask | undefined {
  const kind = nativeToolKind(item.text);
  if (kind === "unrelated") return undefined;
  if (kind === "unknown") throw Error("Native orchestration envelope or namespace is unsupported.");
  if (
    !item.complete ||
    item.status !== "completed" ||
    !item.runId ||
    !item.text ||
    !item.itemId.includes(":native-item:")
  )
    throw Error("Native tool item identity or full completed output is unavailable.");
  const body = nativeBody(item);
  if (kind === "orchestration") return undefined;
  if (kind === "followup") return nativeFollowup(body, item);
  const result = nativeOutput(body.toolName, body.output);
  if (kind === "task-result" && (!record(body.input) || body.input.taskId !== result.taskId))
    throw Error("Task status identity disagrees with requested task.");
  const source = {
    itemId: item.itemId,
    parentRunId: item.runId,
    updatedAt: item.updatedAt,
    fingerprint: digest(item.text),
  };
  if ("environmentId" in result) return { ...source, remote: result };
  if (kind === "task-result") return { ...source, result };
  const input = invocationInput(record(body.input) ? body.input : {});
  return {
    itemId: item.itemId,
    parentRunId: item.runId,
    updatedAt: item.updatedAt,
    fingerprint: digest(item.text),
    inputFingerprint: delegationFingerprint(record(body.input) ? body.input : {}),
    input,
    result,
  };
}

function nativeBody(item: ReportActivityItem): Record<string, unknown> & { toolName: string } {
  const body: unknown = JSON.parse(item.text!);
  if (!record(body) || !text(body.toolName)) throw Error("Native tool envelope is malformed.");
  const prefix = body.toolName.startsWith("t3-code.")
    ? "turn-item:provider:codex:native-item:"
    : "turn-item:provider:claudeAgent:native-item:";
  if (!item.itemId.startsWith(prefix) || item.itemId.length === prefix.length)
    throw Error("Native delegation harness identity is unsupported.");
  return { ...body, toolName: body.toolName };
}

function followupOutput(body: Record<string, unknown>) {
  let output = body.output;
  if (String(body.toolName).startsWith("mcp__")) {
    if (
      !record(output) ||
      output.isError === true ||
      typeof output.content !== "string" ||
      !isDeepStrictEqual(JSON.parse(output.content), output.structuredContent)
    )
      throw Error("Native follow-up wrapper disagrees.");
    output = output.structuredContent;
  }
  return output;
}

function nativeFollowup(body: Record<string, unknown>, item: ReportActivityItem): NativeFollowup {
  const input = body.input;
  const output = followupOutput(body);
  if (
    !record(input) ||
    !record(output) ||
    output.isError === true ||
    output.error !== undefined ||
    !text(input.message) ||
    !["queue", "steer"].includes(String(input.mode)) ||
    (input.environmentId !== undefined && input.environmentId !== null) ||
    input.threadId !== output.threadId ||
    !text(output.threadId) ||
    !text(output.runId) ||
    !text(output.messageId) ||
    !statuses.includes(String(output.status))
  )
    throw Error("Native follow-up identity is unavailable.");
  const receipt = {
    itemId: item.itemId,
    parentRunId: item.runId!,
    updatedAt: item.updatedAt,
    fingerprint: digest(item.text!),
    messageFingerprint: digest(input.message.trim()),
    threadId: output.threadId,
    runId: output.runId,
  };
  if (input.mode === "steer") return steeringFollowup(input, output, receipt);
  if (
    !text(input.clientRequestId) ||
    !text(output.taskId) ||
    !["started", "queued"].includes(String(output.delivery))
  )
    throw Error("Native queued follow-up identity is unavailable.");
  return { ...receipt, requestKey: input.clientRequestId, taskId: output.taskId };
}

/** Steering mutates an existing execution but grants no queued task or activation authority. */
function steeringFollowup(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  receipt: NativeSendReceipt,
): NativeSteer {
  if (
    output.delivery !== "steered" ||
    (input.clientRequestId !== undefined && !text(input.clientRequestId)) ||
    (output.taskId !== undefined && output.taskId !== null)
  )
    throw Error("Native steering receipt is unavailable.");
  return {
    ...receipt,
    mode: "steer",
    requestKey: text(input.clientRequestId) ? input.clientRequestId : null,
    taskId: null,
  };
}

/** Excludes inherited prose and other tools; uncertainty never proves absence of work.
 * The caller must compare input evidence to its persisted plan and independently read children. */
export function delegationActivity(activity: ReportActivity): DelegationActivity {
  const commands = activity.items
    .filter((item) => localNativeItem(item, activity.threadId))
    .flatMap((item) => {
      const command = nativeCommand(item);
      return command ? [command] : [];
    });
  const invocations: DelegationInvocation[] = [];
  const taskResults: NativeTaskResult[] = [];
  const followups: NativeFollowup[] = [];
  const remoteTasks: NativeRemoteTask[] = [];
  let problem = activity.problem;
  let stopComplete = activity.complete && !problem;
  for (const item of activity.items) {
    if (!localNativeItem(item, activity.threadId)) continue;
    try {
      const invocation = nativeInvocation(item);
      if (!invocation) continue;
      if ("remote" in invocation) {
        remoteTasks.push(invocation);
        problem ??= "Remote work cannot establish local lifecycle coverage.";
      } else if ("input" in invocation) invocations.push(invocation);
      else if ("requestKey" in invocation) followups.push(invocation);
      else taskResults.push(invocation);
    } catch (error) {
      stopComplete = false;
      remoteTasks.push(...remoteAttempts(item));
      problem ??= evidenceError(error);
    }
  }
  return {
    threadId: activity.threadId,
    projectId: activity.projectId,
    invocations,
    commands: resolveCommandTargets(
      commands,
      [...invocations, ...taskResults],
      activity.items.filter((item) => localNativeItem(item, activity.threadId)),
    ),
    remoteTasks,
    taskResults,
    followups,
    complete: activity.complete && !problem,
    stopComplete,
    ...(problem ? { problem } : {}),
  };
}

function localNativeItem(item: ReportActivityItem, threadId: string) {
  return (
    item.type === "dynamic_tool" &&
    item.visibility === "local" &&
    item.sourceThreadId === threadId &&
    item.subagentId === undefined
  );
}

function evidenceError(error: unknown) {
  return error instanceof Error ? error.message : "Native delegation evidence is unavailable.";
}

/** A failed/unfinished remote call may have launched work before losing its reply.
 * Preserve only its native caller and explicit peer, never a guessed task/thread. */
function remoteAttempts(item: ReportActivityItem): NativeRemoteTask[] {
  try {
    if (!item.runId || nativeToolKind(item.text) !== "delegation") return [];
    const body = nativeBody(item);
    const input = invocationInput(record(body.input) ? body.input : {});
    if (!input.environmentId) return [];
    return [
      {
        itemId: item.itemId,
        parentRunId: item.runId,
        updatedAt: item.updatedAt,
        fingerprint: digest(item.text!),
        remote: {
          taskId: null,
          threadId: null,
          environmentId: input.environmentId,
          label: input.environmentId,
          status: "unknown",
          providerInstanceId: input.providerInstanceId,
          model: input.model,
        },
      },
    ];
  } catch {
    return [];
  }
}
