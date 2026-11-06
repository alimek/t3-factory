import type { EvidenceCall } from "./coordination-evidence.ts";
export interface RemoteWorkTarget {
  environmentId: string;
  threadId: string;
}
export interface RemoteWorkObservation extends RemoteWorkTarget {
  available: boolean;
  pendingRequestCount: number | null;
}
/** Positive input evidence only. Public detail cannot associate remote task/execution,
 * verify options or prove a complete descendant/request frontier. No absence inference. */
export async function readRemoteWork(
  call: EvidenceCall,
  target: RemoteWorkTarget,
): Promise<RemoteWorkObservation> {
  try {
    const body = (await call("t3_thread_read", {
      ...target,
      limit: 1,
      maxCharsPerItem: 1,
      runLimit: 1,
    })) as { thread?: { threadId?: string; pendingRequestCount?: number } };
    const count = body.thread?.pendingRequestCount;
    if (
      body.thread?.threadId !== target.threadId ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw Error("Remote observation unavailable.");
    return { ...target, available: true, pendingRequestCount: count };
  } catch {
    return { ...target, available: false, pendingRequestCount: null };
  }
}
