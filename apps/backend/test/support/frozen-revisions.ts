import { DatabaseSync } from "node:sqlite";

/**
 * The Flow and Agent revisions a Run froze at Start, in the shape of its stored snapshot.
 * Run reads still serve the snapshot, so these references have no public read yet.
 */
export function frozenRevisions(databasePath: string, runId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const flow = db
      .prepare(
        `SELECT r.id AS revisionId, r.flow_id AS id, r.revision, r.name, r.input_x, r.input_y,
          r.saved_at AS updatedAt
        FROM runs JOIN flow_revisions r ON r.id = runs.flow_revision_id WHERE runs.id = ?`,
      )
      .get(runId) as
      | {
          revisionId: string;
          id: string;
          revision: number;
          name: string;
          input_x: number;
          input_y: number;
          updatedAt: string;
        }
      | undefined;
    const rows = <T>(query: string) => db.prepare(query).all(flow?.revisionId ?? null) as T[];
    const blocks = rows<{
      block_id: string;
      kind: "agent" | "human";
      name: string;
      agent_id: string | null;
      x: number;
      y: number;
    }>(`SELECT * FROM flow_revision_blocks WHERE flow_revision_id = ? ORDER BY ordinal`);
    const exits = rows<{
      block_id: string;
      exit_id: string;
      name: string;
      description: string;
      outcome: string;
      requires_feedback: number;
    }>(`SELECT * FROM flow_revision_exits WHERE flow_revision_id = ? ORDER BY ordinal`);
    const connections = rows<{
      source_block_id: string;
      exit_id: string;
      target_block_id: string;
    }>(`SELECT * FROM flow_revision_connections WHERE flow_revision_id = ? ORDER BY ordinal`);
    const targets = rows<{ block_id: string }>(
      `SELECT block_id FROM flow_revision_input_targets WHERE flow_revision_id = ? ORDER BY ordinal`,
    );
    const agents = db
      .prepare(
        `SELECT r.id AS revisionId, r.agent_id AS id, r.name, r.prompt, r.revision,
          r.environment_id, r.provider_instance_id, r.model_id, r.model_options_json,
          r.saved_at AS updatedAt
        FROM run_agent_revisions f JOIN agent_revisions r ON r.id = f.agent_revision_id
        WHERE f.run_id = ? ORDER BY r.agent_id`,
      )
      .all(runId) as {
      revisionId: string;
      id: string;
      name: string;
      prompt: string;
      revision: number;
      environment_id: string;
      provider_instance_id: string;
      model_id: string;
      model_options_json: string;
      updatedAt: string;
    }[];
    const activations = db
      .prepare(
        `SELECT a.id, r.agent_id AS agentId, r.revision FROM run_activations a
        LEFT JOIN agent_revisions r ON r.id = a.agent_revision_id
        WHERE a.run_id = ? ORDER BY a.rowid`,
      )
      .all(runId) as { id: string; agentId: string | null; revision: number | null }[];
    return {
      flow: flow && {
        id: flow.id,
        name: flow.name,
        revision: flow.revision,
        updatedAt: flow.updatedAt,
        graph: {
          blocks: blocks.map((block) => ({
            id: block.block_id,
            name: block.name,
            kind: block.kind,
            ...(block.kind === "agent" ? { agentId: block.agent_id } : {}),
            position: { x: block.x, y: block.y },
            exits: exits
              .filter((exit) => exit.block_id === block.block_id)
              .map((exit) => ({
                id: exit.exit_id,
                name: exit.name,
                description: exit.description,
                outcome: exit.outcome,
                requiresFeedback: exit.requires_feedback === 1,
              })),
          })),
          connections: connections.map((connection) => ({
            sourceBlockId: connection.source_block_id,
            exitId: connection.exit_id,
            targetBlockId: connection.target_block_id,
          })),
          flowInput: {
            position: { x: flow.input_x, y: flow.input_y },
            targetBlockIds: targets.map((target) => target.block_id),
          },
        },
      },
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
        revision: agent.revision,
        updatedAt: agent.updatedAt,
        execution: {
          environmentId: agent.environment_id,
          providerInstanceId: agent.provider_instance_id,
          modelId: agent.model_id,
          modelOptions: JSON.parse(agent.model_options_json),
        },
      })),
      activations,
    };
  } finally {
    db.close();
  }
}

/** The snapshot fields that the frozen revisions must reproduce exactly. */
export function snapshotDefinitions(snapshot: {
  flow: { id: string; name: string; revision: number; updatedAt: string; graph: unknown };
  agents: readonly {
    id: string;
    name: string;
    prompt: string;
    revision: number;
    updatedAt: string;
    execution: unknown;
  }[];
}) {
  const { id, name, revision, updatedAt, graph } = snapshot.flow;
  return {
    flow: { id, name, revision, updatedAt, graph },
    agents: snapshot.agents
      .map(({ id, name, prompt, revision, updatedAt, execution }) => ({
        id,
        name,
        prompt,
        revision,
        updatedAt,
        execution,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}
