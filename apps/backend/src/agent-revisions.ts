import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { AgentExecutionSettings, BlockExit, RunDefinitions } from "@t3-factory/contracts";
import { newId } from "./ids.ts";

/** A saved Agent revision as Studio and Start read it; settings availability is derived separately. */
export type AgentRevision = RunDefinitions["agents"][number];

type RevisionRow = {
  id: string;
  agent_id: string;
  revision: number;
  name: string;
  prompt: string;
  environment_id: string;
  provider_instance_id: string;
  model_id: string;
  model_options_json: string;
  saved_at: string;
  created_at: string;
};
type ExitRow = {
  agent_revision_id: string;
  exit_id: string;
  name: string;
  description: string;
  message_required: number;
};

/** Appends one immutable revision; callers own the transaction and the `agents` identity row. */
export const appendAgentRevision = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  agent: Omit<AgentRevision, "createdAt">,
) {
  const { execution } = agent;
  const revisionId = yield* newId;
  yield* sql`INSERT INTO agent_revisions (
      id, agent_id, revision, name, prompt, environment_id, provider_instance_id, model_id,
      model_options_json, saved_at
    ) VALUES (
      ${revisionId}, ${agent.id}, ${agent.revision}, ${agent.name}, ${agent.prompt},
      ${execution.environmentId}, ${execution.providerInstanceId}, ${execution.modelId},
      ${JSON.stringify(execution.modelOptions)}, ${agent.updatedAt}
    )`;
  yield* Effect.forEach(
    agent.exits,
    (exit, ordinal) =>
      sql`INSERT INTO agent_revision_exits (agent_revision_id, exit_id, ordinal, name, description, message_required)
        VALUES (${revisionId}, ${exit.id}, ${ordinal}, ${exit.name}, ${exit.description},
          ${exit.messageRequired ? 1 : 0})`,
    { discard: true },
  );
});

/** The latest revision of each non-removed Agent (or only `agentId`), most recently saved first. */
export const readCurrentAgents = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  agentId?: string,
) {
  const rows = yield* sql<RevisionRow>`SELECT r.*, a.created_at FROM agents a
    JOIN agent_revisions r ON r.agent_id = a.id
      AND r.revision = (SELECT max(revision) FROM agent_revisions WHERE agent_id = a.id)
    WHERE a.removed_at IS NULL ${agentId === undefined ? sql`` : sql`AND a.id = ${agentId}`}
    ORDER BY r.saved_at DESC, a.id ASC`;
  return yield* withExits(sql, rows);
});

/** The Agent revisions a Run froze at Start, in the order its Flow first places them. */
export const readRunAgentRevisions = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  run: { id: string; flow_revision_id: string },
) {
  const rows = yield* sql<RevisionRow>`SELECT r.*, a.created_at FROM run_agent_revisions f
    JOIN agent_revisions r ON r.id = f.agent_revision_id
    JOIN agents a ON a.id = r.agent_id
    WHERE f.run_id = ${run.id}
    ORDER BY (SELECT min(ordinal) FROM flow_revision_blocks
      WHERE flow_revision_id = ${run.flow_revision_id} AND agent_id = f.agent_id)`;
  return yield* withExits(sql, rows);
});

/**
 * The last name of every exit each Agent's revisions had, so readiness can name a wire whose exit
 * the current revision removed.
 */
export const readFormerExitNames = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{ agent_id: string; exit_id: string; name: string }>`
    SELECT r.agent_id, e.exit_id, e.name FROM agent_revision_exits e
    JOIN agent_revisions r ON r.id = e.agent_revision_id ORDER BY r.revision`;
  const names = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const agent = names.get(row.agent_id) ?? new Map<string, string>();
    agent.set(row.exit_id, row.name);
    names.set(row.agent_id, agent);
  }
  return names;
});

const withExits = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  rows: readonly RevisionRow[],
) {
  if (!rows.length) return [];
  const exits = yield* sql<ExitRow>`SELECT * FROM agent_revision_exits
    WHERE agent_revision_id IN ${sql.in(rows.map((row) => row.id))} ORDER BY ordinal`;
  return rows.map((row) =>
    toRevision(
      row,
      exits.filter((exit) => exit.agent_revision_id === row.id),
    ),
  );
});

const toExit = (row: ExitRow): BlockExit => ({
  id: row.exit_id,
  name: row.name,
  description: row.description,
  messageRequired: row.message_required === 1,
});

const toRevision = (row: RevisionRow, exits: readonly ExitRow[]): AgentRevision => ({
  id: row.agent_id,
  name: row.name,
  prompt: row.prompt,
  revision: row.revision,
  execution: {
    environmentId: row.environment_id,
    providerInstanceId: row.provider_instance_id,
    modelId: row.model_id,
    modelOptions: JSON.parse(row.model_options_json) as AgentExecutionSettings["modelOptions"],
  },
  exits: exits.map(toExit),
  createdAt: row.created_at,
  updatedAt: row.saved_at,
});

/** The current saved revision number, absent once the Agent is removed. */
export const currentAgentRevisionNumber = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  agentId: string,
) {
  const [row] = yield* sql<{ revision: number | null }>`SELECT max(r.revision) AS revision
    FROM agents a JOIN agent_revisions r ON r.agent_id = a.id
    WHERE a.id = ${agentId} AND a.removed_at IS NULL`;
  return row?.revision ?? undefined;
});
