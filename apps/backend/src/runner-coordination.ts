import { readRemoteReferences } from "./coordinator-remote.ts";
import { threadHref } from "./thread-link.ts";
import { workerDelegationPlan } from "./coordinator-plan.ts";
import type { RunSnapshot, RunDetail } from "@t3-factory/contracts";
import type { LaunchPayload } from "./adapters/t3.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { fingerprint } from "./runner-utils.ts";

export const COORDINATOR_HOLD = "Coordinator evidence unavailable; activation remains unverified.";

/** The direct worker's first message and native delegation plan for one Block activation. */
export function coordinatorLaunch(
  snapshot: RunSnapshot,
  blockId: string,
  input: string,
  activationId: string,
  requestKey: string,
  payload: LaunchPayload,
) {
  const block = snapshot.flow.graph.blocks.find((b) => b.id === blockId)!;
  const agent = snapshot.agents.find((a) => block.kind === "agent" && a.id === block.agentId)!;
  const message = `${agent.prompt}\n\nTask context:\n${input}\n\nFactory activation ${activationId}. You are the direct worker for this Block. Call factory-runtime.factory_report yourself. Report status finished with one exact configured exit and a concise nonempty result. Report waiting with a concise question when clarification is needed; no exit for waiting. Factory owns routing and immutable final acceptance. Do not delegate replacement work or ask the Run conversation to judge or report your final. A report accepted while you work does not release downstream work until your execution and subtree finish. Configured exits: ${JSON.stringify(block.exits)}.`;
  const invocation = workerDelegationPlan(agent, message, requestKey);
  return {
    activationId,
    requestKey,
    inputFingerprint: fingerprint(JSON.stringify(invocation)),
    payload: { ...payload, message },
  };
}

/** Separate activation and native request identity; no external worker dispatch intent exists. */
export function persistActivation(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
  plan: Pick<
    ReturnType<typeof coordinatorLaunch>,
    "activationId" | "requestKey" | "inputFingerprint"
  >,
  cause = "start:" + blockId,
) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO run_activations(id,run_id,block_id,cause,created_at) VALUES(${plan.activationId},${runId},${blockId},${cause},${time})`;
    yield* sql`INSERT INTO run_delegations(activation_id,request_key,input_fingerprint) VALUES(${plan.activationId},${plan.requestKey},${plan.inputFingerprint})`;
  });
}

export function coordinationRead(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      blockId: string;
      cause: string;
      phase: RunDetail["activations"][number]["phase"];
      coverage: RunDetail["activations"][number]["coverage"];
      problem: string | null;
      evidence_json: string | null;
      createdAt: string;
      requestKey: string;
      inputFingerprint: string;
      accepted_json: string | null;
    }>`SELECT a.id,a.block_id AS blockId,a.cause,a.phase,a.coverage,a.created_at AS createdAt,a.problem,a.evidence_json,d.request_key AS requestKey,d.input_fingerprint AS inputFingerprint,d.accepted_json FROM run_activations a JOIN run_delegations d ON d.activation_id=a.id WHERE a.run_id=${id} ORDER BY a.rowid`;
    const threadBindings = yield* sql<
      RunDetail["threadBindings"][number]
    >`SELECT id,block_id AS blockId,environment_id AS environmentId,thread_id AS threadId,role,link,parent_binding_id AS parentBindingId FROM run_thread_bindings WHERE run_id=${id} ORDER BY rowid`;
    return {
      remoteWork: yield* readRemoteReferences(sql, id),
      activations: rows.map(
        ({ requestKey, inputFingerprint, evidence_json, accepted_json, ...activation }) => ({
          ...activation,
          evidence: evidence_json
            ? (JSON.parse(evidence_json) as import("@t3-factory/contracts").CoordinatorEvidence)
            : null,
          delegation: {
            requestKey,
            inputFingerprint,
            state: accepted_json ? ("accepted" as const) : ("planned" as const),
            ...(accepted_json ? { accepted: acceptedReference(accepted_json) } : {}),
          },
        }),
      ),
      threadBindings: threadBindings.map((binding) => ({
        ...binding,
        link: threadHref(binding.link),
      })),
    };
  });
}

function acceptedReference(json: string) {
  const source = JSON.parse(
    json,
  ) as import("./adapters/delegation-activity.ts").DelegationActivity["invocations"][number];
  return {
    taskId: source.result.taskId,
    childThreadId: source.result.childThreadId,
    childExecutionId: source.result.childRunId,
    sourceExecutionId: source.parentRunId,
    itemId: source.itemId,
  };
}
