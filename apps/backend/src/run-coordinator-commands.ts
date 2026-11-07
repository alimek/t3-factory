import * as Effect from "effect/Effect";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";

type RootCommand = { thread_id: string | null };

/**
 * Historical coordinator commands stay readable. Factory does not dispatch or
 * observe them: a Block worker is launched directly, and a lost launch is searched
 * for rather than replayed through a Run conversation.
 */
export function openRootCommands(database: RunnerDatabase, t3: T3Adapter) {
  void t3;
  const commands = (id: string) =>
    database.transaction(
      (sql) =>
        sql<RootCommand>`SELECT thread_id FROM run_coordinator_commands WHERE run_id=${id} ORDER BY rowid`,
    );
  return {
    dispatch(run: RunRow) {
      void run;
      return Effect.void;
    },
    observe(run: RunRow) {
      void run;
      return Effect.void;
    },
    commands,
  };
}
