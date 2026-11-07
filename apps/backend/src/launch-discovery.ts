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
      const candidate = await candidateFor(call, thread, projectId, title);
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
  const body = asObject(value);
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
  projectId: string,
  title: string,
): Promise<LaunchCandidate | "incomplete" | undefined> {
  const detail = await titledThread(call, thread);
  if (!detail || detail.title !== title) return undefined;
  if (!("workspaceRoot" in detail)) return "incomplete";
  const executions = executionList(detail);
  if (!executions) return "incomplete";
  return candidateFrom(detail, projectId, title, executions);
}

async function titledThread(call: Call, thread: Record<string, unknown>) {
  if (typeof thread.title === "string") return thread;
  const threadId = requiredString(thread.threadId);
  const detail = {
    ...asObject(await call("t3_thread_read", { threadId, runLimit: 50 })),
    ...thread,
  };
  return typeof detail.title === "string" ? detail : undefined;
}

function executionList(detail: Record<string, unknown>) {
  if (Array.isArray(detail.recentRuns)) return detail.recentRuns;
  if (Array.isArray(detail.runs)) return detail.runs;
  return null;
}

function textOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parentThread(value: unknown) {
  if (value === null) return null;
  return typeof value === "string" ? value : null;
}

function candidateFrom(
  detail: Record<string, unknown>,
  projectId: string,
  title: string,
  executions: readonly unknown[],
): LaunchCandidate {
  return {
    title,
    projectId: textOr(detail.projectId, projectId),
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
