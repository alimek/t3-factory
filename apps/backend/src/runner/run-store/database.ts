import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RunRow } from "../runner-types.ts";
import { readRunDefinitions } from "./run-definitions.ts";
import { readRunWorkspace } from "../run-workspace.ts";
import type { LiveChanges } from "../../live-changes.ts";
import { guardsHold } from "./guards.ts";

type Lane = <A, E>(id: string, action: () => Effect.Effect<A, E>) => Effect.Effect<A, E>;

/** A Run with its captured definitions and workspace, read in the caller's transaction. */
export function readRunRow(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const [runRow] = yield* sql<
      Omit<RunRow, "definitions" | "workspace">
    >`SELECT r.*, t.project_id, t.title, c.endpoint, c.environment_id, p.project_id AS t3_project_id FROM runs r JOIN tasks t ON t.id=r.task_id JOIN t3_authorization_contexts c ON c.id=r.context_id JOIN projects p ON p.id=t.project_id WHERE r.id=${id}`;
    return (
      runRow && {
        ...runRow,
        definitions: yield* readRunDefinitions(sql, runRow),
        workspace: yield* readRunWorkspace(sql, runRow.id),
      }
    );
  });
}

/**
 * The raw transaction handle of the Run store, kept for the Runner's reads and the Run and Task
 * renames. `mutate` enters the store's one mutation lane per Run. Writers outside `mutate` publish
 * their committed Run changes through `changes` themselves.
 */
export function openRunnerDatabase(
  sqlClient: SqlClient.SqlClient,
  owner: { token: string },
  changes: LiveChanges,
  serial: Lane,
) {
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sqlClient));
  const transaction = <A>(
    fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
  ) =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(fn(sql));
      }),
    );
  /** Publishes after the transaction commits, unless `published` says the committed value
   * changed nothing to publish; a rolled-back mutation publishes nothing. */
  const mutate = <A>(
    id: string,
    fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
    published: (value: A) => boolean = () => true,
  ) =>
    serial(id, () =>
      transaction(fn).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (published(value)) changes.runChanged(id);
          }),
        ),
      ),
    );
  const row = (id: string) =>
    run(
      Effect.gen(function* () {
        return yield* readRunRow(yield* SqlClient.SqlClient, id);
      }),
    );
  /** Observations apply only to an open Run under this owner and its unchanged authorization context. */
  function runHeldUnderContext(sql: SqlClient.SqlClient, runRow: RunRow, requireOpenGate = false) {
    return guardsHold(sql, owner.token, runRow.id, {
      owner: true,
      notArchived: true,
      liveContext: runRow.context_id,
      ...(requireOpenGate ? { gateOpen: true as const } : {}),
    });
  }
  return {
    run,
    owner,
    changes,
    mutate,
    row,
    transaction,
    runHeldUnderContext,
  };
}
export type RunnerDatabase = ReturnType<typeof openRunnerDatabase>;
