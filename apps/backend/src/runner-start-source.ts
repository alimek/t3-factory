import type { FlowDraft, Result, RunSnapshot, StartRunInput } from "@t3-factory/contracts";
import { fingerprint } from "./runner-utils.ts";

/** The exact request identity: Flow Starts and snapshot Starts never share a key's content. */
export function startRequestFingerprint(input: StartRunInput) {
  return fingerprint(
    JSON.stringify(
      input.sourceRunId === undefined
        ? [input.projectId, input.flowId, input.input, input.taskId ?? null]
        : ["snapshot", input.projectId, input.sourceRunId, input.input, input.taskId ?? null],
    ),
  );
}

/** Run again reuses the source Run's captured Flow, Run coordinator and Agent settings. */
export function snapshotStartDefinitions(
  snapshot: RunSnapshot,
): Result<{ flow: FlowDraft; capturedAgents: RunSnapshot["agents"] }> {
  return { ok: true, value: { flow: snapshot.flow, capturedAgents: snapshot.agents } };
}
