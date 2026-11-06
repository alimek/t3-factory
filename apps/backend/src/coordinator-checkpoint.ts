import * as Effect from "effect/Effect";
import type { RuntimeBinding } from "./runtime-types.ts";
import type { Checkpoint } from "./coordinator-evidence.ts";

/** A worker final needs a fresh, still-valid assessment frontier at acceptance. */
export function checkpointRejection(
  sql: import("effect/sql/SqlClient").SqlClient,
  proof: Checkpoint | null,
) {
  return Effect.gen(function* () {
    return !proof || !(yield* proof.validate(sql)) ? { code: "ASSESSMENT_UNVERIFIED" } : undefined;
  });
}
export function persistCheckpoint(
  sql: import("effect/sql/SqlClient").SqlClient,
  binding: RuntimeBinding,
  reportId: string,
  proof: Checkpoint | null,
) {
  return Effect.gen(function* () {
    if (!proof) return;
    yield* sql`INSERT INTO assessment_checkpoints(activation_id,report_id,reporter_thread_id,reporter_execution_id,evidence_json) VALUES(${proof.activationId},${reportId},${binding.threadId},${binding.runId},${proof.evidence})`;
  });
}
