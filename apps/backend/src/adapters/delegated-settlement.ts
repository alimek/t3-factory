/** `t3_thread_wait` over the installed public tool; never task authority. */
export type WaitCall = (args: Record<string, unknown>) => Promise<unknown>;

/** T3's answer for one waited run, including its delegated and background work. */
export interface DelegatedSettlement {
  readonly threadId: string;
  readonly runId: string;
  readonly state: "settled" | "pending" | "unknown";
  readonly status: string | null;
  readonly problem?: string;
}
const terminal = ["completed", "failed", "cancelled", "interrupted"];
const statuses = ["queued", "running", "waiting", ...terminal];

/** Settled means a terminal status that did not time out. `resultRun` names whichever run T3
 * answered from (for example an earlier run when a notification resumed the thread), so it is
 * informational and never compared with the waited run. */
export async function readDelegatedSettlement(
  call: WaitCall,
  threadId: string,
  runId: string,
): Promise<DelegatedSettlement> {
  const base = { threadId, runId };
  try {
    const body = await call({ threadId, runId, timeoutMs: 0, untilDelegatedWorkSettled: true });
    if (typeof body !== "object" || body === null) throw Error("Missing wait answer.");
    const answer = body as Record<string, unknown>;
    if (answer.threadId !== threadId || answer.runId !== runId)
      throw Error("Wait answer names another thread or run.");
    if (typeof answer.timedOut !== "boolean") throw Error("Wait timeout evidence unavailable.");
    if (typeof answer.status !== "string" || !statuses.includes(answer.status))
      throw Error("Unknown execution status.");
    if (answer.timedOut || !terminal.includes(answer.status))
      return { ...base, state: "pending", status: answer.status };
    return { ...base, state: "settled", status: answer.status };
  } catch (error) {
    return {
      ...base,
      state: "unknown",
      status: null,
      problem: error instanceof Error ? error.message : "Wait answer unavailable.",
    };
  }
}
