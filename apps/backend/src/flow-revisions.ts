import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { FlowBlock, FlowGraph, FlowWorkspace, RunDefinitions } from "@t3-factory/contracts";
import { newId } from "./ids.ts";

/** A saved Flow revision as Studio and Start read it; readiness is derived separately. */
export type FlowRevision = RunDefinitions["flow"];

type RevisionRow = {
  id: string;
  flow_id: string;
  revision: number;
  name: string;
  input_x: number;
  input_y: number;
  workspace_mode: FlowWorkspace["mode"];
  workspace_base_ref: string | null;
  saved_at: string;
  created_at: string;
};
type BlockRow = {
  flow_revision_id: string;
  block_id: string;
  kind: FlowBlock["kind"];
  name: string;
  agent_id: string | null;
  prompt: string | null;
  x: number;
  y: number;
};
/** A Flow-local exit of an Agent block. */
type ExitRow = {
  flow_revision_id: string;
  block_id: string;
  exit_id: string;
  name: string;
  description: string;
  message_required: number;
};
type HiddenExitRow = { flow_revision_id: string; block_id: string; exit_id: string };
type ConnectionRow = {
  flow_revision_id: string;
  source_block_id: string;
  exit_id: string;
  target_block_id: string;
};
type TargetRow = { flow_revision_id: string; block_id: string };

const groupBy = <R>(rows: readonly R[], key: (row: R) => string) => {
  const groups = new Map<string, R[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
};
const byRevision = (row: { flow_revision_id: string }) => row.flow_revision_id;
const byBlock = (row: { flow_revision_id: string; block_id: string }) =>
  JSON.stringify([row.flow_revision_id, row.block_id]);

/** Appends one immutable revision with its owned graph rows; callers own the transaction. */
export const appendFlowRevision = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  flow: {
    id: string;
    revision: number;
    name: string;
    graph: FlowGraph;
    workspace: FlowWorkspace;
    savedAt: string;
  },
) {
  const revisionId = yield* newId;
  const { graph, workspace } = flow;
  const baseRef =
    workspace.mode === "worktree" && workspace.base.kind === "ref" ? workspace.base.ref : null;
  yield* sql`INSERT INTO flow_revisions (id, flow_id, revision, name, input_x, input_y,
      workspace_mode, workspace_base_ref, saved_at)
    VALUES (${revisionId}, ${flow.id}, ${flow.revision}, ${flow.name},
      ${graph.flowInput.position.x}, ${graph.flowInput.position.y},
      ${workspace.mode}, ${baseRef}, ${flow.savedAt})`;
  yield* Effect.forEach(
    graph.blocks,
    (block, ordinal) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO flow_revision_blocks (flow_revision_id, block_id, ordinal, kind, name, agent_id, prompt, x, y)
        VALUES (${revisionId}, ${block.id}, ${ordinal}, ${block.kind}, ${block.name},
          ${block.kind === "agent" ? block.agentId : null},
          ${block.kind === "continuation" ? block.prompt : null}, ${block.position.x}, ${block.position.y})`;
        if (block.kind !== "agent") return;
        yield* Effect.forEach(
          block.localExits,
          (exit, exitOrdinal) =>
            sql`INSERT INTO flow_revision_exits (flow_revision_id, block_id, exit_id, ordinal, name, description, message_required)
            VALUES (${revisionId}, ${block.id}, ${exit.id}, ${exitOrdinal}, ${exit.name},
              ${exit.description}, ${exit.messageRequired ? 1 : 0})`,
          { discard: true },
        );
        yield* Effect.forEach(
          block.hiddenExitIds,
          (exitId, hiddenOrdinal) =>
            sql`INSERT INTO flow_revision_hidden_exits (flow_revision_id, block_id, exit_id, ordinal)
            VALUES (${revisionId}, ${block.id}, ${exitId}, ${hiddenOrdinal})`,
          { discard: true },
        );
      }),
    { discard: true },
  );
  yield* Effect.forEach(
    graph.connections,
    (connection, ordinal) =>
      sql`INSERT INTO flow_revision_connections (flow_revision_id, ordinal, source_block_id, exit_id, target_block_id)
        VALUES (${revisionId}, ${ordinal}, ${connection.sourceBlockId}, ${connection.exitId}, ${connection.targetBlockId})`,
    { discard: true },
  );
  yield* Effect.forEach(
    graph.flowInput.targetBlockIds,
    (blockId, ordinal) =>
      sql`INSERT INTO flow_revision_input_targets (flow_revision_id, ordinal, block_id)
        VALUES (${revisionId}, ${ordinal}, ${blockId})`,
    { discard: true },
  );
});

const toWorkspace = (row: RevisionRow): FlowWorkspace => {
  if (row.workspace_mode === "checkout") return { mode: "checkout" };
  return {
    mode: "worktree",
    base:
      row.workspace_base_ref === null
        ? { kind: "default" }
        : { kind: "ref", ref: row.workspace_base_ref },
  };
};

const toBlock = (
  row: BlockRow,
  exits: readonly ExitRow[],
  hidden: readonly HiddenExitRow[],
): FlowBlock => {
  const base = { id: row.block_id, name: row.name, position: { x: row.x, y: row.y } };
  if (row.kind === "human") return { ...base, kind: "human" };
  if (row.kind === "continuation")
    return { ...base, kind: "continuation", prompt: row.prompt ?? "" };
  return {
    ...base,
    kind: "agent",
    agentId: row.agent_id,
    hiddenExitIds: hidden.map((entry) => entry.exit_id),
    localExits: exits.map((exit) => ({
      id: exit.exit_id,
      name: exit.name,
      description: exit.description,
      messageRequired: exit.message_required === 1,
    })),
  };
};

/** The latest revision of each non-removed Flow (or only `flowId`), newest Flow first. */
export const readCurrentFlows = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  flowId?: string,
) {
  const revisions = yield* sql<RevisionRow>`SELECT r.*, f.created_at FROM flows f
    JOIN flow_revisions r ON r.flow_id = f.id
      AND r.revision = (SELECT max(revision) FROM flow_revisions WHERE flow_id = f.id)
    WHERE f.removed_at IS NULL ${flowId === undefined ? sql`` : sql`AND f.id = ${flowId}`}
    ORDER BY f.created_at DESC, f.id ASC`;
  return yield* withGraphs(sql, revisions);
});

/** One stored revision by its id, also after a later save or the Flow's removal. */
export const readFlowRevision = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  revisionId: string,
) {
  const revisions = yield* sql<RevisionRow>`SELECT r.*, f.created_at FROM flow_revisions r
    JOIN flows f ON f.id = r.flow_id WHERE r.id = ${revisionId}`;
  const [flow] = yield* withGraphs(sql, revisions);
  if (!flow) return yield* Effect.die(new Error(`Flow revision ${revisionId} is missing`));
  return flow;
});

const withGraphs = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  revisions: readonly RevisionRow[],
) {
  if (!revisions.length) return [];
  const ids = sql.in(revisions.map((revision) => revision.id));
  const [blocks, exits, hidden, connections, targets] = yield* Effect.all([
    sql<BlockRow>`SELECT * FROM flow_revision_blocks WHERE flow_revision_id IN ${ids} ORDER BY ordinal`,
    sql<ExitRow>`SELECT * FROM flow_revision_exits WHERE flow_revision_id IN ${ids} ORDER BY ordinal`,
    sql<HiddenExitRow>`SELECT * FROM flow_revision_hidden_exits WHERE flow_revision_id IN ${ids} ORDER BY ordinal`,
    sql<ConnectionRow>`SELECT * FROM flow_revision_connections WHERE flow_revision_id IN ${ids} ORDER BY ordinal`,
    sql<TargetRow>`SELECT * FROM flow_revision_input_targets WHERE flow_revision_id IN ${ids} ORDER BY ordinal`,
  ]);
  const blocksByRevision = groupBy(blocks, byRevision);
  const exitsByBlock = groupBy(exits, byBlock);
  const hiddenByBlock = groupBy(hidden, byBlock);
  const connectionsByRevision = groupBy(connections, byRevision);
  const targetsByRevision = groupBy(targets, byRevision);
  return revisions.map((revision): FlowRevision => ({
    id: revision.flow_id,
    name: revision.name,
    revision: revision.revision,
    graph: {
      blocks: (blocksByRevision.get(revision.id) ?? []).map((block) =>
        toBlock(
          block,
          exitsByBlock.get(byBlock(block)) ?? [],
          hiddenByBlock.get(byBlock(block)) ?? [],
        ),
      ),
      connections: (connectionsByRevision.get(revision.id) ?? []).map((connection) => ({
        sourceBlockId: connection.source_block_id,
        exitId: connection.exit_id,
        targetBlockId: connection.target_block_id,
      })),
      flowInput: {
        position: { x: revision.input_x, y: revision.input_y },
        targetBlockIds: (targetsByRevision.get(revision.id) ?? []).map((target) => target.block_id),
      },
    },
    workspace: toWorkspace(revision),
    createdAt: revision.created_at,
    updatedAt: revision.saved_at,
  }));
});

/** The current saved revision number, absent once the Flow is removed. */
export const currentFlowRevisionNumber = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  flowId: string,
) {
  const [row] = yield* sql<{ revision: number | null }>`SELECT max(r.revision) AS revision
    FROM flows f JOIN flow_revisions r ON r.flow_id = f.id
    WHERE f.id = ${flowId} AND f.removed_at IS NULL`;
  return row?.revision ?? undefined;
});

/** Whether the latest revision of any non-removed Flow places the Agent in a block. */
export const currentFlowsReferenceAgent = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  agentId: string,
) {
  const rows = yield* sql`SELECT 1 FROM flows f
    JOIN flow_revisions r ON r.flow_id = f.id
      AND r.revision = (SELECT max(revision) FROM flow_revisions WHERE flow_id = f.id)
    JOIN flow_revision_blocks b ON b.flow_revision_id = r.id
    WHERE f.removed_at IS NULL AND b.agent_id = ${agentId} LIMIT 1`;
  return rows.length > 0;
});
