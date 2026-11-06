/** Internal evidence seams over installed public read/list/wait calls. Never task authority. */
export type EvidenceCall = (
  name: "t3_thread_read" | "t3_thread_list" | "t3_thread_wait",
  args: Record<string, unknown>,
) => Promise<unknown>;
export interface ChildEvidenceTarget {
  readonly parentThreadId: string;
  readonly projectId: string;
  readonly childThreadId: string;
  readonly childRunId: string | null;
}
interface ThreadIdentity {
  readonly threadId: string;
  readonly projectId: string;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: string | null;
  readonly creationSource: string;
  readonly createdBy: string;
  readonly providerInstanceId: string;
  readonly model: string;
}
interface ChildThread extends ThreadIdentity {
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly worktreePath: string | null;
  readonly activeRunId: string | null;
  readonly latestRunId: string | null;
  readonly pendingRequestCount: number;
}
interface ChildExecution {
  readonly runId: string;
  readonly status: string;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
}
type Relationship = "t3-owned" | "provider-native" | "other" | "unknown";
export interface ChildEvidence {
  readonly target: ChildEvidenceTarget;
  readonly relationship: Relationship;
  readonly scopeMatches: boolean;
  readonly thread: ChildThread | null;
  readonly execution: ChildExecution | null;
  /** Public detail and exact runs omit options. Native acceptance is separate evidence. */
  readonly optionsCoverage: "unavailable";
  readonly problem?: string;
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Missing evidence object.");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw Error("Missing evidence identity.");
  return value;
};
const nullableString = (value: unknown) => (value === null ? null : string(value));
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("Invalid evidence count/cursor.");
  return value;
};
const failure = (error: unknown) =>
  error instanceof Error ? error.message : "Evidence unavailable.";
const terminal = ["completed", "failed", "cancelled", "interrupted"];
const runStatus = (value: unknown) => {
  const status = string(value);
  if (!["queued", "running", "waiting", ...terminal].includes(status))
    throw Error("Unknown execution status.");
  return status;
};
function threadIdentity(value: unknown): ThreadIdentity {
  const t = object(value);
  return {
    threadId: string(t.threadId),
    projectId: string(t.projectId),
    parentThreadId: nullableString(t.parentThreadId),
    relationshipToParent: nullableString(t.relationshipToParent),
    creationSource: string(t.creationSource),
    createdBy: string(t.createdBy),
    providerInstanceId: string(t.providerInstanceId),
    model: string(t.model),
  };
}
function relationship(thread: ThreadIdentity): Relationship {
  if (thread.relationshipToParent !== "subagent") return "other";
  if (thread.creationSource === "provider") return "provider-native";
  return thread.creationSource === "mcp" && thread.createdBy === "agent" ? "t3-owned" : "other";
}
function childThread(value: unknown): ChildThread {
  const t = object(value);
  return {
    ...threadIdentity(t),
    runtimeMode: string(t.runtimeMode),
    interactionMode: string(t.interactionMode),
    worktreePath: nullableString(t.worktreePath),
    activeRunId: nullableString(t.activeRunId),
    latestRunId: nullableString(t.latestRunId),
    pendingRequestCount: count(t.pendingRequestCount),
  };
}
async function childExecution(
  call: EvidenceCall,
  target: ChildEvidenceTarget,
  runs: unknown,
): Promise<ChildExecution | null> {
  if (target.childRunId === null) return null;
  if (!Array.isArray(runs)) throw Error("Exact child execution coverage unavailable.");
  const matches = runs.map(object).filter((run) => run.runId === target.childRunId);
  if (matches.length > 1) throw Error("Duplicate exact child executions.");
  const run = matches[0];
  if (run)
    return {
      runId: target.childRunId,
      status: runStatus(run.status),
      providerInstanceId: string(run.providerInstanceId),
      model: string(run.model),
    };
  const exact = object(
    await call("t3_thread_wait", {
      threadId: target.childThreadId,
      runId: target.childRunId,
      timeoutMs: 0,
    }),
  );
  if (exact.threadId !== target.childThreadId || exact.runId !== target.childRunId)
    throw Error("Exact child execution was substituted.");
  return {
    runId: target.childRunId,
    status: runStatus(exact.status),
    providerInstanceId: null,
    model: null,
  };
}
export async function readChildEvidence(
  call: EvidenceCall,
  target: ChildEvidenceTarget,
): Promise<ChildEvidence> {
  let thread: ChildThread | null = null;
  let execution: ChildExecution | null = null;
  let problem: string | undefined;
  try {
    const body = object(
      await call("t3_thread_read", {
        threadId: target.childThreadId,
        limit: 1,
        maxCharsPerItem: 1,
        runLimit: 50,
      }),
    );
    const observed = childThread(body.thread);
    if (observed.threadId !== target.childThreadId)
      throw Error("Child thread identity was substituted.");
    thread = observed;
    execution = await childExecution(call, target, body.recentRuns);
  } catch (error) {
    problem = failure(error);
  }
  return {
    target,
    thread,
    execution,
    relationship: thread ? relationship(thread) : "unknown",
    scopeMatches:
      thread?.projectId === target.projectId && thread.parentThreadId === target.parentThreadId,
    optionsCoverage: "unavailable",
    ...(problem ? { problem } : {}),
  };
}

export interface DescendantEvidence {
  readonly parentThreadId: string;
  readonly descendants: readonly (ThreadIdentity & { readonly relationship: Relationship })[];
  readonly scanComplete: boolean;
  /** Offset lists are not atomic and do not prove remote/hidden work absent. */
  readonly coverage: "incomplete" | "unknown";
  readonly problem: string;
}
function descendantsOf(parentThreadId: string, threads: readonly ThreadIdentity[]) {
  const owned = new Set([parentThreadId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (
        thread.parentThreadId &&
        owned.has(thread.parentThreadId) &&
        !owned.has(thread.threadId)
      ) {
        owned.add(thread.threadId);
        changed = true;
      }
    }
  }
  return threads
    .filter((t) => t.threadId !== parentThreadId && owned.has(t.threadId))
    .map((t) => ({ ...t, relationship: relationship(t) }));
}
class DescendantScan {
  readonly threads = new Map<string, ThreadIdentity>();
  cursor = 0;
  complete = false;
  private total: number | undefined;

  accept(value: unknown) {
    const body = object(value);
    if (body.projectId !== null || !Array.isArray(body.threads) || body.threads.length > 100)
      throw Error("Invalid descendant list scope/page.");
    const total = count(body.total);
    if (this.total !== undefined && this.total !== total)
      throw Error("Descendant list changed during pagination.");
    this.total = total;
    for (const row of body.threads) {
      const thread = threadIdentity(row);
      if (this.threads.has(thread.threadId))
        throw Error("Duplicate descendant identity during pagination.");
      this.threads.set(thread.threadId, thread);
    }
    if (body.nextCursor === null) {
      if (this.threads.size !== total)
        throw Error("Descendant list count does not establish scan coverage.");
      this.complete = true;
      return;
    }
    const next = count(body.nextCursor);
    if (next !== this.cursor + body.threads.length || next <= this.cursor || next >= total)
      throw Error("Invalid descendant continuation.");
    this.cursor = next;
  }
}
export async function readDescendants(
  call: EvidenceCall,
  parentThreadId: string,
): Promise<DescendantEvidence> {
  const scan = new DescendantScan();
  let problem =
    "Public offset listing cannot establish atomic, hidden or remote descendant coverage.";
  try {
    string(parentThreadId);
    for (let page = 0; page < 100 && !scan.complete; page++) {
      scan.accept(
        await call("t3_thread_list", {
          allProjects: true,
          includeSubagents: true,
          cursor: scan.cursor,
          limit: 100,
        }),
      );
    }
    if (!scan.complete) problem = "Descendant listing exceeded 100 pages.";
  } catch (error) {
    problem = failure(error);
  }
  return {
    parentThreadId,
    descendants: descendantsOf(parentThreadId, [...scan.threads.values()]),
    scanComplete: scan.complete,
    coverage: scan.threads.size || scan.complete ? "incomplete" : "unknown",
    problem,
  };
}

export interface DelegatedSettlement {
  readonly threadId: string;
  readonly runId: string;
  readonly state: "settled" | "pending" | "unknown";
  readonly status: string | null;
  readonly resultRun: { readonly runId: string; readonly status: string } | null;
  readonly queueCoverage: "unobserved";
  readonly nativeRequestCoverage: "unobserved";
  readonly problem?: string;
}
export async function readDelegatedSettlement(
  call: EvidenceCall,
  threadId: string,
  runId: string,
): Promise<DelegatedSettlement> {
  const base = {
    threadId,
    runId,
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  } as const;
  try {
    string(threadId);
    string(runId);
    const body = object(
      await call("t3_thread_wait", {
        threadId,
        runId,
        timeoutMs: 0,
        untilDelegatedWorkSettled: true,
      }),
    );
    if (body.threadId !== threadId || body.runId !== runId || typeof body.timedOut !== "boolean")
      throw Error("Exact parent wait identity or timeout evidence unavailable.");
    const status = runStatus(body.status);
    const result = body.resultRun === undefined ? null : object(body.resultRun);
    if (result && (result.runId !== runId || !terminal.includes(runStatus(result.status))))
      throw Error("Aggregate result execution was substituted or is not terminal.");
    if (body.timedOut) return { ...base, state: "pending", status, resultRun: null };
    if (!terminal.includes(status) || !result || result.status !== status)
      throw Error("Exact terminal aggregate result unavailable.");
    return { ...base, state: "settled", status, resultRun: { runId, status } };
  } catch (error) {
    return { ...base, state: "unknown", status: null, resultRun: null, problem: failure(error) };
  }
}
