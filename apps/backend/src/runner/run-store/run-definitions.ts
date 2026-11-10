import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RunDefinitions } from "@t3-factory/contracts";
import { readRunAgentRevisions } from "../../agent-revisions.ts";
import { readFlowRevision } from "../../flow-revisions.ts";

/** The revisions a Run captured at Start; later edits and removals never change them. */
export const readRunDefinitions = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  run: { id: string; flow_revision_id: string },
) {
  const definitions: RunDefinitions = {
    flow: yield* readFlowRevision(sql, run.flow_revision_id),
    agents: yield* readRunAgentRevisions(sql, run),
  };
  return definitions;
});
