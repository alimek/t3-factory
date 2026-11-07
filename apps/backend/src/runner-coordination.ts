import { readRemoteReferences } from "./coordinator-remote.ts";
import { threadHref } from "./thread-link.ts";
import type { RunDetail } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const COORDINATOR_HOLD = "Worker evidence unavailable; activation remains unverified.";

/** Separate activation and native request identity; no external worker dispatch intent exists. */
export function persistActivation(
  sql: SqlClient.SqlClient,
  runId: string,
  blockId: string,
  time: string,
  plan: { activationId: string; requestKey: string; inputFingerprint: string },
  cause = "start:" + blockId,
) {
  return Effect.gen(function* () {
    // An Agent block runs with the revision its Run froze at Start, never the current one.
    yield* sql`INSERT INTO run_activations(id,run_id,block_id,cause,created_at,agent_revision_id) VALUES(${plan.activationId},${runId},${blockId},${cause},${time},(SELECT f.agent_revision_id FROM runs r JOIN flow_revision_blocks b ON b.flow_revision_id=r.flow_revision_id AND b.block_id=${blockId} JOIN run_agent_revisions f ON f.run_id=r.id AND f.agent_id=b.agent_id WHERE r.id=${runId}))`;
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
