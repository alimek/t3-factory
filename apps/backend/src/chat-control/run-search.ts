import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { runLifecycle } from "../runner/run-store/lifecycle.ts";

/** A Run's state as Chat control names it: Snoozed is an Active Run's presentation. */
export type ChatRunState = "active" | "snoozed" | "settled" | "archived";

/** What identifies a Run to a chat participant. */
export interface RunIdentity {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  readonly project: { readonly id: string; readonly name: string; readonly repositoryPath: string };
  readonly flow: string;
  readonly state: ChatRunState;
  readonly startedAt: string;
}

/** The position after the last Run a search page showed, in search order. */
export interface SearchPosition {
  readonly createdAt: string;
  readonly creationKey: string;
  readonly id: string;
}

/** What a Run search matches; scope is applied separately at every use. */
export interface RunQuery {
  /** Words that must each appear in the Run title, Project name or path, or Flow name. */
  readonly words: readonly string[];
  readonly projectId: string | null;
  readonly includeArchived: boolean;
}

type Row = {
  id: string;
  number: number | null;
  title: string;
  created_at: string;
  creation_key: string;
  started_at: string;
  settled_at: string | null;
  archived_at: string | null;
  snoozed: number | null;
  project_id: string;
  project_title: string;
  workspace_root: string;
  flow_name: string;
};

const identity = (row: Row): RunIdentity => {
  const lifecycle = runLifecycle(row);
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    project: { id: row.project_id, name: row.project_title, repositoryPath: row.workspace_root },
    flow: row.flow_name,
    state: lifecycle === "active" && row.snoozed ? "snoozed" : lifecycle,
    startedAt: row.started_at,
  };
};

/** Escapes LIKE wildcards so a word matches literally. */
const literal = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * Scoped Run reads for Chat control. Every read is limited to `projectIds`, the Projects the
 * thread's parent channel grants the requester now, so a known Run ID or number reaches nothing
 * outside them.
 */
export function runSearch(sql: SqlClient.SqlClient) {
  const columns = sql.literal(
    "r.id,r.number,r.title,r.created_at,r.creation_key,r.started_at,r.settled_at,r.archived_at,rp.snoozed,p.id AS project_id,p.title AS project_title,p.workspace_root,f.name AS flow_name",
  );
  const from = sql`FROM runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
    JOIN flow_revisions f ON f.id=r.flow_revision_id LEFT JOIN run_presentation rp ON rp.run_id=r.id`;
  const scoped = (projectIds: readonly string[], conditions: readonly Statement.Fragment[]) =>
    sql.and([sql`p.id IN ${sql.in(projectIds)}`, ...conditions]);

  const matching = (query: RunQuery) => [
    ...query.words.map(
      (word) =>
        sql`(r.title || ' ' || p.title || ' ' || p.workspace_root || ' ' || f.name) LIKE ${literal(word)} ESCAPE '\\'`,
    ),
    ...(query.projectId === null ? [] : [sql`p.id=${query.projectId}`]),
    ...(query.includeArchived ? [] : [sql`r.archived_at IS NULL`]),
  ];

  return {
    /**
     * The Run an exact reference names, in any lifecycle, or undefined when no permitted Run has
     * that ID or number.
     */
    reference: (projectIds: readonly string[], reference: { id: string } | { number: number }) =>
      Effect.gen(function* () {
        if (projectIds.length === 0) return undefined;
        const [row] = yield* sql<Row>`SELECT ${columns} ${from} WHERE ${scoped(projectIds, [
          "id" in reference ? sql`r.id=${reference.id}` : sql`r.number=${reference.number}`,
        ])}`;
        return row ? identity(row) : undefined;
      }),
    /**
     * Up to `limit` matching Runs after `after`, newest first, and how many match now. The order
     * is a fixed key of existing Runs, so continuing from a position never skips a Run that
     * already matched, whatever was started meanwhile.
     */
    page: (
      projectIds: readonly string[],
      query: RunQuery,
      after: SearchPosition | null,
      limit: number,
    ) =>
      Effect.gen(function* () {
        if (projectIds.length === 0) return { runs: [], more: false, matching: 0 };
        const conditions = matching(query);
        const position =
          after === null
            ? []
            : [
                sql`(r.created_at<${after.createdAt} OR (r.created_at=${after.createdAt} AND (r.creation_key>${after.creationKey}
                  OR (r.creation_key=${after.creationKey} AND r.id>${after.id}))))`,
              ];
        const rows = yield* sql<Row>`SELECT ${columns} ${from}
          WHERE ${scoped(projectIds, [...conditions, ...position])}
          ORDER BY r.created_at DESC,r.creation_key,r.id LIMIT ${limit + 1}`;
        const [count] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count ${from}
          WHERE ${scoped(projectIds, conditions)}`;
        const shown = rows.slice(0, limit);
        const last = shown.at(-1);
        return {
          runs: shown.map(identity),
          more: rows.length > limit,
          matching: count!.count,
          last: last
            ? ({
                createdAt: last.created_at,
                creationKey: last.creation_key,
                id: last.id,
              } satisfies SearchPosition)
            : undefined,
        };
      }),
  };
}

export type RunSearch = ReturnType<typeof runSearch>;
