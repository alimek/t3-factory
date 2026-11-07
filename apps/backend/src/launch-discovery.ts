import type { LaunchCandidate, LaunchDiscovery, ThreadIdentityRead } from "./adapters/t3.ts";

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Project-scoped thread search. Any incomplete page or protocol gap withholds candidates. */
export async function discoverLaunches(
  call: Call,
  projectId: string,
  title: string,
): Promise<LaunchDiscovery> {
  try {
    const threads = await listProjectThreads(call, projectId);
    const candidates: LaunchCandidate[] = [];
    for (const thread of threads) {
      const candidate = await candidateFor(call, thread, title);
      if (candidate === "incomplete") return { available: false };
      if (candidate) candidates.push(candidate);
    }
    return { available: true, candidates };
  } catch {
    return { available: false };
  }
}

/** Exact thread identity for a Factory-launched worker. Missing fields stay unproven. */
export function threadIdentityRead(value: unknown, threadId: string): ThreadIdentityRead {
  const body = flattenThreadRead(value);
  if (body.threadId !== threadId) throw Error("Thread identity mismatch");
  if (!("parentThreadId" in body)) throw Error("Thread parent evidence is unavailable");
  const runs = Array.isArray(body.recentRuns)
    ? body.recentRuns
    : Array.isArray(body.runs)
      ? body.runs
      : null;
  if (!runs) throw Error("Execution evidence is unavailable");
  return {
    threadId,
    projectId: requiredString(body.projectId),
    parentThreadId: body.parentThreadId === null ? null : requiredString(body.parentThreadId),
    workspaceRoot: typeof body.workspaceRoot === "string" ? body.workspaceRoot : null,
    providerInstanceId: requiredString(body.providerInstanceId),
    model: requiredString(body.model),
    executions: runs.map(executionIdentity),
  };
}

async function listProjectThreads(call: Call, projectId: string) {
  const threads: Record<string, unknown>[] = [];
  let cursor = 0;
  let complete = false;
  for (let page = 0; page < 100 && !complete; page++) {
    const body = asObject(
      await call("t3_thread_list", {
        projectId,
        includeSubagents: true,
        cursor,
        limit: 100,
      }),
    );
    if (body.projectId !== projectId || !Array.isArray(body.threads) || body.threads.length > 100)
      throw Error("Incomplete project thread list");
    threads.push(...body.threads.map(asObject));
    if (body.nextCursor === null) {
      complete = true;
      break;
    }
    if (typeof body.nextCursor !== "number" || body.nextCursor <= cursor)
      throw Error("Invalid thread list continuation");
    cursor = body.nextCursor;
  }
  if (!complete) throw Error("Thread list pagination is incomplete");
  return threads;
}

async function candidateFor(
  call: Call,
  thread: Record<string, unknown>,
  title: string,
): Promise<LaunchCandidate | "incomplete" | undefined> {
  const detail = await evidenceFor(call, thread, title);
  if (detail === "incomplete" || !detail) return detail;
  const executions = executionList(detail);
  if (!executions) return "incomplete";
  return candidateFrom(detail, title, executions);
}

/** A title match with a missing parent, workspace, project or execution list is read before it can count. */
async function evidenceFor(call: Call, thread: Record<string, unknown>, title: string) {
  const named = await ensureTitle(call, thread);
  if (typeof named.title !== "string" || named.title !== title) return undefined;
  const detail = launchEvidenceGap(named) ? await readThread(call, named) : named;
  if (detail.title !== title) return undefined;
  if (!provenLaunchEvidence(detail)) return "incomplete" as const;
  return detail;
}

async function ensureTitle(call: Call, thread: Record<string, unknown>) {
  if (typeof thread.title === "string") return thread;
  return readThread(call, thread);
}

async function readThread(call: Call, thread: Record<string, unknown>) {
  const threadId = requiredString(thread.threadId);
  return {
    ...flattenThreadRead(await call("t3_thread_read", { threadId, runLimit: 50 })),
    ...thread,
  };
}

/** Live `t3_thread_read` nests identity under `thread` and names the workspace `worktreePath`. */
function flattenThreadRead(value: unknown): Record<string, unknown> {
  const body = asObject(value);
  const thread = nestedThread(body.thread);
  if (!thread) return body;
  return {
    ...thread,
    ...body,
    threadId: firstDefined(body.threadId, thread.threadId),
    projectId: firstDefined(body.projectId, thread.projectId),
    providerInstanceId: firstDefined(body.providerInstanceId, thread.providerInstanceId),
    model: firstDefined(body.model, thread.model),
    interactionMode: firstDefined(body.interactionMode, thread.interactionMode),
    title: typeof body.title === "string" ? body.title : thread.title,
    options: firstDefined(body.options, body.modelOptions, thread.options, thread.modelOptions),
    recentRuns: firstDefined(body.recentRuns, body.runs, thread.recentRuns),
    runs: firstDefined(body.runs, thread.runs),
    ...copiedParent(body, thread),
    ...copiedWorkspace(body, thread),
  };
}

function nestedThread(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined);
}

function copiedParent(body: Record<string, unknown>, thread: Record<string, unknown>) {
  if ("parentThreadId" in body) return { parentThreadId: body.parentThreadId };
  if ("parentThreadId" in thread) return { parentThreadId: thread.parentThreadId };
  return {};
}

function copiedWorkspace(body: Record<string, unknown>, thread: Record<string, unknown>) {
  if ("workspaceRoot" in body) return { workspaceRoot: body.workspaceRoot };
  if ("worktreePath" in thread) return { workspaceRoot: thread.worktreePath };
  if ("workspaceRoot" in thread) return { workspaceRoot: thread.workspaceRoot };
  return {};
}

function launchEvidenceGap(thread: Record<string, unknown>) {
  return (
    !("parentThreadId" in thread) ||
    !("workspaceRoot" in thread) ||
    !("projectId" in thread) ||
    !executionList(thread)
  );
}

function provenLaunchEvidence(detail: Record<string, unknown>) {
  return (
    !launchEvidenceGap(detail) &&
    provenParent(detail.parentThreadId) &&
    typeof detail.projectId === "string" &&
    detail.projectId.length > 0
  );
}

function provenParent(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function executionList(detail: Record<string, unknown>) {
  if (Array.isArray(detail.recentRuns)) return detail.recentRuns;
  if (Array.isArray(detail.runs)) return detail.runs;
  return null;
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parentThread(value: unknown) {
  if (!provenParent(value)) throw Error("Thread parent evidence is unavailable");
  return value;
}

function candidateFrom(
  detail: Record<string, unknown>,
  title: string,
  executions: readonly unknown[],
): LaunchCandidate {
  return {
    title,
    projectId: requiredString(detail.projectId),
    parentThreadId: parentThread(detail.parentThreadId),
    workspaceRoot: optionalText(detail.workspaceRoot),
    interactionMode: optionalText(detail.interactionMode),
    providerInstanceId: requiredString(detail.providerInstanceId),
    model: requiredString(detail.model),
    options: modelOptions(detail.options ?? detail.modelOptions),
    threadId: requiredString(detail.threadId),
    executions: executions.map(executionIdentity),
    link: typeof detail.link === "string" || detail.link === null ? detail.link : null,
  };
}

function executionIdentity(value: unknown) {
  const run = asObject(value);
  return {
    runId: requiredString(run.runId),
    providerInstanceId: requiredString(run.providerInstanceId),
    model: requiredString(run.model),
    status: requiredString(run.status),
  };
}

function modelOptions(value: unknown): LaunchCandidate["options"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const options: Record<string, string | boolean> = {};
  for (const [key, option] of Object.entries(value)) {
    if (typeof option !== "string" && typeof option !== "boolean") return null;
    options[key] = option;
  }
  return options;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("T3 JSON object is unavailable");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value) throw Error("T3 identity field is unavailable");
  return value;
}
